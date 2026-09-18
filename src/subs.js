// 订阅 & 候选 IP 的通用能力：订阅地址解析、节点抽取、边缘段判定、候选域名解析。
//
// 设计约束（重要）：本文件**不写死任何业务域名 / IP / IP 段**。
// 一切取值按「面板配置 → 环境变量 → 规范默认值」三级查找（统一由 settings.js 给出）；
// 取不到时降级为「不判定 / 明确报错」，而不是退回到硬编码常量——否则 fork 后自定义部署
// 必然静默地操作到别人的域名上。
// 远端数据源地址也不再写死在这里：默认值登记在 settings.js 的 SPEC 里，面板可改、改完即生效。

import { runtime } from './runtime.js';
import { b64, isIpv4, isDomain, md5Hex, md5md5 } from './util.js';
import { SETTINGS_SPEC, readSettings, nodeIdentity } from './settings.js';

// 远端边缘 IP 段数据源 / 公共 DNS / 缓存时长的默认值：真源在 settings.js 的 SPEC，
// 这里只取出来复用，避免同一个默认值在两处各写一份（AGENTS 第 1 节）。
const DEFAULT_RANGES_URL = SETTINGS_SPEC.cf_ip_ranges_url.default;
const DEFAULT_DOH_URL = SETTINGS_SPEC.doh_url.default;

/**
 * 一次「拉取优选候选」最多返回多少个 IP 的**默认值**。
 * 具名导出：面板侧（admin.js）调用时也要用同一个默认值，免得两处各写一个 40。
 * 实际取值走 settings 的 candidate_limit（面板可改、实时生效）。
 */
const CANDIDATE_LIMIT = SETTINGS_SPEC.candidate_limit.default;

async function kvGet(key) {
  try {
    return await runtime.KV.get(key);
  } catch {
    return null;
  }
}

async function kvPut(key, value) {
  try {
    await runtime.KV.put(key, value);
    return true;
  } catch {
    return false;
  }
}

// MD5 摘要与 MD5MD5 口径统一由 util.js 提供（全项目只有一份实现，含 tempsubs 的 token 推导），
// 这里只做转发，保留历史导出名，避免调用方为了一个工具函数改动 import 路径。
// 见 util.js 的 md5md5 注释：两份实现分叉过会表现为「临时订阅 404、主订阅正常」。


// IPv4 判定与列表解析统一由 util.js 提供（面板与运行时必须同一口径），这里只做转发，
// 保留历史导出名，避免调用方为了一个工具函数改动 import 路径。
// 见 util.js「列表型配置的解析」一节。
function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function cidrMatch(ip, cidr) {
  const [base, bitsRaw] = String(cidr).trim().split('/');
  const ipn = ipv4ToInt(ip);
  const bn = ipv4ToInt(base);
  if (ipn === null || bn === null) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipn & mask) === (bn & mask);
}

function parseCidrList(text) {
  return String(text || '')
    .split(/\r?\n|,|;|\s+/)
    .map(s => s.trim())
    .filter(s => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s));
}

/**
 * 边缘 IP 段：用于把「订阅里混进来的第三方节点」挡在优选池之外。
 * 优先级：手工段（面板）→ 远端数据源（地址面板可配）→ 缓存 → null（表示无法判定，调用方应不过滤）。
 * 刻意不内置任何写死的 IP 段。
 */
