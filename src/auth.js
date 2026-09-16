import { json, b64, esc } from './util.js';
import { MD5MD5 } from '../vendor/vless.js';
import { runtime } from './runtime.js';
// 伪装模块只用到「清除进门标记」，直接内联该 cookie 名规则，避免 auth <-> disguise 互相依赖
import { expiredGateCookie } from './disguise.js';

// 统一口令的登录态：主页 / 管理页共用一份 Cookie

/** 校验请求是否已登录（Cookie auth 与口令匹配） */
function isAuthed(req) {
  const cookie = req.headers.get('Cookie') || '';
  const hit = cookie
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('ap_auth='));
  return !!hit && hit.slice(8) === b64(runtime.PASSWORD);
}

async function handleLogin(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {}
  if (body.password === runtime.PASSWORD) {
    const secure = request.url.startsWith('https:') ? '; Secure' : '';
    // 统一登录：同时种两套 cookie
    //  - ap_auth：any-proxy 管理页（站点管理）
    //  - auth：edgetunnel 代理面板（/admin），值与 UA+KEY+runtime.PASSWORD 绑定
    const ua = request.headers.get('User-Agent') || '';
    const key = (env && env.KEY) || '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改';
    const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
    h.append('Set-Cookie', `ap_auth=${b64(runtime.PASSWORD)}; Path=/; Max-Age=172800; HttpOnly; SameSite=Lax${secure}`);
    h.append('Set-Cookie', `auth=${await MD5MD5(ua + key + runtime.PASSWORD)}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax${secure}`);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
  }
  return json({ error: '密码错误' }, 401);
}

