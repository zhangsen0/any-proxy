/**
 * 订阅出口：把节点按**实测延迟**重排，让「多快」真正落到客户端拿到的顺序上。
 *
 * 为什么放在出口而不是去改 vendor/vless.js：节点由引擎生成，我们在它吐出来之后
 * 做增强 —— 上游升级不冲突，开关一关就是原样透传（与 nodetag.js 同一套取舍）。
 *
 * 为什么这件事值得做：客户端（v2rayN / Clash / sing-box）通常**拿订阅里第一个节点用**，
 * 而上游订阅的顺序是「别人推过来的顺序」，跟快慢毫无关系。于是 `latency.js` 测出来的
 * 快慢如果不作用到这里的顺序上，用户拿到的还是「恰好排第一」的那一个 ——
 * 延迟实测就只是个能看的数字，不是速度。
 *
 * 三条硬约束（与 nodetag.js 一致）：
 *   1. 进出编码形态必须一致：拉到整份 base64 就仍然返回 base64。
 *   2. 任何一步异常都退回原文。订阅是整个服务的入口，为了排个序把它搞挂，
 *      代价远大于收益。
 *   3. 不能把请求拖过头：测量走 `latency_budget_ms` 预算，超了就按已测到的排。
 *
 * 缓存：测量结果按 TTL（`sub_latency_ttl_ms`）存在 KV 里，多个客户端共享。
 * 缓存期内拉订阅**一次探测都不发**，所以「多花几秒」只在缓存过期后那一次发生。
 * 不通的 IP 也记下来（值为 null），否则每次都要把不可达地址重测到超时。
 */

import { decodeWhole, encodeWhole, NODE_RE, lineHost, MAX_SUB_BYTES } from './nodetag.js';
import { isIpv4 } from './geoip.js';
import { runtime } from './runtime.js';
import { readSettings, SETTINGS_SPEC } from './settings.js';
import { probeLatency } from './dns.js';

/** 等到 deadline 之后resolve成 null。Promise.race 用它给任意一步套闸门。 */
function budgetGuard(deadlineMs) {
  const left = Math.max(0, deadlineMs - Date.now());
  return new Promise((resolve) => { setTimeout(() => resolve(null), left); });
}

/**
 * 给订阅里的缺失 IP 补测一轮，受 deadline 保护。
 *
 * 为什么闸门要落在这里而不是只放在 router 层：router 的 `Promise.race` 只能掐断
 * 「整个订阅请求」，而这里是真正会干等的地方 —— 测量函数再慢，也必须到点就走，
 * 剩下没收到的 IP 留到下一轮（缓存会一轮轮补齐）。少一次防护，单测直接调本函数
 * 就没有任何预算可言，真实链路里也只能靠上层兜底，属于「检查覆盖了但没人受保护」。
 *
 * @returns {Promise<object|null>} null = 预算到了 / 测量失败，按「没测过」处理
 */
async function measureWithBudget(targets, opts) {
  const run = opts.measure || ((t, o) => probeLatency(t, { host: opts.host, ...o }));
  const call = run(targets, {
    env: opts.env,
    host: opts.host,
    // 预算与墙钟都往下传：两步增强共用一份总预算，不能各用各的
    deadlineMs: opts.deadlineMs,
    budgetMs: opts.deadlineMs ? Math.max(500, opts.deadlineMs - Date.now()) : undefined,
  });
  try {
    return await Promise.race([call, budgetGuard(opts.deadlineMs)]);
  } catch {
    return null;   // 测量整段失败：按「没测过」处理，顺序保持原样
  }
}

const CACHE_KEY = 'LATENCY_CACHE';

/** 读缓存。任何异常都当作「没有缓存」—— 重测一遍只是慢，读坏了才是事故。 */
async function readCache() {
  try {
    if (!runtime.KV || typeof runtime.KV.get !== 'function') return null;
    const raw = await runtime.KV.get(CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || !o.ms) return null;
    return { ts: Number(o.ts) || 0, ms: o.ms };
  } catch {
    return null;
  }
}

/** 写缓存。写不进去不影响本次结果（下次重测就是了），所以静默。 */
async function writeCache(ms) {
  try {
    if (!runtime.KV || typeof runtime.KV.put !== 'function') return false;
    await runtime.KV.put(CACHE_KEY, JSON.stringify({ ts: Date.now(), ms }));
    return true;
  } catch {
    return false;
  }
}

/**
 * 给每个 IP 定一个排序档位，档位内保持原顺序（稳定排序）。
 *
 * 0 = 实测通过（档内按毫秒升序）→ 1 = 没测过（未知，别乱动）→ 2 = 实测不通。
 * 「没测过」排在「测过但不通」前面：前者可能还是好的，后者已经确认不行。
 */
function rankOf(ms) {
  if (typeof ms === 'number') return [0, ms];
  if (ms === null) return [2, 0];
  return [1, 0];
}

/**
 * 按实测延迟重排订阅文本里的节点行。
 *
 * @param {string} text 订阅原文（明文或整份 base64）
 * @param {object} opts
 *   - env 环境（读配置 / 缓存）
 *   - host 探测时用的目标域名（Host 头），空则跳过测量
 *   - measure 注入的测量函数，单测用（默认走 dns.js 的 probeLatency）
 * @returns {{text:string, nodes:number, ranked:number, skipped:string, stats:object}}
 */
