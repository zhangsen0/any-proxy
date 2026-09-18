// 访问统计：按天记录各访问通道的请求数、流量与来访者数量。
//
// 为什么不是「每请求写一次存储」：Workers 每个请求只有约 10ms CPU 预算，
// 逐请求做一次 KV/D1 读改写等于给每个代理请求加一次存储往返 —— 这是拿可用性换精度。
// 这里的做法是**内存聚合 + 后台批量落盘**：
//   请求路径上只往 Map 里加数字（纳秒级），攒到 flush_ms（默认 15s）或请求处理结束后
//   由 ctx.waitUntil 统一写入。代价是 isolate 被回收时最后一批计数会丢，
//   统计「趋势」不需要逐条精确，这个代价是划算的。
//
// 隐私：来访者以「IP + 安装级盐值」的哈希落盘，原始 IP 不出内存，服务端也反查不出来。
// 呼吸不了的维度（单个 bucket 的 uv）通过 uv_limit 截断，避免异常访问把存储撑爆。

import { runtime } from './runtime.js';
import { readSection, writeSection } from './config.js';
import { readSetting } from './settings.js';
import { isAdminScope } from './scopes.js';

const SECTION = 'stats';
const KEY_PREFIX = 'stat:';

/** 字段声明：默认值集中在这里，任何一条都能被环境变量或面板覆盖 */
const SPEC = {
  enabled: { type: 'bool', default: false, env: 'STATS_ENABLED' },
  retention_days: { type: 'int', default: 30, min: 1, max: 3650, env: 'STATS_RETENTION_DAYS' },
  flush_ms: { type: 'int', default: 15000, min: 1000, max: 120000, env: 'STATS_FLUSH_MS' },
  top_limit: { type: 'int', default: 10, min: 1, max: 100, env: 'STATS_TOP_LIMIT' },
  uv_limit: { type: 'int', default: 200, min: 10, max: 5000, env: 'STATS_UV_LIMIT' },
  track_visitors: { type: 'bool', default: true, env: 'STATS_TRACK_VISITORS' },
  record_admin: { type: 'bool', default: false, env: 'STATS_RECORD_ADMIN' },
};

/**
 * 可回看的天数档位。**单一来源**：面板的天数按钮、驾驶舱脚本的默认档位、
 * 服务端没拿到 days 参数时的回看天数，三处都从这里取。
 * 加一档「90 天」只在这里加一个数字，前后端都不用跟着改。
 */
export const STATS_RANGES = [7, 14, 30];
/** 默认档位：取第一档，避免「档位表改了、默认值还停在 7」 */
export const DEFAULT_RANGE_DAYS = STATS_RANGES[0];

async function visitorHash(ip, salt) { return await digest(`${salt}|${ip}`); }

/** 安装级盐值的存储键：用于区分来访者，同时保证原始 IP 无法被反查 */
const SALT_KEY = 'STATS_SALT';

// ===================== 内存缓冲 =====================

/** @type {Map<string, {hits:number, bytes:number, errors:number, aborts:number, mbytes:number, ips:Set<string>|null}>} */
const buffer = new Map();
let bufferBytesDirtyAt = 0;
let lastFlush = 0;
let lastPrune = 0;

function bucketDate(ts = Date.now()) {
  // 统一按 UTC 归档：isolate 分布在全球，按本地时区切分会出现多个半天错位的桶
  return new Date(ts).toISOString().slice(0, 10);
}

function storageKey(scope, date) {
  return `${KEY_PREFIX}${scope}:${date}`;
}

/** 存储桶的内容形状 —— 读写都走这里，避免两个分支写成两种格式
 *  - bytes   实际传输字节（由出口流的计数回填，不信任响应头 Content-Length）
 *  - aborts  传输中断次数：响应发出后客户端中途断开（播放器放弃 / 弱网断流）
 *  - mbytes  媒体流字节：视频/音频/分片（206、video/audio、带 Range 的请求）
 */
function emptyBucket() {
  return { hits: 0, bytes: 0, errors: 0, aborts: 0, mbytes: 0, uv: 0, ips: [], truncated: false };
}

