#!/usr/bin/env node
/**
 * 代理链路冒烟自检：从路由入口一路走到页面出口。
 *
 * 为什么要这一层：单元测试各自通过、组合起来却炸的事真的发生过——
 * proxyRequest 增加 env 参数后，dispatchProxy 没跟着传，结果每个代理页面
 * 都 502（ReferenceError）。而 rewrite / compress / disguise 的单测全绿，
 * 因为它们都没走完整链路。这类问题只有把整条路跑通才抓得住。
 *
 * 所以这里刻意从 handleRequest 进入，而不是直接调某个内部函数。
 *
 * 用法：
 *   node tools/check-smoke.mjs
 */
import { handleRequest } from '../src/router.js';
import { handleWebSocket } from '../src/proxy.js';
import { bindRuntime } from '../src/runtime.js';
import { kvKey } from '../src/util.js';
import { invalidateSettings } from '../src/settings.js';
import zlib from 'node:zlib';

const ORIGIN = 'https://proxy.example.com';
const PASSWORD = 'dev';
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

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  -> ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  -> ' + extra : ''}`); }
}

// 假源站：返回一段够大的 HTML（低于 512B 就不会触发压缩，测不出东西）
const ORIGIN_BODY = '<!DOCTYPE html><html><head><title>演示站 Demo</title>'
  + '<script src="/app.js"></script></head><body>'
  + '上游正文 '.repeat(300)
  + '</body></html>';

let upstreamCalls = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/app.js')) {
    return new Response('console.log(1);', { status: 200, headers: { 'content-type': 'application/javascript' } });
  }
  upstreamCalls++;
  return new Response(ORIGIN_BODY, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
};

mem.set(kvKey('demo'), JSON.stringify({
  id: 'demo', name: '演示站', host: '127.0.0.1', target: 'http://127.0.0.1', scheme: 'http',
}));

const NAV = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Sec-Fetch-Dest': 'document',
};

async function call(path, headers = {}, method = 'GET', body) {
  try {
    const res = await handleRequest(new Request(ORIGIN + path, { method, headers, body }), env, {});
    const buf = await res.arrayBuffer();
    return { status: res.status, buf, headers: res.headers };
  } catch (e) {
    return { status: 0, buf: new ArrayBuffer(0), headers: new Headers(), err: String(e && e.message) };
  }
}

async function gunzip(buf) {
  const out = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(out).text();
}

console.log('\n[1] 代理页面能正常出来（守住ReferenceError 这类调用链断层）');
{
  upstreamCalls = 0;
  const r = await call('/p/demo/', { ...NAV, 'Accept-Encoding': 'identity' });
  ok('HTTP 200（不是 502 / 不是抛异常）', r.status === 200, `status=${r.status} ${r.err ? r.err : ''}`);
  ok('确实转发到了上游', upstreamCalls === 1, `上游调用 ${upstreamCalls} 次`);
  const text = new TextDecoder().decode(r.buf);
  // 主文档走 docWrite 方案：原始 HTML 以 base64 嵌进脚本由客户端重建，
  // 所以这里看不到明文正文，但目标站信息会出现在注入脚本里。
  ok('注入脚本带目标站信息', text.includes('127.0.0.1'), `${text.length} 字符`);
  ok('注入了前端钩子脚本', text.includes('<script'));

  // 非导航请求（Turbo / fetch 局部更新）走服务端重写，正文是明文，直接用它验证重写结果。
  // Sec-Fetch-Dest 必须是 empty：缺省时 isNavigation 会按 Accept 兜底判成导航。
  const frag = await call('/p/demo/', {
    Accept: 'text/html', 'Sec-Fetch-Dest': 'empty', 'Accept-Encoding': 'identity',
  });
  const fragText = new TextDecoder().decode(frag.buf);
  ok('服务端重写路径能拿到源站正文', fragText.includes('上游正文'), `${fragText.length} 字符`);
}

