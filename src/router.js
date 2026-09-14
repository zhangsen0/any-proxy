import vlessHandler from '../vendor/vless.js';
import { json, b64, esc, isNavigation } from './util.js';
import { bindRuntime, runtime } from './runtime.js';
import { getSite } from './sites.js';
import { isAuthed, handleLogin, handleLogout, loginPage } from './auth.js';
import { adminPage, handleAdmin } from './admin.js';
import { proxyRequest, friendlyError, handleWebSocket } from './proxy.js';
import { injectHomeButton } from './inject.js';
import { CROSS_PREFIX } from './url.js';
import { scheduledDnsCheck } from './dns.js';

// HTTP 入口路由： edgetunnel 端点 / 登录 / 管理 API / 管理页 / 反代通道

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
    if (resp.status === 200 && (resp.headers.get('content-type') || '').includes('text/html')) {
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
  if (path === '/login' || path === '/admin' || path.startsWith('/admin/') || path === '/logout' || path === '/sub' || path.startsWith('/sub/')) {
    // 统一登出：面板/主页任何登出入口都同时清除两个子系统的 cookie，并回主页
    if (path === '/logout') {
      const h = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
      h.append('Set-Cookie', 'ap_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
      h.append('Set-Cookie', 'auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
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
    if (resp.status === 200 && (path === '/admin' || path === '/login' || path.startsWith('/admin/')) && (resp.headers.get('content-type') || '').includes('text/html')) {
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
    if (path === '/__api/logout') return handleLogout();
    const resp = loginPage();
    resp.headers.set('Cache-Control', 'no-store');
    return resp;
  }

  const authed = isAuthed(request);

  // 管理页 / 首页：未登录也可查看（只读模式：仅站点列表 + 复制）
  if (path === '/' || path === '/__admin') {
    const resp = await adminPage(authed, url.origin, env);
    // 防缓存：历史出现浏览器/CF边缘缓存旧版HTML导致列表一直加载中
    resp.headers.set('Cache-Control', 'no-store');
    return resp;
  }

  // API
  if (path.startsWith('/__api')) {
    // 只读接口：未登录也放行（站点列表 / 配置探测 / DNS 频率配置 / 上游测速 / 优选池 / 订阅候选）
    if (request.method === 'GET' && (path === '/__api/sites' || path === '/__api/config' || path === '/__api/dns-config' || path === '/__api/speedtest' || path === '/__api/preferred-ips' || path === '/__api/preferred-candidates')) {
      return handleAdmin(request, url, env);
    }
    // 其余（添加 / 删除 / 更新等写操作）：需要登录
    if (!authed) {
      return json({ error: 'unauthorized', message: '请先登录' }, 401);
    }
    return handleAdmin(request, url, env);
  }

  // 反向代理 /p/{id}/...：无需登录，访问链接可直接打开
  const m = path.match(/^\/p\/([^/]+)(\/.*)?$/);

  if (m) {
    const id = decodeURIComponent(m[1]);
    const site = await getSite(id);
    if (!site) {
      return friendlyError('站点不存在', `代理地址 <b>/p/${esc(id)}/</b> 尚未配置对应站点，请到管理页添加后再访问。`, '', 404, isNavigation(request));
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
      return await proxyRequest(request, site, crossHost, ctx);
    } catch (e) {
      return friendlyError('代理请求失败', `无法连接到目标站 <b>${esc(crossHost || site.host)}</b>：${esc(e && e.message || '网络错误')}`, request.url, 502, isNavigation(request));
    }
  }

  // 其余路径 -> 管理页
  return Response.redirect(new URL('/__admin', request.url).toString(), 302);
}

export { handleRequest };