function handleLogout(cfg) {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  h.append('Set-Cookie', 'ap_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  h.append('Set-Cookie', 'auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  // 一并清除「进门」标记：否则登出后根路径仍是真面板，等于没真正登出
  if (cfg) h.append('Set-Cookie', expiredGateCookie(cfg));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
}

/**
 * 登录页。
 * opts.plain = true（首页伪装开启时）：脱掉项目名称与功能描述，只保留口令输入框 ——
 * 否则陌生人只要猜到 /__login 就能确认「这是个代理面板」。
 * opts.plain 下的标题取伪装配置的站点标题（管理员自己的文案），不回落到任何内置品牌名。
 */
function loginPage(opts = {}) {
  const plain = !!(opts && opts.plain);
  const brand = plain ? String((opts && opts.title) || '').trim() : 'Any-Proxy';
  const pageTitle = brand ? `登录 · ${esc(brand)}` : '登录';
  const h1 = brand ? esc(brand) : '进入';
  const sub = plain ? '请输入访问口令以继续' : '统一代理入口 · 多站反向代理 + 优选 IP 节点，一个域名全部搞定';
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${pageTitle}</title>
  <style>
  :root { --bg:#f4f6fb; --card:#ffffff; --line:#e2e8f0; --txt:#0f172a; --muted:#64748b; --accent:#2563eb; --accent-hover:#1d4ed8; --ok:#16a34a; --err:#dc2626; --input:#f1f5f9; --on-accent:#ffffff; --radius:14px; --radius-sm:10px; --radius-xs:8px; --shadow:0 1px 2px rgba(15,23,42,.04), 0 6px 18px rgba(15,23,42,.06); --ring:0 0 0 3px rgba(37,99,235,.18); --err-bg:rgba(220,38,38,.10); --hover:rgba(100,116,139,.06); }
  :root[data-theme="dark"] { --bg:#0f172a; --card:#1e293b; --line:#334155; --txt:#e2e8f0; --muted:#94a3b8; --accent:#38bdf8; --accent-hover:#7dd3fc; --ok:#4ade80; --err:#f87171; --input:#0b1220; --on-accent:#06283d; --shadow:0 1px 2px rgba(0,0,0,.30), 0 8px 24px rgba(0,0,0,.35); --ring:0 0 0 3px rgba(56,189,248,.25); --err-bg:rgba(248,113,113,.12); --hover:rgba(148,163,184,.08); }
  @media (prefers-color-scheme: dark) { :root[data-theme="auto"] { --bg:#0f172a; --card:#1e293b; --line:#334155; --txt:#e2e8f0; --muted:#94a3b8; --accent:#38bdf8; --accent-hover:#7dd3fc; --ok:#4ade80; --err:#f87171; --input:#0b1220; --on-accent:#06283d; --shadow:0 1px 2px rgba(0,0,0,.30), 0 8px 24px rgba(0,0,0,.35); --ring:0 0 0 3px rgba(56,189,248,.25); --err-bg:rgba(248,113,113,.12); --hover:rgba(148,163,184,.08); } }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif; background:var(--bg); color:var(--txt); min-height:100vh; font-size:14px; line-height:1.6; -webkit-font-smoothing:antialiased; display:flex; align-items:center; justify-content:center; }
  .box { width:340px; max-width:92vw; background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:28px 24px; position:relative; box-shadow:var(--shadow); }
  #themeBtn { position:absolute; top:10px; right:10px; background:transparent; color:var(--muted); border:1px solid var(--line); padding:5px 10px; font-size:12px; border-radius:var(--radius-xs); margin:0; width:auto; cursor:pointer; transition:color .15s, border-color .15s, background .15s; }
  #themeBtn:hover { color:var(--txt); border-color:var(--muted); background:var(--hover); }
  h1 { font-size:19px; margin:0 0 4px; letter-spacing:-.01em; }
  .sub { color:var(--muted); font-size:13px; margin:0 0 22px; line-height:1.6; }
  input { width:100%; padding:11px 12px; border-radius:var(--radius-sm); border:1px solid var(--line); background:var(--input); color:var(--txt); font-size:14px; outline:none; transition:border-color .15s, box-shadow .15s; }
  input:focus, input:focus-visible { border-color:var(--accent); box-shadow:var(--ring); }
  input:hover:not(:focus) { border-color:var(--muted); }
  button { width:100%; margin-top:16px; padding:11px; border:none; border-radius:var(--radius-sm); font-size:15px; cursor:pointer; background:var(--accent); color:var(--on-accent); font-weight:600; transition:background .15s, transform .05s, box-shadow .15s; }
  button:hover { background:var(--accent-hover); }
  button:active { transform:translateY(1px); }
  button:focus-visible { outline:none; box-shadow:var(--ring); }
  button:disabled { opacity:.5; cursor:not-allowed; transform:none; }
  .msg { font-size:13px; margin-top:12px; min-height:18px; line-height:1.5; }
  .msg.err { color:var(--err); }
</style>
</head>
<body>
<div class="box">
  <button type="button" id="themeBtn"></button>
  <h1>${h1}</h1>
  <div class="sub">${sub}</div>
  <input type="password" id="pw" placeholder="访问口令" autofocus>
  <button id="btn">登录</button>
  <div class="msg err" id="msg"></div>
</div>
<script>
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: '跟随系统', light: '亮色', dark: '暗色' };
const saved = localStorage.getItem('ap_theme') || 'auto';
document.documentElement.dataset.theme = saved;
const themeBtn = document.getElementById('themeBtn');
themeBtn.textContent = THEME_LABEL[saved];
themeBtn.onclick = () => {
  const next = THEMES[(THEMES.indexOf(document.documentElement.dataset.theme) + 1) % 3];
  document.documentElement.dataset.theme = next;
  localStorage.setItem('ap_theme', next);
  themeBtn.textContent = THEME_LABEL[next];
};
const pw = document.getElementById('pw');
const btn = document.getElementById('btn');
const msg = document.getElementById('msg');
async function doLogin() {
  msg.textContent = '';
  if (!pw.value) { msg.textContent = '请输入口令'; return; }
  btn.disabled = true;
  try {
    const r = await fetch('/__api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password: pw.value }) });
    if (r.ok) { location.href = '/__admin'; }
    else { msg.textContent = '口令错误'; }
  } catch(e) { msg.textContent = '请求失败'; }
  btn.disabled = false;
}
btn.onclick = doLogin;
pw.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function noConfigPage() {
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Service Unavailable</title>
<style>body{margin:0;font-family:-apple-system,"PingFang SC",system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}.box{max-width:560px;background:#1e293b;border:1px solid #334155;border-radius:14px;padding:28px 26px}h1{font-size:19px;margin:0 0 10px}code{background:#0b1220;color:#7dd3fc;padding:2px 6px;border-radius:4px;font-size:13px}p{color:#94a3b8;font-size:14px;line-height:1.7}</style>
</head><body><div class="box"><h1>服务暂时不可用</h1>
<p>本站尚未完成配置，请稍后再试。</p>
</div></body></html>`;
  // 503 而非 200：健康依赖 HTTP 状态码判活（优选探测、Actions 自愈、跨站测速都看状态码），
  // 若返回 200 会被误判为「该 IP 可用」，进而污染优选池与 A 记录。
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// ===================== 反向代理 =====================

/**
 * 反向代理核心：把请求转发到目标站，并把响应内容里的 URL 映射回代理命名空间。
 *
 * 通用性约定（不含任何站点 / 域名 / 路径的特判）：
 *   - 主通道   /p/<id>/<path>              -> 站点自身域
 *   - 跨域通道 /p/<id>/__x/<host>/<path>   -> 任意第三方域（页面用到的任何外部资源/接口）
 * 两套通道共用同一套重写规则，因此任何站点的资源、接口、跳转都会留在代理内，不会被浏览器直连。
 */

export { isAuthed, handleLogin, handleLogout, loginPage, noConfigPage };
