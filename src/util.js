// 无依赖的通用工具：响应构造、编码、合法性判定、缓存指纹判定等

function json(data, status = 200, extra = {}) {
  // no-store：避免边缘节点把带鉴权的接口响应（含 401/404）缓存后回给其它访客
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

function b64(str) {
  try {
    return btoa(unescape(encodeURIComponent(str)));
  } catch {
    return btoa(str);
  }
}

/** 校验请求是否已登录（Cookie auth 与口令匹配） */

function slugify(name) {
  const s = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'site';
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 6);
}

function kvKey(id) {
  return `site:${id}`;
}

function validTarget(target) {
  let u;
  try {
    u = new URL(target);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname) return null;
  return u;
}

function cors(h) {
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  h.set('Access-Control-Allow-Headers', '*');
}

function isText(ct) {
  return /text\/html|text\/javascript|application\/javascript|application\/x-javascript|text\/css|application\/json|text\/xml|application\/xml|application\/x-font-ttf|application\/vnd.ms-fontobject|font\/opentype|text\/plain/.test(ct);
}

// ===================== KV 站点操作 =====================

/**
 * 路径是否为「内容寻址」资源：文件名里带 hash 指纹（xxx.<hash>.js / xxx.<hash>.css 等）。
 * 这类资源内容变化时文件名必然变化，因此可以安全地给一年 immutable 长缓存。
 * 与站点 / 域名无关，对所有目标站一致适用。
 */
function isFingerprinted(pathname) {
  const file = (pathname || '').split('/').pop() || '';
  return /[._-](?:[0-9a-f]{8,}|[a-z0-9]{20,})(?:\.[a-z0-9]{1,5})?$/i.test(file);
}

/**
 * 上游 Set-Cookie 落地到代理域：
 *   - 去掉 Domain（变为 host-only，浏览器才会存到代理域）
 *   - Path 收敛到该通道前缀，避免不同站点/不同域的 cookie 互相覆盖
 *   - 逐个输出，绝不合并成逗号分隔头（浏览器解析会丢 cookie）
 */

/**
 * 后端 HTML 转义（Worker 侧使用，与前端同名函数互不影响）
 */
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/**
 * 是否为导航类请求（地址栏打开页面）。用标准 Sec-Fetch-Dest / Accept 判断，不依赖 URL 形态
 */
function isNavigation(request) {
  const dest = request.headers.get('Sec-Fetch-Dest');
  if (dest) return dest === 'document' || dest === 'iframe' || dest === 'object' || dest === 'embed';
  return (request.headers.get('Accept') || '').includes('text/html');
}

// ===================== 列表型配置的解析（唯一实现）=====================
//
// 面板保存与运行时消费必须在「什么算合法 IP / 域名」上完全一致，否则会出现
// 「面板说保存成功、运行时全被静默过滤掉」。这件事真的发生过：
// admin.js 曾用只验数字段数的正则（999.999.999.999 也能存进优选池），
// 而 subs.js/dns.js 用的是带段值校验的实现，于是面板显示已保存、池子其实是空的。
//
// 所以这类解析统一放这里（util.js 无依赖，三处都能引），不再各写一份。

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 严格 IPv4：先验段数，再验每段 0-255 */
function isIpv4(s) {
  if (!IPV4_RE.test(s)) return false;
  return s.split('.').every(o => Number(o) >= 0 && Number(o) <= 255);
}

/**
 * 候选域名池用的域名判定。
 * 沿用原实现的正则（不收紧也不放宽），只把它从三处拷贝收敛成一份。
 */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/;

function isDomain(s) {
  return DOMAIN_RE.test(s);
}

/**
 * 多行文本 → 合法的 IPv4 列表。
 * 兼容换行 / 逗号 / 分号 / 空格分隔，`#` 之后视为注释，结果去重并截到 limit。
 * @param {unknown} text
 * @param {number} [limit] 不传则不截断
 */
function parseIpv4List(text, limit) {
  const out = [];
  for (const raw of String(text == null ? '' : text).split(/\r?\n|,|;|\s+/)) {
    const s = raw.trim().split('#')[0].trim();
    if (s && isIpv4(s) && !out.includes(s)) out.push(s);
  }
  return typeof limit === 'number' && limit > 0 ? out.slice(0, limit) : out;
}

/**
 * 多行文本 → 合法的域名列表（小写、去重、可截断）。
 * @param {unknown} text
 * @param {number} [limit]
 */
function parseDomainList(text, limit) {
  const out = [];
  for (const raw of String(text == null ? '' : text).split(/\r?\n|,|;|\s+/)) {
    const s = raw.trim().toLowerCase().split('#')[0].trim();
    if (s && isDomain(s) && !out.includes(s)) out.push(s);
  }
  return typeof limit === 'number' && limit > 0 ? out.slice(0, limit) : out;
}

export {
  json, b64, slugify, randomSuffix, kvKey, validTarget, cors, isText, isFingerprinted, esc, isNavigation,
  isIpv4, isDomain, parseIpv4List, parseDomainList,
};
