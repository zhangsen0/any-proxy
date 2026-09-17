#!/usr/bin/env node
/**
 * 重写规则的纯函数校验（无需网络、无需 Cloudflare 运行时）。
 * 这些用例锁死本次修复的根因，任何一条失败都意味着「页面脚本又会被改写坏」。
 *
 * 用法：node tools/check-rewrite.mjs
 */
import { rewriteContent, mapAbsoluteUrl, isSchemeRelative } from '../src/url.js';

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

let failed = 0;
for (const c of cases) {
  let err = null;
  try { err = c.fn(); } catch (e) { err = 'threw: ' + e.message; }
  if (err) { failed++; console.log('FAIL  ' + c.name + '  -> ' + err); }
  else console.log('PASS  ' + c.name);
}
console.log(`\n重写规则：${cases.length} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
