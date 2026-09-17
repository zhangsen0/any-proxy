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
import { bindRuntime } from '../src/runtime.js';
import { kvKey } from '../src/util.js';

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

async function call(path, headers = {}) {
  try {
    const res = await handleRequest(new Request(ORIGIN + path, { method: 'GET', headers }), env, {});
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

console.log('\n[2] 浏览器支持 gzip 时，页面压着发');
{
  const r = await call('/p/demo/', { ...NAV, 'Accept-Encoding': 'gzip, deflate, br' });
  ok('HTTP 200', r.status === 200, `status=${r.status}`);
  ok('带 Content-Encoding: gzip', r.headers.get('content-encoding') === 'gzip');
  ok('带 Vary: Accept-Encoding', /accept-encoding/i.test(r.headers.get('vary') || ''));
  const back = await gunzip(r.buf);
  ok('解压后仍是完整的主文档包裹', back.includes('127.0.0.1') && back.includes('<script'), `${back.length} 字符`);
  const plain = await call('/p/demo/', { ...NAV, 'Accept-Encoding': 'identity' });
  ok('压缩版显著小于明文版', r.buf.byteLength < plain.buf.byteLength,
    `${plain.buf.byteLength}B -> ${r.buf.byteLength}B`);
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

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
console.log(`代理链路冒烟：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
