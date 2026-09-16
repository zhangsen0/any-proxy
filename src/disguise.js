/**
 * 首页伪装：让根路径渲染成一个普通站点，把管理面板藏到隐蔽入口。
 *
 * 设计原则（与全项目一致）：不含任何站点 / 域名 / 品牌 / 业务数据，
 * 一切由配置驱动。三级取值：KV 面板配置 → 环境变量种子（回写 KV）→ 明确停用。
 * 绝不内置会悄悄生效的兜底文案。
 *
 * 三档访客模型：
 *   陌生人（无 gate cookie）      -> 伪装首page，/__api/* 一律伪装 404
 *   已进门未登录（有 gate cookie）-> 真面板，/__api/* 返回 401 让面板正常引导登录
 *   已登录（ap_auth 有效）        -> 真面板，全部放行
 *
 * gate cookie 无需保密：伪造它最多拿到 401，拿不到任何数据 —— 敏感接口一律要求真登录。
 * 它只用于区分「是否找对了门」，真正的门始终是 PASSWORD。
 */

import { runtime } from './runtime.js';
import { esc } from './util.js';

const KEY = 'DISGUISE_CONFIG';

/**
 * 隐蔽入口的保留前缀：这些路径已被代理协议 / 面板占用，不能拿来当入口，
 * 否则会把管理入口伪装成无法访问（自己锁死自己）。这是安全基线，不是业务数据。
 */
const RESERVED_SEGMENTS = [
  'admin', 'login', 'logout', 'api', 'sub', 'edt', 'p', 'tsub',
  '__admin', '__login', '__logout', '__api', '__tsub',
  'static', 'assets', 'public', 'wp-admin', 'wp-login.php',
];

const DEFAULT_GATE_COOKIE = 'visited';

// ===================== 配置读写 =====================

/** 归一化：任何来源的配置都收敛到同一形状，缺字段补安全默认值 */
function normalize(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
  return {
    enabled: c.enabled === true,
    template: str(c.template) || 'maintenance',
    title: str(c.title),
    subtitle: str(c.subtitle),
    contact: str(c.contact),
    items: Array.isArray(c.items) ? c.items.filter(i => i && typeof i === 'object').slice(0, 12) : [],
    posts: Array.isArray(c.posts) ? c.posts.filter(i => i && typeof i === 'object').slice(0, 30) : [],
    custom_html: str(c.custom_html),
    path: String(str(c.path)).trim(),
    token: str(c.token),
    strict: c.strict !== false,
    gate_cookie: str(c.gate_cookie) || DEFAULT_GATE_COOKIE,
    configured: c.configured === true,
  };
}

/** 环境变量种子：支持整段 JSON 或分散变量；取到则回写 KV，让面板后续可维护 */
function seedFromEnv(env) {
  const g = (k) => String((env && (env[k] || env[k.toLowerCase()])) || '');
  const whole = g('DISGUISE_CONFIG').trim();
  if (whole) {
    try {
      const parsed = JSON.parse(whole);
      const cfg = normalize({ ...parsed, configured: true });
      writeQuiet(env, cfg);
      return cfg;
    } catch {}
  }
  const pieces = {
    template: g('DISGUISE_TEMPLATE'),
    title: g('DISGUISE_TITLE'),
    subtitle: g('DISGUISE_SUBTITLE'),
    contact: g('DISGUISE_CONTACT'),
    path: g('DISGUISE_PATH'),
    token: g('DISGUISE_TOKEN'),
    custom_html: g('DISGUISE_HTML'),
  };
  if (Object.values(pieces).some(Boolean)) {
    const cfg = normalize({
      ...pieces,
      enabled: true,
      strict: String(g('DISGUISE_STRICT') || '').toLowerCase() !== 'false',
      configured: true,
    });
    if (cfg.enabled !== true || cfg.path || cfg.token) {
      writeQuiet(env, cfg);
      return cfg;
    }
  }
  return normalize({});
}

function writeQuiet(env, cfg) {
  try {
    if (env) {
      Promise.resolve(runtime.KV.put(KEY, JSON.stringify({ ...cfg, configured: true }))).catch(() => {});
    }
  } catch {}
}

/**
 * 短期进程内缓存：伪装配置要参与**每个请求**的分流判断，逐请求读一次 D1/KV
 * 等于给全站加了一次存储往返。Workers isolate 长期存活，这里缓存 3 秒已足够，
 * 且 saveConfig 会立即失效缓存，保证「面板点保存 → 立刻生效」不被延迟影响。
 */
