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
 * 友好的错误页（反代失败 / 站点不存在等），带「返回主页」「重试」入口。
 * 对 JS/CSS/JSON/图片等**资源类请求**不返回 HTML（否则浏览器会把错误页当 JS 解析，报
 * "Unexpected token '<'" 刷屏、样式/功能全挂），改为返回空 204 静默失败。
 */
/** 是否为导航类请求（地址栏打开页面）。用标准 Sec-Fetch-Dest / Accept 判断，不依赖 URL 形态 */

/**
 * 友好的错误页（反代失败 / 站点不存在等），带「返回主页」「重试」入口。
 * 对 JS/CSS/JSON/图片等**资源类请求**不返回 HTML（否则浏览器会把错误页当 JS 解析，报
 * "Unexpected token '<'" 刷屏、样式/功能全挂），改为返回空 204 静默失败。
 */
/** 是否为导航类请求（地址栏打开页面）。用标准 Sec-Fetch-Dest / Accept 判断，不依赖 URL 形态 */
function isNavigation(request) {
  const dest = request.headers.get('Sec-Fetch-Dest');
  if (dest) return dest === 'document' || dest === 'iframe' || dest === 'object' || dest === 'embed';
  return (request.headers.get('Accept') || '').includes('text/html');
}

export { json, b64, slugify, randomSuffix, kvKey, validTarget, cors, isText, isFingerprinted, esc, isNavigation };