// ===================== 对外：读取配置 =====================

export async function readStatsConfig(env) {
  return await readSection(env, SECTION, SPEC);
}

export async function saveStatsConfig(env, patch) {
  return await writeSection(env, SECTION, SPEC, patch);
}

export { SPEC as STATS_SPEC };

// ===================== 对外：记录一次访问 =====================

/**
 * 管理侧通道：面板与登录页自己的访问。它们只有开 record_admin 时才计入 ——
 * 否则「我自己看面板」会把访客统计搅浑（统计的用来看谁来用站点，不是用来看自己）。
 *
 * 判定口径不在这里：哪些通道算管理侧由 src/scopes.js 的登记表统一给出，
 * 免得这里再抄一份、加通道时两边不一致。
 */
export { isAdminScope };

/** 桶里的累加动作集中在这里：hits / bytes / errors / aborts / mbytes / 来访者都只有这一个入口 */
function bump(scope, delta) {
  const key = `${scope}|${bucketDate()}`;
  let item = buffer.get(key);
  if (!item) {
    item = { hits: 0, bytes: 0, errors: 0, aborts: 0, mbytes: 0, ips: null };
    buffer.set(key, item);
  }
  if (delta.hits) item.hits += delta.hits;
  if (delta.bytes) item.bytes += delta.bytes;
  if (delta.errors) item.errors += delta.errors;
  if (delta.aborts) item.aborts += delta.aborts;
  if (delta.mbytes) item.mbytes += delta.mbytes;
  if (delta.ip) {
    if (!item.ips) item.ips = new Set();
    // 上限内才继续收集：超过就不再膨胀，最终 uv 记为「≥上限」
    const limit = Number(delta.uvLimit) || 0;
    if (!limit || item.ips.size < limit) item.ips.add(delta.ip);
  }
  return item;
}

/** 统计开关 + 通道分档的统一闸门：不满足就直接不记账 */
function allowed(scope, cfg) {
  if (!cfg || !cfg.enabled) return false;
  return !(isAdminScope(scope) && !cfg.record_admin);
}

/**
 * 记录一次访问。设计约定：
 *   - 同步部分只做加法，绝不 await 存储 —— 调用方可以有 ctx 也可以没有（websocket 等场景）
 *   - ctx 存在时用 waitUntil 落盘；不存在（本地脚本 / 定时任务）就直接累计，等待下次机会
 *
 * @param {object} args
 * @param {string} args.scope   访问通道标识，如 p:<站点id> / edt / sub / admin
 * @param {Response|null} args.response  响应（用于取状态码；可为 null）
 * @param {string|null} args.ip  来源 IP（会被哈希后才落盘）
 * @param {object} [args.env]
 * @param {object} [args.ctx]
 *
 * ⚠️ 流量（bytes）**不在这里记**：响应头 Content-Length 是「声称的大小」，
 * 大文件请求一旦被客户端中途掐断，头里整片的大小会被当成实际流量（线上实测
 * 边缘只发了 0.5GB、日志却记了 20GB）。字节一律由调用方套在出口流上
 * 数**实际传输**的量，再走 recordBytes 回填。
 */
export function record({ scope, response, ip, env, ctx, failed }) {
  if (!scope) return;
  // 开关没打开时一次哈希都不做：配置都还没读过，这条路径也必须零成本
  schedulePersist(env, ctx, async () => {
    const cfg = await readStatsConfig(env);
    if (!allowed(scope, cfg)) return false;

    const status = response ? response.status : 0;
    bump(scope, {
      hits: 1,
      errors: failed || status >= 500 ? 1 : 0,
      ip: cfg.track_visitors && ip ? ip : '',
      uvLimit: cfg.uv_limit,
    });
    return true;
  });
  return;
}

