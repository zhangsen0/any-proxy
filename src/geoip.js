// IP 归属国家查询：批量 HTTP 请求 + 永久缓存 + 零数据表。
//
// 「效率最高」体现在四个地方：
//   1. 批量：一次 POST 最多问 100 个 IP，而不是逐个问。80 个节点 = 1 次外部请求。
//   2. 缓存：结果写进 runtime.KV 长期保存，同一个 IP 第二次起零外部请求。
//       IP 归属几乎不变，没必要设短 TTL —— 这是这套设计里最大的一笔节省。
//   3. 查不到的也缓存（负缓存）：避免同一个 IP 每次订阅都要白区一轮。
//   4. 零数据表：中文国家名由平台 ICU 提供（Intl.DisplayNames），
//      国旗 emoji 由 ISO 3166-1 alpha-2 直接算出，两者都不需要内置映射表。
//
// 失败的代价被刻意压到最低：拿不到国家就原样返回，绝不让订阅拉不出来。

import { runtime } from './runtime.js';

// 默认数据源：HTTPS、免密钥、单次 POST 支持 100 个 IP，数据来自 MaxMind GeoLite2。
// 任何接受 JSON 数组并返回国家代码的批量端点都能替换，见 GEOIP_BATCH_URL。
const DEFAULT_BATCH_URL = 'https://api.country.is/';
const DEFAULT_BATCH_SIZE = 100;
const KEY_PREFIX = 'geoip:';
const NEGATIVE = '-';
const EMPTY = '';

const OFF_WORDS = ['0', 'false', 'no', 'off', 'none', 'disable', 'disabled'];
const ON_WORDS = ['1', 'true', 'yes', 'on', 'enable', 'enabled'];

/** 开关语义：明确写否才算关，其它（含未配置）都按默认值走。 */
function toggle(raw, dflt = true) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (!s) return dflt;
  if (OFF_WORDS.includes(s)) return false;
  if (ON_WORDS.includes(s)) return true;
  return dflt;
}

async function kvGet(key) {
  try { return await runtime.KV.get(key); } catch { return null; }
}

async function kvPut(key, value) {
  try { await runtime.KV.put(key, value); return true; } catch { return false; }
}

export function isIpv4(s) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(s))) return false;
  return String(s).split('.').every(o => Number(o) >= 0 && Number(o) <= 255);
}