console.log('\n[2] 出口编码契约：Worker 一律发明文，压缩协商交给边缘（见 src/compress.js）');
{
  // 曾经的实现按入站 AE 决定是否 gzip，被 CF 边缘「改写入站 AE + 对未要求压缩的
  // 客户端剥 CE 不解压」合伙搞成整站乱码。这条用例守住：不管 AE 是什么，出口必须明文。
  for (const ae of ['gzip, deflate, br', 'identity', 'xyz']) {
    const r = await call('/p/demo/', { ...NAV, 'Accept-Encoding': ae });
    ok(`AE=${JSON.stringify(ae)} HTTP 200`, r.status === 200, `status=${r.status}`);
    const head = new Uint8Array(r.buf.slice(0, 2));
    const isGzip = head[0] === 0x1f && head[1] === 0x8b;
    ok(`AE=${JSON.stringify(ae)} 出口是明文（不是 gzip 字节）`, !isGzip, `len=${r.buf.byteLength}`);
    ok(`AE=${JSON.stringify(ae)} 不带 Content-Encoding`, r.headers.get('content-encoding') === null,
      String(r.headers.get('content-encoding')));
    const text = new TextDecoder().decode(r.buf);
    ok(`AE=${JSON.stringify(ae)} 主文档包裹完整`, text.includes('127.0.0.1') && text.includes('<script'),
      `${r.buf.byteLength} 字符`);
  }
}

console.log('\n[3] 不支持压缩的浏览器照常拿到明文');
{
  const r = await call('/p/demo/', { ...NAV, 'Accept-Encoding': 'identity' });
  ok('不带 Content-Encoding', r.headers.get('content-encoding') === null);
  ok('解压函数是解不开它的（说明确实是明文）', await gunzip(r.buf).catch(() => null) === null);
}

console.log('\n[4] 站点不存在时不炸');
{
  const r = await call('/p/nonexistent/', { ...NAV });
  ok('返回 404 而不是异常', r.status === 404 || r.status === 200, `status=${r.status}`);
}

