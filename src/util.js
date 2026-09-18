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

// 注意：HLS 播放清单（m3u8）虽是明文，但不在这里判定。判定放在 url.js 的 isHlsManifest
// （单一来源）—— url.js 是自包含模块、要被前端注入脚本复用，不能反向依赖 util.js
// （util.js 带 KV/env 语义，打进浏览器会炸）。调用方需同时看 isText 与 isHlsManifest。

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
 * 节点 UUID 判定：**必须与代理引擎的接受条件逐字一致**。
 *
 * vendor/vless.js 里 `userID = (envUUID && uuidRegex.test(envUUID)) ? envUUID.toLowerCase() : 由口令派生`。
 * 也就是说：面板上填了一个「看起来像 UUID 但不是 v4 形态」的值时，引擎会**默默忽略它**
 * 改用派生 UUID —— 面板提示保存成功，实际订阅里的节点 ID 完全没变。
 * 这就是「改了这里、那里不生效」的典型，所以格式判断必须与引擎同源，
 * 并且要在**写入前**拦住（见 settings.js 的 node_uuid.validate），而不是等引擎静默丢弃。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isUuid(s) {
  return UUID_RE.test(String(s == null ? '' : s).trim().toLowerCase());
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

/**
 * MD5 十六进制摘要。
 */
async function md5Hex(s) {
  const buf = await crypto.subtle.digest('MD5', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 与代理引擎（vendor/vless.js 的 MD5MD5）完全一致的口径：MD5(MD5(text).hex.slice(7,27))。
 *
 * 为什么必须放在这里：这个口径原先在 subs.js 与 tempsubs.js 各写了一份。
 * 两份实现只要有一处改动（哪怕只是大小写），订阅 token 与临时订阅 token 就会分叉，
 * 表现为「临时订阅链接 404 而主订阅正常」——很难从现象定位到原因。
 * 全项目现在只有这一份实现，引擎侧那份属于上游，改动由 check-nodetag 用例钉住。
 */
async function md5md5(s) {
  const first = await md5Hex(s);
  return (await md5Hex(first.slice(7, 27))).toLowerCase();
}

export {
  json, b64, slugify, randomSuffix, kvKey, validTarget, cors, isText, isFingerprinted, esc, isNavigation,
  isIpv4, isDomain, isUuid, parseIpv4List, parseDomainList,
  md5Hex, md5md5,
};
