import { cors, isText, esc, isNavigation, isFingerprinted } from './util.js';
import { CROSS_PREFIX, mapAbsoluteUrl, rewriteContent, contentKind } from './url.js';
import { injectLinkFix, buildDocWritePage, rewriteLocations } from './inject.js';

// 反向代理核心：请求转发、响应重写、WebSocket 透传

/**
 * HTML 重写结果缓存（通用，作用于任何站点）。
 * 大 HTML（数百 KB）的多轮正则重写会吃满 Worker 的 CPU 预算（免费计划约 10ms/请求），
 * 同一页面被多次访问时（刷新、多用户）重复重写是纯浪费。缓存命中时整轮重写被跳过，
 * 只剩轻量的注入脚本（<1ms），大幅降低 504 概率。
 *   - TTL 30s：站点配置 / 源站内容更新最多延迟 30s 生效（反代场景可接受）
 *   - 上限 50 条：防内存膨胀（每条数百 KB，远低于 Worker 内存预算）
 *   - 只缓存 GET 的 HTML；注入脚本不进缓存，每次按当前请求现做
 */
const HTML_CACHE_TTL = 30_000;
const HTML_CACHE_MAX = 50;
const htmlCache = new Map();
function cachedHtmlRewrite(site, crossHost, url, text, sitePrefix, base) {
  const key = `${site.id}|${crossHost || ''}|${url.pathname}|${url.search}`;
  const now = Date.now();
  const hit = htmlCache.get(key);
  if (hit && now - hit.ts < HTML_CACHE_TTL) return hit.html;
  const html = rewriteContent(text, site, sitePrefix, base, 'html');
  htmlCache.set(key, { html, ts: now });
  if (htmlCache.size > HTML_CACHE_MAX) {
    for (const k of htmlCache.keys()) {
      if (htmlCache.size <= HTML_CACHE_MAX) break;
      const v = htmlCache.get(k);
      if (now - v.ts >= HTML_CACHE_TTL) htmlCache.delete(k);
    }
  }
  return html;
}

/**
 * 主文档缓存：把「原始 HTML -> base64 重建页」的结果缓存（b64 编码是大头 CPU 成本）。
 * 键、TTL、上限与 cachedHtmlRewrite 一致；缓存的是最终交付页，命中时零重写成本。
 */
function cachedDocWritePage(site, crossHost, url, text, sitePrefix, base, targetUrl) {
  const key = `${site.id}|${crossHost || ''}|${url.pathname}|${url.search}`;
  const now = Date.now();
  const hit = htmlCache.get(key);
  if (hit && now - hit.ts < HTML_CACHE_TTL) return hit.html;
  const html = buildDocWritePage(text, site, sitePrefix, base, targetUrl);
  htmlCache.set(key, { html, ts: now });
  if (htmlCache.size > HTML_CACHE_MAX) {
    for (const k of htmlCache.keys()) {
      if (htmlCache.size <= HTML_CACHE_MAX) break;
      const v = htmlCache.get(k);
      if (now - v.ts >= HTML_CACHE_TTL) htmlCache.delete(k);
    }
  }
  return html;
}

/** 缓存键：给 URL 加版本参数，重写规则升级后旧缓存自动失效（不用于请求上游） */
function cacheKeyOf(u) {
  const x = new URL(u);
  x.searchParams.set('__apv', '1');
  return x.toString();
}

/**
 * 经 CF Cache API 提供不可变资源（fingerprinted：文件名含 hash，内容永不变）。
 * 跨隔离共享：首次回源后所有请求直接命中，避免每个用户每次都要 Worker 回源 + 重写，
 * 也避免大 bundle（数百 KB）在浏览器端等 4-7 秒才执行、拖垮 React 水合。
 * 只命中 200 的 GET；miss 时构建响应并 waitUntil 写入缓存。
 */
