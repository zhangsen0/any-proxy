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

async function call(path, headers = {}, method = 'GET') {
  try {
    const res = await handleRequest(new Request(ORIGIN + path, { method, headers }), env, {});
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
    mem.set('SUB_URL', '/sub?token=smoketest');
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

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
console.log(`代理链路冒烟：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
