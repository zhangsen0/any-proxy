/**
 * 线上面板的**浏览器侧**体检（在 GitHub Actions 里跑，因为只有 CI 拿得到管理口令）。
 *
 * 为什么要这一步：
 *   后端接口全 200 不代表页面能用。面板里有几处脚本是「写成函数、再 toString() 注入到
 *   HTML 里」的 —— 它们一旦在浏览器里第一行就 ReferenceError，页面照常渲染得出来，
 *   但所有按钮的事件绑定都没挂上，表现出来就是「点了没反应」。而 Worker 日志一条都没有，
 *   只看接口状态码永远查不出。
 *
 * 所以这里是真开一个浏览器：登录 → 打开面板 → 收集控制台报错 → 再点几个代表性按钮，
 * 看事件到底有没有挂上。
 *
 * 用法：
 *   PROXY_HOST=xxx PASSWORD=yyy node .github/scripts/diag-browser.mjs
 */
import puppeteer from 'puppeteer';

const HOST = process.env.PROXY_HOST || '';
const PASSWORD = process.env.PASSWORD || '';
if (!HOST || !PASSWORD) { console.error('需要 PROXY_HOST 与 PASSWORD'); process.exit(1); }
const ORIGIN = 'https://' + HOST;

// 先登录拿会话
const login = await fetch(ORIGIN + '/__api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
});
const sc = login.headers.get('set-cookie') || '';
const m = sc.match(/ap_auth=([^;]+)/);
if (!m) { console.error('登录没拿到会话'); process.exit(2); }
const authValue = decodeURIComponent(m[1]);

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push('[console.error] ' + msg.text().slice(0, 200));
});
page.on('requestfailed', (r) => {
  errors.push('[requestfailed] ' + r.url().slice(0, 120) + ' — ' + ((r.failure() && r.failure().errorText) || ''));
});

await page.setCookie({ name: 'ap_auth', value: authValue, domain: HOST, path: '/' });
const resp = await page.goto(ORIGIN + '/__admin', { waitUntil: 'networkidle2', timeout: 45000 });
console.log('打开 /__admin → HTTP', resp.status(), '| 页面字节', (await page.content()).length);

// ---- 面板结构自检 ----
const shape = await page.evaluate(() => ({
  title: document.title,
  scriptCount: document.querySelectorAll('script').length,
  buttons: document.querySelectorAll('button').length,
  dataKeys: document.querySelectorAll('[data-key]').length,
  panes: document.querySelectorAll('[data-pane]').length,
  bodyLen: document.body.innerHTML.length,
}));
console.log('\n=== 页面结构 ===');
for (const [k, v] of Object.entries(shape)) console.log(`  ${k.padEnd(14)} ${v}`);

// ---- 关键全局是否在 ----
const globals = await page.evaluate(() => ({
  api: typeof window.api,
  switchPane: typeof window.switchPane,
  escapeHtml: typeof window.escapeHtml,
}));
console.log('\n=== 前端函数是否挂上 ===');
for (const [k, v] of Object.entries(globals)) console.log(`  window.${k.padEnd(12)} ${v}`);

// ---- 点几个代表性按钮，看有没有反应 ----
console.log('\n=== 交互自检 ===');
const probe = async (label, fn) => {
  let out;
  try { out = await page.evaluate(fn); } catch (e) { out = 'EXC ' + String(e && e.message).slice(0, 100); }
  console.log(`  ${label.padEnd(22)} ${JSON.stringify(out)}`);
};
// 绑了 onclick / onclickish 的按钮比例：为 0 说明注入 JS 压根没执行
await probe('按钮带 onclick 数', () => {
  const bs = [...document.querySelectorAll('button')];
  let n = 0;
  for (const b of bs) {
    if (b.onclick) n++;
    else if (b.getAttribute('id') && Object.keys(b).some(k => k.startsWith('on'))) n++;
  }
  return { total: bs.length, bound: n };
});
await probe('标签页切换可用性', () => {
  const before = document.querySelector('[data-pane].active, .pane.active, .tab.active') ? 'has-active' : 'none';
  return { before, canCall: typeof window.switchPane };
});
await probe('刷新站点列表', async () => {
  const r = await fetch('/__api/sites?t=' + Date.now(), { credentials: 'same-origin' });
  return { status: r.status };
});

// 等一会儿，让懒加载的分区、定时刷新的表格跑一段，期间的报错都进来
await new Promise((r) => setTimeout(r, 4000));

console.log('\n=== 控制台错误（共 ' + errors.length + ' 条）===');
for (const e of errors.slice(0, 40)) console.log('  ' + e);

await browser.close();
