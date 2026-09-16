// 订阅 & 候选 IP 的通用能力：订阅地址解析、节点抽取、边缘段判定、候选域名解析。
//
// 设计约束（重要）：本文件**不写死任何业务域名 / IP / IP 段**。
// 一切取值按「环境变量 → KV（面板可配）」两级查找；取不到时降级为「不判定 / 明确报错」，
// 而不是退回到硬编码常量——否则 fork 后自定义部署必然静默地操作到别人的域名上。
// 唯一允许出现的 URL 是远端数据源的默认地址，且随时可用环境变量覆盖。

import { runtime } from './runtime.js';

// 远端边缘 IP 段数据源。可用 CF_IP_RANGES_URL 覆盖；返回形如 {"result":{"ipv4_cidrs":[...]}} 的 JSON。
const DEFAULT_RANGES_URL = 'https://api.cloudflare.com/client/v4/ips';
// 解析候选域名用的公共 DNS（DoH）。Workers 自身没有 DNS 解析能力，只能借道查询接口。
const DEFAULT_DOH_URL = 'https://cloudflare-dns.com/dns-query';
const RANGES_TTL_MS = 12 * 3600 * 1000;

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

async function md5Hex(s) {
  const buf = await crypto.subtle.digest('MD5', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function md5md5(s) {
  const first = await md5Hex(s);
  return (await md5Hex(first.slice(7, 27))).toLowerCase();
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function isIpv4(s) {
  if (!IPV4_RE.test(s)) return false;
  return s.split('.').every(o => Number(o) >= 0 && Number(o) <= 255);
}

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
 * 优先级：KV（面板可配 CF_IP_RANGES）→ 远端数据源（URL 可配）→ 缓存 → null（表示无法判定，调用方应不过滤）。
 * 刻意不内置任何写死的 IP 段。
 */
async function cloudflareRanges(env, opts = {}) {
  const manual = parseCidrList(await kvGet('CF_IP_RANGES'));
  if (manual.length) return { cidrs: manual, source: 'kv' };

  const cached = await kvGet('CF_RANGES_CACHE');
  const cachedTs = Number(await kvGet('CF_RANGES_TS')) || 0;
  if (cached && Date.now() - cachedTs < RANGES_TTL_MS) {
    const cidrs = parseCidrList(cached);
    if (cidrs.length) return { cidrs, source: 'cache' };
  }

  const url = String((env && (env.CF_IP_RANGES_URL || env.cf_ip_ranges_url)) || DEFAULT_RANGES_URL).trim();
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
 * 订阅地址：面板配置（KV SUB_URL）优先，其次环境变量 SUB_URL。
 * 支持完整 URL 或以 / 开头的相对路径（拼origin），贴 /tsub/<id> 这类链接也能直接用。
 */
async function subscriptionUrl(env, origin) {
  const raw = String((await kvGet('SUB_URL')) || (env && (env.SUB_URL || env.sub_url)) || '').trim();
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
  const envUuid = env && (env.UUID || env.uuid);
  const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
  let userId = '';
  if (envUuid && uuidRe.test(envUuid)) {
    userId = envUuid.toLowerCase();
  } else if (env && env.KEY) {
    const admin = env.ADMIN || env.PASSWORD || env.TOKEN || env.KEY;
    const seed = await md5md5(String(admin) + String(env.KEY));
    userId = [seed.slice(0, 8), seed.slice(8, 12), '4' + seed.slice(13, 16), '8' + seed.slice(17, 20), seed.slice(20)].join('-');
  } else {
    return null;
  }
  // host 口径同样跟随 edgetunnel：配了 HOST 就用 HOST 的首个条目，否则取请求 hostname
  let host = String(hostname || '');
  const hostCfg = env && (env.HOST || env.host);
  if (hostCfg) {
    host = String(hostCfg).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)[0]
      .toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0] || host;
  }
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
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(name)) continue;
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
 * 拉取订阅候选 IP。
 * @returns {{ips:string[], source:string, note:string, filtered:number, addresses:number}}
 */
async function fetchSubscriptionCandidates(env, opts = {}) {
  const origin = opts.origin || '';
  const url = (await subscriptionUrl(env, origin)) || (await fallbackSubscription(env, origin, opts.hostname));
  const empty = { ips: [], source: 'none', note: '', filtered: 0, addresses: 0 };
  if (!url) {
    return { ...empty, note: '未配置订阅链接，且无法推导 /sub  token（请配置 SUB_URL，或在面板粘贴订阅链接）' };
  }
  let text = '';
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': String((env && env.SUB_UA) || 'Mozilla/5.0') },
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

  const strict = opts.strict === false ? false : true;
  if (!strict) {
    return { ips: [...new Set(ipv4)].slice(0, opts.limit || 40), source: 'sub', filtered: 0, addresses: addresses.length };
  }
  const ranges = await cloudflareRanges(env, { signal: opts.signal });
  if (!ranges) {
    // 拿不到边缘段就不过滤（比用写死的常量安全），但要如实标注，便于面板/日志排障
    return {
      ips: [...new Set(ipv4)].slice(0, opts.limit || 40),
      source: 'sub',
      filtered: 0,
      addresses: addresses.length,
      note: '无法获取边缘 IP 段，本次未做归属过滤',
    };
  }
  const kept = [...new Set(ipv4)].filter(ip => ranges.cidrs.some(c => cidrMatch(ip, c)));
  return {
    ips: kept.slice(0, opts.limit || 40),
    source: 'sub',
    filtered: ipv4.length - kept.length,
    addresses: addresses.length,
    ranges: ranges.source,
  };
}

export {
  md5Hex, md5md5, isIpv4, cidrMatch, cloudflareRanges,
  subscriptionUrl, fallbackSubscription, parseNodeAddresses, resolveDomains,
  fetchSubscriptionCandidates,
};