const CACHE_TTL_MS = 3000;
let cacheValue = null;
let cacheTs = 0;

export async function readConfig(env) {
  if (cacheValue && Date.now() - cacheTs < CACHE_TTL_MS) return cacheValue;
  let cfg;
  try {
    const raw = await runtime.KV.get(KEY);
    if (raw) {
      try {
        cfg = normalize({ ...JSON.parse(raw), configured: true });
      } catch {}
    }
  } catch {}
  if (!cfg) cfg = seedFromEnv(env);
  cacheValue = cfg;
  cacheTs = Date.now();
  return cfg;
}

function invalidateCache() {
  cacheValue = null;
  cacheTs = 0;
}

/**
 * 伪装是否真正生效。
 * 硬性要求：必须配了至少一个隐蔽入口 —— 否则启用后连管理员自己都进不去面板，
 * 这是最容易把自己锁死的地方，宁可拒绝启用也不留后门。
 */
export function isActive(cfg) {
  return !!(cfg && cfg.enabled && (cfg.path || cfg.token));
}

export async function saveConfig(env, patch) {
  const cur = await readConfig(env);
  const next = normalize({ ...cur, ...(patch && typeof patch === 'object' ? patch : {}), configured: true });

  // 入口校验：防止把中间件已占用的路径设成入口，导致面板不可达
  if (next.path) {
    const err = checkEntryPath(next.path);
    if (err) return { error: err };
  }
  if (next.enabled && !next.path && !next.token) {
    return { error: '启用伪装必须至少配置一种隐蔽入口（隐蔽路径或 URL 口令），否则你自己也进不去面板' };
  }
  if (next.template === 'custom' && !String(next.custom_html).trim()) {
    return { error: '自定义模板必须填写 HTML 内容' };
  }
  if (!TEMPLATES[next.template]) {
    return { error: `未知的伪装模板：${next.template}` };
  }
  await runtime.KV.put(KEY, JSON.stringify(next));
  invalidateCache();
  return sanitize(next);
}

/** 对外返回配置：永远不带 token 明文，避免前端/日志二次泄漏入口口令 */
export function sanitize(cfg) {
  const c = normalize(cfg);
  return {
    enabled: c.enabled,
    template: c.template,
    title: c.title,
    subtitle: c.subtitle,
    contact: c.contact,
    items: c.items,
    posts: c.posts,
    custom_html: c.custom_html,
    path: c.path,
    has_token: !!c.token,
    strict: c.strict,
    gate_cookie: c.gate_cookie,
    configured: c.configured,
    templates: listTemplates(),
    reserved: RESERVED_SEGMENTS,
  };
}

export function clearConfig(env) {
  return runtime.KV.delete(KEY);
}

/** 隐蔽路径合法性：必须以 / 开头、不能是根、首段不能命中保留字 */
export function checkEntryPath(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (!s.startsWith('/')) return '隐蔽入口路径必须以 / 开头';
  if (s === '/') return '隐蔽入口路径不能是根路径（否则伪装页永远无法显示）';
  if (!/^[/a-zA-Z0-9._~%-]+$/.test(s)) return '隐蔽入口路径只能包含字母、数字、下划线、短横线与斜杠';
  const first = s.slice(1).split('/')[0].toLowerCase();
  if (RESERVED_SEGMENTS.includes(first)) {
    return `隐蔽入口路径的首段「${first}」已被代理协议或面板占用，换一个（该路径会与现有功能冲突）`;
  }
  return '';
}

// ===================== 进门判定 =====================

export function gateName(cfg) {
  return (cfg && cfg.gate_cookie) || DEFAULT_GATE_COOKIE;
}

/** 请求是否已通过隐蔽入口（持有 gate cookie） */
export function hasGate(request, cfg) {
  const name = gateName(cfg);
  const jar = request.headers.get('Cookie') || '';
  // 逐段比对，避免子串误判（如 gate 名是 a，cookie 里有 abc=1）
  return jar.split(';').some(part => part.trim().split('=')[0] === name);
}

export function gateCookieValue(cfg, request) {
  const secure = request && String(request.url || '').startsWith('https:') ? '; Secure' : '';
  return `${gateName(cfg)}=1; Path=/; Max-Age=15552000; SameSite=Lax; HttpOnly${secure}`;
}

export function expiredGateCookie(cfg) {
  return `${gateName(cfg)}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`;
}

