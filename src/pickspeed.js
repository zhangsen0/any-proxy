/**
 * 浏览器侧测速结果：存下来，并让自动优选**真的按它排序**。
 *
 * 为什么需要这个文件 —— 先说清楚测量起点这件事：
 *
 *   服务端（Worker）探测只能从 Cloudflare 自己的网络出发，测到的是
 *   「CF 数据中心 → 边缘 IP」的距离。而用户连的是「自己的网络 → 边缘 IP」。
 *   实测过：同批 24 个 IP，两个不同网络视角测出来的延迟排序
 *   斯皮尔曼相关系数 rho ≈ -0.056（几乎零相关）—— 也就是说服务端排出来的
 *   「最快」，换到用户网络上看基本等于随机。（见 docs/01 迭代 14）
 *
 *   浏览器自动优选（admin.js 的 measureIp）是全局唯一能从**用户网络**出发测量的
 *   入口。但在加这个文件之前，它测完只把 IP 名单填进优选池，**延迟数字当场丢掉**：
 *   服务端自动优选走二值判定（latency_enabled 默认关），顺序变成「谁先探到谁在前」，
 *   最后写进 A 记录的两条跟用户测出来的快慢没有关系。于是「优选」实际只是「筛候选」。
 *
 * 这里做的事：把浏览器测到的 `{ip: 毫秒}` 存进 KV，自动优选在**写完通断过滤之后**
 * 用它重排一次。分工变成：
 *
 *   浏览器（你的网络）→ 谁快        |  服务端（CF 网络）→ 谁通
 *
 * 服务端不再负责排快慢，只负责别把不通的 IP 写进 A 记录。
 *
 * 三条约束（与 sublat.js 同一套取舍）：
 *   1. 拿不到表 / 表过期 / 开关关着 → 一律原样返回，绝不因此让优选失败。
 *   2. 只重排**已经探通的** IP，绝不能让一个用户侧很快但服务端判定不通的 IP 上位。
 *   3. 未测过的 IP 垫在后面并保持原相对顺序（未知 ≠ 慢，别乱动）。
 */

import { runtime } from './runtime.js';
import { isIpv4 } from './geoip.js';
import { readSettings, SETTINGS_SPEC } from './settings.js';

/** 浏览器测速结果的存储键。运行数据（不是可配置项），所以不进运行参数注册表。 */
const KEY = 'PICK_SPEED';
export const PICK_SPEED_KEY = KEY;

/** 整表最多留多少条：池子上限是运行参数，这里只防「KV 里堆了一堆历史垃圾」 */
const MAX_ENTRIES = 200;

function defaultTtl() {
  return SETTINGS_SPEC.pick_speed_ttl_ms.default;
}

/** 读表。任何异常都当作「没有表」—— 少一次排序只是回到老行为，读坏了才是事故。 */
export async function readPickSpeed(env) {
  try {
    if (!runtime.KV || typeof runtime.KV.get !== 'function') return { ts: 0, ms: {} };
    const raw = await runtime.KV.get(KEY);
    if (!raw) return { ts: 0, ms: {} };
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || !o.ms) return { ts: 0, ms: {} };
    const ms = {};
    for (const [ip, v] of Object.entries(o.ms)) {
      // 只认「合法 IPv4 → 非负数」。写进表的时候已经过滤过一次，这里是防旧数据/手改。
      if (isIpv4(ip) && typeof v === 'number' && isFinite(v) && v >= 0) ms[ip] = v;
    }
    return { ts: Number(o.ts) || 0, ms };
  } catch {
    return { ts: 0, ms: {} };
  }
}

/**
 * 存表。新值覆盖旧值、旧表里没重测的条目保留（池子是分批测的，删了就白测了）。
 * 整表共用一个 ts：换网络后旧数据会一起过期，不会出现「一半新的混着一半旧的」。
 *
 * @param {Array<{ip:string, ms:number}>} items
 * @returns {{ok:boolean, n:number, ts:number}}
 */
