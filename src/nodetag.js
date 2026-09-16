// 订阅文本后处理：给每个节点的备注补上 IP 归属国家。
//
// 刻意不去改 vendor/vless.js —— 节点由它生成，我们在出口做增强，
// 上游升级时不冲突，关掉开关就是原样透传。
//
// 两条硬约束：
//   1. 进出编码形态必须一致。拉到的是整份 base64，就仍然返回 base64，
//      换成明文输出会让一部分客户端直接不认。
//   2. 任何一步异常都必须退回原文。订阅是整个服务的入口，
//      为了加个后缀把订阅搞挂，代价远大于收益。

import {
  lookupCountries, enabled as geoipEnabled, isIpv4, flagEmoji, regionName, toggle,
  readTagSettings, saveTagSettings, STYLE_DEFAULT,
  ANYCAST, ANYCAST_LABEL, ANYCAST_CODE,
} from './geoip.js';

export { readTagSettings, saveTagSettings };

const NODE_RE = /^(vless|vmess|trojan|ss|ssr|tuic|hysteria2?|http|https|socks5?):\/\//i;
const SEP = ' | ';
// 备注后缀的默认样式：中文名 + ISO 3166-1 alpha-2 代号。
const DEFAULT_STYLE = STYLE_DEFAULT;
// 超长订阅不做处理：几千行节点的正则 + 编解码会吃掉可观的 CPU 时间，
// 而 Workers 的 CPU 预算是硬性的。超过了就原样透传，宁可少个点缀。
const MAX_SUB_BYTES = 512 * 1024;

/**
 * base64 编解码：必须走 UTF-8。
 * btoa/atob 只认 Latin-1，直接用在含中文备注的 vmess/订阅上会把字节拆坏
 * （"vmess节点" 会变成 "vmessèç¹"），而且 btoa 遇到中文会直接抛 InvalidCharacterError。
 */
function b64DecodeUtf8(s) {
  const norm = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return bin;
  }
}

