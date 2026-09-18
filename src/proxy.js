import { cors, isText, esc, isNavigation, isFingerprinted } from './util.js';
import { CROSS_PREFIX, mapAbsoluteUrl, rewriteContent, contentKind, isHlsManifest } from './url.js';
import { injectLinkFix, buildDocWritePage, rewriteLocations } from './inject.js';
import { finalizeResponse } from './compress.js';

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
  // key 必须带命名空间：往下还有一份「主文档重建」的缓存，两者的处理分支和产物完全不同。
  // 共用 key 会让同一 URL 先来的一方把结果留给后来的一方——
  // 表现为 Turbo 的局部更新拿到一整份 docWrite 包裹的文档。
  const key = `rw|${site.id}|${crossHost || ''}|${url.pathname}|${url.search}`;
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
  const key = `dw|${site.id}|${crossHost || ''}|${url.pathname}|${url.search}`;
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
 * 媒体分片缓存 key：在普通缓存 key 基础上把（可选）鉴权身份绑进去。
 *  - 刻意**不**绑 Range：CF Cache API 的 cache.put 拒绝 status=206 的响应
 *    （官方文档 Invalid parameters 明确列出 206），媒体缓存只存 200 完整小响应
 *    （HLS/DASH 分片 .ts/.m4s 等）。cache.match 命中带 Content-Length 的完整
 *    200 响应时，CF 会根据请求的 Range 头自动切 206 返回 —— key 不绑 Range 才能
 *    吃到这个能力；绑了 Range 反而让带 Range 的请求永远 miss。
 *  - authBind（盗链保护）：把 api_key / X-Emby-Token 编进 key，不同用户的缓存隔离，
 *    未带鉴权的请求永远命中不了别人的缓存；不开则共享缓存（更快，播放 URL 带鉴权时
 *    本身不可猜测，已受一层保护，这里做的是第二层）。
 */
function mediaCacheKeyOf(targetUrl, request, authBind) {
  const x = new URL(cacheKeyOf(targetUrl));
  if (authBind) {
    const apiKey = x.searchParams.get('api_key') || request.headers.get('X-Emby-Token') || '';
    if (apiKey) x.searchParams.set('__auth', apiKey);
  }
  return x.toString();
}

/**
 * 流媒体请求判定（流媒体模式的站点专用）：
 *   1. 带 Range / If-Range 头（分片请求，最可靠）；
 *   2. 路径含媒体特征（stream / play / segment / hls / dash）；
 *   3. Content-Type 为 video/*、audio/*、image/*、HLS 或 DASH 清单。
 * image/*（海报/缩略图）刻意归入：VidHub 首页海报墙的请求量远超视频流本身，
 * 每张图都回源会让首页肉眼可见地慢；边缘缓存命中后海报秒出。
 * 判定过宽只会多走一条缓存分支（miss 时照常回源），不会破坏功能，宁可宽不可漏。
 */
function isMediaRequest(request, ct) {
  if (!request || !request.headers) return false;
  if (request.headers.has('range') || request.headers.has('if-range')) return true;
  const path = new URL(request.url).pathname.toLowerCase();
  if (/(?:\/|^)(?:stream|play|segment|hls|dash)(?:\/|\.|$)/.test(path)) return true;
  return /^(?:video|audio|image)\//.test(ct) || ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/dash+xml');
}

/**
 * 进 Cache API 的体积上限。写缓存必须把整个响应体读完（put 需要完整的 body），
 * 因此「缓存什么」等价于「允许把多大的东西读进 Worker 内存」——
 * 这套缓存是为 JS/CSS/图片与 HLS 分片设计的。
 *
 * 踩过的坑：isFingerprinted 的正则（[._-] + 8 位以上十六进制）会命中大量视频分片名
 * （segment-1234567890.ts、1080p-00000001.ts），于是几十 MB 的视频被整个读进内存
 * 去写缓存 —— 请求拖到超时、播放器重试又重新下一遍，表现为「网速极慢 + 转发流量暴涨
 * + 最后还是播不了」。大文件必须挡在缓存之外。
 *
 * 上限取 4MB 的依据：主流 HLS 分片（1080p~2K，4-6 秒片长）普遍在 1-4MB，
 * 1MB 上限会把它们全挡在缓存外 —— 每个观众每次播放都回源，源站吞吐一慢全站卡顿。
 * 4MB 仍在 Worker 内存预算内（写缓存走 waitUntil 后台进行，不阻塞客户端响应，
 * 数十个并发分片写入的内存占用也在百 MB 预算内），且 40MB 级整片仍被拒之门外。
 */
