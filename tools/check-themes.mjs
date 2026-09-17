#!/usr/bin/env node
/**
 * 主题系统自检：验证「10 套预设可用」「自定义主题能存能删」「自定义内容打不穿页面」。
 *
 * 只用 Node 内置模块，不需要 Cloudflare 账号。
 *
 * 用法：
 *   node tools/check-themes.mjs
 */
import { handleRequest } from '../src/router.js';
import { bindRuntime } from '../src/runtime.js';
import { PRESETS, BASE_VARS, ROTATE_MODES, isValidId, rotatingTheme } from '../src/themes.js';
import { btoa } from 'node:buffer';

const PASSWORD = process.env.PASSWORD || 'dev';
const ORIGIN = process.env.PROBE_ORIGIN || 'https://proxy.example.com';

// ---- 内存版 KV（与 check-smoke.mjs / check-disguise.mjs 同一约定）----
const mem = new Map();
const kv = {
  async list(o = {}) {
    const p = (o && o.prefix) || '';
    return { keys: [...mem.keys()].filter(k => k.startsWith(p)).map(name => ({ name })), list_complete: true, cursor: '' };
  },
  async get(k) { return mem.has(k) ? mem.get(k) : null; },
  async put(k, v) { mem.set(k, v); },
  async delete(k) { mem.delete(k); },
};
globalThis.__MEM__ = mem;
const env = { PASSWORD, SITES: kv, PROXY_HOST: new URL(ORIGIN).hostname };
bindRuntime(env);

const authCookie = `ap_auth=${btoa(unescape(encodeURIComponent(PASSWORD)))}`;

async function call(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.authed) headers.Cookie = authCookie;
  if (opts.body) headers['Content-Type'] = 'application/json';
  try {
    const res = await handleRequest(
      new Request(ORIGIN + path, { method: opts.method || 'GET', headers, body: opts.body }),
      env,
      {}
    );
    return { status: res.status, text: await res.text(), headers: res.headers };
  } catch (e) {
    return { status: 0, text: 'THROW: ' + (e && e.message), headers: new Headers() };
  }
}

let failed = 0;
function check(name, pass, detail) {
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) failed++;
}

console.log('\n=== 主题系统自检 ===\n');

// ---------- 1. 数据表本身 ----------
{
  check(`预设主题共 10 套`, PRESETS.length === 10, `实际 ${PRESETS.length} 套`);
  const ids = PRESETS.map(t => t.id);
  check('id 无重复', new Set(ids).size === ids.length, ids.join(','));
  check('id 全部合法（可用于 data-theme）', ids.every(isValidId), ids.filter(i => !isValidId(i)).join(',') || 'ok');
  check('每套都有名称与说明', PRESETS.every(t => t.name && t.desc), 'ok');
  check('每套都有 scheme', PRESETS.every(t => t.scheme === 'light' || t.scheme === 'dark'), 'ok');
  // 主题至少要覆盖背景/卡片/主色，否则不同主题会长得太像
  check('每套都定义了背景与主色', PRESETS.every(t => t.vars['--bg'] && t.vars['--accent']), 'ok');
  // 变量名必须合法，否则生成的 CSS 会出错
  const badVars = PRESETS.flatMap(t => Object.keys(t.vars)).filter(n => !/^--[a-z][a-z0-9-]{0,31}$/.test(n));
  check('变量名全部合法', badVars.length === 0, badVars.join(',') || 'ok');
  check('基础变量足以独立成一套外观', Object.keys(BASE_VARS).length >= 20, `${Object.keys(BASE_VARS).length} 个`);
  check('轮换方式表齐全', ROTATE_MODES.length === 3 && ROTATE_MODES.map(m => m.id).join(',') === 'off,visit,interval', 'ok');
}