/** 常量时间比较：避免通过响应耗时侧信道逐字节爆破入口口令 */
function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** 本次请求是否命中隐蔽入口（需要下发 gate） */
export function hitEntry(url, cfg) {
  if (!cfg || !cfg.enabled) return false;
  if (cfg.path && checkEntryPath(cfg.path) === '' && url.pathname === cfg.path) return true;
  if (cfg.token && url.searchParams.get('k') && safeEqual(url.searchParams.get('k'), cfg.token)) return true;
  return false;
}

// ===================== 模板渲染 =====================

/**
 * 页面外壳。
 * - favicon 用空 data URI：浏览器不会再去请求 /favicon.ico，少一个探测面
 * - noindex：避免伪装页被搜索引擎收录后留下可用存档
 * - 无任何 <meta generator> / 项目名称 / 版本号 / 管理入口链接
 */
function shell(title, body, request) {
  // 标题缺省时从请求 hostname 推导（而非写死任何一个名字），与 dns.js 的 proxyHost 同口径
  let host = '';
  try {
    host = new URL(request.url).hostname;
  } catch {}
  const t = String(title || '').trim() || host || ' ';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(t)}</title>
<link rel="icon" href="data:,">
<meta name="robots" content="noindex, nofollow">
<style>
:root { --bg:#f6f7f9; --card:#fff; --line:#e5e7eb; --txt:#111827; --muted:#6b7280; --accent:#2563eb; --soft:#f3f4f6; --radius:12px; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0d1117; --card:#161b22; --line:#272e38; --txt:#e6edf3; --muted:#8b949e; --accent:#58a6ff; --soft:#1c2129; }
}
* { box-sizing:border-box; }
body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
       background:var(--bg); color:var(--txt); font-size:15px; line-height:1.7; -webkit-font-smoothing:antialiased; }
