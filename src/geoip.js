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

import { runtime, onConfigChange } from './runtime.js';
import { toBool } from './config.js';
import { isIpv4 } from './util.js';
import { SETTINGS_SPEC, readSettings, settingsSource } from './settings.js';

// 默认数据源：HTTPS、免密钥、单次 POST 支持 100 个 IP，数据来自 MaxMind GeoLite2。
// 任何接受 JSON 数组并返回国家代码的批量端点都能替换 —— 默认值登记在 settings.js 的 SPEC，
// 面板「配置中心 → 边缘段与外部数据源」可改，改完下一个订阅请求即生效。
const DEFAULT_BATCH_URL = SETTINGS_SPEC.geoip_batch_url.default;
const DEFAULT_BATCH_SIZE = SETTINGS_SPEC.geoip_batch_size.default;
const KEY_PREFIX = 'geoip:';
const NEGATIVE = '-';
const EMPTY = '';

// —— CDN / 任播 IP 兜底 ——
//
// CDN 任播 IP 在全球边缘通告同一个地址，本来就不存在「单一国家归属」，
// GeoIP 数据库对这类 IP 普遍缺数据：实测主源对 CF 官方段内的节点只能覆盖约 1/4。
// 缺数据时不编造国名，而是命中官方 IP 段就如实标成任播——用户看到的信息反而更准。
//
// 官方段列表由 CDN 厂商自己公开维护，一次拉取后长期缓存；
// 之后每个 IP 的判定是纯内存的整数区间比较，零外部请求。
const CF_NETS_URL = SETTINGS_SPEC.cf_nets_url.default;
const CF_NETS_KEY = KEY_PREFIX + 'cfnets';
// 任播伪代号：故意用连字符，保证永远不会和任何 ISO 3166-1 alpha-2 撞车。
// 不能用 'CF' —— 那是中非共和国的真实国家代码。
export const ANYCAST = '--';
// 给备注用的展示名。geoip 模块不碰文案，由 nodetag 决定怎么排版。
export const ANYCAST_LABEL = 'Cloudflare 任播';
export const ANYCAST_CODE = 'ANYCAST';

/**
 * 开关语义统一走 config.js 的 toBool（"明确写否才算关，其它按默认值走"）。
 * 这里原先自带一份 ON/OFF 词表，和面板那份不一致 —— 于是 `none` 在环境变量里能关掉、
 * 在面板里却被当成没配。词表只能有一份，所以删掉本地的，改为引用。
 */
function toggle(raw, dflt = true) {
  return toBool(raw, dflt);
}

async function kvGet(key) {
  try { return await runtime.KV.get(key); } catch { return null; }
}

async function kvPut(key, value) {
  try { await runtime.KV.put(key, value); return true; } catch { return false; }
}

/**
 * IPv4 判定改为引用 util.js 的唯一实现（本文件原本自带一份同样的正则）。
 * 仍然从这里再导出，是因为 nodetag.js 一直从本模块借它，不必为一次收敛改动调用方。
 */
export { isIpv4 };

/** IPv4 → 32 位无符号整数。整数比较比逐段字符串处理快得多，也更省 GC。 */
export function ipToInt(ip) {
  if (!isIpv4(ip)) return NaN;
  const p = String(ip).split('.');
  return (((+p[0] << 24) >>> 0) + ((+p[1] << 16) >>> 0) + ((+p[2] << 8) >>> 0) + (+p[3] >>> 0)) >>> 0;
}

/** '1.2.3.0/24' → [起始整数, 结束整数]。解析不出来返回 null。 */
export function parseCidr(cidr) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(cidr).trim());
  if (!m || !isIpv4(m[1])) return null;
  const bits = Number(m[2]);
  if (!(bits >= 0 && bits <= 32) || String(bits) !== m[2]) return null;
  const base = ipToInt(m[1]);
  if (bits === 0) return [0, 0xffffffff];
  const size = 1 << (32 - bits);
  return [base, base + size - 1];
}

/** IP 是否落在任一 CIDR 区间内。纯 CPU，无外部请求。 */
export function isCfIp(ip, nets) {
  if (!nets || !nets.length || !isIpv4(ip)) return false;
  const n = ipToInt(ip);
  for (const range of nets) if (n >= range[0] && n <= range[1]) return true;
  return false;
}

/**
 * 任播兜底的开关。默认开启，运行参数（面板）/环境变量显式写否才关。
 * 取值统一走 settings.js —— 原先只认环境变量，改一次要重新部署。
 */
export async function anycastEnabled(env) {
  const cfg = await readGeoipSettings(env);
  return toggle(cfg.node_country_anycast, true);
}

/** 本模块用到的运行参数：读一次复用，避免国家查询链路里重复读存储 */
async function readGeoipSettings(env) {
  try {
    return await readSettings(env);
  } catch {
    return {};
  }
}

let cfNets = null;
// 官方段是进程内快照，配置一改（换数据源 / 关掉兜底）必须丢掉，否则「保存了却还是老行为」
onConfigChange(() => { cfNets = null; });

/**
 * 取 Cloudflare 官方 IPv4 段。KV 缓存优先，拉不到就用上一次的结果；
 * 什么都拿不到时返回空数组——退化为「不做任播兜底」，节点照旧输出。
 */
