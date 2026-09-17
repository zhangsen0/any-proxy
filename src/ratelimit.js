/**
 * 限流与防滥用：按「来访者 + 时间窗」计数，超阈值就挡住，屡犯可临时封禁。
 *
 * 设计取舍（写在前面，免得后来的人猜）：
 *   1. 计数放在 isolate 内存里。Workers 的每次请求可能落在不同的 isolate，
 *      逐请求读写 D1/KV 会给全站加一次存储往返，代价远高于限流本身要防的东西。
 *      因此这里是「单实例级平滑限流」——能挡住脚本刷接口、撞登录口令这类集中流量，
 *      不承诺跨实例的精确配额。需要全局一致时把 window 放宽、阈值调大即可。
 *   2. 只有「封禁」落盘。封禁是低频、需要跨实例生效的决定，写进存储才有意义。
 *   3. 任何取值都来自配置，代码里不写死阈值、路径、白名单。
 */

import { readSection, writeSection, sanitize } from './config.js';
import { runtime } from './runtime.js';

/** 封禁记录的存储键前缀（与计数分离：计数在内存，封禁要跨实例） */
const BAN_PREFIX = 'rlban:';

/** 配置项声明。默认值全部是中性值，不含任何域名 / IP / 路径假设。 */
const SPEC = {
  enabled: { type: 'bool', default: false, env: 'RATELIMIT_ENABLED' },
  window_seconds: { type: 'int', default: 60, min: 5, max: 3600, env: 'RATELIMIT_WINDOW_SECONDS' },
  max_requests: { type: 'int', default: 120, min: 1, max: 100000, env: 'RATELIMIT_MAX_REQUESTS' },
  // ip：按来访者整体计数；ip_path：同一来访者打同一个路径才算一次（防的是刷某个接口）
  scope: {
    type: 'str',
    default: 'ip',
    maxLen: 16,
    env: 'RATELIMIT_SCOPE',
    validate: v => (['ip', 'ip_path'].includes(String(v).toLowerCase()) ? '' : 'scope 只能是 ip 或 ip_path'),
  },
  // 放行名单：每行一个 IP 或 CIDR，命中即完全不计数（自己的监控、健康检查等）
  whitelist: { type: 'str', default: '', maxLen: 4000, env: 'RATELIMIT_WHITELIST' },
  // 豁免路径：每行一个前缀，命中即不计数（登录接口要留给 Actions 自愈取 cookie）
  exempt_paths: { type: 'str', default: '', maxLen: 2000, env: 'RATELIMIT_EXEMPT_PATHS' },
  exempt_authed: { type: 'bool', default: true, env: 'RATELIMIT_EXEMPT_AUTHED' },
  // 屡犯封禁：一个窗口内被挡 ban_threshold 次，接下来 ban_seconds 秒直接拒绝
  ban_enabled: { type: 'bool', default: false, env: 'RATELIMIT_BAN_ENABLED' },
  ban_threshold: { type: 'int', default: 5, min: 1, max: 1000, env: 'RATELIMIT_BAN_THRESHOLD' },
  ban_seconds: { type: 'int', default: 600, min: 10, max: 86400, env: 'RATELIMIT_BAN_SECONDS' },
  message: { type: 'str', default: '请求过于频繁，请稍后再试', maxLen: 200, env: 'RATELIMIT_MESSAGE' },
};

// ===================== 内存计数 =====================

/** key -> { count, resetAt, blocked }；进程内有效，随 isolate 回收自然消失 */
const buckets = new Map();
/** 内存里的封禁快照，避免每个请求都读一次存储 */
const banCache = new Map();
const BAN_CACHE_TTL_MS = 10000;
let banCacheTs = 0;

/** 客户端 IP：CF 边缘注入的头最可靠，取不到就回落到空串（空串不参与限流，见 check） */
function clientIp(request) {
  const h = request && request.headers;
  if (!h) return '';
  return String(
    h.get('CF-Connecting-IP') || h.get('X-Forwarded-For') || h.get('X-Real-IP') || ''
  ).split(',')[0].trim();
}