/** ISO alpha-2 → 国旗 emoji。两个 regional indicator 直接算出来，不需要任何映射表。 */
export function flagEmoji(cc) {
  const s = String(cc || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) return EMPTY;
  return String.fromCodePoint(...[...s].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

let displayNames = null;
/** ISO alpha-2 → 中文地区名。由平台 ICU 提供，查不到就退回代号本身。 */
export function regionName(cc) {
  const code = String(cc || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return EMPTY;
  try {
    if (!displayNames) displayNames = new Intl.DisplayNames(['zh-Hans'], { type: 'region' });
    return displayNames.of(code) || code;
  } catch {
    return code;
  }
}

/** 是否给节点备注补国家：KV（面板）→ 环境变量 → 默认开启。 */
export async function enabled(env) {
  const kv = await kvGet('NODE_COUNTRY_TAG');
  if (kv !== null && kv !== undefined && String(kv).trim() !== '') return toggle(kv, true);
  const raw = env && (env.NODE_COUNTRY_TAG || env.node_country_tag);
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') return toggle(raw, true);
  return true;
}

const KEY_ON = 'NODE_COUNTRY_TAG';
const KEY_STYLE = 'NODE_COUNTRY_STYLE';
// 备注后缀的默认样式：中文名 + ISO 代号，例如 英国【GB】
const STYLE_DEFAULT = 'cn-code';

/** 备注后缀样式的默认值，由这里单点定义，nodetag 与面板都从这里取。 */
export { STYLE_DEFAULT };

/** 读取「是否标注国家」+「标注样式」：KV（面板）→ 环境变量 → 默认值。 */
export async function readTagSettings(env) {
  const kvOn = await kvGet(KEY_ON);
  const kvStyle = await kvGet(KEY_STYLE);
  const envOn = env && (env.NODE_COUNTRY_TAG || env.node_country_tag);
  const envStyle = env && (env.NODE_COUNTRY_STYLE || env.node_country_style);
  const onRaw = kvOn !== null && kvOn !== undefined && String(kvOn).trim() !== '' ? kvOn : envOn;
  const styleRaw = kvStyle !== null && kvStyle !== undefined && String(kvStyle).trim() !== '' ? kvStyle : envStyle;
  const style = String(styleRaw || '').trim().toLowerCase();
  return {
    enabled: toggle(onRaw, true),
    style: style || STYLE_DEFAULT,
    sourceOn: String(kvOn || '').trim() ? 'kv' : (String(envOn || '').trim() ? 'env' : 'default'),
    sourceStyle: String(kvStyle || '').trim() ? 'kv' : (String(envStyle || '').trim() ? 'env' : 'default'),
  };
}

/** 保存面板里的设置。enabled / style 都允许显式写回，空串表示回到默认。 */
export async function saveTagSettings(patch = {}) {
  if (patch.enabled !== undefined) await kvPut(KEY_ON, patch.enabled === true ? 'true' : 'false');
  if (patch.style !== undefined) await kvPut(KEY_STYLE, String(patch.style).trim().toLowerCase());
  return await readTagSettings(patch.env);
}

function batchSize(env) {
  const n = Number(env && (env.GEOIP_BATCH_SIZE || env.geoip_batch_size));
  return Number.isInteger(n) && n > 0 ? Math.min(n, DEFAULT_BATCH_SIZE) : DEFAULT_BATCH_SIZE;
}

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function writeThrough(ip, cc, ctx) {
  const p = kvPut(KEY_PREFIX + ip, cc || NEGATIVE).catch(() => false);
  // 有 ctx 就把写缓存甩到响应之后，不让存储往返拖慢订阅返回；
  // 没有 ctx（本地预览 / 单测）则让它自然跑完，保证结果可读。
  if (ctx && typeof ctx.waitUntil === 'function') return ctx.waitUntil(p);
  return p;
}

/** 一次批量询问。返回 [{ip, cc}]，拿不到就抛出交给调用方降级。 */
async function queryBatch(batch, env, opts) {
  const url = String((env && (env.GEOIP_BATCH_URL || env.geoip_batch_url)) || DEFAULT_BATCH_URL).trim();
  if (!url) return [];
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(batch),
    signal: opts.signal || AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  // 兼容数组直接返回，也兼容 {result:[...]} / {data:[...]} 这类包装
  const arr = Array.isArray(j) ? j
    : Array.isArray(j && j.result) ? j.result
    : Array.isArray(j && j.data) ? j.data
    : [];
  const rows = [];
  for (const row of arr) {
    if (!row) continue;
    const ip = String(row.ip || row.query || row.address || '').trim();
    const cc = String(row.country || row.countryCode || row.country_code || row.iso_code || '').trim().toUpperCase();
    if (isIpv4(ip) && /^[A-Z]{2}$/.test(cc)) rows.push({ ip, cc });
  }
  return rows;
}

/**
 * 查一组 IP 的归属国家。
 * @returns {Map<string, {cc:string, cn:string, flag:string}>} 查不到的不在 Map 里
 */
export async function lookupCountries(ips, opts = {}) {
  const env = opts.env || {};
  const out = new Map();
  const list = [...new Set((Array.isArray(ips) ? ips : [ips])
    .map(s => String(s).trim())
    .filter(isIpv4))];
  if (!list.length) return out;

  // 1) 先吃缓存：命中就不再产生任何外部请求
  const missing = [];
  await Promise.all(list.map(async ip => {
    const hit = await kvGet(KEY_PREFIX + ip);
    if (hit === NEGATIVE) return;              // 已知查不到，别再问第二次
    if (hit && /^[A-Z]{2}$/.test(String(hit).toUpperCase())) {
      const cc = String(hit).toUpperCase();
      out.set(ip, { cc, cn: regionName(cc), flag: flagEmoji(cc) });
      return;
    }
    missing.push(ip);
  }));
  if (!missing.length) return out;

  // 2) 未命中的分批问。任一批失败只影响这一批，其余照常返回。
  const size = batchSize(env);
  for (const batch of chunks(missing, size)) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    try {
      const rows = await queryBatch(batch, env, opts);
      for (const row of rows) {
        out.set(row.ip, { cc: row.cc, cn: regionName(row.cc), flag: flagEmoji(row.cc) });
        writeThrough(row.ip, row.cc, opts.ctx);
      }
      // 批里有问没答的（数据源缺数据）也标记为已查，避免每次订阅都重试
      const answered = new Set(rows.map(r => r.ip));
      for (const ip of batch) if (!answered.has(ip)) writeThrough(ip, EMPTY, opts.ctx);
    } catch {
      // 数据源不可用：本批留空，节点原样输出。订阅本身必须还能拉到。
    }
  }
  return out;
}

export {
  KEY_PREFIX, NEGATIVE, toggle,
  DEFAULT_BATCH_URL, DEFAULT_BATCH_SIZE,
};
