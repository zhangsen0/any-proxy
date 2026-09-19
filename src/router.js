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
import { scheduledDnsCheck, resolveProxyHost } from './dns.js';
import {
  readConfig, isActive, hitEntry, hasGate, gateCookieValue, expiredGateCookie,
  renderHome, renderNotFound, renderRobots, emptyFavicon,
} from './disguise.js';
import { subscriptionTaggingEnabled, styleFrom, tagSubscriptionResponse } from './nodetag.js';
import { sortSubscriptionResponse } from './sublat.js';
import { engineEnvFor, nodeIdentity, readSettings, SETTINGS_SPEC } from './settings.js';
import { renderClashYaml, renderSingboxJson } from './native-sub.js';
import { check as rateLimitCheck } from './ratelimit.js';
import { readShareConfig, resolve as resolveShare } from './share.js';
import { notify as notifyAlert } from './alert.js';

/**
 * 调用代理引擎时用的运行环境。
 *
 * 引擎（vendor/vless.js）每次请求都会用环境变量与请求上下文覆盖它自己那份
 * config.json 里的 UUID / HOSTS / PATH，所以面板上改「节点 ID / 节点地址 / 路径」
 * 曾经保存成功却完全不生效。这里把面板值回灌成引擎认的环境变量，
 * 让「面板 → 存储 → 引擎」成为一条链（详见 settings.js 的 engineEnvFor）。
 *
 * 默认值与环境变量种子相同，所以没在面板上改过的部署行为与改动前一致。
 */
function engineEnv(env, extra = {}) {
  return engineEnvFor(env, { KV: runtime.KV, ...extra });
}

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
/**
 * 标注参数。样式必须 await 注册表 —— 面板把样式存在 KV 里，
 * 早先这里同步读环境变量，于是「面板改了样式、订阅输出没变」。
 */