// ---------- 2. 面板首屏真的带上了主题 ----------
{
  const home = await call('/');
  // 只看「变量块」本身（紧跟 {）；带作用域的结构样式（:root[data-theme="x"] .card{...}）不算，
  // 否则每套主题会按补充样式的条数被重复计数。
  const themeBlocks = (home.text.match(/:root\[data-theme="[a-z0-9-]+"\]\{/g) || []).length;
  check('管理页渲染了全部主题变量块', themeBlocks === PRESETS.length, `渲染 ${themeBlocks} 套`);
  check('页面上带上了 default theme 标记', /<html[^>]+data-theme="[^"]+"/.test(home.text), 'ok');
  check('首屏应用脚本存在（防闪）', home.text.includes('__apThemeDefault'), 'ok');
}

// ---------- 3. 接口：列表 / 默认主题 ----------
{
  const r = await call('/__api/themes', { authed: true });
  let themes = [];
  try { themes = JSON.parse(r.text).themes || []; } catch {}
  check('GET /__api/themes 返回 10 套', themes.length === 10, `HTTP ${r.status}，${themes.length} 套`);
  check('每套都带预览色', themes.every(t => t.swatch && t.swatch.bg && t.swatch.accent), 'ok');

  const noAuth = await call('/__api/themes');
  check('未登录拿不到主题接口', noAuth.status === 401, 'HTTP ' + noAuth.status);
}

// ---------- 4. 自定义主题：能存、能在页面上生效 ----------
{
  const ok1 = await call('/__api/themes/custom', {
    method: 'POST', authed: true,
    body: JSON.stringify({ id: 'mytheme', name: '我的主题', vars: { '--accent': '#ff6600', '--bg': '#101010' } }),
  });
  check('可以新增自定义主题', ok1.status === 200, 'HTTP ' + ok1.status);

  const list = await call('/__api/themes', { authed: true });
  const themes = JSON.parse(list.text).themes || [];
  check('列表里出现自定义主题', themes.length === 11 && themes.some(t => t.id === 'mytheme'), `${themes.length} 套`);

  const home = await call('/');
  check('自定义主题的变量出现在页面上', home.text.includes(':root[data-theme="mytheme"]'), 'ok');
  check('自定义变量值正确', home.text.includes('#ff6600'), 'ok');

  // id 冲突 / 非法 id 必须被拒绝
  const dup = await call('/__api/themes/custom', {
    method: 'POST', authed: true, body: JSON.stringify({ id: 'aurora', vars: { '--accent': '#000' } }),
  });
  check('不能占用内置主题 id', dup.status === 400, 'HTTP ' + dup.status);

  const badId = await call('/__api/themes/custom', {
    method: 'POST', authed: true, body: JSON.stringify({ id: 'Bad Id!', vars: { '--accent': '#000' } }),
  });
  check('非法 id 被拒绝', badId.status === 400, 'HTTP ' + badId.status);

  const noVars = await call('/__api/themes/custom', {
    method: 'POST', authed: true, body: JSON.stringify({ id: 'novars', vars: { 'accent-bad': '#000' } }),
  });
  check('没有合法变量时拒绝保存', noVars.status === 400, 'HTTP ' + noVars.status);
}

// ---------- 5. 自定义内容不能打穿页面（CSS 注入） ----------
{
  const inject = await call('/__api/themes/custom', {
    method: 'POST', authed: true,
    body: JSON.stringify({
      id: 'evil',
      vars: { '--accent': 'red;} body{display:none} .card{' },
      extra: '.card{background:url(javascript:alert(1))}',
    }),
  });
  const home = await call('/');
  const body = String(inject.status);
  check('含花括号的值被拒或过滤', !home.text.includes('body{display:none}'), 'HTTP ' + body);
  check('含 JS 伪协议的值被拒', !home.text.includes('javascript:alert'), 'ok');
  check('页面未被注入<script>', !/MYINJECT|<\/style><script>alert/.test(home.text), 'ok');
}

// ---------- 6. 设为默认 / 删掉后回退 ----------
{
  const setDefault = await call('/__api/themes', {
    method: 'POST', authed: true, body: JSON.stringify({ default_theme: 'mytheme' }),
  });
  check('可以把自定义主题设为全站默认', setDefault.status === 200, 'HTTP ' + setDefault.status);
  const home1 = await call('/');
  check('首页默认主题随之改变', /<html[^>]+data-theme="mytheme"/.test(home1.text), 'ok');

  const del = await call('/__api/themes/custom/mytheme', { method: 'DELETE', authed: true });
  check('可以删除自定义主题', del.status === 200, 'HTTP ' + del.status);

  // 默认主题指向了已删除的主题：必须落回到一套真实存在的主题，而不是渲染出无效 data-theme
  const home2 = await call('/');
  const m = home2.text.match(/<html[^>]+data-theme="([^"]+)"/);
  const fallbackId = m ? m[1] : '';
  const allIds = new Set([...PRESETS.map(t => t.id), 'evil'].filter(Boolean));
  check('默认主题失效后落回有效主题', allIds.has(fallbackId), '回退到 ' + fallbackId);
  check('页面仍带有该主题的变量块', home2.text.includes(`:root[data-theme="${fallbackId}"]`), 'ok');
}

