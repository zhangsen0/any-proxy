#!/usr/bin/env node
/**
 * 重写规则的纯函数校验（无需网络、无需 Cloudflare 运行时）。
 * 这些用例锁死本次修复的根因，任何一条失败都意味着「页面脚本又会被改写坏」。
 *
 * 用法：node tools/check-rewrite.mjs
 */
import { rewriteContent, mapAbsoluteUrl, isSchemeRelative } from '../src/url.js';
import { injectHomeButton } from '../src/inject.js';

const site = { id: 'demo', host: 'demo.com', scheme: 'https', target: 'https://demo.com' };
const P = '/p/demo';
const ORIGIN = 'https://proxy.example.com';
const base = { host: 'demo.com', prefix: P, origin: ORIGIN };

const cases = [];
const t = (name, fn) => cases.push({ name, fn });
const ok = (cond, name, extra = '') => (cond ? null : `${name}${extra ? ' (' + extra + ')' : ''}`);

t('JS 的 sourceMappingURL 注释不被改写', () => {
  const src = 'console.log(1);\n//# sourceMappingURL=app.js.map\n';
  return ok(rewriteContent(src, site, P, base, 'literal') === src, 'sourceMappingURL', rewriteContent(src, site, P, base, 'literal'));
});
t('JS 的行注释不被改写', () => {
  const src = 'let a = 1; // see https://other.dev/x\nvar b = 2; //# noop\n';
  const out = rewriteContent(src, site, P, base, 'literal');
  return ok(out === src, 'line comment', JSON.stringify(out));
});
t('JS 字符串里的协议相对 URL 仍被重写', () => {
  const out = rewriteContent('var u = "//cdn.other.dev/a.js";', site, P, base, 'literal');
  return ok(out.includes(`${ORIGIN}${P}/__x/cdn.other.dev/a.js`), 'scheme-relative in string', out);
});
t('JS 字符串里的绝对 URL 仍被重写', () => {
  const out = rewriteContent('var u = "https://api.other.dev/v1";', site, P, base, 'literal');
  return ok(out.includes(`${ORIGIN}${P}/__x/api.other.dev/v1`), 'absolute in string', out);
});
t('转义引号包裹的 URL 仍被重写', () => {
  const out = rewriteContent('var cfg = {origin: \\\"https://github.com/demo\\\"};', site, P, base, 'literal');
  return ok(out.includes(`${ORIGIN}${P}/__x/github.com/demo`), 'escaped quote URL', out);
});
t('复合字符串里引号不配对的 URL 仍被重写（闭合引号必须原样保留）', () => {
  // 真实案例：百度降级页 document.write('<a href="http://www.baidu.com/...'+enc+'">登录</a>')
  // 开引号是 href 的 "、闭引号是外层字符串的 '；漏改则链接跳出代理命名空间
  const src = "document.write('<a href=\"https://demo.com/next?u='+encodeURIComponent(location.href)+'\">x</a>');";
  const out = rewriteContent(src, site, P, base, 'literal');
  const okRewritten = out.includes(`${ORIGIN}${P}/next?u=`);
  const okQuotes = out.includes("href=\"" + ORIGIN) && out.includes("u='+encodeURIComponent");
  return ok(okRewritten && okQuotes, 'mixed-quote literal', out);
});
t('JS 里的 URL 必须是绝对地址（单参数 new URL 只接受绝对 URL）', () => {
  const out = rewriteContent('const u = new URL("https://json-schema.org/");', site, P, base, 'literal');
  const m = out.match(/new URL\("([^"]+)"\)/);
  const v = m ? m[1] : '';
  // 根相对路径会让 new URL() 抛 "Failed to construct 'URL': Invalid URL" 并中断整段脚本
  return ok(/^https?:\/\//.test(v), 'must be absolute', v);
});
t('HTML 内联 <script> 里的 URL 同样输出绝对地址', () => {
  const out = rewriteContent(
    '<script>var u = new URL("https://json-schema.org/");</script><a href="/next">x</a>',
    site, P, base, 'html');
  const v = (out.match(/new URL\("([^"]+)"\)/) || [])[1] || '';
  return ok(/^https?:\/\//.test(v), 'inline script must be absolute', v)
    || ok(out.includes(`href="${P}/next"`), 'markup keeps relative', out);
});
t('协议相对判定：必须紧跟合法主机名', () => {
  return ok(isSchemeRelative('//cdn.other.dev/a.js') === true, 'valid host')
    || ok(isSchemeRelative('//# sourceMappingURL=x.map') === false, 'comment must be false')
    || ok(isSchemeRelative('//foo') === false, 'single label must be false');
});
t('HTML 根相对属性走代理前缀', () => {
  const out = rewriteContent('<a href="/next">x</a><script src="/app.js"></script>', site, P, base, 'html');
  return ok(out.includes(`href="${P}/next"`) && out.includes(`src="${P}/app.js"`), 'root-relative attrs', out);
});
t('HTML srcset 逐项重写', () => {
  const out = rewriteContent('<img srcset="/img/s.png 1x, /img/l.png 2x">', site, P, base, 'html');
  return ok(out.includes(`${P}/img/s.png 1x`) && out.includes(`${P}/img/l.png 2x`), 'srcset', out);
});
t('HTML 移除 <base> 与 integrity', () => {
  const out = rewriteContent('<base href="https://cdn.other.dev/"><script src="/a.js" integrity="sha384-x"></script>', site, P, base, 'html');
  return ok(!/<base/i.test(out) && !/integrity=/i.test(out), 'base+integrity', out);
});
t('幂等：已在代理命名空间内的路径不再套前缀', () => {
  const out = rewriteContent('<a href="/p/demo/next">x</a>', site, P, base, 'html');
  return !out.includes('/p/demo/p/demo') ? null : 'idempotent (' + out + ')';
});
t('映射幂等：回传的代理路径原样保留', () => {
  const out = mapAbsoluteUrl('https://demo.com/p/demo/next', site, P, base);
  return out === '/p/demo/next' ? null : 'mapAbsoluteUrl idempotent (' + out + ')';
});
t('CSS url(/...) 走代理前缀', () => {
  const out = rewriteContent('.a{background:url(/img/bg.png)}', site, P, base, 'css');
  return out.includes(`url(${P}/img/bg.png)`) ? null : 'css url (' + out + ')';
});
t('CSS 注释不被改写', () => {
  const src = '/* // not a url */\n.a{color:red}';
  return rewriteContent(src, site, P, base, 'css') === src ? null : 'css comment';
});
t('无 URL 内容原样返回（快速通道）', () => {
  const src = 'body{color:#fff}';
  return rewriteContent(src, site, P, base, 'css') === src ? null : 'fast path';
});

// ---- 「返回主页」按钮：塞进 HTML 还不够，面板是 SPA，一重绘就把按钮抹掉 ----
// 真人反馈过「按钮没了」，而此前没有任何一条检查覆盖它。这里不但验注入结果，
// 还把附带的保活脚本抠出来在最小 DOM 桩上真跑一遍：按钮被移除后必须能自己补回来。
const BTN = 'ap-home-btn';
const withHeader = '<html><body><div class="header-buttons"><a href="/x">x</a></div></body></html>';
const plainBody = '<html><body><p>panel</p></body></html>';
const noBody = '<html><p>fragment</p></html>';

t('返回主页按钮：有顶部导航时注入到导航里', () => {
  const out = injectHomeButton(withHeader);
  return ok(out.includes(BTN) && /<div class="header-buttons"><a id="ap-home-btn"/.test(out), 'nav inject', out.slice(0, 120));
});
t('返回主页按钮：无导航时退回 body 末尾悬浮', () => {
  const out = injectHomeButton(plainBody);
  return ok(out.includes(BTN) && out.includes('position:fixed'), 'fixed inject');
});
t('返回主页按钮：连 body 标签都没有也要注入', () => {
  return ok(injectHomeButton(noBody).includes(BTN), 'fragment inject');
});
t('返回主页按钮：三种形态都附带保活脚本', () => {
  const miss = [withHeader, plainBody, noBody].filter((h) => !/ap-home-btn[\s\S]*<script>/.test(injectHomeButton(h)));
  return ok(!miss.length, 'keepalive script');
});

// 把保活脚本抠出来，在最小 DOM 桩上真跑
function runKeepAlive(html, hasHeader) {
  const m = html.match(/<script>\s*\(function\(\)\{[\s\S]*?\}\)\(\);\s*<\/script>/);
  if (!m) return null;
  const code = m[0].replace(/^<script>/, '').replace(/<\/script>$/, '');
  const nodes = new Map();
  let inserts = 0;
  let cb = null;
  function MO(fn) { cb = fn; }
  MO.prototype.observe = function () {};
  const header = { firstChild: null, insertBefore(el) { nodes.set(el.id, el); inserts++; } };
  const body = { appendChild(el) { nodes.set(el.id, el); inserts++; } };
  const doc = {
    getElementById: (id) => nodes.get(id) || null,
    querySelector: (sel) => (sel === '.header-buttons' && hasHeader ? header : null),
    createElement: () => ({ id: '', href: '', textContent: '', style: {}, setAttribute() {} }),
    body,
    documentElement: {},
  };
  const win = { MutationObserver: MO, addEventListener() {} };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', code)(win, doc);
  return { nodes, cb, inserts: () => inserts };
}

t('返回主页按钮：保活脚本初次就能把按钮挂上', () => {
  const r = runKeepAlive(injectHomeButton(plainBody), false);
  return ok(r && r.nodes.has(BTN), 'initial mount');
});
t('返回主页按钮：被 SPA 重绘抹掉后能补回来', () => {
  const r = runKeepAlive(injectHomeButton(plainBody), false);
  if (!r) return 'no script';
  r.nodes.clear(); // 模拟整块 DOM 被重绘替换
  if (typeof r.cb !== 'function') return 'observer 未注册';
  r.cb();
  return ok(r.nodes.has(BTN), 'remount after repaint');
});
t('返回主页按钮：补回时仍然回到顶部导航（有导航就不悬浮）', () => {
  const r = runKeepAlive(injectHomeButton(withHeader), true);
  if (!r) return 'no script';
  r.nodes.clear();
  r.cb();
  return ok(r.nodes.has(BTN), 'remount into nav');
});
t('返回主页按钮：保活是幂等的（按钮在就不重复插入）', () => {
  const r = runKeepAlive(injectHomeButton(plainBody), false);
  if (!r) return 'no script';
  const before = r.inserts();
  r.cb(); r.cb(); r.cb();
  return ok(r.inserts() === before, 'idempotent', `${before} -> ${r.inserts()}`);
});

let failed = 0;
for (const c of cases) {
  let err = null;
  try { err = c.fn(); } catch (e) { err = 'threw: ' + e.message; }
  if (err) { failed++; console.log('FAIL  ' + c.name + '  -> ' + err); }
  else console.log('PASS  ' + c.name);
}
console.log(`\n重写规则：${cases.length} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