console.log('\n[5] 优选候选的同源自拉必须带凭据（否则被自家伪装挡成 404）');
// 背景：伪装开启时，Worker 内部 fetch 自己的 /sub 是一个不带 cookie 的全新请求，
// 会被首页伪装当成陌生人渲染成伪装 404 —— 面板表现即「订阅拉取失败: HTTP 404」。
// 回归口径：同源自拉必须带 ap_auth；外部订阅地址绝不能带（避免泄漏口令）。
{
  const realFetch = globalThis.fetch;
  const seen = []; // { url, cookie }
  const SUB_BODY = Buffer.from(
    ['vless://00000000-0000-4000-8000-000000000000@104.16.1.1:443?a=1#edge', 'vless://00000000-0000-4000-8000-000000000000@8.8.8.8:443?a=1#dns'].join('\n')
  ).toString('base64');
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/sub?token=') || u.includes('external-sub.example.com')) {
      const h = (init && init.headers) || {};
      seen.push({ url: u, cookie: h.Cookie || h.cookie || '' });
      if (u.includes('external-sub.example.com')) return new Response('vless://x@1.2.3.4:443#n', { status: 200 });
      return new Response(SUB_BODY, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (u.includes('api.cloudflare.com/client/v4/ips')) {
      return new Response(JSON.stringify({ result: { ipv4_cidrs: ['104.16.0.0/12'] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };

  const AUTH = 'ap_auth=' + Buffer.from(PASSWORD).toString('base64');
  try {
    // 场景 A：SUB_URL 指向本机 /sub（同源）
    // 直接写 KV 键 = 绕过面板写入，readSettings 的进程内缓存对此无感（与 config.js
    // 「外部变更最多等一个 TTL」同口径），所以这里显式作废，模拟的是「冷启动读到这份值」
    mem.set('SUB_URL', '/sub?token=smoketest');
    invalidateSettings();
    seen.length = 0;
    const ra = await call('/__api/preferred-candidates', { Cookie: AUTH });
    const ja = JSON.parse(new TextDecoder().decode(ra.buf));
    ok('HTTP 200 且拉到候选 IP', ra.status === 200 && ja.ok && (ja.ips || []).length > 0,
      `status=${ra.status} ips=${(ja.ips || []).length} note=${ja.note || ''}`);
    const selfCall = seen.find(s => s.url.includes('/sub?token='));
    ok('确实发起了同源自拉', !!selfCall, selfCall ? selfCall.url.slice(ORIGIN.length) : '(未发起)');
    ok('同源自拉带上了 ap_auth 凭据', !!selfCall && selfCall.cookie === AUTH,
      selfCall ? `cookie=${selfCall.cookie ? '有' : '无'}` : '');
    ok('边缘段过滤生效（8.8.8.8 被滤掉）', (ja.ips || []).includes('104.16.1.1') && !(ja.ips || []).includes('8.8.8.8'),
      `ips=${JSON.stringify(ja.ips)}`);

    // 场景 B：SUB_URL 指向外部订阅 —— 绝不能把凭据带出去
    mem.set('SUB_URL', 'https://external-sub.example.com/sub?token=ext');
    invalidateSettings();   // 同上：绕过面板的直接写入，缓存看不见
    seen.length = 0;
    const rb = await call('/__api/preferred-candidates', { Cookie: AUTH });
    JSON.parse(new TextDecoder().decode(rb.buf));
    const extCall = seen.find(s => s.url.includes('external-sub.example.com'));
    ok('外部订阅请求不带本站凭据', !!extCall && extCall.cookie === '',
      extCall ? `cookie=${extCall.cookie ? '泄漏了!' : '无'}` : '(未发起)');
  } finally {
    mem.delete('SUB_URL');
    globalThis.fetch = realFetch;
  }
}

console.log('\n[6] 上游无视 Accept-Encoding: identity 强发 br（整站乱码事故回归）');
// 背景：proxyRequest 向上游发的是 Accept-Encoding: identity，但真实世界有源站无视它
// 强行返回 br。Workers 运行时只自动解 gzip/deflate，br 会原样透传——压缩字节按文本
// 解码就是整页乱码，且后续还会删掉 content-encoding 头，体头彻底对不上。
// 回归口径：br 必须被解成明文再改写；运行时不支持的格式则连头带体原样透传。
{
  const realFetch = globalThis.fetch;
  const realDS = globalThis.DecompressionStream;
  const brBody = zlib.brotliCompressSync(Buffer.from(ORIGIN_BODY, 'utf8'));
  // 本地 Node 的 DecompressionStream 不认识 br：用 zlib 桩一个，专门验证解压路径
  class BrDecompressionStream {
    constructor(format) {
      if (String(format).toLowerCase() !== 'br') throw new TypeError('unsupported: ' + format);
      const d = zlib.createBrotliDecompress();
      this.readable = new ReadableStream({
        start(c) { d.on('data', x => c.enqueue(new Uint8Array(x))); d.on('end', () => c.close()); d.on('error', e => c.error(e)); },
        cancel() { d.destroy(); },
      });
      this.writable = new WritableStream({
        write(x) { return new Promise((res, rej) => d.write(x, err => (err ? rej(err) : res()))); },
        close() { return new Promise(res => d.end(() => res())); },
        abort(e) { d.destroy(e); },
      });
    }
  }
  let sawAcceptEncoding = '';
  const brUpstream = async () => new Response(brBody, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'br' },
  });
  try {
    // 场景 A：运行时支持 br（有 DecompressionStream）→ 必须解成明文再改写输出
    globalThis.fetch = async (url, init) => {
      sawAcceptEncoding = String((init && init.headers instanceof Headers
        ? init.headers.get('accept-encoding') : (init && init.headers && init.headers['accept-encoding'])) || '');
      return brUpstream();
    };
    globalThis.DecompressionStream = BrDecompressionStream;
    const a = await call('/p/demo/', { 'Accept-Encoding': 'br' });
    ok('上游响应 200', a.status === 200, `status=${a.status}`);
    ok('发给上游的仍是 identity（省一次解压是优化，不是依赖）', sawAcceptEncoding === 'identity',
      `accept-encoding=${sawAcceptEncoding}`);
    const textA = new TextDecoder().decode(a.buf);
    ok('br 被解成明文（正文可读、无乱码）', textA.includes('演示站') && !textA.includes('\uFFFD'),
      `len=${a.buf.length}`);
    ok('输出不带 content-encoding（已解压，头必须同步）', !a.headers.get('content-encoding'),
      `enc=${a.headers.get('content-encoding') || '无'}`);

    // 场景 B：运行时不认识这种格式（构造即抛）→ 连头带体原样透传，浏览器自己解
    globalThis.DecompressionStream = class { constructor() { throw new TypeError('unsupported'); } };
    const b = await call('/p/demo/', { 'Accept-Encoding': 'br' });
    ok('解不开时返回 200（降级透传而不是 5xx）', b.status === 200, `status=${b.status}`);
    ok('透传保留 content-encoding（头体一致，浏览器可自行解码）',
      (b.headers.get('content-encoding') || '').toLowerCase() === 'br',
      `enc=${b.headers.get('content-encoding')}`);
    ok('透传体就是上游原始压缩字节（未被当文本改写）',
      Buffer.compare(Buffer.from(b.buf), brBody) === 0, `len=${b.buf.length} vs ${brBody.length}`);

    // 场景 C：上游在 CF 边缘后面，边缘把子响应压成 gzip 且**不带 content-encoding 头**
    // （线上复发事故：头是空的、body 是 1f 8b 魔术字节）。按头裁决会当明文 → 整页乱码，
    // 必须按魔术字节嗅探出来并解压。gzip 用本地 DecompressionStream 原生支持，无需桩。
    globalThis.DecompressionStream = realDS;
    const gzBody = zlib.gzipSync(Buffer.from(ORIGIN_BODY, 'utf8'));
    globalThis.fetch = async () => new Response(gzBody, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' }, // 刻意不带 content-encoding
    });
    const c = await call('/p/demo/', { 'Accept-Encoding': 'identity' });
    ok('无头 gzip：上游响应 200', c.status === 200, `status=${c.status}`);
    const textC = new TextDecoder().decode(c.buf);
    ok('无头 gzip 被嗅探并解压（正文可读、无乱码）',
      textC.includes('演示站') && !textC.includes('\uFFFD'), `len=${c.buf.length}`);
    ok('无头 gzip：输出不带 content-encoding（已解压，头必须干净）',
      !c.headers.get('content-encoding'), `enc=${c.headers.get('content-encoding') || '无'}`);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.DecompressionStream = realDS;
  }
}

// [7] WebSocket 透传：上游 OPEN 前到达的客户端消息必须被缓冲、OPEN 后按序冲刷。
// 真实事故：按 readyState===1 直接放行，客户端在 101 后立刻发出的第一条消息
// 撞上出站握手仍在 CONNECTING 的窗口被静默丢弃 —— 表现为「握手成功但回显永远不来」。
// Cloudflare 的 WebSocketPair 是运行时能力，这里用最小桩还原握手时序做行为级验证。
{
  console.log('\n[7] WebSocket 透传：CONNECTING 窗口的消息不得丢弃');
  let lastPair = null;
  let lastUpstream = null;
  class FakeSock {
    constructor() { this.listeners = {}; this.sent = []; this.readyState = 1; this.closed = false; }
    accept() {}
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    send(d) { if (this.readyState !== 1) throw new Error('send on non-open socket'); this.sent.push(d); }
    close() { this.closed = true; }
    fire(t, ev) { for (const fn of this.listeners[t] || []) fn(ev); }
  }
  const RealWS = globalThis.WebSocket;
  const RealPair = globalThis.WebSocketPair;
  const RealResponse = globalThis.Response;
  // Node 的 undici Response 不接受 101；CF 运行时允许 { status:101, webSocket }，桩掉即可
  globalThis.Response = class {
    constructor(body, init = {}) { this.status = init.status; this.webSocket = init.webSocket; }
  };
  globalThis.WebSocketPair = class { constructor() { this[0] = new FakeSock(); this[1] = new FakeSock(); lastPair = this; } };
  globalThis.WebSocket = class {
    constructor() { this.readyState = 0; this.listeners = {}; this.sent = []; lastUpstream = this; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    send(d) { if (this.readyState !== 1) throw new Error('send on non-open upstream'); this.sent.push(d); }
    close() { this.readyState = 3; }
    fire(t, ev) { if (t === 'open') this.readyState = 1; for (const fn of this.listeners[t] || []) fn(ev); }
  };
  try {
    const req = new Request('https://proxy.example.com/p/demo/ws', { headers: { Upgrade: 'websocket' } });
    const resp = await handleWebSocket(req, { id: 'demo', host: 'demo.com' }, null);
    ok('升级返回 101 且携带客户端侧 socket', resp.status === 101 && !!resp.webSocket && resp.webSocket === lastPair[0]);
    const server = lastPair[1];
    const upstream = lastUpstream;
    ok('出站握手尚未完成（CONNECTING 窗口存在）', upstream.readyState === 0);
    server.fire('message', { data: 'early' });
    ok('OPEN 前到达的消息不外发、先入队', upstream.sent.length === 0);
    upstream.fire('open');
    ok('OPEN 后按序冲刷积压消息', upstream.sent.join(',') === 'early', `sent=${upstream.sent.join(',')}`);
    server.fire('message', { data: 'late' });
    ok('OPEN 后消息直通上游', upstream.sent.join(',') === 'early,late', `sent=${upstream.sent.join(',')}`);
    upstream.fire('message', { data: 'from-upstream' });
    ok('上游消息中继回客户端侧', server.sent.join(',') === 'from-upstream', `sent=${server.sent.join(',')}`);
    upstream.fire('close', {});
    ok('上游断开联动关闭客户端侧', server.closed === true);
  } finally {
    globalThis.WebSocket = RealWS;
    globalThis.WebSocketPair = RealPair;
    globalThis.Response = RealResponse;
  }
}

// [8] OPTIONS 预检必须 204。真实事故：router.js 用了 cors() 却漏 import，任何预检
// 一进来就 ReferenceError → 全局兜底渲染成伪装 404。本地从未真打过 OPTIONS，漏网至今。
console.log('\n[8] OPTIONS 预检：不得 5xx / 伪装 404');
{
  const r = await call('/p/demo/', {}, 'OPTIONS');
  ok('预检返回 204', r.status === 204, `status=${r.status} ${r.err || ''}`);
  ok('响应带 CORS 放行头', !!r.headers.get('access-control-allow-origin'), `${r.headers.get('access-control-allow-origin')}`);
  const r2 = await call('/', {}, 'OPTIONS');
  ok('根路径预检同样 204', r2.status === 204, `status=${r2.status} ${r2.err || ''}`);
}

// [9] 分片请求（Range）—— 视频播放的关键路径。
// 真实故障：源站不支持 Range 时，反代把整个文件塞回给只要了一小段的播放器，
// 却一个 Accept-Ranges 头都不给，播放器无从得知「这里不能分片」，于是每要一段
// 就重新下载一整个文件 —— 转发流量按分片数翻倍、网速越来越慢、最后还是播不了。
console.log('\n[9] 分片请求：上游不支持 Range 时必须明确声明，否则流量按分片数翻倍');
{
  const realFetch = globalThis.fetch;

  // 场景 A：上游支持 Range —— 206 必须原样透传，Content-Range 一个字都不能动
  globalThis.fetch = async () => new Response(new Uint8Array(100), {
    status: 206,
    headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-99/1000', 'accept-ranges': 'bytes' },
  });
  const a = await call('/p/demo/ok.mp4', { Range: 'bytes=0-99' });
  ok('上游支持 Range 时 206 原样透传', a.status === 206, `status=${a.status}`);
  ok('Content-Range 原样保留', (a.headers.get('content-range') || '').includes('bytes 0-99'),
    `${a.headers.get('content-range')}`);
  ok('不谎报成 none', a.headers.get('accept-ranges') !== 'none', `${a.headers.get('accept-ranges')}`);

  // 场景 B：上游不支持 Range（要了分片却回 200 整个文件）—— 必须声明 none
  globalThis.fetch = async () => new Response(new Uint8Array(1000), {
    status: 200,
    headers: { 'content-type': 'video/mp4' },
  });
  const b = await call('/p/demo/norange.mp4', { Range: 'bytes=0-99' });
  ok('上游不支持 Range 时声明 none', b.headers.get('accept-ranges') === 'none',
    `${b.headers.get('accept-ranges') || '无'}`);

  // 场景 C：没要分片的普通请求不该被误标 none（否则会误伤正常下载）
  const c = await call('/p/demo/plain.mp4', {});
  ok('未带 Range 的请求不声明 none', c.headers.get('accept-ranges') !== 'none',
    `${c.headers.get('accept-ranges') || '无'}`);

  globalThis.fetch = realFetch;
}

// [10] 站点增删改之后必须**立刻**可见 —— 钉住 `sites.js` 那层进程内缓存的失效点。
//
// 为什么单开一段：`getSite` 落在每个反代请求的热路径上（媒体播放一次上百个分片），
// 不缓存就变成一次播放几百次存储读。但加了缓存之后，每一次写入之后**都必须**同时清缓存，
// 漏一处就是「改完 slug 三秒内还走旧值」「刚删除的站点还能打开」——
// 症状看起来就是「保存成功、行为没变」，而且只在缓存窗口那几秒内出现，极难复现。
//
// 牙齿验证（四份清理缺哪个坏哪个，均已逐条实测）：
//   · `src/admin.js` DELETE 分支的 `invalidateSite(id)`            -> 「删除后立刻打不开」「删除后列表里也没有了」
//   · `src/admin.js` PUT 末尾的 `invalidateSite(keyId)`            -> 「改完 slug：新后缀立刻打得开」
//   · `src/admin.js` 的 `if (renamedFrom) invalidateSite(...)`      -> 「旧后缀立刻打不开」
//   · `src/sites.js` 里 `addSite()` 末尾那份                        -> 「新增后列表里立刻就有」「新增后立刻能打开」
// 在补这一段之前，这四份一处都没被任何检查盯着；且早先它们散成三份互相打掩护
// （三选二就够用，砍掉一份照样全绿），收拢之后才做到「缺哪个坏哪个」。
//
// ⚠️ 这里每一条都要先「预热」再验，否则断言全是假的：缓存本来是空的（cold），
// 写完之后就算没失效，下次读也会因为 miss 而拿到新值 —— 怎么改都是绿的，
// 验的其实是「缓存天生没东西」，不是「写入之后有没有清」。
// 必须先把一份「写着没有 / 写着旧值」的副本装进缓存，改动才有被暴露的机会。
console.log('\n[10] 站点增删改后立即生效（缓存失效点）');
{
  const AUTH = { Cookie: 'ap_auth=' + Buffer.from(PASSWORD).toString('base64'), 'Content-Type': 'application/json' };
  const jcall = async (p, m, b) => {
    const r = await call(p, AUTH, m, JSON.stringify(b));
    let j = {};
    try { j = JSON.parse(new TextDecoder().decode(r.buf)); } catch {}
    return { status: r.status, j };
  };

  const rnd = Math.random().toString(36).slice(2, 7);
  const slug = 'smoke-' + rnd;
  const newSlug = slug + '-v2';

  // 探针用**真实访问路径** `/p/<slug>/`（而不用 `/__api/sites/:id` —— 后者没有 GET 分支）：
  // 用户感知的正是「能不能打开」，顺带把「新增完立刻能用」这条也覆盖了。
  const open = async (id) => (await call(`/p/${id}/`, { ...NAV, 'Accept-Encoding': 'identity' })).status;
  const listHas = async (id) => {
    const r = await jcall('/__api/sites', 'GET');
    const sites = r.j.sites || [];
    return { n: sites.length, has: sites.some(s => s.id === id) };
  };

  // 1) 新增：先把「列表里没有它」「这个后缀不存在」两份旧状态塞进缓存，再写
  const absent = await open(slug);
  ok('前置：新后缀此刻不存在（负缓存里已有一份「没有」）', absent === 404, `HTTP ${absent}`);
  const beforeN = (await listHas(slug)).n;

  const cre = await jcall('/__api/sites', 'POST', { name: '缓存校验站', slug, target: 'https://cache-check.example.com' });
  ok('新增站点返回 201', cre.status === 201, `HTTP ${cre.status} ${cre.j.error || ''}`);
  const list1 = await listHas(slug);
  ok('新增后列表里立刻就有', list1.has, `列表 ${list1.n} 条（新增前 ${beforeN} 条）`);
  const freshSt = await open(slug);
  ok('新增后立刻能打开（不是要等缓存过期）', freshSt === 200, `HTTP ${freshSt}`);

  // 2) 改 slug：新后缀立刻可用、旧后缀立刻打不开 —— 两个方向都要清，
  //    只清新不清旧会让旧地址在缓存窗口里继续可用（看起来像删不掉）
  const put = await jcall(`/__api/sites/${slug}`, 'PUT', { slug: newSlug });
  ok('改 slug 返回 200', put.status === 200, `HTTP ${put.status} ${put.j.error || ''}`);
  const nsSt = await open(newSlug);
  ok('改完 slug：新后缀立刻打得开', nsSt === 200, `HTTP ${nsSt}`);
  const oldSt = await open(slug);
  ok('改完 slug：旧后缀立刻打不开（缓存里没留下残影）', oldSt === 404, `HTTP ${oldSt}`);

  // 3) 删除：立刻打不开，也从列表里消失。
  //    列表要重新预热一次 —— 上一步改 slug 时顺手清过 listCache，不重装进去
  //    这条就退化成「缓存本来是空的」，永远绿。
  const warm = await listHas(newSlug);
  ok('前置：删除前列表里确实有它（列表缓存已装上）', warm.has, `列表 ${warm.n} 条`);
  const del = await jcall(`/__api/sites/${newSlug}`, 'DELETE');
  ok('删除返回 200', del.status === 200, `HTTP ${del.status}`);
  const goneSt = await open(newSlug);
  ok('删除后立刻打不开', goneSt === 404, `HTTP ${goneSt}`);
  const list2 = await listHas(newSlug);
  ok('删除后列表里也没有了', !list2.has, `列表 ${list2.n} 条`);
}

// [11] 注入到页面的脚本必须是合法 JS：页面能渲染 ≠ 前端能跑。
//
// 这一段的来历很痛：面板整段 script 是被模板字符串拼出来的。写
//     alert('写回 ' + n + ' 个' + '\n跳过' + m)
// 这种单反斜杠写法时，反斜杠被模板字符串提前解释成了真实换行，浏览器拿到的是
// 「单引号字符串里出现裸换行」——直接 SyntaxError，整个 script 块一行都不执行。
// 后果特别难查：页面照样渲染得漂漂亮亮，但所有按钮的 onclick 一个都没挂上，
// 用户看到的就是「所有功能都不能用」；而后端接口清一色 200，Worker 日志一条报错都没有。
// 从此所有带 script 的页面都把里面的脚本原样抽出来过一遍语法。
console.log('\n[11] 注入页面的脚本必须是合法 JS（页面能渲染不等于前端能跑）');
{
  const AUTH = 'ap_auth=' + Buffer.from(PASSWORD).toString('base64');
  const pages = ['/__admin', '/__login', '/'];
  for (const p of pages) {
    const resp = await handleRequest(new Request(ORIGIN + p, { headers: { Cookie: AUTH } }), env, {});
    const html = await resp.text();
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    if (scripts.length === 0) { ok(`${p} 不含注入脚本（跳过语法检查）`, true, `${html.length}B`); continue; }
    let err = null;
    for (const s of scripts) {
      // 只构造不调用：语法都在这里解析完，运行时才跑的部分交给浏览器
      try { new Function(s); } catch (e) { err = `${e.name}: ${e.message}`.slice(0, 140); break; }
    }
    ok(`${p} 的 ${scripts.length} 段脚本都过得了语法（前端不会整块不执行）`, err === null, err || '');
  }
}

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
console.log(`代理链路冒烟：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
