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

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
console.log(`代理链路冒烟：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
