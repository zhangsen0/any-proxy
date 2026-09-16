#!/usr/bin/env node
/**
 * 首页伪装自检：验证「根路径渲染伪装页」与「面板移到隐蔽入口」两件事，
 * 重点覆盖两类高风险回归：把自己锁死在面板外，以及伪装反而穿帮。
 *
 * 只用 Node 内置模块，不需要 Cloudflare 账号。
 *
 * 用法：
 *   node tools/check-disguise.mjs
 *
 * 环境变量：
 *   PROBE_ORIGIN   伪装目标源，默认 https://proxy.example.com
 */
import { handleRequest } from '../src/router.js';
import { bindRuntime } from '../src/runtime.js';
import { btoa } from 'node:buffer';

const PASSWORD = process.env.PASSWORD || 'dev';
const ORIGIN = process.env.PROBE_ORIGIN || 'https://proxy.example.com';

// ---- 内存版 KV（与 check-preferred.mjs 同一约定）----
const mem = new Map();
const kv = {
  async list(o = {}) {
    const p = (o && o.prefix) || '';
    return { keys: [...mem.keys()].filter(k => k.startsWith(p)).map(name => ({ name })), list_complete: true };
  },
  async get(k) { return mem.has(k) ? mem.get(k) : null; },
  async put(k, v) { mem.set(k, v); },
  async delete(k) { mem.delete(k); },
};
const env = { PASSWORD, SITES: kv, PROXY_HOST: new URL(ORIGIN).hostname };
bindRuntime(env);

const authCookie = `ap_auth=${btoa(unescape(encodeURIComponent(PASSWORD)))}`;

async function call(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.authed) headers.Cookie = authCookie;
  if (opts.gate) headers.Cookie = opts.gate;
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

const BRAND = ['Any-Proxy', 'any-proxy', 'edgetunnel', 'ap_auth'];
const TITLE = '示例在线';
const HIDDEN_PATH = '/mypanel';
const HIDDEN_TOKEN = 'op3n-sesame';

console.log('\n=== 首页伪装自检 ===\n');

// ---------- 1. 伪装启用前 ----------
{
  const home = await call('/');
  check('未配置时根路径仍是管理页', home.status === 200 && /<html/i.test(home.text) && home.text.includes('Any-Proxy'), 'HTTP ' + home.status);
}

// ---------- 2. 配置校验：拒绝会把自己锁死的组合 ----------
{
  const noEntry = await call('/__api/disguise', {
    method: 'POST', authed: true,
    body: JSON.stringify({ enabled: true, template: 'maintenance', title: TITLE }),
  });
  check('启用但未配任何入口时被拒绝', noEntry.status === 400, 'HTTP ' + noEntry.status);

  const badPath = await call('/__api/disguise', {
    method: 'POST', authed: true,
    body: JSON.stringify({ enabled: true, path: '/admin' }),
  });
  check('占用保留路径 /admin 被拒绝', badPath.status === 400, 'HTTP ' + badPath.status);

  const rootPath = await call('/__api/disguise', {
    method: 'POST', authed: true,
    body: JSON.stringify({ enabled: true, path: '/' }),
  });
  check('把入口设成根路径被拒绝', rootPath.status === 400, 'HTTP ' + rootPath.status);

  const badTpl = await call('/__api/disguise', {
    method: 'POST', authed: true,
    body: JSON.stringify({ template: '不存在的模板', path: HIDDEN_PATH }),
  });
  check('未知模板被拒绝', badTpl.status === 400, 'HTTP ' + badTpl.status);

  const customEmpty = await call('/__api/disguise', {
    method: 'POST', authed: true,
    body: JSON.stringify({ template: 'custom', custom_html: '', path: HIDDEN_PATH }),
  });
  check('自定义模板缺 HTML 被拒绝', customEmpty.status === 400, 'HTTP ' + customEmpty.status);
}

// ---------- 3. 保存合法配置 ----------
{
  const saved = await call('/__api/disguise', {
    method: 'POST', authed: true,
    body: JSON.stringify({
      enabled: true, template: 'maintenance', title: TITLE,
      subtitle: '正在升级，稍后回来', contact: 'hi@example.com',
      path: HIDDEN_PATH, token: HIDDEN_TOKEN, strict: true,
    }),
  });
  check('保存伪装配置', saved.status === 200, 'HTTP ' + saved.status);

  const read = await call('/__api/disguise', { authed: true });
  const cfg = JSON.parse(read.text).config;
  check('读取配置不返回口令明文', cfg.has_token === true && !read.text.includes(HIDDEN_TOKEN), 'has_token=' + cfg.has_token);
  check('伪装已进入生效状态', JSON.parse(read.text).active === true);
}

// ---------- 4. 陌生人视角 ----------
{
  const home = await call('/');
  check('陌生人看到伪装页', home.status === 200 && home.text.includes(TITLE), 'HTTP ' + home.status);
  check('伪装页不含任何品牌字样', BRAND.every(b => !home.text.includes(b)), BRAND.filter(b => home.text.includes(b)).join(',') || '干净');

  for (const ep of ['/__api/sites', '/__api/config', '/__api/dns-config', '/__api/speedtest', '/__api/preferred-ips', '/__api/preferred-candidates']) {
    const r = await call(ep);
    check(`匿名读 ${ep} 已收敛`, r.status === 404 && !r.text.trim().startsWith('{'), 'HTTP ' + r.status);
  }

  const hiddenCard = await call('/__admin');
  check('伪装后 /__admin 不再直接暴露面板', hiddenCard.status === 404 && !BRAND.some(b => hiddenCard.text.includes(b)), 'HTTP ' + hiddenCard.status);

  const scan = await call('/wp-login.php');
  check('随机扫描路径不再 302 到 __admin', scan.status === 404 && !(scan.headers.get('location') || '').includes('__admin'), 'HTTP ' + scan.status);

  const fav = await call('/favicon.ico');
  check('/favicon.ico 静默 204', fav.status === 204, 'HTTP ' + fav.status);

  const robots = await call('/robots.txt');
  check('/robots.txt 拒绝抓取', robots.status === 200 && robots.text.includes('Disallow: /'), 'HTTP ' + robots.status);

  const login = await call('/__login');
  check('登录页脱掉品牌字样', login.status === 200 && BRAND.every(b => !login.text.includes(b)), 'HTTP ' + login.status);

  // 探活目标：根路径必须始终可达，否则 healthcheck 会误判 IP 不可达进而误删 A 记录
  const probe = await call('/');
  check('根路径探活始终 200', probe.status === 200, 'HTTP ' + probe.status);
}