/**
 * 只累加流量（含媒体分类与传输中断）。响应实际发了多少字节只有流发完才知道，
 * 所以由调用方在流结束时（或客户端中途断开时）回填，与 hits 分开记：
 * 万一流没结束，丢的只是字节数，请求数不会跟着丢。
 *
 * ⚠️ 这里刻意**不**接 ctx：字节数是在响应流发完之后才拿到的，那时请求已经结束，
 * 再调 ctx.waitUntil() 会被运行时直接丢掉（异常还被下面的 catch 吞掉），
 * 表现就是「请求数有、流量永远是 0」。所以调用方必须在请求还活着的时候就把
 * 「等流结束 → 记账」这条链登记进 waitUntil，这里只负责 await 完成。
 * 返回的 Promise 必须被调用方 await（否则 isolate 可能提前回收，落盘丢失）。
 *
 * @param {object} args
 * @param {string} args.scope
 * @param {number} args.bytes     实际传输字节（>0 才计）
 * @param {boolean} [args.media]  是否媒体流（video/audio/分片/Range）→ 计入 mbytes
 * @param {boolean} [args.aborted] 流未完整发完（客户端中途断开）→ 计入 aborts
 */
export async function recordBytes({ scope, bytes, env, media, aborted }) {
  const n = Number(bytes) || 0;
  if (!scope || (n <= 0 && !aborted)) return false;
  try {
    const cfg = await readStatsConfig(env);
    if (!allowed(scope, cfg)) return false;
    bump(scope, {
      bytes: n,
      mbytes: media ? n : 0,
      aborts: aborted ? 1 : 0,
    });
    const due = Date.now() - lastFlush >= (cfg.flush_ms || SPEC.flush_ms.default);
    if (due) await flush(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把需要 await 的动作挂到 waitUntil 上；没有 ctx 时退化为用户态异步任务。
 * 统计失败绝不能影响业务请求 —— 所有异常在这里就地吞掉。
 */
function schedulePersist(env, ctx, task) {
  const run = async () => {
    try {
      const wrote = await task();
      if (wrote !== true) return;
      const cfg = await readStatsConfig(env).catch(() => null);
      const due = !cfg || Date.now() - lastFlush >= (cfg.flush_ms || SPEC.flush_ms.default);
      if (due) await flush(env);
    } catch {}
  };
  if (ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(run()); } catch { /* 忽略：统计永不阻塞请求 */ }
  } else {
    // 没有 ctx（本地脚本 / 定时任务）：不 await，避免调用方被统计拖住
    try { Promise.resolve(run()).catch(() => {}); } catch {}
  }
}

// ===================== 落盘 =====================

/** 把内存里的计数合并进存储。整个函数是幂等的：合并用加法，重复执行只会累计要多级观察确认 */
export async function flush(env) {
  if (!buffer.size) return { keys: 0 };
  const cfg = await readStatsConfig(env);
  const snapshot = [...buffer.entries()];
  buffer.clear();
  lastFlush = Date.now();
  const salt = await getSalt(env);
  let written = 0;

  for (const [composite, item] of snapshot) {
    const sep = composite.lastIndexOf('|');
    const scope = composite.slice(0, sep);
    const date = composite.slice(sep + 1);
    const key = storageKey(scope, date);
    let bucket = emptyBucket();
    try {
      const raw = await runtime.KV.get(key);
      if (raw) bucket = { ...bucket, ...JSON.parse(raw) };
    } catch {}

    bucket.hits = Number(bucket.hits || 0) + item.hits;
    bucket.bytes = Number(bucket.bytes || 0) + item.bytes;
    bucket.errors = Number(bucket.errors || 0) + item.errors;
    bucket.aborts = Number(bucket.aborts || 0) + item.aborts;
    bucket.mbytes = Number(bucket.mbytes || 0) + item.mbytes;

    if (item.ips && item.ips.size) {
      const previous = Array.isArray(bucket.ips) ? bucket.ips : [];
      const merged = new Set(previous);
      for (const raw of item.ips) merged.add(await visitorHash(raw, salt));
      const limited = [...merged].slice(0, cfg.uv_limit || SPEC.uv_limit.default);
      // 截断标记：uv 是「至少这么多」，宁可少算也不让异常流量把记录撑成巨型 JSON
      bucket.truncated = merged.size > limited.length || !!bucket.truncated;
      bucket.ips = limited;
      bucket.uv = limited.length;
    }

    try {
      await runtime.KV.put(key, JSON.stringify(bucket));
      written++;
    } catch {
      // 写失败不能丢：把这条放回内存缓冲等下一次 flush 再试。原先 snapshot 已 clear，
      // 存储一抖动整段计数就静默蒸发 —— 线上表现为「日志的请求数 / 流量与边缘日志
      // 对不上」（并发一高，KV 批量写入偶发失败，丢的全是账）。
      const cur = buffer.get(composite) || { hits: 0, bytes: 0, errors: 0, aborts: 0, mbytes: 0, ips: null };
      cur.hits += item.hits;
      cur.bytes += item.bytes;
      cur.errors += item.errors;
      cur.aborts += item.aborts;
      cur.mbytes += item.mbytes;
      if (item.ips && item.ips.size) {
        if (!cur.ips) cur.ips = new Set();
        for (const raw of item.ips) cur.ips.add(raw);
      }
      buffer.set(composite, cur);
    }
  }

  await prune(env, cfg);
  return { keys: written };
}

/** 清理超过保留期的桶。按天粒度 + 一天最多清一次，避免每次落盘都全表扫描 */
async function prune(env, cfg) {
  const dayMs = 86400000;
  if (Date.now() - lastPrune < dayMs) return 0;
  lastPrune = Date.now();
  const keep = Math.max(1, Number(cfg.retention_days || SPEC.retention_days.default));
  const cutoff = bucketDate(Date.now() - keep * dayMs);
  let removed = 0;
  try {
    const page = await runtime.KV.list({ prefix: KEY_PREFIX, limit: 1000 });
    for (const k of page.keys || []) {
      const tail = k.name.slice(KEY_PREFIX.length);
      const date = tail.slice(tail.lastIndexOf(':') + 1);
      // 日期字典序即时间序：小于 cutoff 的就是超期的
      if (date && date < cutoff) {
        try { await runtime.KV.delete(k.name); removed++; } catch {}
      }
    }
  } catch {}
  return removed;
}

/** 安装级盐值：只生成一次，用于在不知道原始 IP 的前提下区分不同来访者 */
async function getSalt(env) {
  // 面板「配置中心 → 运维与隐私」可显式指定；未指定时用历史键里已生成的，
  // 都没有才生成一个新的 —— 生成后落盘，保证同一个安装的哈希口径长期稳定
  try {
    const fromPanel = String((await readSetting(env, 'stats_salt')) || '').trim();
    if (fromPanel) return fromPanel;
  } catch { /* 读配置失败就退回历史键，不让一次存储抖动把统计打停 */ }
  try {
    const saved = await runtime.KV.get(SALT_KEY);
    if (saved) return saved;
  } catch {}
  const generated = randomToken();
  try { await runtime.KV.put(SALT_KEY, generated); } catch {}
  return generated;
}

function randomToken() {
  const arr = new Uint8Array(16);
  try {
    crypto.getRandomValues(arr);
    return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

async function digest(text) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch {
    // digest 不可用的环境（极老 runtime）：退化成不可逆的弱哈希，仍不外泄原始 IP
    return Math.random().toString(36).slice(2, 10);
  }
}

// ===================== 对外：查询 =====================

/**
 * 汇总最近 N 天的数据。
 * 返回两条视角：按时间（每天总计）与按通道（累计最多的 top_limit 个）。
 */
export async function summarize(env, days) {
  const cfg = await readStatsConfig(env);
  const wanted = Math.min(Math.max(Number(days) || DEFAULT_RANGE_DAYS, 1), Number(cfg.retention_days || SPEC.retention_days.default));
  const since = bucketDate(Date.now() - (wanted - 1) * 86400000);

  let keys = [];
  try {
    const page = await runtime.KV.list({ prefix: KEY_PREFIX, limit: 1000 });
    keys = (page.keys || []).map(k => k.name);
  } catch {}

  const dates = new Set();
  const perScope = new Map();
  const daily = new Map();

  for (const name of keys) {
    const tail = name.slice(KEY_PREFIX.length);
    const sep = tail.lastIndexOf(':');
    const scope = tail.slice(0, sep);
    const date = tail.slice(sep + 1);
    if (date < since) continue;
    let bucket;
    try {
      const raw = await runtime.KV.get(name);
      if (!raw) continue;
      bucket = JSON.parse(raw);
    } catch { continue; }

    dates.add(date);
    const hits = Number(bucket.hits || 0);
    const bytes = Number(bucket.bytes || 0);
    const errors = Number(bucket.errors || 0);
    const aborts = Number(bucket.aborts || 0);
    const mbytes = Number(bucket.mbytes || 0);
    const uv = Number(bucket.uv || 0);

    const agg = perScope.get(scope) || { scope, hits: 0, bytes: 0, errors: 0, aborts: 0, mbytes: 0, uv: 0, days: [] };
    agg.hits += hits; agg.bytes += bytes; agg.errors += errors; agg.aborts += aborts; agg.mbytes += mbytes; agg.uv += uv;
    agg.days.push({ date, hits, bytes, errors, aborts, mbytes, uv });
    perScope.set(scope, agg);

    const day = daily.get(date) || { date, hits: 0, bytes: 0, errors: 0, aborts: 0, mbytes: 0 };
    day.hits += hits; day.bytes += bytes; day.errors += errors; day.aborts += aborts; day.mbytes += mbytes;
    daily.set(date, day);
  }

  const allScopes = [...perScope.values()];

  // 总量必须按「全部通道」求和，绝不能拿 top_limit 截断后的 series 去加：
  // 否则榜外通道的请求/流量/错误会被悄悄扣掉，出现「总流量 0 B 但趋势图里有柱子」
  // 这种自相矛盾的画面（趋势图读的是 daily，它不截断）。uv 同理，只是它本来就是上界。
  const totals = allScopes.reduce((a, s) => ({
    hits: a.hits + s.hits,
    bytes: a.bytes + s.bytes,
    errors: a.errors + s.errors,
    aborts: a.aborts + s.aborts,
    mbytes: a.mbytes + s.mbytes,
    // 跨通道去重做不到（不同通道的哈希集合互不相干），这里给出的是各通道 uv 之和的上界
    uv: a.uv + s.uv,
  }), { hits: 0, bytes: 0, errors: 0, aborts: 0, mbytes: 0, uv: 0 });

  const series = allScopes
    .slice()
    .sort((a, b) => b.hits - a.hits)
    .slice(0, Number(cfg.top_limit || SPEC.top_limit.default))
    .map(s => {
      // 每天的点必须补齐：没有记录的日期要显式是 0，否则折线图会把日期拉直
      s.days = [...dates].sort().map(d => {
        const found = s.days.find(x => x.date === d);
        return found || { date: d, hits: 0, bytes: 0, errors: 0, aborts: 0, mbytes: 0, uv: 0 };
      });
      return s;
    });

  const sortedDates = [...dates].sort();
  return {
    ok: true,
    enabled: cfg.enabled,
    days: wanted,
    retention_days: cfg.retention_days,
    top_limit: Number(cfg.top_limit || SPEC.top_limit.default),
    dates: sortedDates,
    daily: sortedDates.map(d => daily.get(d) || { date: d, hits: 0, bytes: 0, errors: 0, aborts: 0, mbytes: 0 }),
    series,
    totals,
  };
}

/** 清空全部统计数据（保留配置）。 jealousy: 面板上的「清空数据」按钮 */
export async function clearAll() {
  buffer.clear();
  let removed = 0;
  try {
    const page = await runtime.KV.list({ prefix: KEY_PREFIX, limit: 1000 });
    for (const k of page.keys || []) {
      try { await runtime.KV.delete(k.name); removed++; } catch {}
    }
  } catch {}
  return { removed };
}

export { SECTION as STATS_SECTION };
