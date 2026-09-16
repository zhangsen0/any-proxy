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

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.goto(PROXY + '/', { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 2000));

    // 只查语法/运行时致命错误，不针对任何特定文案
    const bad = pageErrors.filter(e => /SyntaxError|Unexpected end of input|Unexpected token|is not defined is not a function/i.test(e));
    check('无脚本运行时错误', bad.length === 0, bad.slice(0, 2).join(' | '));

    // 页面已真实渲染：document 有可见文本且存在标题元素（不依赖任何具体业务文案）
    const rendered = await page.evaluate(() => {
      const t = (document.title || '').trim();
      const h1 = document.querySelector('h1');
      return { hasTitle: t.length > 0, hasHeading: !!h1 && h1.textContent.trim().length > 0 };
    });
    check('首页已渲染', rendered.hasTitle && rendered.hasHeading, JSON.stringify(rendered));
  } finally {
    await browser.close();
  }
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
