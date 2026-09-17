#!/usr/bin/env node
/**
 * 反代路径归一化自检（无需网络）。
 *
 * 锁死一个真实故障：客户端把「以 / 结尾的 base 地址」与「以 / 开头的绝对路径」拼接，
 * 产生 /p/<id>//xxx 这种双斜杠路径。语义上等价于单斜杠，但源站与代理都会当成不同的
 * 路径并回 404。
 *
 * 现场（Emby / VidHub）：System/Info 里的 LocalAddress 是站点根 https://site，
 * 改写成代理地址后带上了尾斜杠 https://proxy/p/<id>/；客户端再拼播放地址
 * /play/video/... 就得到 /p/<id>//play/video/... —— 视频点开即失败，播放器反复重试，
 * 流量日志疯涨但始终播不了。
 *
 * 单看代码这只是「少了个 replace」，但它的后果是「能登录、能刷首页、就是播不了」，
 * 极难从表象反推，必须钉死。
 *
 * 用法：node tools/check-path.mjs
 */
import { proxyRequest } from '../src/proxy.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
}

const site = { id: 'demo', name: 'demo', scheme: 'https', host: 'site.example', port: null };

/**
 * 跑一次 proxyRequest，只关心最后送到源站的 URL。
 * 用可控的 fetch 替身接住请求，不产生真实网络访问。
 */
async function capture(pathname) {
  let seen = null;
  globalThis.fetch = async (u) => {
    seen = String(u);
    return new Response('body', {
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'content-length': '4' },
    });
  };
  const req = new Request(`https://proxy.example${pathname}`, { method: 'GET' });
  try { await proxyRequest(req, site, null, null, {}); } catch {}
  return seen;
}

console.log('\n[1] 双斜杠必须折叠成单斜杠（Emby/VidHub 拼接现场）');
{
  const u = await capture('/p/demo//play/video/abc');
  check('双斜杠路径归一到单斜杠', u === 'https://site.example/play/video/abc', u);
}
{
  const u = await capture('/p/demo/play/video/abc');
  check('本来正常的单斜杠不受影响', u === 'https://site.example/play/video/abc', u);
}
{
  const u = await capture('/p/demo///play/video/abc');
  check('三斜杠同样折叠', u === 'https://site.example/play/video/abc', u);
}

console.log('\n[2] 站点根路径仍然映射到源站根');
{
  const u = await capture('/p/demo/');
  check('尾斜杠根路径 -> 源站 /', u === 'https://site.example/', u);
}
{
  const u = await capture('/p/demo');
  check('无尾斜杠根路径 -> 源站 /', u === 'https://site.example/', u);
}

console.log('\n[3] 查询串与深层路径不受影响');
{
  const u = await capture('/p/demo//play/video/abc?api_key=xyz');
  check('双斜杠 + 查询串', u === 'https://site.example/play/video/abc?api_key=xyz', u);
}
{
  // 路径中间的双斜杠属于源站自己的语义，不去动
  const u = await capture('/p/demo/a//b');
  check('路径中间的双斜杠保持原样', u === 'https://site.example/a//b', u);
}