// ---------- 5. 代理通道不被误伤 ----------
{
  // 站点不存在 -> 走 friendlyError 的普通错误页，而不是伪装页。
  // 必须带 Accept: text/html 才会判定为导航请求（否则按设计返回 204 静默失败，
  // 避免浏览器把 HTML 错误页当成 JS 去解析）。
  const noSite = await call('/p/nonexistent/', { headers: { Accept: 'text/html' } });
  check('反代未知站点返回普通错误页（非伪装页）', noSite.status === 404 && !noSite.text.includes(TITLE), 'HTTP ' + noSite.status);

  // 临时订阅：客户端不带 cookie，必须能独立通过（此处返回 404 而非伪装页，且不解释失败原因）
  const tsub = await call('/tsub/whatever');
  check('临时订阅不被伪装拦截', tsub.status === 404 && tsub.text === 'Not Found', 'HTTP ' + tsub.status + ' / ' + JSON.stringify(tsub.text.slice(0, 40)));

  // WebSocket：绝不能被伪装逻辑吃掉（节点可能把 path 配成 /，被吃掉就等于断网）。
  // 本地跑不出真实握手（vlessHandler 会抛错），这里只断言它没有落到伪装页分支。
  const ws = await call('/', { headers: { Upgrade: 'websocket', Connection: 'Upgrade' } });
  check('WebSocket 升级未被伪装拦截', !ws.text.includes('<!DOCTYPE html>'), ws.status === 0 ? '已转交代理引擎（本地无真实握手，符合预期）' : 'HTTP ' + ws.status);
}

// ---------- 6. 进门方式一：隐蔽路径 ----------
{
  const entry = await call(HIDDEN_PATH);
  const sc = entry.headers.get('set-cookie') || '';
  check('隐蔽路径下发 gate cookie', entry.status === 302 && sc.includes('visited=1'), 'HTTP ' + entry.status + ' / Set-Cookie=' + (sc.slice(0, 40) || '无'));
  check('进门后跳回根路径', (entry.headers.get('location') || '').endsWith('/'), entry.headers.get('location') || '无');

  const after = await call('/', { gate: 'visited=1' });
  check('带 gate 后根路径显示真面板', after.status === 200 && after.text.includes('Any-Proxy'), 'HTTP ' + after.status);

  const api401 = await call('/__api/sites', { gate: 'visited=1' });
  check('带 gate 未登录时 API 返回 401（面板可引导登录）', api401.status === 401 && api401.text.includes('unauthorized'), 'HTTP ' + api401.status);
}

// ---------- 7. 进门方式二：URL 口令 ----------
{
  const wrong = await call('/anything?k=wrong-token');
  check('错误口令不进门', wrong.status === 404 && !(wrong.headers.get('set-cookie') || '').includes('visited'), 'HTTP ' + wrong.status);

  const ok = await call('/anything?k=' + HIDDEN_TOKEN);
  check('正确口令下发 gate cookie', ok.status === 302 && (ok.headers.get('set-cookie') || '').includes('visited=1'), 'HTTP ' + ok.status);
}

// ---------- 8. 已登录：一切照常 ----------
{
  const home = await call('/', { authed: true });
  check('已登录时根路径显示真面板', home.status === 200 && home.text.includes('Any-Proxy'), 'HTTP ' + home.status);

  const sites = await call('/__api/sites', { authed: true });
  check('已登录可读站点列表', sites.status === 200 && sites.text.includes('"ok"'), 'HTTP ' + sites.status);

  const preview = await call('/__api/disguise-preview', { authed: true });
  check('登录态可预览访客视角', preview.status === 200 && preview.text.includes(TITLE), 'HTTP ' + preview.status);
}

// ---------- 9. 登出必须清除进门标记 ----------
{
  const out = await call('/__api/logout', { authed: true });
  const sc = out.headers.get('set-cookie') || '';
  check('登出清除 gate cookie', sc.includes('visited=;') && sc.includes('Max-Age=0'), sc.replace(/\n/g, ' | ').slice(0, 90) || '无');

  const afterOut = await call('/', { gate: 'ap_auth=' + btoa(unescape(encodeURIComponent(PASSWORD))) });
  check('仍带登录 cookie 时不受影响', afterOut.status === 200 && afterOut.text.includes('Any-Proxy'), 'HTTP ' + afterOut.status);
}

// ---------- 10. 停用伪装 ----------
{
  const off = await call('/__api/disguise', { method: 'POST', authed: true, body: JSON.stringify({ enabled: false }) });
  check('可停用伪装', off.status === 200, 'HTTP ' + off.status);
  const home = await call('/');
  check('停用后根路径恢复管理页', home.status === 200 && home.text.includes('Any-Proxy'), 'HTTP ' + home.status);
}

console.log(`\n=== ${failed === 0 ? '全部通过' : failed + ' 项失败'} ===\n`);
process.exit(failed === 0 ? 0 : 1);