function b64EncodeUtf8(s) {
  const bytes = new TextEncoder().encode(String(s));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 整份订阅的编码形态：整篇没有 :// 就当作 base64。 */
function decodeWhole(text) {
  const raw = String(text || '').trim();
  if (!raw) return { body: '', encoded: false };
  if (raw.includes('://')) return { body: raw, encoded: false };
  try {
    const body = b64DecodeUtf8(raw);
    return body.includes('://') ? { body, encoded: true } : { body: raw, encoded: false };
  } catch {
    return { body: raw, encoded: false };
  }
}

function encodeWhole(body, encoded) {
  return encoded ? b64EncodeUtf8(body) : body;
}

function safeDecode(s) {
  const t = String(s || '');
  if (!t) return '';
  if (!/%[0-9A-Fa-f]{2}/.test(t)) return t;
  try { return decodeURIComponent(t); } catch { return t; }
}

/** 抽取节点地址：明文行取 @ 后到分隔符，vmess 行取 JSON 里的 add。 */
function lineHost(line) {
  const m = String(line).match(/^[a-z0-9+.-]+:\/\/[^@/]*@([^:/?#\s]+)/i);
  if (m) return m[1];
  if (/^vmess:\/\//i.test(line)) {
    try {
      const b64 = line.slice('vmess://'.length).split('#')[0];
      const v = JSON.parse(b64DecodeUtf8(b64));
      return v && v.add ? String(v.add) : '';
    } catch { return ''; }
  }
  return '';
}

/** 取当前备注（URI fragment 或 vmess 的 ps 字段）。 */
function lineRemark(line) {
  const idx = String(line).indexOf('#');
  if (idx >= 0) return safeDecode(String(line).slice(idx + 1));
  if (/^vmess:\/\//i.test(line)) {
    try {
      const b64 = String(line).slice('vmess://'.length).split('#')[0];
      const v = JSON.parse(b64DecodeUtf8(b64));
      return v && v.ps ? String(v.ps) : '';
    } catch { return ''; }
  }
  return '';
}

/**
 * 按配置的样式拼出要追加的内容。
 *   cn-code（默认）：英国【GB】      —— 中文名 + ISO 代号，最适合一眼扫列表
 *   flag-name：      🇬🇧英国        —— 带国旗 emoji
 *   name：          英国
 *   code：          GB
 *   flag：          🇬🇧
 */
function tagText(info, style) {
  // CDN 任播 IP：没有国旗也没有国家名，按样式给最贴近的展示，绝不编造国名。
  if (info && info.anycast) {
    switch (String(style || DEFAULT_STYLE).trim().toLowerCase()) {
      case 'name':
      case 'flag-name': return ANYCAST_LABEL;
      case 'code':
      case 'flag': return ANYCAST_CODE;
      default: return ANYCAST_LABEL + '【' + ANYCAST_CODE + '】';
    }
  }
  const flag = info.flag || flagEmoji(info.cc);
  const name = info.cn || regionName(info.cc);
  const code = String(info.cc || '').toUpperCase();
  switch (String(style || DEFAULT_STYLE).trim().toLowerCase()) {
    case 'name': return name;
    case 'code': return code;
    case 'flag': return flag;
    case 'flag-name': return (flag ? flag : '') + name;
    default: return name ? name + '【' + code + '】' : code;
  }
}

/** 给单行明文节点补国家后缀。拿不到国家或已经补过就原样返回。 */
export function decorateLine(line, info, style) {
  const tag = tagText(info, style);
  if (!tag) return line;
  if (/^vmess:\/\//i.test(line)) {
    try {
      const head = 'vmess://';
      const rest = String(line).slice(head.length).split('#')[0];
      const v = JSON.parse(b64DecodeUtf8(rest));
      const old = String(v.ps || '');
      if (old && old.includes(tag)) return line;
      v.ps = old ? old + SEP + tag : tag;
      return head + b64EncodeUtf8(JSON.stringify(v));
    } catch { return line; }
  }
  const idx = String(line).indexOf('#');
  const before = idx >= 0 ? String(line).slice(0, idx) : String(line);
  const old = lineRemark(line);
  if (old && old.includes(tag)) return line;   // 幂等：重复处理不会越堆越长
  const next = old ? old + SEP + tag : tag;
  return before + '#' + encodeURIComponent(next);
}

/**
 * 给整份订阅的节点补国家。
 * @returns {{text:string, nodes:number, tagged:number, cached:boolean}}
 */
export async function decorateSubscription(text, opts = {}) {
  const { body, encoded } = decodeWhole(text);
  const empty = { text: String(text || ''), nodes: 0, tagged: 0, skipped: 'empty' };
  if (!body.trim()) return empty;

  const lines = body.split(/\r?\n/);
  const isNode = lines.filter(l => l.trim() && NODE_RE.test(l.trim()));
  if (!isNode.length) return { text: String(text || ''), nodes: 0, tagged: 0, skipped: 'no-node' };

  // 只有 IP 节点能查归属；域名节点在 nations 里没有对应项，自然保持原样
  const hosts = isNode.map(lineHost).filter(Boolean);
  const ips = [...new Set(hosts.filter(isIpv4))];
  if (!ips.length) return { text: String(text || ''), nodes: isNode.length, tagged: 0, skipped: 'no-ipv4' };

  const map = await lookupCountries(ips, {
    env: opts.env,
    ctx: opts.ctx,
    signal: opts.signal,
    deadline: opts.deadline,
  });
  if (!map.size) return { text: String(text || ''), nodes: isNode.length, tagged: 0, skipped: 'geoip-empty' };

  const style = opts.style || '';
  let tagged = 0;
  const out = lines.map(line => {
    const t = line.trim();
    if (!t || !NODE_RE.test(t)) return line;
    const host = lineHost(t);
    const info = host && map.get(host);
    if (!info) return line;
    tagged++;
    return decorateLine(t, info, style);
  });

  return { text: encodeWhole(out.join('\n'), encoded), nodes: isNode.length, tagged };
}

/** 面板/路由判断是否要跑这一层：配置未开启或订阅为空都直接透传。 */
export async function subscriptionTaggingEnabled(env) {
  try {
    return await geoipEnabled(env);
  } catch {
    return true;   // 读配置失败按默认值走，不当成关闭
  }
}

/**
 * 按原文重建一个等价响应。
 * 一旦 body 被读过，原 Response 就处于 locked 状态，再往外丢客户端只会拿到
 * 一个读不出内容的空壳 —— 所有「读过 body 后才决定放弃处理」的分支都必须走这里。
 */
function passthrough(resp, original, status) {
  try {
    const h = new Headers(resp.headers);
    h.delete('content-encoding');
    h.delete('content-length');
    return new Response(original, { status: status || resp.status, headers: h });
  } catch {
    return resp;
  }
}

/**
 * 订阅响应出口的统一增强入口。
 * anything 出错都退回原响应 —— 订阅拉不出来比备注少个国家严重得多。
 */
export async function tagSubscriptionResponse(resp, opts = {}) {
  let original = null;
  try {
    // 以下两个分支在读取 body 之前，可以直接把原响应丢回去
    if (!resp || resp.status !== 200) return resp;
    const ct = resp.headers.get('content-type') || '';
    if (!ct || !/(text|json)/i.test(ct)) return resp;

    original = await resp.text();
    // 到这里 body 已经消耗掉了，之后任何退出分支都必须重建响应
    if (!original) return passthrough(resp, original, resp.status);
    if (original.length > MAX_SUB_BYTES) return passthrough(resp, original, resp.status);

    const r = await decorateSubscription(original, opts);
    if (!r.tagged) return passthrough(resp, original, resp.status);

    const h = new Headers(resp.headers);
    // body 已解压为明文，清掉压缩头与旧长度，避免客户端按 gzip 解明文
    h.delete('content-encoding');
    h.delete('content-length');
    return new Response(r.text, { status: 200, headers: h });
  } catch {
    return original !== null ? passthrough(resp, original, resp.status) : resp;
  }
}

/** 备注后缀的样式：cn-code（默认）/ flag-name / name / code / flag。可用环境变量 NODE_COUNTRY_STYLE 覆盖。 */
function styleFrom(env) {
  const raw = String((env && (env.NODE_COUNTRY_STYLE || env.node_country_style)) || '').trim().toLowerCase();
  return raw || DEFAULT_STYLE;
}

export {
  styleFrom, DEFAULT_STYLE, NODE_RE, SEP, decodeWhole,
  lineHost, lineRemark, tagText, toggle, MAX_SUB_BYTES,
};
