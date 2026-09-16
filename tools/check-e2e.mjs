#!/usr/bin/env node
/**
 * 线上部署的端到端校验（云端执行，不依赖本地网络）。
 *
 *   PROXY_HOST=example.com node tools/check-e2e.mjs
 *
 * 设计原则：只校验「部署本身是否健康」，不写死任何具体站点/仓库/按钮文案。
 * 具体站点由面板运行时配置决定，脚本不假设一定存在某个反代目标。
 *
 *   1. HTTP 层：管理 API 可达、首页返回 HTML 且不被缓存
 *   2. 浏览器层（需 puppeteer）：真实渲染首页，确认无脚本语法错误、页面已渲染。
 *      —— 这正是「页面能打开但 JS 报错白屏」这类问题的可靠检测。
 *      失败会重试一轮并如实记录，避免 runner 网络抖动把健康部署判成坏的。
 */
// 不内置默认域名：写死会让 fork 后的 CI 静默地去校验别人的站点。
const HOST = String(process.env.PROXY_HOST || '').trim();
if (!HOST) {
  console.error('缺少 PROXY_HOST：请在环境变量或仓库变量中指定要校验的域名');
  process.exit(2);
}
const PROXY = 'https://' + HOST;

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); };

async function httpChecks() {
  // 站点本身可达、且没被 CDN/浏览器缓存住。
  // 校验目标用根路径而非管理 API：首页伪装开启后 /__api/config 要求登录，
  // 而这里要验证的恰恰是「匿名访客能不能正常打开这个站点」。
  // 兜底对象手写，不能用 Object.assign(new Response(...), { status: 0 }) ——
  // Response.status 是只读 getter，那样写会直接抛 TypeError。
  const fallback = { status: 0, text: async () => '', headers: new Headers() };
  const r = await fetch(PROXY + '/', { redirect: 'manual' }).catch(() => fallback);
  check('根路径可达', r.status === 200, 'status=' + r.status);
  const html = await r.text();
  check('返回 HTML', /<html/i.test(html));
  check('有页面标题', /<title>/i.test(html));

  const cc = r.headers.get('cache-control') || '';
  check('HTML 不缓存', cc.includes('no-store'), cc);
}

async function browserChecks() {
  let puppeteer;
  try { puppeteer = (await import('puppeteer')).default; }
  catch { check('浏览器校验（未安装 puppeteer，已跳过）', true, 'skipped'); return; }

  // 云上偶发的单次失败（runner 出口网络抖动、CF 边缘节点刚同步完的短暂不一致）
  // 给一次重试机会：抖动能自愈，持续故障两次都过不去，不会掩盖真问题。
  let run = await collectBrowserChecks(puppeteer);
  let note = '';
  if (!run.ok) {
    note = '（首次未通过，已重试一次）';
    run = await collectBrowserChecks(puppeteer);
  }
  for (const it of run.items) check(it.name, it.ok, it.extra);
  if (note) check('浏览器校验重试', run.ok, run.ok ? '重试后通过' : '重试后仍未通过');
}

// 跑一轮浏览器取样，返回明细而非直接写全局结果，便于失败重试时丢弃整轮脏数据。
async function collectBrowserChecks(puppeteer) {
  const items = [];
  const add = (name, ok, extra = '') => items.push({ name, ok, extra });
  let browser;
  try {
    browser = await puppeteer.launch({
      // acceptInsecureCerts：这里验的是「站点能不能打开」，不是证书链是否可信。
      // 自定义域名在换证书窗口期可能短暂不可信，不该让可用性校验误报。
      acceptInsecureCerts: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--disable-extensions'],
      protocolTimeout: 60000,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));

    const resp = await page.goto(PROXY + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    add('浏览器可打开根路径', !!resp && resp.status() < 500, resp ? 'status=' + resp.status() : 'no response');
    await settle(page);

    // 只查语法/运行时致命错误。网络类报错（fetch failed 之类）不算：
    // 一次 CDN 抖动不该把部署判成坏的。
    const fatal = pageErrors.filter(e => /SyntaxError|Unexpected end of input|Unexpected token|is not a function|is not defined/i.test(e));
    add('无脚本致命错误', fatal.length === 0, fatal.slice(0, 2).join(' | '));

    // 页面已真实渲染：有标题、有标题元素、有可见文案 —— 不依赖任何具体业务文案。
    // 未登录时前端会跳登录页，这是正常行为，因此不断言「必须停留在首页」。
    const rendered = await page.evaluate(() => {
      const heading = document.querySelector('h1, h2, [role="heading"]');
      return {
        url: location.href,
        hasTitle: (document.title || '').trim().length > 0,
        hasHeading: !!heading && heading.textContent.trim().length > 0,
        textLen: (document.body && document.body.innerText || '').trim().length,
      };
    });
    add('页面已真实渲染', rendered.hasTitle && rendered.hasHeading && rendered.textLen > 0, JSON.stringify(rendered));
  } catch (e) {
    // 浏览器链路任何一步炸了都要落成一条可读的失败项。直接抛出去的话 CI 只看到一个
    // stack trace，后面的校验项全部失踪，等于白跑一次。
    add('浏览器校验未抛异常', false, String((e && e.message) || e).slice(0, 300));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return { ok: items.every(i => i.ok), items };
}

// 等页面稳定：优先等 readyState 落到 complete，等不到也继续（慢资源不该拖垮校验）。
// 不采用 networkidle2：页面上的异步请求没有固定终点（列表拉取、节点测速），
// 它要求「两秒内不超过两个连接」，在慢环境里永远等不到，会被 goto 超时炸掉整个 job。
async function settle(page) {
  try {
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000, polling: 500 });
  } catch { /* 不强求：readyState 卡住时仍按下面的固定等待继续取样 */ }
  await new Promise(r => setTimeout(r, 2000));
}

await httpChecks();
await browserChecks();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  -> ' + r.extra : ''}`);
}
console.log(`\n线上校验 ${PROXY}：${results.length} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