.wrap { max-width:760px; margin:0 auto; padding:64px 20px 80px; }
.center { min-height:70vh; display:flex; align-items:center; justify-content:center; }
.card { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:36px 32px; }
h1 { font-size:24px; margin:0 0 12px; font-weight:650; letter-spacing:-.01em; }
h2 { font-size:17px; margin:0 0 12px; font-weight:650; }
p { color:var(--muted); margin:0 0 10px; }
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }
.meta { color:var(--muted); font-size:13.5px; }
hr { border:none; border-top:1px solid var(--line); margin:28px 0; }
nav { display:flex; gap:22px; align-items:center; flex-wrap:wrap; margin-bottom:52px; }
nav .brand { font-weight:650; font-size:16px; color:var(--txt); }
nav .spacer { flex:1; }
nav a { color:var(--muted); font-size:14.5px; }
.hero h1 { font-size:32px; margin-bottom:14px; }
.grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-top:24px; }
@media (max-width:620px) { .grid { grid-template-columns:1fr; } .wrap { padding:40px 18px 60px; } .hero h1 { font-size:26px; } }
.tile { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:20px; }
.tile h3 { margin:0 0 8px; font-size:15.5px; font-weight:650; }
.tile p { margin:0; font-size:14px; }
.post { padding:20px 0; border-bottom:1px solid var(--line); }
.post:last-child { border-bottom:none; }
.post h2 { margin:0 0 6px; font-size:17px; }
.post time { color:var(--muted); font-size:13px; }
.row { display:flex; gap:12px; flex-wrap:wrap; margin-top:22px; }
.btn { display:inline-block; padding:10px 20px; border-radius:8px; background:var(--accent); color:#fff; font-size:14.5px; font-weight:600; }
.btn:hover { text-decoration:none; opacity:.9; }
.btn.alt { background:transparent; color:var(--accent); border:1px solid var(--line); }
footer { margin-top:44px; padding-top:22px; border-top:1px solid var(--line); color:var(--muted); font-size:13.5px; }
ul.checks { margin:0; padding-left:20px; color:var(--muted); }
ul.checks li { margin-bottom:7px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function nav(title, request) {
  let host = '';
  try {
    host = new URL(request.url).hostname;
  } catch {}
  return `<nav><span class="brand">${esc(title || host)}</span><span class="spacer"></span><a href="/">首页</a></nav>`;
}

function footer(contact) {
  return contact ? `<footer>${esc(contact)}</footer>` : '';
}

/** 极简「维护中 / 建站中」单页 */
function tplMaintenance(c, request) {
  const body = `<div class="wrap center">
  <div class="card">
    <h1>${esc(c.title || '网站升级维护中')}</h1>
    ${c.subtitle ? `<p>${esc(c.subtitle)}</p>` : ''}
    ${c.contact ? `<p class="meta">${esc(c.contact)}</p>` : ''}
  </div>
</div>`;
  return shell(c.title, body, request);
}

/** 企业官网 / 工作室 */
function tplCorp(c, request) {
  const tiles = c.items.length
    ? `<div class="grid">${c.items.map(i => `<div class="tile"><h3>${esc(i.title || '')}</h3><p>${esc(i.desc || '')}</p></div>`).join('')}</div>`
    : '';
  const body = `<div class="wrap">
  ${nav(c.title, request)}
  <div class="hero">
    <h1>${esc(c.title || '')}</h1>
    ${c.subtitle ? `<p>${esc(c.subtitle)}</p>` : ''}
  </div>
  ${tiles}
  ${footer(c.contact)}
</div>`;
  return shell(c.title, body, request);
}

/** 技术博客 / 文章列表 */
function tplBlog(c, request) {
  const list = c.posts.length
    ? c.posts.map(p => `<article class="post">
      ${p.date ? `<time>${esc(p.date)}</time>` : ''}
      <h2>${esc(p.title || '')}</h2>
      ${p.summary ? `<p>${esc(p.summary)}</p>` : ''}
    </article>`).join('')
    : '<p class="meta">暂无内容。</p>';
  const body = `<div class="wrap">
  ${nav(c.title, request)}
  <h1>${esc(c.title)}</h1>
  ${c.subtitle ? `<p>${esc(c.subtitle)}</p>` : ''}
  <hr>
  ${list}
  ${footer(c.contact)}
</div>`;
  return shell(c.title, body, request);
}

/** 开源项目 / 下载页 */
function tplDownload(c, request) {
  const checks = c.items.length
    ? `<ul class="checks">${c.items.map(i => `<li>${esc(i.title || i.desc || '')}</li>`).join('')}</ul>`
    : '';
  const body = `<div class="wrap">
  ${nav(c.title, request)}
  <div class="hero">
    <h1>${esc(c.title)}</h1>
    ${c.subtitle ? `<p>${esc(c.subtitle)}</p>` : ''}
  </div>
  ${checks}
  <div class="row">
    ${c.contact ? `<a class="btn" href="mailto:${esc(c.contact)}">联系我们</a>` : ''}
  </div>
  ${footer(c.contact)}
</div>`;
  return shell(c.title, body, request);
}

/** 自定义：整段 HTML 直出，终极兜底 —— 任何站点页面都能贴 */
function tplCustom(c) {
  return String(c.custom_html || '');
}

const TEMPLATES = {
  maintenance: tplMaintenance,
  corp: tplCorp,
  blog: tplBlog,
  download: tplDownload,
  custom: tplCustom,
};

const TEMPLATE_DESC = {
  maintenance: '极简维护页：一行标题 + 说明 + 联系方式',
  corp: '企业官网：导航 + 主视觉 + 服务三栏 + 页脚',
  blog: '文章列表：标题 + 日期 + 摘要',
  download: '项目/下载页：主视觉 + 特性列表 + 按钮',
  custom: '自定义：直接输出你贴的整段 HTML',
};

export function listTemplates() {
  return Object.keys(TEMPLATES).map(k => ({ id: k, desc: TEMPLATE_DESC[k] }));
}

// ===================== 对外渲染 =====================

function htmlResponse(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

/** 伪装首页 */
export function renderHome(cfg, request) {
  const fn = TEMPLATES[cfg.template] || tplMaintenance;
  try {
    return htmlResponse(fn(cfg, request));
  } catch {
    // 模板自身出错时不回落到任何内置页面，返回同模板的空壳，避免泄漏
    return htmlResponse(tplMaintenance({ title: cfg.title, subtitle: cfg.subtitle, contact: cfg.contact }, request));
  }
}

/** 伪装 404：外观与首页同模板，陌生人无法据此区分「路径不存在」与「路径存在但需登录」 */
export function renderNotFound(cfg, request) {
  const fn = TEMPLATES[cfg.template] || tplMaintenance;
  let body;
  try {
    body = fn(cfg, request);
  } catch {
    body = tplMaintenance({ title: cfg.title, subtitle: cfg.subtitle, contact: cfg.contact }, request);
  }
  return htmlResponse(body, 404);
}

/** /robots.txt：伪装站点一律拒绝抓取，避免留下可被检索的存档 */
export function renderRobots() {
  return new Response('User-agent: *\nDisallow: /\n', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** /favicon.ico：静默 204，浏览器不会再反复请求，且不产生 404 特征 */
export function emptyFavicon() {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

export { KEY as DISGUISE_KEY };
