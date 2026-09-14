#!/usr/bin/env node
/**
 * 线上部署的端到端校验（云端执行，不依赖本地网络）。
 *
 *   node tools/check-e2e.mjs            # 校验默认域名
 *   PROXY_HOST=example.com node tools/check-e2e.mjs
 *
 * 分两部分：
 *   1. HTTP 层：入口、反代页、跨域资源、缓存头
 *   2. 浏览器层（需 puppeteer）：真实渲染，检查是否有脚本语法错误、按钮能否点开、链接能否跳转
 *      —— 这正是「按钮点不动」这类问题的唯一可靠检测方式。
 */
const PROXY = `https://${process.env.PROXY_HOST || 'proxy.520215.xyz'}`;
const SITE = process.env.PROXY_SITE || 'github';
const PAGE = process.env.PROXY_PAGE || `/p/${SITE}/zhangsen0/any-proxy`;

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); };

const abs = (u) => (u.startsWith('http') ? u : new URL(u, PROXY).toString());

async function httpChecks() {
  const cfg = await fetch(`${PROXY}/__api/config`).catch(e => ({ status: 0, text: async () => e.message }));
  check('管理配置接口可用', cfg.status === 200, 'status=' + cfg.status);

  const r = await fetch(PROXY + PAGE, { redirect: 'manual' });
  check('反代首页 200', r.status === 200, 'status=' + r.status);
  const html = await r.text();
  check('反代页是 HTML', /<html/i.test(html));
  check('页面内链接已映射到代理命名空间', html.includes(`/p/${SITE}/`));
  check('没有残留源站绝对地址', !html.includes('https://github.com/'));

  // 抽一个脚本资源，确认跨域通道与「JS 未被改写坏」
  const m = html.match(/<script[^>]+src="([^"]+)"/);
  if (m) {
    const a = await fetch(abs(m[1]));
    const t = await a.text();
    check('跨域通道可取到脚本', a.status === 200, 'status=' + a.status);
    check('脚本未被误改写（无 https://# 注入）', !t.includes('https://#'), t.slice(0, 60));
  } else {
    check('页面含脚本资源', false, 'no script src found');
  }

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
    await page.goto(PROXY + PAGE, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 3000));

    const bad = pageErrors.filter(e => /SyntaxError|Unexpected end of input|Unexpected token/i.test(e));
    check('无脚本语法错误', bad.length === 0, bad.slice(0, 2).join(' | '));

    // 点「Code」按钮：展开下拉说明页面脚本已挂载
    // 注意：不能在 evaluate 内部 await 后读 DOM —— 页面若发生导航，执行上下文销毁会抛
    // ProtocolError（Execution context was destroyed）。所有跨导航的读取都在 evaluate 外部做。
    const codeBtn = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button, summary')]
        .find(b => /^\s*Code\s*$/.test((b.textContent || '').trim()));
      if (!btn) return null;
      btn.click();
      return true;
    });
    await new Promise(r => setTimeout(r, 1500));
    const opened = codeBtn ? await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button, summary')]
        .find(b => /^\s*Code\s*$/.test((b.textContent || '').trim()));
      const el = document.querySelector('.SelectMenu, [data-target*="clone"], #clone-url-input');
      return { found: true, expanded: btn ? btn.getAttribute('aria-expanded') : null, menu: !!el };
    }) : { found: false };
    check('按钮可点击（Code 菜单展开）', opened.found && (opened.expanded === 'true' || opened.menu), JSON.stringify(opened));

    // 点文件链接：应发生站内导航。点击与后续读取分开，避免导航销毁执行上下文
    const before = await page.evaluate(() => location.href);
    const clicked = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find(x => /^(README\.md|wrangler\.toml|worker\.js)$/.test((x.textContent || '').trim()));
      if (!a) return false;
      a.click();
      return true;
    });
    await new Promise(r => setTimeout(r, 2500));
    const after = await page.evaluate(() => location.href).catch(() => before);
    check('链接可跳转', clicked && after !== before && after.includes(`/p/${SITE}/`), JSON.stringify({ clicked, before, after }).slice(0, 160));
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