async function serveCached(ctx, cacheKey, build) {
  if (!ctx || !cacheKey || typeof caches === 'undefined') return build();
  const key = new Request(cacheKey);
  const hit = await caches.default.match(key).catch(() => null);
  if (hit) return hit;
  const res = build();
  if (res && res.status === 200) {
    try { ctx.waitUntil(caches.default.put(key, res.clone())); } catch {}
  }
  return res;
}

/**
 * 请求头值通用还原：把 header 值里出现的代理地址形态还原为目标站地址形态——
 *   - 跨域通道 https://<代理host>/p/<id>/__x/<host>/<path> -> https://<host>/<path>
 *   - 主通道   https://<代理host>/p/<id>/<path>            -> <targetBase>/<path>
 *   - URL 编码（%2Fp%2F<id>...）与无协议变体一并处理
 * 与路径/body 还原共用同一套前缀规则，不针对任何站点。
 */
function restoreHeaderValue(s, proxyHost, sitePrefix, targetBase, targetHost) {
  if (typeof s !== 'string' || !s) return s;
  const escHost = proxyHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = s;
  // 跨域通道（必须最先处理，避免被主通道前缀拆分误伤）
  out = out.replace(
    new RegExp(`https?://${escHost}${sitePrefix}${CROSS_PREFIX}([^/\\s"']+)(/[^\\s"']*)?`, 'g'),
    (_m, h, p) => `https://${h}${p || ''}`
  );
  out = out.replace(
    new RegExp(`${escHost}${sitePrefix}${CROSS_PREFIX}([^/\\s"']+)(/[^\\s"']*)?`, 'g'),
    (_m, h, p) => `${h}${p || ''}`
  );
  // 主通道：带协议
  out = out.split(`https://${proxyHost}${sitePrefix}`).join(targetBase);
  out = out.split(`http://${proxyHost}${sitePrefix}`).join(targetBase);
  // URL 编码形式
  const encAll = encodeURIComponent(sitePrefix);
  out = out.split(`https://${proxyHost}${encAll}`).join(targetBase);
  out = out.split(`http://${proxyHost}${encAll}`).join(targetBase);
  // 无协议（host + 前缀）
  out = out.split(`${proxyHost}${sitePrefix}`).join(targetHost);
  out = out.split(`${proxyHost}${encAll}`).join(targetHost);
  return out;
}

/**
 * 反向代理核心：把请求转发到目标站，并把响应内容里的 URL 映射回代理命名空间。
 *
 * 通用性约定（不含任何站点 / 域名 / 路径的特判）：
 *   - 主通道   /p/<id>/<path>              -> 站点自身域
 *   - 跨域通道 /p/<id>/__x/<host>/<path>   -> 任意第三方域（页面用到的任何外部资源/接口）
 * 两套通道共用同一套重写规则，因此任何站点的资源、接口、跳转都会留在代理内，不会被浏览器直连。
 */