/** 计数桶的键：按 scope 决定是否带上路径 */
function bucketKey(ip, path, scope) {
  const base = `v:${ip}`;
  return String(scope).toLowerCase() === 'ip_path' ? `${base}:${path}` : base;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// ===================== 放行名单 =====================

/** 解析「每行一个」的文本配置：IP 或 CIDR（仅 IPv4，够用且不引入依赖） */
export function parseList(raw) {
  return String(raw || '')
    .split(/[\n,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) + n;
  }
  return out >>> 0;
}

/** ip 是否落在 entry（IP 或 a.b.c.d/n）内 */
function matchEntry(ip, entry) {
  const target = ipv4ToInt(ip);
  if (target === null) return false;
  const [base, bitsRaw] = String(entry).split('/');
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (target & mask) === (baseInt & mask);
}

export function inWhitelist(ip, list) {
  if (!ip) return false;
  return (Array.isArray(list) ? list : parseList(list)).some(e => matchEntry(ip, e));
}

function pathExempt(path, list) {
  const prefixes = Array.isArray(list) ? list : parseList(list);
  return prefixes.some(p => path === p || path.startsWith(p));
}

// ===================== 封禁 =====================

async function banGet(ip) {
  if (!runtime.KV) return 0;
  const cached = banCache.get(ip);
  if (cached && Date.now() - cached.ts < BAN_CACHE_TTL_MS) return cached.until;
  let until = 0;
  try {
    const raw = await runtime.KV.get(BAN_PREFIX + ip);
    const rec = raw ? JSON.parse(raw) : null;
    if (rec && Number(rec.until) > nowSec()) until = Number(rec.until);
  } catch {}
  banCache.set(ip, { until, ts: Date.now() });
  return until;
}

async function banPut(ip, seconds) {
  if (!runtime.KV) return;
  const until = nowSec() + seconds;
  try {
    await runtime.KV.put(BAN_PREFIX + ip, JSON.stringify({ until, at: Date.now() }));
  } catch {}
  banCache.set(ip, { until, ts: Date.now() });
}

/** 列出当前生效的封禁（面板展示 / 自检核对用） */
export async function listBans() {
  if (!runtime.KV || typeof runtime.KV.list !== 'function') return [];
  const out = [];
  const now = nowSec();
  let cursor;
  do {
    let page;
    try {
      page = await runtime.KV.list({ prefix: BAN_PREFIX, limit: 500, ...(cursor ? { cursor } : {}) });
    } catch { break; }
    if (!page || !Array.isArray(page.keys)) break;
    for (const k of page.keys) {
      let rec = null;
      try { rec = JSON.parse(await runtime.KV.get(k.name)); } catch {}
      const until = rec ? Number(rec.until) : 0;
      if (until > now) out.push({ ip: k.name.slice(BAN_PREFIX.length), until, inSec: until - now });
    }
    cursor = page.cursor || page.list_complete === false ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/** 解除全部封禁（面板一键解封） */
export async function clearBans() {
  if (!runtime.KV || typeof runtime.KV.list !== 'function') return 0;
  let n = 0;
  let cursor;
  do {
    let page;
    try {
      page = await runtime.KV.list({ prefix: BAN_PREFIX, limit: 500, ...(cursor ? { cursor } : {}) });
    } catch { break; }
    if (!page || !Array.isArray(page.keys)) break;
    for (const k of page.keys) {
      try { await runtime.KV.delete(k.name); n++; } catch {}
      banCache.delete(k.name.slice(BAN_PREFIX.length));
    }
    cursor = page.cursor;
  } while (cursor);
  banCacheTs = 0;
  return n;
}

// ===================== 配置读写 =====================

export async function readLimitConfig(env) {
  return readSection(env, 'ratelimit', SPEC);
}

export async function saveLimitConfig(env, patch) {
  return writeSection(env, 'ratelimit', SPEC, patch);
}

export function safeLimitConfig(values) {
  return sanitize(SPEC, values);
}

// ===================== 判定入口 =====================

/**
 * 判定一次请求是否放行。
 * 返回 { allowed, reason, retryAfter, ip }：
 *   - reason: '' | 'banned' | 'limited'
 *   - retryAfter: 建议多少秒后重试（用于 Retry-After 头）
 * 未启用 / 拿不到 IP / 命中放行名单时一律放行 —— 限流只做减法，不制造新的故障。
 */
export async function check(env, request, opts = {}) {
  const cfg = await readLimitConfig(env);
  const empty = { allowed: true, reason: '', retryAfter: 0, ip: '', cfg };
  if (!cfg.enabled) return empty;

  const ip = clientIp(request);
  if (!ip) return empty;
  if (inWhitelist(ip, parseList(cfg.whitelist))) return { ...empty, ip };

  const url = new URL(request.url || 'https://./');
  const path = url.pathname || '/';
  if (pathExempt(path, parseList(cfg.exempt_paths))) return { ...empty, ip };
  if (cfg.exempt_authed && opts.authed) return { ...empty, ip };

  // 已封禁：直接拒绝，连计数都不做（否则封禁期内每次访问都会刷新封禁时长）
  const until = await banGet(ip);
  if (until > nowSec()) {
    return { allowed: false, reason: 'banned', retryAfter: until - nowSec(), ip, cfg };
  }

  const key = bucketKey(ip, path, cfg.scope);
  const now = Date.now();
  const winMs = cfg.window_seconds * 1000;
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + winMs, blocked: 0 };
    buckets.set(key, b);
  }
  b.count += 1;

  if (b.count > cfg.max_requests) {
    b.blocked += 1;
    const retry = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    // 屡犯封禁：达到阈值就落盘，让别的实例也一起挡
    let banned = false;
    if (cfg.ban_enabled && b.blocked >= cfg.ban_threshold) {
      await banPut(ip, cfg.ban_seconds);
      b.blocked = 0;
      banned = true;
    }
    return { allowed: false, reason: banned ? 'banned' : 'limited', retryAfter: banned ? cfg.ban_seconds : retry, ip, cfg };
  }
  return { allowed: true, reason: '', retryAfter: 0, ip, cfg };
}

/** 把一次「被挡」上报给调用方（计数已在 check 内完成，这里只用于自检与调试观察） */
export function snapshot() {
  const out = [];
  for (const [k, v] of buckets.entries()) out.push({ key: k, count: v.count, blocked: v.blocked });
  return out;
}

/** 清空内存计数（自检脚本用；生产环境无需调用，isolate 回收即失效） */
export function resetBuckets() {
  buckets.clear();
  banCache.clear();
  banCacheTs = 0;
}

export { SPEC as RATELIMIT_SPEC, clientIp };