export async function loadCfNets(env, ctx) {
  if (cfNets) return cfNets;
  const parse = text => String(text || '').split('\n').map(parseCidr).filter(Boolean);
  try {
    const cached = await kvGet(CF_NETS_KEY);
    const nets = parse(cached);
    if (nets.length) { cfNets = nets; return nets; }
  } catch { /* 读缓存失败不致命，继续走网络 */ }
  if (!(await anycastEnabled(env))) { cfNets = []; return cfNets; }
  const cfg = await readGeoipSettings(env);
  try {
    const r = await fetch(String(cfg.cf_nets_url || CF_NETS_URL).trim(), {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    // 存原始文本：读出来时走的是同一个 parseCidr，格式必须保持一致。
    const lines = String(text).split('\n').map(s => s.trim()).filter(Boolean);
    const nets = lines.map(parseCidr).filter(Boolean);
    if (nets.length) {
      cfNets = nets;
      const saved = kvPut(CF_NETS_KEY, lines.join('\n')).catch(() => false);
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(saved);
      return nets;
    }
  } catch { /* 拿不到官方段就跳过兜底，不影响订阅本身 */ }
  cfNets = [];
  return cfNets;
}

/** 单测用：清掉进程内缓存，让下一次 loadCfNets 重新走 KV / 网络。 */
export function resetCfNets() { cfNets = null; }

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

/** 是否给节点备注补国家。取值统一走注册表：面板（独立 KV 键）→ 环境变量 → 默认开启。 */
export async function enabled(env) {
  const cfg = await readSettings(env);
  return cfg.node_tag_enabled !== false;
}

// 备注后缀的默认样式：中文名 + ISO 代号，例如 英国【GB】。
// 真源在注册表（node_tag_style），这里取出来给 nodetag 复用 —— 样式词表只允许有一份。
const STYLE_DEFAULT = SETTINGS_SPEC.node_tag_style.default;

/** 备注后缀样式的默认值，由注册表单点定义，nodetag 与面板都从这里取。 */
export { STYLE_DEFAULT };

/**
 * 读取「是否标注国家」+「标注样式」。
 *
 * 这里刻意不再自己解析一遍：这两个字段已经是注册表里的成员（store: 'kv'，
 * 独立 KV 键由注册表读写），来源标注也用注册表的归因。曾经这里有一份
 * 「KV → 环境变量 → 默认」的实现，nodetag 那边还有一份「只认环境变量」的
 * —— 于是就出现了「面板改了样式、订阅输出没变」。
 */
export async function readTagSettings(env) {
  const cfg = await readSettings(env);
  return {
    enabled: cfg.node_tag_enabled !== false,
    style: String(cfg.node_tag_style || '').trim().toLowerCase() || STYLE_DEFAULT,
    sourceOn: await settingsSource(env, 'node_tag_enabled'),
    sourceStyle: await settingsSource(env, 'node_tag_style'),
  };
}

/**
 * 保存面板里的设置 —— 已并入统一运行参数，不再单独提供入口。
 *
 * 原先这里有一个 `saveTagSettings({enabled, style})`：它把面板的 {enabled, style} 翻译成
 * 注册表字段名再写 KV。现在接口直接收注册表字段名（node_tag_enabled / node_tag_style），
 * 翻译层本身就是「同一件事的第二份定义」，删掉它才谈得上单一真源。
 */

/** 单次批量查询的条数上限：运行参数（面板）优先，环境变量作种子，默认值在 SPEC 里 */
async function batchSize(env) {
  const cfg = await readGeoipSettings(env);
  const n = Number(cfg.geoip_batch_size);
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
  const cfg = await readGeoipSettings(env);
  const url = String(cfg.geoip_batch_url || DEFAULT_BATCH_URL).trim();
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
    if (hit === ANYCAST) {                     // 已知是 CDN 任播段
      out.set(ip, { cc: ANYCAST, cn: ANYCAST_LABEL, flag: EMPTY, anycast: true });
      return;
    }
    if (hit && /^[A-Z]{2}$/.test(String(hit).toUpperCase())) {
      const cc = String(hit).toUpperCase();
      out.set(ip, { cc, cn: regionName(cc), flag: flagEmoji(cc) });
      return;
    }
    missing.push(ip);
  }));
  if (!missing.length) return out;

  // 2) 未命中的分批问。任一批失败只影响这一批，其余照常返回。
  const size = await batchSize(env);
  const useAnycast = await anycastEnabled(env);
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
      const unknown = batch.filter(ip => !answered.has(ip));
      // 缺数据的一部分其实是 CDN 任播 IP：它们没有单一国家归属，
      // 与其附上一条随时可能错的国名，不如命中官方段就如实标成任播。
      const nets = (useAnycast && unknown.length) ? await loadCfNets(env, opts.ctx) : [];
      for (const ip of unknown) {
        if (isCfIp(ip, nets)) {
          out.set(ip, { cc: ANYCAST, cn: ANYCAST_LABEL, flag: EMPTY, anycast: true });
          writeThrough(ip, ANYCAST, opts.ctx);
        } else {
          writeThrough(ip, EMPTY, opts.ctx);
        }
      }
    } catch {
      // 数据源不可用：本批留空，节点原样输出。订阅本身必须还能拉到。
    }
  }
  return out;
}

export {
  KEY_PREFIX, NEGATIVE, EMPTY, toggle,
  DEFAULT_BATCH_URL, DEFAULT_BATCH_SIZE,
  CF_NETS_KEY, CF_NETS_URL,
};