async function proxyRequest(request, site, crossHost, ctx) {
  const url = new URL(request.url);
  const sitePrefix = `/p/${site.id}`;
  // origin = 代理自身对外地址。脚本上下文的 URL 需要补成绝对地址（见 url.js absOnOrigin）
  const base = crossHost
    ? { host: crossHost, prefix: `${sitePrefix}${CROSS_PREFIX}${crossHost}`, origin: url.origin }
    : { host: site.host, prefix: sitePrefix, origin: url.origin };

  // 去掉通道前缀后剩下的就是原始路径
  let rest = url.pathname.slice(base.prefix.length);
  if (!rest.startsWith('/')) rest = '/';
  // 自愈：历史链接 / 源站回传可能让前缀重复出现（/p/<id>/p/<id>/xxx），
  // 逐层剥掉多余的前缀，保证最终送到源站的始终是干净路径
  while (rest.startsWith(sitePrefix + '/') || rest === sitePrefix) {
    rest = rest.slice(sitePrefix.length) || '/';
  }

  const scheme = crossHost ? 'https' : (site.scheme || 'https');
  const targetHost = base.host;
  const targetBase = `${scheme}://${targetHost}`;

  /**
   * 把字符串里回传的代理路径还原为目标站路径（通用，不针对任何站点）。
   * 场景：页面上的回跳参数（return_to / next / redirect / callback ...）被重写成了
   * /p/<id>/xxx，表单提交或跳转时又原样带回源站；源站不认识这个前缀，
   * 会把它当站内路径再拼一次 -> /p/<id>/p/<id>/xxx -> 404。
   * 同时处理未编码（/p/id/xxx）与 URL 编码（%2Fp%2Fid%2Fxxx）两种形式。
   */
  function restoreProxyPath(s) {
    if (typeof s !== 'string' || !s) return s;
    let out = s;
    out = out.split(sitePrefix + '/').join('/');
    out = out.split(sitePrefix).join('');
    // 编码形式：%2Fp%2F<id>%2Fxxx -> %2Fxxx
    const encAll = encodeURIComponent(sitePrefix); // %2Fp%2Fgithub
    out = out.split(encAll + '%2F').join('%2F');
    out = out.split(encAll + '%2f').join('%2f');
    out = out.split(encAll).join('');
    // 小写编码变体
    const encLower = encAll.replace(/%2F/g, '%2f');
    if (encLower !== encAll) {
      out = out.split(encLower + '%2f').join('%2f');
      out = out.split(encLower).join('');
    }
    return out;
  }

  const targetSearch = restoreProxyPath(url.search);
  const targetUrl = targetBase + rest + targetSearch;

  const headers = new Headers(request.headers);
  headers.set('Host', targetHost);
  headers.set('Origin', targetBase);
  if (headers.has('Referer')) {
    try {
      const ref = new URL(headers.get('Referer'));
      // 浏览器侧的 Referer 指向代理域，还原成目标域，避免被上游按来源拒绝
      headers.set('Referer', targetBase + restoreProxyPath(ref.pathname) + restoreProxyPath(ref.search));
    } catch {}
  }
  // 通用还原：请求头值里可能夹带代理地址（防盗链、回跳参数等），全部还原为目标域，
  // 与路径/body 还原共用同一套前缀规则，不针对任何站点、不修改 Host 与长度等数值头。
  try {
    headers.forEach((value, key) => {
      if (key === 'Host' || key === 'Content-Length' || !value) return;
      const fixed = restoreHeaderValue(value, url.host, sitePrefix, targetBase, targetHost);
      if (fixed !== value) headers.set(key, fixed);
    });
  } catch {}

  // 强制上游返回未压缩明文：避免 br/deflate 等编码在读取 body 后与响应头不一致。
  // 内容若被改写，body 已解压，头上的 content-encoding 会变成谎言（浏览器按压缩去解明文 → 全部资源解析失败）。
  headers.set('Accept-Encoding', 'identity');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ray');
  headers.delete('x-forwarded-for');

  const reqInit = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const ctype = request.headers.get('content-type') || '';
    // 文本类请求体（登录表单等）里同样可能带回代理路径，一并还原为目标站路径；
    // 二进制体（上传/媒体）原样透传，不做任何改动
    if (/urlencoded|text\/|application\/(json|javascript|xml)|application\/x-www-form/i.test(ctype)) {
      try {
        const raw = await request.text();
        const fixed = restoreProxyPath(raw);
        if (fixed !== raw) {
          reqInit.body = fixed;
          headers.delete('content-length');
        } else {
          reqInit.body = raw;
        }
      } catch {
        try { reqInit.body = await request.arrayBuffer(); } catch {}
      }
    } else {
      try { reqInit.body = await request.arrayBuffer(); } catch {}
    }
  }

  // 上游取一次；网络错误或 5xx/429 重试一次（不区分站点，纯传输层兜底）
  let upstream = await fetchUpstream(targetUrl, reqInit);

  /**
   * 代理路径 -> 目标站绝对路径（用于 Location / Referer 还原）
   *   /p/<id>/foo            -> https://site/foo
   *   /p/<id>/__x/h/foo      -> https://h/foo
   */
  function mapToTargetPath(p) {
    if (p.startsWith(sitePrefix + CROSS_PREFIX)) {
      const tail = p.slice(sitePrefix.length + CROSS_PREFIX.length);
      const i = tail.indexOf('/');
      const host = i === -1 ? tail : tail.slice(0, i);
      const path = i === -1 ? '/' : tail.slice(i);
      return `https://${host}${path}`;
    }
    if (p === sitePrefix || p.startsWith(sitePrefix + '/')) return targetBase + p.slice(sitePrefix.length);
    return targetBase + p;
  }

  // 重定向：一律折算回代理命名空间（站内走主通道，站外走跨域通道），保证跳转不脱离代理
  if ([301, 302, 303, 307, 308].includes(upstream.status)) {
    const loc = upstream.headers.get('Location');
    if (loc) {
      let newLoc = loc;
      try {
        const lu = new URL(loc, targetBase);
        if (lu.protocol === 'http:' || lu.protocol === 'https:') {
          newLoc = mapAbsoluteUrl(lu.toString(), site, sitePrefix, base);
        }
      } catch {}
      const h = new Headers(upstream.headers);
      rewriteSetCookies(h, upstream, base.prefix);
      h.set('Location', newLoc);
      cors(h);
      return new Response(upstream.body, { status: upstream.status, headers: h });
    }
  }

  const headersOut = new Headers(upstream.headers);
  cors(headersOut);
  headersOut.delete('Content-Security-Policy');
  headersOut.delete('Content-Security-Policy-Report-Only');
  headersOut.delete('X-Frame-Options');
  // 代理场景下必然失效/有害的策略头一并清掉：
  // COEP/CORP 会阻断跨域资源加载，COOP 影响 window.open 的窗口引用，Permissions-Policy 可能限制摄像头等授权
  headersOut.delete('Cross-Origin-Embedder-Policy');
  headersOut.delete('Cross-Origin-Embedder-Policy-Report-Only');
  headersOut.delete('Cross-Origin-Resource-Policy');
  headersOut.delete('Cross-Origin-Opener-Policy');
  headersOut.delete('Permissions-Policy');
  rewriteSetCookies(headersOut, upstream, base.prefix);

  const ct = headersOut.get('content-type') || '';
  const isHtml = ct.includes('text/html');
  // 只有 HTML 必须 no-store：每次都要拿到最新的重写结果与注入脚本。
  // JS/CSS/图片若也 no-store，每次导航都得重下全部 bundle，页面会长时间停在加载态。
  if (isHtml) {
    headersOut.set('Cache-Control', 'no-store');
    headersOut.delete('ETag');
    headersOut.delete('Last-Modified');
  } else if (upstream.status >= 200 && upstream.status < 300 && isFingerprinted(url.pathname)) {
    // 内容寻址资源（文件名里带 hash 指纹）：内容一变文件名必变，可放长缓存。
    // 命中即用浏览器缓存，重复访问不再回源、不再走一遍 Worker 重写。
    headersOut.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (upstream.status >= 200 && upstream.status < 300) {
    // 静态资源允许缓存，但覆盖源站的 immutable/超长 max-age：
    // 一旦改写结果有问题，坏内容会被浏览器锁死一年无法恢复，短缓存 + SWR 兼顾速度与安全
    headersOut.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  }

  if (!isText(ct)) {
    // 非文本资源（图片/字体/音视频）：fingerprinted 走共享缓存，其余直接回源
    if (request.method === 'GET' && upstream.status === 200 && isFingerprinted(url.pathname)) {
      return serveCached(ctx, cacheKeyOf(targetUrl), () =>
        new Response(upstream.body, { status: upstream.status, headers: headersOut }));
    }
    return new Response(upstream.body, { status: upstream.status, headers: headersOut });
  }

  // HEAD / 204 / 304 没有正文可改写，直接回源响应，省掉一次无意义的读取 + 全量正则
  if (request.method === 'HEAD' || upstream.status === 204 || upstream.status === 304) {
    return new Response(upstream.body, { status: upstream.status, headers: headersOut });
  }

  // 超大文本直通：整体正则改写会打爆 Worker 的 CPU/内存预算，导致请求超时（页面一直转圈）。
  // 这类文件通常是单个大 bundle，其内部的绝对 URL 由前端注入脚本的运行时 hook 兜底。
  const declaredLen = parseInt(upstream.headers.get('content-length') || '0', 10);
  if (declaredLen > (isHtml ? 3 * 1024 * 1024 : 512 * 1024)) {
    return new Response(upstream.body, { status: upstream.status, headers: headersOut });
  }

  // 编码检测：上游非 utf-8（gb2312/GBK 等老站）必须按实际编码解码，否则全文乱码。
  // 顺序：Content-Type charset -> HTML <meta> charset -> utf-8 兜底。
  const raw = await upstream.arrayBuffer();
  let enc = 'utf-8';
  const ctCharset = ct.match(/charset=([^\s;]+)/i);
  if (ctCharset) enc = ctCharset[1];
  else if (isHtml) {
    try {
      // meta 标签在 ASCII 范围内，任何编码下前 2KB 都能以 utf-8 预读定位
      const head = new TextDecoder('utf-8').decode(raw.slice(0, 2048));
      const metaCharset = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([^\s"';>]+)/i);
      if (metaCharset) enc = metaCharset[1];
    } catch {}
  }
  let text;
  try { text = new TextDecoder(enc).decode(raw); } catch { text = new TextDecoder('utf-8').decode(raw); }
  // 解码后统一声明 utf-8，避免浏览器按上游原始 charset 二次解码已转码的文本
  if (ct.includes('charset=')) headersOut.set('Content-Type', ct.replace(/charset=[^\s;]+/i, 'charset=utf-8'));

  // 关键：body 已被 upstream.text() 解压成明文，必须清掉压缩头与旧长度，
  // 否则浏览器按 gzip 去解明文 → 全部 JS/CSS 解析失败 → 页面永远停在加载态、按钮全死。
  headersOut.delete('content-encoding');
  headersOut.delete('content-length');

  const kind = contentKind(ct);
  // 外部脚本文件原样透传（不做 URL 字面量改写）：
  // SPA（React 等）在初始化时会按字面量精确匹配 origin / 域名，改写会静默破坏其运行时判断
  // （表现为水合不触发、按钮无事件）。绝对 URL 的资源请求由前端注入脚本的 fetch/XHR/DOM hook 兜底。
  const isJsFile = /javascript|ecmascript|application\/x-js/i.test(ct);
  const isNavHtml = isHtml && isNavigation(request);
  const canCacheHtml = request.method === 'GET' && upstream.status >= 200 && upstream.status < 300;
  // 主文档：完全参考 cf-proxy-ex —— 原始 HTML base64 嵌入注入脚本，客户端解码后
  // 统一把属性与 script/style 字面量转成绝对代理 URL 再 document.write 重建（水合友好）。
  // 非导航 HTML 片段（turbo 等 fetch 的局部更新）：仍走服务端重写，页面级 hook 持续修复。
  let rewritten;
  if (isNavHtml) {
    rewritten = canCacheHtml
      ? cachedDocWritePage(site, crossHost, url, text, sitePrefix, base, targetUrl)
      : buildDocWritePage(text, site, sitePrefix, base, targetUrl);
  } else if (isHtml) {
    rewritten = canCacheHtml
      ? cachedHtmlRewrite(site, crossHost, url, text, sitePrefix, base)
      : rewriteContent(text, site, sitePrefix, base, 'html');
  } else {
    rewritten = isJsFile ? rewriteLocations(text) : rewriteContent(text, site, sitePrefix, base, kind);
  }
  if (isNavHtml) {
    return new Response(rewritten, { status: upstream.status, headers: headersOut });
  }
  // 文本资源（JS/CSS/JSON）：fingerprinted 资源加长缓存头（浏览器/CDN 层缓存），
  // 二次访问零回源、零 Cache API 开销——并发突发时不再因每次请求的 Cache API
  // get/put 放大 worker 延迟导致 CF 530（React 全家桶 JS 曾集体 530 阻断水合）。
  if (request.method === 'GET' && upstream.status === 200 && isFingerprinted(url.pathname)) {
    headersOut.set('Cache-Control', 'public, max-age=604800, immutable');
    headersOut.set('CDN-Cache-Control', 'public, max-age=604800, immutable');
  }
  return new Response(rewritten, { status: upstream.status, headers: headersOut });
}

/**
 * 上游 Set-Cookie 落地到代理域：
 *   - 去掉 Domain（变为 host-only，浏览器才会存到代理域）
 *   - Path 收敛到该通道前缀，避免不同站点/不同域的 cookie 互相覆盖
 *   - 逐个输出，绝不合并成逗号分隔头（浏览器解析会丢 cookie）
 */
function rewriteSetCookies(out, upstream, cookiePath) {
  let list = [];
  try {
    if (typeof upstream.headers.getSetCookie === 'function') list = upstream.headers.getSetCookie() || [];
  } catch {}
  if (!list.length) {
    const raw = upstream.headers.get('Set-Cookie');
    if (!raw) return;
    list = raw.split(/,(?=\s*[A-Za-z_][A-Za-z0-9_.-]*\s*=)/).map(s => s.trim()).filter(Boolean);
  }
  if (!list.length) return;
  out.delete('Set-Cookie');
  for (const sc of list) {
    const name = (sc.split('=')[0] || '').trim();
    // __Host- 前缀 cookie 按规范必须 Path=/ 且无 Domain，改 Path 会被浏览器丢弃（登录态存不住）
    const path = /^__host-/i.test(name) ? '/' : cookiePath;
    out.append('Set-Cookie', sc.replace(/;\s*Domain=[^;]+/gi, '').replace(/;\s*Path=[^;]*/gi, '') + `; Path=${path}`);
  }
}

/** 上游请求：失败重试一次（网络抖动 / 瞬时 5xx / 限流）；HTTPS 不可用时回退 HTTP（自签或纯 HTTP 源站） */

/** 上游请求：失败重试一次（网络抖动 / 瞬时 5xx / 限流）；HTTPS 不可用时回退 HTTP（自签或纯 HTTP 源站） */
async function fetchUpstream(targetUrl, reqInit) {
  let res = null;
  try {
    res = await fetch(targetUrl, reqInit);
    if (res.status >= 500 || res.status === 429) {
      await new Promise(r => setTimeout(r, 300));
      res = await fetch(targetUrl, reqInit);
    }
  } catch (e) {
    try {
      await new Promise(r => setTimeout(r, 300));
      res = await fetch(targetUrl, reqInit);
    } catch (e2) {
      if (targetUrl.startsWith('https://')) {
        try { return await fetch(targetUrl.replace(/^https:/, 'http:'), reqInit); } catch (e3) {}
      }
      throw e2;
    }
  }
  return res;
}

/**
 * 后端 HTML 转义（Worker 侧使用，与前端同名函数互不影响）
 */

function friendlyError(title, msg, retryUrl, status = 502, isDoc = true) {
  // 非导航请求（脚本/样式/接口等）一律静默失败：
  // 返回 HTML 会被浏览器当 JS 解析，报 "Unexpected token '<'" 并连同样式/功能一起挂掉
  if (!isDoc) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
const retry = retryUrl
    ? `<a href="${esc(retryUrl)}" style="display:inline-block;background:#2563eb;color:#fff;border-radius:8px;padding:10px 20px;text-decoration:none;font-size:14px;font-weight:600;margin-right:10px;">重试</a>`
    : '';
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} · Any-Proxy</title>
<style>body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:#f4f6fb;color:#0f172a;min-height:100vh;display:flex;align-items:center;justify-content:center}.box{max-width:520px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:32px 28px;text-align:center}h1{font-size:20px;margin:0 0 12px}p{color:#64748b;font-size:14px;line-height:1.8;word-break:break-all}.links{margin-top:24px}</style>
</head><body><div class="box"><h1>${esc(title)}</h1><p>${msg}</p><div class="links">${retry}<a href="/" style="display:inline-block;background:transparent;color:#2563eb;border:1px solid #2563eb;border-radius:8px;padding:10px 20px;text-decoration:none;font-size:14px;">← 返回主页</a></div></div></body></html>`;
  return new Response(html, {
    status: status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * 为 edgetunnel 管理面板 / 登录页注入「返回主页」入口，方便回到统一入口。
 * 优先注入到面板顶部导航（header-buttons），避免被页面 JS 重绘移除；登录页无导航则退回 body 末尾。
 */

/**
 * WebSocket 透传：客户端 Upgrade 请求 -> 入站 WebSocketPair -> 出站 WebSocket 到目标站 -> 双向转发。
 * 主通道与跨域通道（__x）一视同仁，任何目标域的实时通信都经此转发。
 */
async function handleWebSocket(request, site, crossHost) {
  const url = new URL(request.url);
  const sitePrefix = `/p/${site.id}`;
  const base = crossHost
    ? { host: crossHost, prefix: `${sitePrefix}${CROSS_PREFIX}${crossHost}`, origin: url.origin }
    : { host: site.host, prefix: sitePrefix, origin: url.origin };
  let rest = url.pathname.slice(base.prefix.length);
  if (!rest.startsWith('/')) rest = '/';
  const targetHost = base.host;
  const targetWs = `wss://${targetHost}${rest}${url.search}`;
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  // 出站 WebSocket 需要的请求头
  const wsHeaders = {};
  const ua = request.headers.get('User-Agent');
  if (ua) wsHeaders['User-Agent'] = ua;
  const auth = request.headers.get('Authorization');
  if (auth) wsHeaders.Authorization = auth;
  const cookie = request.headers.get('Cookie');
  if (cookie) wsHeaders.Cookie = cookie;
  const origin = request.headers.get('Origin');
  wsHeaders.Origin = `https://${targetHost}`;

  let upstream = null;
  try {
    upstream = new WebSocket(targetWs, [], wsHeaders);
  } catch (e) {
    // 目标不支持 wss 时回退明文 ws（通用传输层回退）
    try { upstream = new WebSocket(targetWs.replace(/^wss:/, 'ws:'), [], wsHeaders); } catch (e2) {}
  }
  if (!upstream) {
    try { server.close(1011, 'upstream ws failed'); } catch (e2) {}
    return new Response(null, { status: 101, webSocket: client });
  }

  // 双向消息转发
  server.addEventListener('message', (ev) => {
    if (upstream.readyState === 1) {
      try { upstream.send(ev.data); } catch (e) {}
    }
  });
  upstream.addEventListener('message', (ev) => {
    if (server.readyState === 1) {
      try { server.send(ev.data); } catch (e) {}
    }
  });
  server.addEventListener('close', () => {
    try { upstream.close(); } catch (e) {}
  });
  upstream.addEventListener('close', () => {
    try { server.close(); } catch (e) {}
  });
  upstream.addEventListener('error', () => {
    try { server.close(); } catch (e) {}
  });

  return new Response(null, { status: 101, webSocket: client });
}

export { proxyRequest, rewriteSetCookies, fetchUpstream, friendlyError, handleWebSocket };
