import vlessHandler from '../vendor/vless.js';
import { json, b64, esc, cors, isNavigation } from './util.js';
import { bindRuntime, runtime } from './runtime.js';
import { getSite, listSites } from './sites.js';
import { isAuthed, handleLogin, handleLogout, loginPage, noConfigPage } from './auth.js';
import { adminPage, handleAdmin, tempSubPage } from './admin.js';
import { get as getTempSub, isActive as isTempSubActive, subToken as tempSubToken } from './tempsubs.js';
import { proxyRequest, friendlyError, handleWebSocket } from './proxy.js';
import { injectHomeButton } from './inject.js';
import { CROSS_PREFIX } from './url.js';
import { scheduledDnsCheck } from './dns.js';
import {
  readConfig, isActive, hitEntry, hasGate, gateCookieValue, expiredGateCookie,
  renderHome, renderNotFound, renderRobots, emptyFavicon,
} from './disguise.js';
import { subscriptionTaggingEnabled, styleFrom, tagSubscriptionResponse } from './nodetag.js';
import { check as rateLimitCheck } from './ratelimit.js';
import { readShareConfig, resolve as resolveShare } from './share.js';
import { notify as notifyAlert } from './alert.js';

/** 被限流 / 被封禁时的统一响应：状态码与文案都取自配置，不在这里写死 */
function rateLimitedResponse(rl) {
  const msg = (rl.cfg && rl.cfg.message) || '请求过于频繁，请稍后再试';
  const h = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
  if (rl.retryAfter > 0) h['Retry-After'] = String(rl.retryAfter);
  return new Response(msg, { status: 429, headers: h });
}

/**
 * 临时访问链接：/<prefix>/<token>/<path> —— 命中且有效就按站点分发反代，
 * 否则按「没这个东西」处理（与伪装口径一致，不泄漏 token 是否存在过）。
 */
async function dispatchShare(request, url, ctx, env, cfg) {
  const prefix = String(cfg.path_prefix || '/s').replace(/\/+$/, '') + '/';
  const rest = url.pathname.slice(prefix.length);
  const token = rest.split('/')[0] || '';
  const r = await resolveShare(env, token);
  if (r.status === 'ok') {
    const tail = rest.slice(token.length);
    const sub = tail.startsWith('/') ? tail : (tail ? '/' + tail : '/');
    const proxied = new URL(`/p/${encodeURIComponent(r.site)}${sub}${url.search}`, url.origin);
    return await dispatchProxy(request, proxied, ctx, env);
  }
  // 过期 / 停用 / 不存在：提示文案统一，顺带按订阅的事件发一条告警
  if (ctx && typeof ctx.waitUntil === 'function' && r.status === 'expired') {
    ctx.waitUntil(notifyAlert(env, 'temp_link_expired', `有人访问了已失效的临时链接（${r.status}）`));
  }
  return friendlyError(
    '链接不可用',
    '这条临时链接已过期或已被停用，请联系发送者重新生成。',
    '',
    404,
    isNavigation(request)
  );
}

/** 给节点备注增强用的参数：统一收敛在这儿，两个订阅出口共用同一口径。 */
function tagOpts(env, ctx) {
  return {
    env,
    ctx,
    style: styleFrom(env),
    // 墙钟兜底：GeoIP 是外部请求，网络抖动不能把订阅请求拖到 Worker 超时。
    deadline: Date.now() + NODE_TAG_BUDGET_MS,
  };
}

/** 节点备注增强最多给多少毫秒（拿到就用，拿不到就原样返回节点）。 */
const NODE_TAG_BUDGET_MS = 8000;