export async function savePickSpeed(env, items) {
  const next = {};
  let n = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const ip = String((it && it.ip) || '').trim();
    const ms = Number(it && it.ms);
    if (!isIpv4(ip) || !isFinite(ms) || ms < 0) continue;
    next[ip] = Math.round(ms);
    n++;
  }
  if (!n) return { ok: false, n: 0, ts: 0 };
  try {
    if (!runtime.KV || typeof runtime.KV.put !== 'function') return { ok: false, n: 0, ts: 0 };
    const prev = await readPickSpeed(env);
    const merged = { ...prev.ms, ...next };
    // 条目超上限时只留本次测到的（旧的优先被丢：它们更可能已经不在池子里）
    const keep = Object.keys(merged).length > MAX_ENTRIES
      ? next
      : merged;
    const ts = Date.now();
    await runtime.KV.put(KEY, JSON.stringify({ ts, ms: keep }));
    return { ok: true, n, ts, total: Object.keys(keep).length };
  } catch {
    return { ok: false, n: 0, ts: 0 };
  }
}

/**
 * 按浏览器测速结果重排（纯函数，便于单测）。
 *
 * 档位：测过（按毫秒升序）→ 没测过（垫后，保持原相对顺序）。
 * 相同毫秒时按入参顺序，保证结果可复现（不依赖引擎的排序稳定性）。
 *
 * @param {string[]} ips
 * @param {Record<string, number>} ms
 * @returns {{ips: string[], matched: number}}
 */
export function orderByPickSpeed(ips, ms) {
  const list = Array.isArray(ips) ? ips : [];
  const table = ms && typeof ms === 'object' ? ms : {};
  const known = [];
  const unknown = [];
  list.forEach((ip, i) => {
    if (typeof table[ip] === 'number') known.push({ ip, i, v: table[ip] });
    else unknown.push({ ip, i });
  });
  known.sort((a, b) => (a.v - b.v) || (a.i - b.i));
  return {
    ips: [...known, ...unknown].map((x) => x.ip),
    matched: known.length,
  };
}

/**
 * 带开关与有效期的封装：自动优选就调这一个。
 *
 * 不生效的四种情况都如实回报 reason，面板/接口要把这个原因说给人听 ——
 * 「没排」和「排了但顺序没变」是两件事，混在一起就再也查不清了。
 *
 * @returns {{ips:string[], applied:boolean, reason:string, matched:number, ts:number}}
 */
export async function rankByPickSpeed(env, ips, opts = {}) {
  const list = Array.isArray(ips) ? ips : [];
  const none = (reason) => ({ ips: list, applied: false, reason, matched: 0, ts: 0 });
  if (list.length < 2) return none('too-few');
  let cfg = opts.cfg;
  if (!cfg) {
    try { cfg = await readSettings(env); } catch { return none('config-error'); }
  }
  if (cfg.pick_speed_enabled === false) return none('disabled');
  const { ts, ms } = await readPickSpeed(env);
  if (!Object.keys(ms).length) return none('empty');
  const ttl = Number(cfg.pick_speed_ttl_ms) || defaultTtl();
  if (!ts || Date.now() - ts > ttl) return none('stale');
  const r = orderByPickSpeed(list, ms);
  if (!r.matched) return { ips: list, applied: false, reason: 'no-match', matched: 0, ts };
  return { ips: r.ips, applied: true, reason: 'ok', matched: r.matched, ts };
}

/**
 * 区分度自检：一批延迟是不是「全挤在一起」。
 *
 * 用途：浏览器在**代理状态下**测速时，所有 IP 的耗时都会趋同（因为走的都是
 * 「出口节点 → CF」那一段，跟用户无关）。这时候排序是假的，必须告诉用户，
 * 否则他会以为优选过了。判据：极差太小、或相对离散度太小。
 */
export function spread(values) {
  const vs = (Array.isArray(values) ? values : [])
    .map((v) => Number(v))
    .filter((v) => isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  if (vs.length < 3) return { ok: false, n: vs.length, range: 0, ratio: 0 };
  const lo = vs[0];
  const hi = vs[vs.length - 1];
  const range = hi - lo;
  const ratio = hi > 0 ? range / hi : 0;
  // 极差 <20ms 或 极差/最大 <10%：这次测量没有区分度
  return { ok: range >= 20 && ratio >= 0.1, n: vs.length, range, ratio, min: lo, max: hi };
}