// ---------- 7. 换主题要像换系统：结构性样式按主题作用域生效 ----------
{
  const home = await call('/');
  const scoped = (id, needle) => new RegExp(`:root\\[data-theme="${id}"\\][^{]*\\{[^}]*${needle}`).test(home.text);
  check('玻璃主题带了毛玻璃（且限定在该主题下）', scoped('glass', 'backdrop-filter'), 'ok');
  check('极简主题改了标签栏形状', scoped('graphite', 'border-radius:2px'), 'ok');
  check('终端主题保留了描边风格', scoped('terminal', 'border-style:solid'), 'ok');
  check('樱粉主题把按钮做成药丸', scoped('sakura', 'border-radius:999px'), 'ok');
  // 结构样式必须带作用域：否则后加载的主题会盖掉前面所有主题
  const leaking = /backdrop-filter/.test(home.text) && !/\[data-theme="glass"\][^{]*\{[^}]*backdrop-filter/.test(home.text);
  check('主题补充样式未泄漏到全局', !leaking, 'ok');
}

// ---------- 8. 自动轮换 ----------
{
  const ids = PRESETS.map(t => t.id);
  const setRotate = async (body) => await call('/__api/themes', { method: 'POST', authed: true, body: JSON.stringify(body) });
  const current = async () => {
    const r = await call('/__api/themes', { authed: true });
    try { return JSON.parse(r.text); } catch { return {}; }
  };

  const off = await current();
  check('默认不轮换', off.rotate_mode === 'off' && !off.rotating_theme, String(off.rotate_mode));

  await setRotate({ rotate_mode: 'interval', rotate_interval_minutes: 60, rotate_pool: 'aurora nord' });
  const a = await current();
  const b = await current();
  check('按时轮换会选出一套主题', ids.includes(a.rotating_theme), String(a.rotating_theme));
  check('同一时间片内结果稳定（全球一致）', a.rotating_theme === b.rotating_theme, `${a.rotating_theme} / ${b.rotating_theme}`);
  check('轮换只使用池子里的主题', ['aurora', 'nord'].includes(a.rotating_theme), String(a.rotating_theme));

  await setRotate({ rotate_mode: 'visit', rotate_pool: 'aurora nord' });
  const picks = new Set();
  for (let i = 0; i < 20; i++) picks.add((await current()).rotating_theme);
  check('每次访问随机：抽到了多套', picks.size > 1, `抽到 ${picks.size} 种：${[...picks].join(',')}`);
  check('随机的也都在池子里', [...picks].every(id => ['aurora', 'nord'].includes(id)), [...picks].join(','));

  await setRotate({ rotate_mode: 'interval', rotate_pool: 'ghost none' });
  const bad = await current();
  check('池子配错时退回全部主题', ids.includes(bad.rotating_theme), String(bad.rotating_theme));

  await setRotate({ rotate_mode: 'off' });
  const off2 = await current();
  check('可以关掉轮换', off2.rotate_mode === 'off' && !off2.rotating_theme, String(off2.rotate_mode));
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项未通过`}\n`);
process.exit(failed === 0 ? 0 : 1);