export async function reorderByLatency(text, opts = {}) {
  const empty = { text: String(text || ''), nodes: 0, ranked: 0, skipped: 'empty', stats: {} };
  const { body, encoded } = decodeWhole(text);
  if (!body.trim()) return empty;
  if (body.length > MAX_SUB_BYTES) return { ...empty, skipped: 'too-large' };

  const lines = body.split(/\r?\n/);
  const pos = [];
  lines.forEach((l, i) => { if (l.trim() && NODE_RE.test(l.trim())) pos.push(i); });
  if (pos.length < 2) return { ...empty, nodes: pos.length, skipped: 'too-few' };

  const hostOf = (i) => lineHost(lines[i].trim());
  const ips = [...new Set(pos.map(hostOf).filter(isIpv4))];
  if (!ips.length) return { ...empty, nodes: pos.length, skipped: 'no-ipv4' };

  const cfg = await readSettings(opts.env || {});
  const ttl = Number(cfg.sub_latency_ttl_ms) || SETTINGS_SPEC.sub_latency_ttl_ms.default;
  const host = String(opts.host || (opts.env && (opts.env.PROXY_HOST || opts.env.proxy_host)) || '').trim();
  if (!host) return { ...empty, nodes: pos.length, skipped: 'no-host' };

  let known = {};
  let cached = false;
  const cache = await readCache();
  if (cache && Date.now() - cache.ts < ttl) {
    known = { ...cache.ms };
    cached = true;
  }

  const missing = ips.filter((ip) => !(ip in known));
  // 一轮最多新测这么多个：订阅里可能有 79 个 IP（见过真实case），一轮全测必然吃满预算、
  // 而且预算耗尽后剩下的仍是「没测过」，下次又来一轮 —— 于是每次拉订阅都在重测。
  // 限量之后每轮只补一小批，缓存几轮就补齐了；单次耗时也因此可控。
  const maxProbe = Number(cfg.sub_latency_max_probe) || SETTINGS_SPEC.sub_latency_max_probe.default;
  const toProbe = missing.length > maxProbe ? missing.slice(0, maxProbe) : missing;
  let measured = null;
  if (toProbe.length) {
    // 预算已经见底就别开新一轮了：跑也跑不完，只会把订阅请求拖到被平台杀掉
    if (opts.deadlineMs && opts.deadlineMs - Date.now() <= 0) {
      await writeCache(known);
      return { ...empty, nodes: pos.length, skipped: 'budget', text: encodeWhole(body, encoded) };
    }
    measured = await measureWithBudget(toProbe, opts);
    if (measured && Array.isArray(measured.items)) {
      for (const it of measured.items) {
        // 通的记毫秒，不通的记 null —— null 也要记，否则每次都重测到超时
        if (it && it.target) known[it.target] = (it.ok && typeof it.ms === 'number') ? it.ms : null;
      }
    }
    // 预算耗尽、没收到的 IP 留在「没测过」档（不加 null），下次缓存写入时再补
    await writeCache(known);
  }

  const rank = (i) => rankOf(known[hostOf(i)]);
  const order = pos.slice().sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra[0] !== rb[0]) return ra[0] - rb[0];
    if (ra[0] === 0 && ra[1] !== rb[1]) return ra[1] - rb[1];
    return a - b;   // 同档位（或同毫秒）保持上游原顺序，不做无谓的抖动
  });

  const out = lines.slice();
  pos.slice().sort((a, b) => a - b).forEach((p, k) => { out[p] = lines[order[k]]; });

  const ranked = pos.filter((i) => typeof known[hostOf(i)] === 'number').length;
  return {
    text: encodeWhole(out.join('\n'), encoded),
    nodes: pos.length,
    ranked,
    skipped: '',
    stats: {
      cached,
      measured: toProbe.length,
      ranked,
      bad: pos.filter((i) => known[hostOf(i)] === null).length,
      fastest: (() => {
        const vals = pos.map((i) => known[hostOf(i)]).filter((v) => typeof v === 'number');
        return vals.length ? Math.min(...vals) : null;
      })(),
    },
  };
}

/**
 * 订阅响应出口：开关开着就按延迟重排，否则原样透传。
 * 与 tagSubscriptionResponse 同理——body 一旦读过就必须自己重建响应。
 */
export async function sortSubscriptionResponse(resp, opts = {}) {
  let original = null;
  try {
    if (!resp || resp.status !== 200) return resp;
    const ct = resp.headers.get('content-type') || '';
    if (!ct || !/(text|json)/i.test(ct)) return resp;

    const cfg = await readSettings(opts.env || {});
    if (cfg.sub_latency_sort === false) return resp;

    original = await resp.text();
    if (!original) return rebuild(resp, original);
    if (original.length > MAX_SUB_BYTES) return rebuild(resp, original);

    const r = await reorderByLatency(original, opts);
    if (!r.ranked) return rebuild(resp, original);   // 一个都没测出来就别动顺序

    return rebuild(resp, r.text);
  } catch {
    return original !== null ? rebuild(resp, original) : resp;
  }
}

/** 按原文重建等价响应：body 已解压为明文，必须清掉压缩头与旧长度。 */
function rebuild(resp, text) {
  try {
    const h = new Headers(resp.headers);
    h.delete('content-encoding');
    h.delete('content-length');
    return new Response(text, { status: 200, headers: h });
  } catch {
    return resp;
  }
}