// HTTP 入口路由： edgetunnel 端点 / 登录 / 管理 API / 管理页 / 反代通道
//
// 首页伪装启用时的访客分档（详见 src/disguise.js 顶部说明）：
//   陌生人（无 gate cookie、未登录）      -> 伪装首页，其余路径一律伪装 404
//   已进门未登录（有 gate cookie）        -> 真面板，/__api/* 返回 401 引导登录
//   已登录（ap_auth 有效）                -> 真面板，全部放行
// WebSocket 请求永不受伪装影响：代理节点可能把 path 配成 /，任何伪装都不能挡在前面。

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS 预检：反代页里的接口请求可能带自定义头，统一放行
  if (request.method === 'OPTIONS') {
    const h = new Headers({ 'Access-Control-Max-Age': '86400' });
    cors(h);
    return new Response(null, { status: 204, headers: h });
  }

  // 未配置 runtime.PASSWORD：一律提示配置，拒绝访问
  if (typeof runtime.PASSWORD === 'undefined' || !runtime.PASSWORD) {
    return noConfigPage();
  }

  // ===================== 首页伪装：访客分档 =====================
  const cfg = await readConfig(env);
  const cloaked = isActive(cfg);
  const authed = isAuthed(request);
  const gate = hasGate(request, cfg);
  // 陌生人：伪装已启用 + 既没进过门也没登录
  const stranger = cloaked && !gate && !authed;

  // WebSocket 一律先放行，伪装不参与：代理节点可能把 path 配成 / 或任意前缀，
  // 一旦被伪装拦截，客户端会直接断连（且很难从客户端日志定位到这里）。
  if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
    if (path === '/' || path === '/edt' || path.startsWith('/edt/')) {
      return await vlessHandler.fetch(request, { ...env, KV: runtime.KV }, ctx);
    }
  }

  // 隐蔽入口命中：下发 gate cookie 后跳回根路径。
  // 无论调用者登录与否都跳转，保证「进门方式」行为稳定；真正的门仍是 PASSWORD。
  if (cloaked && hitEntry(url, cfg)) {
    // 不能用 Response.redirect()：它返回的 Response headers 是 immutable guard，
    // 往里 append Set-Cookie 会直接抛 TypeError（Node 与 Workers 行为一致），
    // 结果是「隐蔽入口一点就 500」，把管理员锁在外面。这里手写 302。
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Cache-Control': 'no-store',
        'Set-Cookie': gateCookieValue(cfg, request),
      },
    });
  }

  // ---- 站点临时访问链接：配置开启时才启用，前缀可配 ----
  // 放在访客分档之前：临时链接本来就是给「没进过门的人」用的。
  const shareCfg = await readShareConfig(env);
  const sharePrefix = String(shareCfg.path_prefix || '/s').replace(/\/+$/, '') + '/';
  if (shareCfg.enabled && path.startsWith(sharePrefix)) {
    return await dispatchShare(request, url, ctx, env, shareCfg);
  }

  // ---- 限流与防滥用 ----
  // WebSocket 一律不参与：代理客户端的长连接被 429 会直接断线，且很难从客户端日志定位。
  const isWs = (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';
  if (!isWs) {
    const rl = await rateLimitCheck(env, request, { authed });
    if (!rl.allowed) {
      if (ctx && typeof ctx.waitUntil === 'function' && rl.reason === 'banned') {
        ctx.waitUntil(notifyAlert(env, 'ratelimit_block', `来访者 ${rl.ip} 已被封禁 ${rl.retryAfter} 秒`));
      }
      return rateLimitedResponse(rl);
    }
  }

  // ---- 订阅拉取：客户端行为（v2rayN / Clash 等拉取不带本站 cookie）----
  // 与 /tsub/ 同理，永不参与伪装门禁；token 由代理引擎内部校验，
  // 无效请求不会返回任何节点信息，放行不泄漏任何东西。
  if (path === '/sub' || path.startsWith('/sub/')) {
    // 多格式输出：?fmt=clash|singbox|base64 映射为引擎原生参数。
    // 唯一真源在 vendor/vless.js（内置 clash YAML / sing-box JSON / b64 渲染与 UA 自动识别，
    // 还支持 ?target=、surge、quanx、loon 等），这里只做参数映射，不另写转换实现。
    // 多格式响应已结构化，不做 vless 文本层面的国家标注（标注仅作用于原样输出）。
    const fmt = String(url.searchParams.get('fmt') || '').toLowerCase();
    let subReq = request;
    if (fmt === 'clash' || fmt === 'clashyaml') { url.searchParams.set('clash', '1'); subReq = new Request(url.toString(), request); }
    else if (fmt === 'singbox' || fmt === 'sing-box' || fmt === 'sing') { url.searchParams.set('singbox', '1'); subReq = new Request(url.toString(), request); }
    else if (fmt === 'base64' || fmt === 'b64') { url.searchParams.set('b64', '1'); subReq = new Request(url.toString(), request); }
    const resp = await vlessHandler.fetch(subReq, { ...env, KV: runtime.KV }, ctx);
    if (fmt === 'clash' || fmt === 'clashyaml' || fmt === 'singbox' || fmt === 'sing-box' || fmt === 'sing') return resp;
    // 订阅出口：给每个节点的备注补上 IP 归属国家。
    // 开关关闭时这里一次都不会触发，不产生任何外部请求或存储读取。
    if (!(await subscriptionTaggingEnabled(env))) return resp;
    return await tagSubscriptionResponse(resp, tagOpts(env, ctx));
  }

  // ---- 陌生人：只允许「一个普通网站该有的东西」，其余一律伪装 404 ----
  if (stranger) {
    if (path === '/favicon.ico') return emptyFavicon();
    if (path === '/robots.txt') return renderRobots();
    if (path === '/') return renderHome(cfg, request);
    // 反代通道保持可用：这是站点的正常使用路径，把访客挡在外面反而更可疑
    if (path.startsWith('/p/')) return await dispatchProxy(request, url, ctx, env);
    // 临时订阅：订阅拉取是客户端行为，不带 cookie，按 id + 时效自校验放行
    if (path.startsWith('/tsub/')) return await dispatchTempSub(request, url, env, ctx);
    // 登录 / 登出必须匿名可达：面板 401 后要跳登录页，Actions 自愈也靠它取 cookie
    if (path === '/__api/login') return handleLogin(request, env);
    if (path === '/__api/logout') return handleLogout(cfg);
    if (path === '/__login') return await loginPageResp(cfg, cloaked, env);
    // 前缀丢失自愈也覆盖伪装开启的场景：反代通道对访客本就可达，
    // 客户端拼错前缀时同样要能救回来，否则伪装开着就等于站点废了。
    {
      const healed = await healLostPrefix(request, url, env);
      if (healed) return healed;
    }
    return renderNotFound(cfg, request);
  }

  // VLESS / Trojan / SS 代理端点（edgetunnel 内嵌，前缀 /edt）：
  // 客户端配置：地址=优选IP或域名，端口=443，TLS开，SNI/Host=本域名，路径=/edt，UUID 见 README
  if (path === '/edt' || path.startsWith('/edt/')) {
    const u = new URL(request.url);
    u.pathname = path === '/edt' ? '/' : path.slice(4);
    const req = new Request(u.toString(), request);
    // edgetunnel 依赖 env.KV（登录/日志/ADD.txt），注入为我们的 SITES 绑定
    const resp = await vlessHandler.fetch(req, { ...env, KV: runtime.KV }, ctx);
    // edgetunnel 内部跳转是根路径（/admin /login），补上前缀，保证登录/跳转正常
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('Location');
      if (loc && loc.startsWith('/') && !loc.startsWith('/edt')) {
        resp.headers.set('Location', '/edt' + loc);
      }
    }
    // /edt 下的面板 / 登录页 HTML 也注入「返回主页」悬浮按钮（兼容 /edt/admin 旧路径）
    // 伪装开启时不注入：悬浮按钮是面板存在的活招牌，且此时 / 是伪装页，按钮本身也没用。
    if (!cloaked && resp.status === 200 && (resp.headers.get('content-type') || '').includes('text/html')) {
      const text = await resp.text();
      const h = new Headers(resp.headers);
      // body 已解压为明文，清掉压缩头与旧长度，避免浏览器按 gzip 解明文
      h.delete('content-encoding');
      h.delete('content-length');
      return new Response(injectHomeButton(text), { status: 200, headers: h });
    }
    return resp;
  }

  // edgetunnel 管理面板使用根路径（页面 JS 内 API 均为 /admin/...，无法加前缀），
  // 将 /admin /login /logout 转发给代理引擎（与 any-proxy 的 /__admin /__login 不冲突）
  // 临时订阅拉取：/tsub/<id>（其后的查询参数透传给 /sub）。
  // 命中有效临时记录后，以该记录的 UUID 作为 env.UUID 调用代理引擎，
  // 生成与主订阅完全一致、仅 UUID 不同的节点；不修改任何面板配置。
  if (path.startsWith('/tsub/')) {
    return await dispatchTempSub(request, url, env, ctx);
  }

  if (path === '/login' || path === '/admin' || path.startsWith('/admin/') || path === '/logout') {
    // 统一登出：面板/主页任何登出入口都同时清除两个子系统的 cookie，并回主页
    if (path === '/logout') {
      const h = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
      h.append('Set-Cookie', 'ap_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
      h.append('Set-Cookie', 'auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
      // 伪装开启时一并清除「进门」标记：否则登出后根路径仍是真面板，等于没登出
      if (cloaked) h.append('Set-Cookie', expiredGateCookie(cfg));
      h.append('Location', '/');
      return new Response('<!DOCTYPE html><meta charset="utf-8"><script>location.href="/"</script>已登出', { status: 302, headers: h });
    }
    const resp = await vlessHandler.fetch(request, { ...env, KV: runtime.KV }, ctx);
    // 面板登录成功（Set-Cookie auth）时同步种 ap_auth，保证站点管理子系统也是登录态
    if (path === '/login' && request.method === 'POST' && (resp.headers.get('Set-Cookie') || '').includes('auth=')) {
      const h = new Headers(resp.headers);
      h.append('Set-Cookie', `ap_auth=${b64(runtime.PASSWORD)}; Path=/; Max-Age=172800; HttpOnly; SameSite=Lax; Secure`);
      return new Response(resp.body, { status: resp.status, headers: h });
    }
    // 面板 / 登录页 HTML 注入「返回主页」悬浮按钮（人性化导航回统一入口）
    if (!cloaked && resp.status === 200 && (path === '/admin' || path === '/login' || path.startsWith('/admin/')) && (resp.headers.get('content-type') || '').includes('text/html')) {
      const text = await resp.text();
      const h = new Headers(resp.headers);
      // body 已解压为明文，清掉压缩头与旧长度，避免浏览器按 gzip 解明文
      h.delete('content-encoding');
      h.delete('content-length');
      return new Response(injectHomeButton(text), { status: 200, headers: h });
    }
    return resp;
  }

  // 登录相关（放行）
  if (path === '/__login' || path === '/__api/login' || path === '/__api/logout') {
    if (request.method === 'POST' && path === '/__api/login') return handleLogin(request, env);
    if (path === '/__api/logout') return handleLogout(cfg);
    return await loginPageResp(cfg, cloaked, env);
  }

  // 管理页 / 首页
  if (path === '/' || path === '/__admin') {
    const resp = await adminPage(authed, url.origin, env);
    // 防缓存：历史出现浏览器/CF边缘缓存旧版HTML导致列表一直加载中
    resp.headers.set('Cache-Control', 'no-store');
    return resp;
  }

  // 临时订阅管理页：仅登录后可访问
  if (path === '/__tsub') {
    if (!authed) return Response.redirect(new URL('/__login', request.url).toString(), 302);
    const resp = await tempSubPage(url.origin);
    resp.headers.set('Cache-Control', 'no-store');
    return resp;
  }

  // API
  if (path.startsWith('/__api')) {
    // 只读接口白名单：默认未登录可读（站点列表 / 配置探测 / DNS 频率配置 / 上游测速 / 优选池 / 订阅候选）。
    // 伪装开启且严格模式时清空白名单 —— 这些接口会把站点名、目标域名、优选 IP、订阅源直接交给陌生人。
    const publicGet = cloaked && cfg.strict ? [] : PUBLIC_GET;
    if (request.method === 'GET' && publicGet.includes(path)) {
      return handleAdmin(request, url, env);
    }
    // 其余（包含上述白名单在严格模式下收窄的部分）：需要登录
    if (!authed) {
      return json({ error: 'unauthorized', message: '请先登录' }, 401);
    }
    return handleAdmin(request, url, env);
  }

  // 反向代理 /p/{id}/...：无需登录，访问链接可直接打开
  if (path.startsWith('/p/')) {
    return await dispatchProxy(request, url, ctx, env);
  }

  // 前缀丢失自愈：客户端用绝对路径拼代理地址时会吃掉 /p/<id>，请求落到代理根上。
  // 命中才接管，否则继续走下面的常规分支（见 healLostPrefix 里的收窄条件）。
  {
    const healed = await healLostPrefix(request, url, env);
    if (healed) return healed;
  }

  // 其余路径：
  //   伪装开启 -> 伪装 404。绝不能 302 到 /__admin，Location 头会把面板命名空间直接交给扫描器。
  //   未开启   -> 回管理页（保持历史行为）
  if (cloaked) return renderNotFound(cfg, request);
  return Response.redirect(new URL('/__admin', request.url).toString(), 302);
}

/** 未登录可读的 GET 接口。集中定义，便于伪装模式一键收窄 */
const PUBLIC_GET = [
  '/__api/sites', '/__api/config', '/__api/dns-config',
  '/__api/speedtest', '/__api/preferred-ips', '/__api/preferred-candidates',
];

/**
 * 临时订阅拉取 /tsub/<id>：客户端行为（订阅拉取不带任何本站 cookie），
 * 因此凭 id + 有效期自校验，不参与伪装门禁。
 */
async function dispatchTempSub(request, url, env, ctx) {
  const m = url.pathname.match(/^\/tsub\/([^/]+)(\/.*)?$/);
  if (!m) return renderNotFoundFallback();
  const rec = await getTempSub(decodeURIComponent(m[1]));
  if (!isTempSubActive(rec)) {
    // 404 而非带明文原因的 403：不向探测者解释失败原因，也不暴露这是订阅端点
    return renderNotFoundFallback();
  }
  // 与主订阅同一口径计算 token：MD5MD5(host + uuid)，host 取请求 hostname。
  const token = await tempSubToken(url.hostname, rec.uuid);
  const subUrl = new URL(request.url);
  subUrl.pathname = '/sub';
  subUrl.searchParams.set('token', token);
  const subReq = new Request(subUrl.toString(), request);
  const resp = await vlessHandler.fetch(subReq, { ...env, KV: runtime.KV, UUID: rec.uuid }, ctx);
  // 临时订阅同样支持多格式输出：/tsub/<id>?fmt=clash|singbox|base64 → 引擎原生参数
  const fmt = String(url.searchParams.get('fmt') || '').toLowerCase();
  if (fmt === 'clash' || fmt === 'clashyaml' || fmt === 'singbox' || fmt === 'sing-box' || fmt === 'sing') return resp;
  // 临时订阅同样是订阅输出，备注规则与主订阅保持一致
  if (!(await subscriptionTaggingEnabled(env))) return resp;
  return await tagSubscriptionResponse(resp, tagOpts(env, ctx));
}

function renderNotFoundFallback() {
  return new Response('Not Found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * 前缀丢失自愈：把「打到代理根、但本属于某个反代站点」的请求挂回它的前缀。
 *
 * 起因是 URL 规范决定的客户端拼接行为：客户端把代理地址当 base，与以 / 开头的
 * 绝对路径（如 Emby 的 DirectStreamUrl=/play/video/...）做拼接时，前导斜杠表示
 * 「从域名根开始」，base 里的 /p/<id> 会被整个吃掉：
 *   new URL("/play/video/x", "https://proxy/p/uhdnow")  ->  https://proxy/play/video/x
 * 于是播放地址脱离代理命名空间，请求落到代理根上变成 404，播放器反复重试、
 * 流量打满却始终播不了。
 *
 * 兜底条件收得很紧，保证绝不会误伤代理自身的路径：
 *   - 站点恰好只有一个（多站点时无法判断该回填谁，宁可不动）
 *   - 路径不以 /p/ /edt /tsub /admin /login /sub /__ /favicon /robots 开头
 *   - 只回填带查询串的 GET/HEAD（绝对 URL 拼接必然带走原查询串，
 *     Emby 的 ?api_key= / ?UserId= 等都在其中）
 */
async function healLostPrefix(request, url, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const path = url.pathname;
  if (!url.search) return null;
  if (path === '/' || path === '') return null;
  if (/^\/(?:p|edt|tsub|admin|login|logout|sub|__[a-z]*|favicon\.ico|robots\.txt)(?:\/|$)/.test(path)) return null;

  let sites;
  try { sites = await listSites(); } catch { return null; }
  if (!Array.isArray(sites) || sites.length !== 1) return null;

  const healed = new URL(url.toString());
  healed.pathname = `/p/${sites[0].id}${path}`;
  return dispatchProxy(new Request(healed.toString(), request), healed, null, env);
}

/** 反向代理 /p/{id}/...：无需登录，伪装开启时同样放行（这是站点的正常使用路径） */
async function dispatchProxy(request, url, ctx, env) {
  const path = url.pathname;
  const m = path.match(/^\/p\/([^/]+)(\/.*)?$/);
  const id = decodeURIComponent(m[1]);
  const site = await getSite(id);
  if (!site) {
    return friendlyError('站点不存在', `代理地址 <b>/p/${esc(id)}/</b> 没有对应的内容，请确认链接是否正确。`, '', 404, isNavigation(request));
  }
  const prefix = '/p/' + id;
  const rest = path.slice(prefix.length) || '/';
  // 跨域通道：/p/<id>/__x/<host>/<path> —— 页面用到的任何第三方域资源/接口都从这里走
  const xm = rest.match(/^\/__x\/([^/]+)(\/.*)?$/);
  const crossHost = xm ? decodeURIComponent(xm[1]) : null;
  if (crossHost && !/^[a-zA-Z0-9._-]+(:[0-9]{1,5})?$/.test(crossHost)) {
    return friendlyError('非法请求', '跨域通道的主机名不合法。', '', 400, isNavigation(request));
  }
  if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
    return handleWebSocket(request, site, crossHost);
  }
  try {
    return await proxyRequest(request, site, crossHost, ctx, env);
  } catch (e) {
    return friendlyError('代理请求失败', `无法连接到目标站 <b>${esc(crossHost || site.host)}</b>：${esc(e && e.message || '网络错误')}`, url.href, 502, isNavigation(request));
  }
}

/**
 * 登录页：普通页面身份返回（面板 401 后跳转、Actions 自愈取 cookie 都经过这里）。
 * 伪装开启时脱掉品牌字样与项目名称，页面本身不泄漏任何身份信息。
 */
async function loginPageResp(cfg, cloaked, env) {
  const resp = await loginPage({ plain: !!cloaked, title: cloaked ? cfg.title : '' }, env);
  resp.headers.set('Cache-Control', 'no-store');
  return resp;
}

export { handleRequest };