async function cloudflareRanges(env, opts = {}) {
  const cfg = await readSettings(env);
  const manual = parseCidrList(cfg.cf_ip_ranges);
  if (manual.length) return { cidrs: manual, source: 'panel' };

  const cached = await kvGet('CF_RANGES_CACHE');
  const cachedTs = Number(await kvGet('CF_RANGES_TS')) || 0;
  if (cached && Date.now() - cachedTs < cfg.ranges_ttl_ms) {
    const cidrs = parseCidrList(cached);
    if (cidrs.length) return { cidrs, source: 'cache' };
  }

  const url = String(cfg.cf_ip_ranges_url || DEFAULT_RANGES_URL).trim();
  if (!url) return null;
  try {
    const r = await fetch(url, { signal: (opts.signal || AbortSignal.timeout(6000)) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const list = await r.json();
    const cidrs = parseCidrListStringArray(
      (list && list.result && list.result.ipv4_cidrs) ||
      (list && list.ipv4_cidrs) ||
      (Array.isArray(list) ? list : [])
    );
    if (!cidrs.length) throw new Error('empty range list');
    await kvPut('CF_RANGES_CACHE', cidrs.join('\n'));
    await kvPut('CF_RANGES_TS', String(Date.now()));
    return { cidrs, source: 'remote' };
  } catch {
    const fallback = parseCidrList(cached);
    return fallback.length ? { cidrs: fallback, source: 'stale-cache' } : null;
  }
}

function parseCidrListStringArray(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map(s => String(s).trim())
    .filter(s => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s));
}

/**
 * 订阅地址：统一走运行参数 sub_url（面板可改、立即生效）。
 * 历史独立 KV 键 SUB_URL 由 settings.js 的 legacyKey 兜底，环境变量 SUB_URL 仍可作为部署种子。
 * 支持完整 URL 或以 / 开头的相对路径（拼origin），贴 /tsub/<id> 这类链接也能直接用。
 */
async function subscriptionUrl(env, origin) {
  const raw = String((await readSettings(env)).sub_url || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return String(origin || '').replace(/\/+$/, '') + raw;
  return 'https://' + raw;
}

/**
 * 兜底订阅：面板/环境变量都没配订阅链接时，回退到 Worker 自带的 /sub。
 * token 口径必须与 edgetunnel 完全一致，这里按 vendor/vless.js 的算法推导 userID：
 *   - env.UUID 是合法 UUID → 小写化
 *   - 否则由「管理口令 + KEY」派生；KEY 未配置时 vendor 侧用的是它自己的默认值，
 *     本仓库无法共享该默认值，因此这种情况明确返回 null（由调用方降级），绝不猜测。
 */
async function fallbackSubscription(env, origin, hostname) {
  const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
  // 身份与引擎同源：面板里配的节点 ID / 节点地址优先，其次环境变量，最后本次请求的 hostname。
  // 两边必须算出同一个 token，否则「兜底订阅链接」会 404（引擎校验的就是 MD5MD5(host+uuid)）。
  const id = await nodeIdentity(env, hostname);
  let userId = uuidRe.test(id.uuid) ? id.uuid : '';
  if (!userId) {
    // 面板还没写过、环境变量也没给：按引擎的派生规则算。
    // KEY 未配置时引擎用它自己的默认密钥，本仓库无法共享该默认值，故明确返回 null 由调用方降级。
    if (!(env && env.KEY)) return null;
    const admin = env.ADMIN || env.PASSWORD || env.TOKEN || env.KEY;
    const seed = await md5md5(String(admin) + String(env.KEY));
    userId = [seed.slice(0, 8), seed.slice(8, 12), '4' + seed.slice(13, 16), '8' + seed.slice(17, 20), seed.slice(20)].join('-');
  }
  const host = String(id.host || hostname || '')
    .toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  const token = await md5md5(host + userId);
  return String(origin || '').replace(/\/+$/, '') + '/sub?token=' + encodeURIComponent(token);
}

function decodeSubscription(text) {
  let raw = String(text || '').trim();
  if (!raw) return '';
  if (!raw.includes('://')) {
    try {
      const norm = raw.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
      raw = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
    } catch {}
  }
  return raw;
}

/** 从订阅正文抽节点地址（IPv4 或域名）。覆盖 vless/trojan/ss 明文行与 vmess base64 行。 */
function parseNodeAddresses(text) {
  const out = [];
  const raw = decodeSubscription(text);
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let host = '';
    if (/^(vmess|vless|trojan|ss|ssr|tuic|hysteria2?|http|https|socks5?):\/\//i.test(t)) {
      const m = t.match(/^[a-z0-9+.-]+:\/\/[^@/]*@([^:/?#\s]+)/i);
      if (m) host = m[1];
      if (!host && /^vmess:\/\//i.test(t)) {
        try {
          const b64 = t.slice(t.indexOf('://') + 3).replace(/-/g, '+').replace(/_/g, '/');
          const v = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
          if (v && v.add) host = String(v.add);
        } catch {}
      }
    }
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

/** 经 DoH 解析候选域名 → 当前边缘 IPv4。Workers 无 DNS 能力，只能走查询接口。 */
async function resolveDomains(domains, opts = {}) {
  const base = String((opts.dohUrl || '') || DEFAULT_DOH_URL).trim();
  const deadline = opts.deadlineMs || 0;
  const out = [];
  for (const d of domains) {
    if (deadline && Date.now() > deadline) break;
    const name = String(d || '').trim().toLowerCase();
    // 域名判定同样只留 util.js 一份（这里原本抄了同一份正则）
    if (!isDomain(name)) continue;
    try {
      const r = await fetch(`${base}?name=${encodeURIComponent(name)}&type=A`, {
        headers: { Accept: 'application/dns-json' },
        signal: opts.signal || AbortSignal.timeout(4000),
      });
      const j = await r.json();
      for (const a of (j && j.Answer) || []) {
        if (a.type === 1 && isIpv4(a.data) && !out.includes(a.data)) out.push(a.data);
      }
    } catch {}
  }
  return out;
}

/**
 * 判断订阅地址是否指向本 Worker 自身（同源自拉）。
 * 兜底推导的 /sub?token=… 一定是同源；面板也可能把 SUB_URL 配成本机 /tsub/<id>。
 */
function isSelfFetch(url, origin) {
  try {
    const a = new URL(url);
    const b = new URL(origin || '');
    return a.host === b.host;
  } catch {
    return false;
  }
}

/**
 * 拉取订阅候选 IP。
 * @returns {{ips:string[], source:string, note:string, filtered:number, addresses:number}}
 */
async function fetchSubscriptionCandidates(env, opts = {}) {
  const origin = opts.origin || '';
  const cfg = await readSettings(env);
  const limit = opts.limit || cfg.candidate_limit || CANDIDATE_LIMIT;
  const url = (await subscriptionUrl(env, origin)) || (await fallbackSubscription(env, origin, opts.hostname));
  const empty = { ips: [], source: 'none', note: '', filtered: 0, addresses: 0 };
  if (!url) {
    return { ...empty, note: '未配置订阅链接，且无法推导 /sub  token（请配置 SUB_URL，或在面板粘贴订阅链接）' };
  }
  let text = '';
  try {
    // UA 同样走运行参数：默认 'Mozilla/5.0' 也在 SPEC 里，不在这里另写一份
    const headers = { 'User-Agent': String(cfg.sub_ua || SETTINGS_SPEC.sub_ua.default) };
    // 同源自拉补凭据：伪装开启时，这个 fetch 对 Worker 来说是一个不带任何 cookie 的
    // 全新请求，会被首页伪装当成陌生人挡在伪装 404 上（表现为「订阅拉取失败: HTTP 404」）。
    // 这里以「已登录」身份补上 ap_auth 过门禁；外部订阅地址绝不带凭据，避免泄漏口令。
    if (isSelfFetch(url, origin) && runtime.PASSWORD) {
      headers.Cookie = 'ap_auth=' + b64(runtime.PASSWORD);
    }
    const r = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: opts.signal || AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    text = await r.text();
  } catch (e) {
    return { ...empty, note: '订阅拉取失败：' + (e && e.message ? e.message : e) };
  }

  const addresses = parseNodeAddresses(text);
  const ipv4 = addresses.filter(isIpv4);
  if (!ipv4.length) {
    return { ...empty, addresses: addresses.length, note: '订阅中没有可用的 IPv4 节点地址' };
  }

  // 过滤开关的默认值来自运行参数 sub_strict（面板可改）；
  // 显式传 opts.strict 的调用方（面板接口）优先，便于「用一次性的口径做诊断」
  const strict = opts.strict === undefined ? cfg.sub_strict !== false : opts.strict !== false;
  if (!strict) {
    return { ips: [...new Set(ipv4)].slice(0, limit), source: 'sub', filtered: 0, addresses: addresses.length };
  }
  const ranges = await cloudflareRanges(env, { signal: opts.signal });
  if (!ranges) {
    // 拿不到边缘段就不过滤（比用写死的常量安全），但要如实标注，便于面板/日志排障
    return {
      ips: [...new Set(ipv4)].slice(0, limit),
      source: 'sub',
      filtered: 0,
      addresses: addresses.length,
      note: '无法获取边缘 IP 段，本次未做归属过滤',
    };
  }
  const kept = [...new Set(ipv4)].filter(ip => ranges.cidrs.some(c => cidrMatch(ip, c)));
  return {
    ips: kept.slice(0, limit),
    source: 'sub',
    filtered: ipv4.length - kept.length,
    addresses: addresses.length,
    ranges: ranges.source,
  };
}

export {
  md5Hex, md5md5, isIpv4, cidrMatch, cloudflareRanges, CANDIDATE_LIMIT,
  subscriptionUrl, fallbackSubscription, parseNodeAddresses, resolveDomains,
  fetchSubscriptionCandidates,
};