const MAX_CACHE_BYTES = 4 * 1024 * 1024;

/** 是否允许写入 Cache API：体积已知且不超过上限。
 *  没有 content-length（分块/流式）一律不缓存 —— 无法预知体积时读满整个流是在赌。 */
function cacheableSize(res) {
  const len = parseInt(res.headers.get('content-length') || '0', 10);
  return len > 0 && len <= MAX_CACHE_BYTES;
}

/**
 * 经 CF Cache API 提供不可变资源（fingerprinted：文件名含 hash，内容永不变）。
 * 跨隔离共享：首次回源后所有请求直接命中，避免每个用户每次都要 Worker 回源 + 重写，
 * 也避免大 bundle（数百 KB）在浏览器端等 4-7 秒才执行、拖垮 React 水合。
 * 只命中 200 的 GET，且体积在上限内；miss 时构建响应并 waitUntil 写入缓存。
 *
 * ⚠️ 绝不缓存 206：CF Cache API 的 cache.put 对 status=206 的响应直接抛错
 * （官方文档 Invalid parameters 明确列出），流媒体分片缓存只对 200 完整小响应
 * （HLS/DASH 分片）生效；MP4 等 206 Range 分片靠零 CPU 透传满速转发。
 */
async function serveCached(ctx, cacheKey, build) {
  if (!ctx || !cacheKey || typeof caches === 'undefined') return build();
  const key = new Request(cacheKey);
  const hit = await caches.default.match(key).catch(() => null);
  if (hit) return hit;
  const res = build();
  if (res && res.status === 200 && cacheableSize(res)) {
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
async function proxyRequest(request, site, crossHost, ctx, env) {
  const url = new URL(request.url);
  const sitePrefix = `/p/${site.id}`;
  // origin = 代理自身对外地址。脚本上下文的 URL 需要补成绝对地址（见 url.js absOnOrigin）
  const base = crossHost
    ? { host: crossHost, prefix: `${sitePrefix}${CROSS_PREFIX}${crossHost}`, origin: url.origin }
    : { host: site.host, prefix: sitePrefix, origin: url.origin };

  // 去掉通道前缀后剩下的就是原始路径
  let rest = url.pathname.slice(base.prefix.length);
  if (!rest.startsWith('/')) rest = '/';
  // 折叠前导的连续斜杠：客户端常把「以 / 结尾的 base 地址」与「以 / 开头的绝对路径」
  // 直接拼接，于是产生 //xxx。语义上等价于单斜杠，但源站与代理都会当成不同路径
  // 并回 404 —— 典型现场是 Emby：System/Info 里的 LocalAddress 是站点根，改写成代理
  // 地址后带上了尾斜杠，客户端再拼 /play/video/... 就变成 /p/<id>//play/video/...，
  // 表现为「视频点开就失败、播放器反复重试、流量疯涨但始终播不了」。
  // 只折叠前导部分：路径中间的双斜杠可能是源站自己的语义，不去动。
  rest = rest.replace(/^\/{2,}/, '/');
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
  // 发给上游时必须先记下浏览器真实支持的压缩方式：下面会把请求头的 Accept-Encoding
  // 改成 identity，等信息到这一刻已经拿不到了。
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

  // Emby 系媒体服务同时认 URL 的 api_key 与 X-Emby-Token 请求头两种鉴权；
  // 播放器的媒体栈（AVPlayer / ExoPlayer 等）发起的子请求经常只带 URL 上的
  // api_key 而丢掉了请求头，部分源站（尤其魔改 Emby）只认请求头。
  // URL 里已有 api_key 而客户端没带 X-Emby-Token 时补成请求头，两套鉴权
  // 都满足，不针对任何站点。
  const embyApiKey = url.searchParams.get('api_key');
  if (embyApiKey && !headers.has('X-Emby-Token')) {
    headers.set('X-Emby-Token', embyApiKey);
  }

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

  // 上游取一次。对冲阈值由环境变量给出，未配置即 0（关闭），默认行为与原先一致；
  // 突发 handful 场景下把隔 1200ms 的慢请求重发一次，能明显削掉长尾。
  //
  // 带 Range 的请求（视频/大文件分片）一律不对冲、不重试：分片本来就慢，必然触发对冲，
  // 于是每个分片都下两遍 —— 流量翻倍、带宽被自己吃掉、反而更慢，最后还是播不了。
  const wantsRange = request.headers.has('range') || request.headers.has('if-range');
  const hedgeMs = wantsRange ? 0 : (Number(env && (env.PROXY_HEDGE_MS || env.proxy_hedge_ms)) || 0);
  let upstream = await fetchUpstream(targetUrl, reqInit, hedgeMs, { noRetry: wantsRange });

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
      // 源站把请求重定向到站内路径时经常丢弃原请求的鉴权参数
      // （Emby 的图片重定向 /Items/{id}/Images/Primary -> /img/i/poster/{id}.jpg
      // 就不带 api_key），客户端跟进时若不带鉴权头，资源就 404 ——
      // 首页海报全裂、体感「加载缓慢」。把 api_key 保留到同一站点内的重定向
      // 目标上（绝不带到 __x 跨域目标，避免令牌泄漏给第三方域名）。
      try {
        const nlu = new URL(newLoc, url.origin);
        if (
          !nlu.searchParams.has('api_key') &&
          url.searchParams.has('api_key') &&
          newLoc.startsWith(sitePrefix + '/') &&
          !newLoc.startsWith(sitePrefix + CROSS_PREFIX)
        ) {
          newLoc += (nlu.search ? '&' : '?') + 'api_key=' + encodeURIComponent(url.searchParams.get('api_key'));
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

  // 客户端要了分片，但上游不支持 Range（回的是 200 整个文件）：
  // 这时每个 Range 请求都会被塞回一整个文件，播放器发 N 个分片就是 N 倍流量 ——
  // 对电影这种几个 GB 的文件，每个分片都去下几个 GB，必然超时、必然播不了。
  // 明确声明 Accept-Ranges: none，播放器就会改回一次性顺序下载（只下一遍，边下边播）。
  if (wantsRange && upstream.status === 200) headersOut.set('Accept-Ranges', 'none');

  const ct = headersOut.get('content-type') || '';
  const isHtml = ct.includes('text/html');
  const isHls = isHlsManifest(ct);
  // 播放清单绝不长缓存：直播场景下清单每次都在变，缓存一小时会让播放器一直拿到旧分片列表，
  // 表现为播到某一段就卡死不再往下走。清单体积很小，每次回源的代价可以忽略。
  if (isHls) {
    headersOut.set('Cache-Control', 'no-store');
    headersOut.delete('ETag');
    headersOut.delete('Last-Modified');
  } else if (isHtml) {
    // 只有 HTML 必须 no-store：每次都要拿到最新的重写结果与注入脚本。
    // JS/CSS/图片若也 no-store，每次导航都得重下全部 bundle，页面会长时间停在加载态。
    headersOut.set('Cache-Control', 'no-store');
    headersOut.delete('ETag');
    headersOut.delete('Last-Modified');
  } else if (upstream.status >= 200 && upstream.status < 300 && isFingerprinted(url.pathname)) {
    // 内容寻址资源（文件名里带 hash 指纹）：内容一变文件名必变，可放长缓存。
    // 命中即用浏览器缓存，重复访问不再回源、不再走一遍 Worker 重写。
    headersOut.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (upstream.status === 206 || /^(?:video|audio)\//.test(ct)) {
    // 分片响应与音视频流：保持源站缓存头，不叠加客户端缓存。
    //   - 206 是部分字节，缓存语义必须由源站的 Content-Range 决定；强加 1 小时
    //     缓存会让部分播放器 seek 时把新旧分片拼错（画面花/卡、流量正常却播不好）；
    //   - 音视频多为鉴权内容（URL 带 api_key/token），标 public 等于把私有内容
    //     宣称为可公开缓存，既不安全也会让校验鉴权的 CDN 拒绝后续分片。
  } else if (upstream.status >= 200 && upstream.status < 300) {
    // 静态资源允许缓存，但覆盖源站的 immutable/超长 max-age：
    // 一旦改写结果有问题，坏内容会被浏览器锁死一年无法恢复，短缓存 + SWR 兼顾速度与安全
    headersOut.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  }

  // HLS 清单是明文但不在 isText 白名单里，必须单独判定。漏掉这一条，清单会走进下面的
  // 「非文本直传」分支：分片地址与 AES 密钥 URI 原样透出，播放器按根路径去取 → 404 / 解密失败
  if (!isText(ct) && !isHls) {
    // 流媒体模式（proxyMode=media）：媒体小响应走分片边缘缓存，命中即免回源——
    //   - HLS/DASH 分片 .ts/.m4s（200 响应）
    //   - 海报/缩略图 image/*（VidHub 首页海报墙的主要请求，缓存后秒出）
    // MP4 等 206 Range 分片无法进 Cache API（平台限制：cache.put 拒绝 206），
    // 由零 CPU 透传满速转发，两者结合播放与浏览体感接近直连。
    // key 绑（可选）鉴权身份防盗链；体积闸门沿用 MAX_CACHE_BYTES（4MB），整片挡在缓存外。
    if (request.method === 'GET' && site.proxyMode === 'media' && isMediaRequest(request, ct) && cacheableSize(upstream) && upstream.status === 200) {
      return serveCached(ctx, mediaCacheKeyOf(targetUrl, request, !!site.mediaCacheAuthBind), () =>
        new Response(upstream.body, { status: upstream.status, headers: headersOut }));
    }
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
  const pb = await plaintextBuffer(upstream);
  const raw = pb.raw;
  if (raw === null) {
    // 上游发了一种本环境解不了的压缩格式（如运行时不支持 br）：整响应原样透传，
    // 头里的 content-encoding 保留——头体一致，浏览器自己能解。绝不能把压缩字节
    // 当文本改写（那正是整站乱码的来源），也不能删头（删了浏览器更解不了）。
    return new Response(pb.body, { status: upstream.status, headers: headersOut });
  }
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
    return finalizeResponse(upstream.status, rewritten, headersOut);
  }
  // 文本资源（JS/CSS/JSON）：fingerprinted 资源加长缓存头（浏览器/CDN 层缓存），
  // 二次访问零回源、零 Cache API 开销——并发突发时不再因每次请求的 Cache API
  // get/put 放大 worker 延迟导致 CF 530（React 全家桶 JS 曾集体 530 阻断水合）。
  if (request.method === 'GET' && upstream.status === 200 && isFingerprinted(url.pathname)) {
    headersOut.set('Cache-Control', 'public, max-age=604800, immutable');
    headersOut.set('CDN-Cache-Control', 'public, max-age=604800, immutable');
  }

  // 流媒体模式：媒体库 JSON（/Views、/Items 等 GET 列表接口）短缓存。
  // VidHub 每次进首页都要拉一批列表接口，边缘缓存命中后免回源，列表秒开；
  // 只缓存 GET（登录、播放进度等 POST/PUT 不受影响），key 绑鉴权身份
  // （同一用户自缓存，不跨用户串号）；删除 Set-Cookie（Cache API 拒绝缓存
  // 带 Set-Cookie 的响应）；短 TTL 避免缓存住会变化的私有状态。
  if (request.method === 'GET' && upstream.status === 200 && site.proxyMode === 'media'
      && /^application\/json\b/i.test(ct) && rewritten && rewritten.length <= MAX_CACHE_BYTES) {
    headersOut.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    headersOut.delete('set-cookie');
    const resp = finalizeResponse(upstream.status, rewritten, headersOut);
    try {
      ctx.waitUntil(caches.default.put(new Request(mediaCacheKeyOf(targetUrl, request, !!site.mediaCacheAuthBind)), resp.clone()));
    } catch {}
    return resp;
  }
  return finalizeResponse(upstream.status, rewritten, headersOut);
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

/**
 * 上游请求。三层保障，越往后越保守：
 *   1. 对冲（hedged）：先发一个，超过阈值还没回来就并行发第二个，谁先回来用谁。
 *      治的是长尾延迟（P99）——Tail at Scale 的经典做法。
 *      只对幂等请求启用（GET/HEAD 且无 body）：重复提交一次带 body 的 POST
 *      可能造成重复下单，那种风险换来的延迟收益不值。
 *   2. 错误/5xx/429 立即重试一次。这里刻意不做 sleep：原先在 Worker 里空转 300ms
 *      既救不了过载的源站（真退避应该是秒级指数），又实打实让用户多等 300ms。
 *   3. HTTPS 完全不可用时降级 HTTP（自签证书或纯 HTTP 源站）。
 */
/**
 * 按魔术字节识别压缩流格式。**头会撒谎或缺席，字节不会**：
 * 实测上游也在 Cloudflare 后面时，Worker 明明发了 `Accept-Encoding: identity`，
 * 边缘仍会把子响应压成 gzip 且**不带 Content-Encoding 头**（线上事故 0889479 后复发）。
 * text/html / js / css 等文本永远不可能以这些字节开头，嗅探零误伤。
 */
function sniffCompression(raw) {
  if (!raw || raw.byteLength < 4) return null;
  const b = new Uint8Array(raw, 0, 4);
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip';                       // gzip
  if (b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) return 'zstd'; // zstd
  if (b[0] === 0x78 && (b[1] === 0x01 || b[1] === 0x5e || b[1] === 0x9c || b[1] === 0xda)) return 'deflate'; // zlib
  return null;
}

async function decompressBuffer(raw, fmt) {
  const stream = new Response(raw).body.pipeThrough(new DecompressionStream(fmt));
  return await new Response(stream).arrayBuffer();
}

/**
 * 把上游响应体读成明文 Buffer。
 *
 * 两类真实事故，一个裁决原则——「头说了不算，字节才是最终裁决」：
 * 1. 上游无视 `Accept-Encoding: identity` 强行返回 br/zstd 且带着头（uhdnow 整站乱码）；
 * 2. 上游在 CF 边缘后面，边缘给子响应悄悄压了 gzip **还不带头**（乱码复发，线上抓包
 *    body 是 1f 8b 魔术字节、头是空）。第 2 种头根本没说，只能靠嗅探。
 *
 * 解不了（运行时不认识该格式）就返回 null，由调用方整响应透传（头体一致）。
 *
 * @returns {{ raw: ArrayBuffer|null, compressed: boolean, body: ArrayBuffer }}
 *          raw=null 表示无法解压，调用方必须用 body（原始压缩字节）连头带体原样透传
 */
async function plaintextBuffer(upstream) {
  const declared = String(upstream.headers.get('content-encoding') || '').trim().toLowerCase();
  const raw = await upstream.arrayBuffer();
  // 字节优先：嗅探命中就直接按字节解，头说了什么无关紧要（覆盖「带头压缩」「不带头压缩」「头撒谎」三种）。
  // 字节看着是明文时，只有 br/zstd 这种「运行时不会自动解」的声明编码才值得再试——
  // gzip/deflate 若声明了，运行时早就透明解压完了，再解一遍就是把明文当压缩流、必然抛错。
  const sniffed = sniffCompression(raw);
  let fmt = sniffed || (declared && declared !== 'identity' ? declared : '');
  if (fmt === 'x-gzip') fmt = 'gzip';
  if (!fmt || (!sniffed && (fmt === 'gzip' || fmt === 'deflate'))) {
    return { raw, compressed: false, body: raw };
  }
  try {
    return { raw: await decompressBuffer(raw, fmt), compressed: true, body: raw };
  } catch {
    // body 已经在上面被 arrayBuffer() 消费掉了，透传必须用这份缓冲的原始压缩字节
    return { raw: null, compressed: true, body: raw };
  }
}

/**
 * opts.noRetry：不做失败重试、也不做 https→http 降级重发。
 *
 * 用于 Range 请求（视频/大文件分片）：这类请求一旦中断，重发就是再下一遍整个分片，
 * 而播放器自己有更聪明的重试（换码率、只补那一段、限制并发）。让它快速失败比在
 * Worker 里盲目重发划算得多 —— 后者正是「转发流量暴涨但网速反而更慢」的来源之一。
 */
async function fetchUpstream(targetUrl, reqInit, hedgeMs = 0, opts = {}) {
  const noRetry = opts.noRetry === true;
  const method = String(reqInit.method || 'GET').toUpperCase();
  const idempotent = (method === 'GET' || method === 'HEAD') && !reqInit.body;
  const once = signal => (signal
    ? fetch(targetUrl, { ...reqInit, signal })
    : fetch(targetUrl, reqInit));

  if (hedgeMs > 0 && idempotent) {
    let timer = null;
    let second = null;
    try {
      const hedge = new Promise(resolve => {
        timer = setTimeout(() => {
          // 首个请求超过了长尾阈值还没回来，补一发（不取消首个，两个都在跑）
          second = fetch(targetUrl, reqInit).then(resolve).catch(() => resolve(null));
        }, hedgeMs);
      });
      const first = await Promise.race([fetch(targetUrl, reqInit), hedge]);
      clearTimeout(timer);
      if (first) return first;
      if (second) {
        const r = await second;
        if (r) return r;
      }
    } catch {
      if (timer) clearTimeout(timer);
      // 对冲路径异常不影响正确性，继续走下面的常规重试
    }
  }

  let res = null;
  try {
    res = await fetch(targetUrl, reqInit);
    if (!noRetry && (res.status >= 500 || res.status === 429)) res = await fetch(targetUrl, reqInit);
  } catch (e) {
    if (noRetry) throw e;
    try {
      res = await fetch(targetUrl, reqInit);
    } catch (e2) {
      if (targetUrl.startsWith('https://')) {
        try { return await fetch(targetUrl.replace(/^https:/, 'http:'), reqInit); } catch (e3) { /* ignore */ }
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
<title>${esc(title)}</title>
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

  // 双向消息转发。
  // 竞态：101 响应一返回客户端就能 send，而出站 WebSocket 与上游的握手此刻往往
  // 还在 CONNECTING——按 readyState===1 直接放行会把这段窗口里的消息静默丢弃
  // （线上症状：握手成功但第一条回显永远收不到）。因此上游 OPEN 前到达的消息
  // 先入队，OPEN 事件后按序冲刷；上游断开/出错时清队，避免悬挂引用。
  const pending = [];
  let upstreamOpen = false;
  server.addEventListener('message', (ev) => {
    if (!upstreamOpen) { pending.push(ev.data); return; }
    try { upstream.send(ev.data); } catch (e) {}
  });
  upstream.addEventListener('open', () => {
    upstreamOpen = true;
    while (pending.length) {
      try { upstream.send(pending.shift()); } catch (e) { break; }
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
    pending.length = 0;
    try { server.close(); } catch (e) {}
  });
  upstream.addEventListener('error', () => {
    pending.length = 0;
    try { server.close(); } catch (e) {}
  });

  return new Response(null, { status: 101, webSocket: client });
}

export {
  proxyRequest, rewriteSetCookies, fetchUpstream, friendlyError, handleWebSocket,
  // 导出供自检使用（与 fetchUpstream 同理）：缓存体积这道闸门只能靠断言守住，
  // 一旦有人放宽它，check-media.mjs 必须变红
  serveCached, cacheableSize, MAX_CACHE_BYTES,
  // 流媒体模式判定与分片缓存 key（check-media.mjs 断言其行为）
  isMediaRequest, mediaCacheKeyOf,
};
