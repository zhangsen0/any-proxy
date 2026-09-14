#!/usr/bin/env node
/**
 * 开发测试用的「目标站」：本地起一个静态站点，供 localhost 反代验证使用。
 * 内容故意包含各种容易被误伤/必须被重写的形态：
 *   - JS 里的 // 注释与 //# sourceMappingURL 标记（绝不能被当成协议相对 URL）
 *   - 字符串里的绝对 URL、协议相对 URL
 *   - CSS 的 url() 、注释
 *   - HTML 的站内链接、协议相对资源、srcset、<base>、integrity
 *
 * 用法：node tools/dev-fixture.mjs [端口]
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || process.env.PORT || 8799);
// 默认回环地址：与反代里登记的 target 主机一致，才能区分「同源→主通道」与「跨域→__x 通道」
const HOST = process.argv[3] || process.env.FIXTURE_HOST || '127.0.0.1';

const APP_JS = `'use strict';
const ENDPOINT = "https://${HOST}:${PORT}/api/ping";
const MIRROR = "//${HOST}:${PORT}/api/mirror";
const CDN = "//cdn.example.org/lib.js";
const REMOTE = "https://cdn.example.org/abs.js";
function note() {
  // TODO: 这行注释不能被当成协议相对 URL
  return typeof window;
}
console.log(note(), ENDPOINT, MIRROR, CDN, REMOTE);
function dot(){ return 1; }
export default note;
//# sourceMappingURL=app.js.map
`;

const STYLE_CSS = `/* // 这是注释里的斜杠，不能被改写 */
.a { background: url(/img/bg.png); }
.b { background: url("https://cdn.example.org/img/x.png"); }
.c { background: url('//cdn.example.org/img/y.png'); }
`;

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Fixture</title>
<base href="https://cdn.example.org/">
<script src="/app.js" integrity="sha384-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"></script>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<h1>Fixture</h1>
<a href="/next/page?q=1">站内下一页</a>
<a href="https://cdn.example.org/abs">站外绝对</a>
<a href="//cdn.example.org/rel">协议相对</a>
<img src="//cdn.example.org/a.png" srcset="/img/s.png 1x, /img/l.png 2x" data-srcset="/img/dd.png 1x">
<form action="/submit" method="post"><button type="submit">提交</button></form>
</body>
</html>`;

const routes = {
  '/': ['text/html; charset=utf-8', PAGE],
  '/next/page': ['text/html; charset=utf-8', '<!DOCTYPE html><html><body><a href="/">回到首页</a></body></html>'],
  '/app.js': ['application/javascript; charset=utf-8', APP_JS],
  // 指纹资源：用于验证反代会给内容寻址资源加一年 immutable 长缓存
  '/app.8f2c1b3d.js': ['application/javascript; charset=utf-8', 'export const v=1;\n'],
  '/style.css': ['text/css; charset=utf-8', STYLE_CSS],
  '/img/bg.png': ['image/png', ''],
  '/api/ping': ['application/json', '{"pong":true}'],
};

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}`);
  const hit = routes[pathname];
  if (!hit) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404'); return; }
  res.writeHead(200, { 'content-type': hit[0], 'cache-control': 'no-store' });
  res.end(hit[1]);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[fixture] http://127.0.0.1:${PORT}/  (HOST=${HOST})`);
});