console.log('\n[4] 跨域通道同样归一');
{
  let seen = null;
  globalThis.fetch = async (u) => {
    seen = String(u);
    return new Response('b', { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  };
  const req = new Request('https://proxy.example/p/demo/__x/cdn.example//play/video/abc', { method: 'GET' });
  try { await proxyRequest(req, site, 'cdn.example', null, {}); } catch {}
  check('跨域通道双斜杠归一', seen === 'https://cdn.example/play/video/abc', seen);
}

/**
 * 跑一次 proxyRequest，捕获发送给上游的 URL 与请求头（X-Emby-Token 兜底断言用）。
 */
async function captureUpstream(pathname, extraHeaders = {}) {
  let seen = null;
  globalThis.fetch = async (u, init) => {
    seen = { url: String(u), headers: new Headers((init && init.headers) || {}) };
    return new Response('body', {
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'content-length': '4' },
    });
  };
  const req = new Request(`https://proxy.example${pathname}`, { method: 'GET', headers: extraHeaders });
  try { await proxyRequest(req, site, null, null, {}); } catch {}
  return seen;
}

/**
 * 跑一次 proxyRequest，让上游返回 301 重定向，返回代理改写后的 Location。
 */
async function captureRedirect(pathname, location, extraHeaders = {}) {
  let out = null;
  globalThis.fetch = async () => {
    return new Response(null, {
      status: 301,
      headers: { 'content-type': 'application/octet-stream', location },
    });
  };
  const req = new Request(`https://proxy.example${pathname}`, { method: 'GET', headers: extraHeaders });
  try {
    const res = await proxyRequest(req, site, null, null, {});
    out = res ? res.headers.get('Location') : null;
  } catch {}
  return out;
}

console.log('\n[5] Emby 鉴权兜底：URL 带 api_key 时补 X-Emby-Token 请求头');
{
  const s = await captureUpstream('/p/demo/play/video/abc?api_key=token123');
  check('上游请求带 X-Emby-Token', s && s.headers.get('X-Emby-Token') === 'token123',
    s ? s.headers.get('X-Emby-Token') : 'no-request');
}
{
  const s = await captureUpstream('/p/demo/play/video/abc?api_key=token123',
    { 'X-Emby-Token': 'client-token' });
  check('客户端已带请求头时不覆盖', s && s.headers.get('X-Emby-Token') === 'client-token',
    s ? s.headers.get('X-Emby-Token') : 'no-request');
}
{
  const s = await captureUpstream('/p/demo/play/video/abc');
  check('无 api_key 时不添加请求头', s && !s.headers.has('X-Emby-Token'));
}

console.log('\n[6] 站内重定向保留 api_key（Emby 图片 301 丢参现场）');
{
  const loc = await captureRedirect('/p/demo/Items/m1/Images/Primary?api_key=token123', '/img/i/poster/m1.jpg');
  check('站内重定向补回 api_key', loc === '/p/demo/img/i/poster/m1.jpg?api_key=token123', loc);
}
{
  const loc = await captureRedirect('/p/demo/Items/m1/Images/Primary?api_key=token123', '/img/i/poster/m1.jpg?w=300');
  check('目标已带查询串时用 & 拼接', loc === '/p/demo/img/i/poster/m1.jpg?w=300&api_key=token123', loc);
}
{
  const loc = await captureRedirect('/p/demo/Items/m1/Images/Primary', '/img/i/poster/m1.jpg');
  check('原请求无 api_key 时不添加', loc === '/p/demo/img/i/poster/m1.jpg', loc);
}
{
  // 跨域重定向（__x）绝不携带令牌，避免泄漏给第三方域名
  const loc = await captureRedirect('/p/demo/Items/m1/Images/Primary?api_key=token123',
    'https://cdn.example/img/i/poster/m1.jpg');
  check('跨域目标不携带 api_key', loc === '/p/demo/__x/cdn.example/img/i/poster/m1.jpg', loc);
}

console.log('\n[7] 媒体流不叠加客户端缓存（206 分片 / 音视频 200）');
{
  // 206 分片：源站无缓存头 -> 代理不得强加 public（否则播放器 seek 可能拼错字节）
  let out = null;
  globalThis.fetch = async () => new Response('bytes', {
    status: 206,
    headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-1023/999999' },
  });
  const req = new Request('https://proxy.example/p/demo/videos/a/stream?api_key=t', { method: 'GET', headers: { range: 'bytes=0-1023' } });
  try {
    const res = await proxyRequest(req, site, null, null, {});
    out = res ? res.headers.get('Cache-Control') : 'ERR';
  } catch {}
  check('206 分片不加 public 缓存头', out === null, String(out));
}
{
  // 200 视频：源站标 private（鉴权内容）-> 不得被覆盖成 public
  let out = null;
  globalThis.fetch = async () => new Response('x', {
    status: 200,
    headers: { 'content-type': 'video/mp4', 'cache-control': 'private' },
  });
  const req = new Request('https://proxy.example/p/demo/videos/a/stream?api_key=t', { method: 'GET' });
  try {
    const res = await proxyRequest(req, site, null, null, {});
    out = res ? res.headers.get('Cache-Control') : 'ERR';
  } catch {}
  check('鉴权视频保持源站 private', out === 'private', String(out));
}
{
  // 普通静态资源（JS）仍可缓存 —— 原有行为不回归
  let out = null;
  globalThis.fetch = async () => new Response('x', {
    status: 200,
    headers: { 'content-type': 'application/javascript' },
  });
  const req = new Request('https://proxy.example/p/demo/app.js', { method: 'GET' });
  try {
    const res = await proxyRequest(req, site, null, null, {});
    out = res ? res.headers.get('Cache-Control') : 'ERR';
  } catch {}
  check('JS 静态资源仍给短缓存', out === 'public, max-age=3600, stale-while-revalidate=86400', String(out));
}

console.log(`\n路径归一化自检：通过 ${pass}，失败 ${fail}\n`);
if (fail) process.exit(1);