async function tagOpts(env, ctx, deadlineMs) {
  // 墙钟兜底：GeoIP 是外部请求，网络抖动不能把订阅请求拖到 Worker 超时。
  // 预算值一律来自运行参数（面板可改），这里不另写一个数字 ——
  // 曾经写死 8000，而延迟排序还有它自己的 8000，两步串行 16 秒直接把订阅拖到下载不下来。
  const cfg = await readSettings(env);
  const budget = Number(cfg.sub_enhance_budget_ms) || SETTINGS_SPEC.sub_enhance_budget_ms.default;
  return {
    env,
    ctx,
    style: await styleFrom(env),
    deadline: deadlineMs || Date.now() + budget,
  };
}

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
      return await vlessHandler.fetch(request, await engineEnv(env), ctx);
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
    // 多格式输出。
    //
    // clash / sing-box 由**本文件本地渲染**（native-sub.js）：拿引擎的 mixed 输出
    // （vless:// 行列表，本地生成、一直可靠），渲染成对应格式。
    //
    // 为什么不再转给引擎：引擎的这两种格式走「外部订阅转换后端」（SUBAPI）——
    // 默认值是个占位假域名，面板没有改它的入口，而那台后端一旦坏掉（2026-09-20
    // 就坏了），Stash 这类只吃 YAML 的客户端拿到的是伪装页 HTML，报
    // 「yaml: found character that cannot start any token」，看起来像订阅坏了，
    // 实际是转换后端单点故障。注释里写的「内置渲染」必须真的内置，才算数。
    //
    // base64 与未识别的客户端维持原路径：引擎 mixed ＋ 国家标注 ＋ 延迟重排
    // （这两个增强只作用于原样输出，多格式响应已结构化，不做文本层面标注）。
    const fmt = String(url.searchParams.get('fmt') || '').toLowerCase();
    const ua = (request.headers.get('User-Agent') || '').toLowerCase();
    // UA 自动识别：客户端不用改链接就能拿到对的格式（Stash / mihomo / Clash 系
    // 的 UA 都带自家名字；带 fmt 参数时以参数为准）。
    const wantClash = fmt === 'clash' || fmt === 'clashyaml'
      || (!fmt && /\b(clash|mihomo|stash|verge|meta)\b|clash\.(meta|verge)|mihomo\//.test(ua));
    const wantSb = fmt === 'singbox' || fmt === 'sing-box' || fmt === 'sing'
      || (!fmt && /sing-?box|\bsfa\b|\bsfm\b|\bsfi\b/.test(ua));
    if (wantClash || wantSb) {
      return await nativeSubResponse(request, url, env, ctx, wantClash ? 'clash' : 'singbox');
    }
    let subReq = request;
    if (fmt === 'base64' || fmt === 'b64') { url.searchParams.set('b64', '1'); subReq = new Request(url.toString(), request); }
    const resp = await vlessHandler.fetch(subReq, await engineEnv(env), ctx);
    // 订阅出口的两层增强（都可以在面板关掉，关掉就是原样透传）：
    //   1. 给节点备注补 IP 归属国家；
    //   2. 把节点按实测延迟重排 —— 客户端通常拿第一个节点用，所以顺序就是速度。
    //
    // 两步**共用一个总预算**（不是各一份）：订阅是整个服务的入口，为了「顺序更好看」
    // 把它拖到十几秒、甚至被平台直接杀掉（HTTP 503 / error 1102，客户端表现为订阅下载
    // 不下来），代价远大于收益。超时或任一步出错就退回引擎原文 —— 宁可不排序，也要能用。
    const cfgSub = await readSettings(env);
    const budgetMs = Number(cfgSub.sub_enhance_budget_ms) || SETTINGS_SPEC.sub_enhance_budget_ms.default;
    const deadlineMs = Date.now() + budgetMs;
    // body 还没被读过才有 clone 可用，所以兜底必须在任何 await resp.text() 之前留一份
    const plain = resp.clone();
    const baseOpts = await tagOpts(env, ctx, deadlineMs);
    let timer = null;
    const enhance = (async () => {
      let out = resp;
      if (await subscriptionTaggingEnabled(env)) out = await tagSubscriptionResponse(out, baseOpts);
      return await sortSubscriptionResponse(out, {
        ...baseOpts,
        deadlineMs,
        host: (await resolveProxyHost(env, url.hostname)) || url.hostname,
      });
    })();
    try {
      const guardP = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('sub enhance budget exceeded')), Math.max(200, deadlineMs - Date.now()));
      });
      return await Promise.race([enhance, guardP]);
    } catch {
      return plain;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * clash / sing-box 的本地渲染出口（native-sub.js 承担解析与渲染）。
   *
   * 内层再发一次 /sub、UA 定成浏览器：让引擎走 mixed 分支（本地生成、明文输出），
   * 这是整条订阅链里唯一不依赖外部服务的一环。token 原样带着 —— 引擎会校验，
   * 校验不过内层就是伪装页，那正好被下面「没有分享链接行」的判定接住，
   * 给客户端一个说人话的 503，而不是一份把客户端解析器炸掉的 HTML。
   */
  async function nativeSubResponse(req, subUrl, e, c2, kind) {
    const innerUrl = new URL(subUrl);
    for (const k of ['fmt', 'clash', 'clashyaml', 'singbox', 'sing-box', 'sing', 'b64', 'base64', 'target', 'surge', 'quanx', 'loon']) {
      innerUrl.searchParams.delete(k);
    }
    const inner = new Request(innerUrl.toString(), {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; native-sub/1; +https://github.com/zhangsen0/any-proxy)' },
    });
    const mixed = await vlessHandler.fetch(inner, await engineEnv(e), c2);
    const text = await mixed.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const share = lines.filter(l => /^(vless|trojan|ss):\/\//i.test(l));
    const say = (body, status, extra = {}) => new Response(body, {
      status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
    });
    if (!share.length) {
      // 引擎连 mixed 都没给出来（token 不对 / 数据不在）：此时说什么都要比回 HTML 强
      return say('订阅当前不可用：服务端没有取到节点清单（常见于存储降级中）。'
        + '链接本身没错，稍后重试；若持续，请进管理面板看顶部运行模式。', 503);
    }
    // 引擎在 mixed 响应上带的流量信息头（Subscription-Userinfo 等）原样透传
    const info = {};
    for (const h of ['subscription-userinfo', 'profile-update-interval', 'profile-web-page-url']) {
      const v = mixed.headers.get(h);
      if (v) info[h] = v;
    }
    if (kind === 'clash') {
      const r = renderClashYaml(share);
      if (!r.yaml) return say(`订阅当前不可用：拿到 ${r.total} 行链接但一行都解析不出来。`, 503, info);
      return say(r.yaml, 200, {
        'Content-Type': 'application/x-yaml; charset=utf-8',
        'Content-Disposition': `attachment; filename*=utf-8''${encodeURIComponent('config.yaml')}`,
        ...(r.skipped ? { 'X-Sub-Skipped-Lines': String(r.skipped) } : {}),
        ...info,
      });
    }
    const r = renderSingboxJson(share);
    if (!r.json) return say(`订阅当前不可用：拿到 ${r.total} 行链接但一行都解析不出来。`, 503, info);
    return say(r.json, 200, {
      'Content-Type': 'application/json; charset=utf-8',
      ...(r.skipped ? { 'X-Sub-Skipped-Lines': String(r.skipped) } : {}),
      ...info,
    });
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
    const resp = await vlessHandler.fetch(req, await engineEnv(env), ctx);
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
    const resp = await vlessHandler.fetch(request, await engineEnv(env), ctx);
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
  // 与主订阅同一口径计算 token：MD5MD5(host + uuid)。host 取「面板配的节点地址优先，
  // 否则本次请求的 hostname」—— 引擎拿到的身份由 engineEnv() 注入，两边必须同源，
  // 否则面板一配节点地址，临时订阅链接就会 404。
  const id = await nodeIdentity(env, url.hostname);
  const token = await tempSubToken(id.host, rec.uuid);
  const subUrl = new URL(request.url);
  subUrl.pathname = '/sub';
  subUrl.searchParams.set('token', token);
  const subReq = new Request(subUrl.toString(), request);
  const resp = await vlessHandler.fetch(subReq, await engineEnv(env, { UUID: rec.uuid }), ctx);
  // 临时订阅同样支持多格式输出：/tsub/<id>?fmt=clash|singbox|base64 → 引擎原生参数
  const fmt = String(url.searchParams.get('fmt') || '').toLowerCase();
  if (fmt === 'clash' || fmt === 'clashyaml' || fmt === 'singbox' || fmt === 'sing-box' || fmt === 'sing') return resp;
  // 临时订阅同样是订阅输出，备注规则与主订阅保持一致
  if (!(await subscriptionTaggingEnabled(env))) return resp;
  return await tagSubscriptionResponse(resp, await tagOpts(env, ctx));
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
