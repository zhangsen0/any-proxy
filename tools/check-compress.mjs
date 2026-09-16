#!/usr/bin/env node
// 出口压缩 + 上游请求策略的自检。
//
// 压缩是「优化」类改动里最危险的一类：做对了只是快一点，
// 做错了会把浏览器解不开的 body 发出去，整站 JS/CSS 一起挂。
// 所以这里既验证「压了」，也验证「压完能还原成原文」，以及「不该压的别压」。

import {
  acceptsEncoding, compressible, finalizeResponse,
} from '../src/compress.js';
import { fetchUpstream } from '../src/proxy.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
}

async function gunzip(res) {
  const buf = await res.arrayBuffer();
  const out = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(out).text();
}

console.log('\n[1] Accept-Encoding 解析');
check('普通 gzip', acceptsEncoding('gzip, deflate, br', 'gzip') === true);
check('q=0 视为不接受', acceptsEncoding('gzip;q=0', 'gzip') === false);
check('q=0.5 视为接受', acceptsEncoding('gzip;q=0.5', 'gzip') === true);
check('通配符接受', acceptsEncoding('*', 'gzip') === true);
check('只有 br 时 gzip 不算接受', acceptsEncoding('br', 'gzip') === false);
check('只有 identity 不算接受', acceptsEncoding('identity', 'gzip') === false);
check('空头不接受', acceptsEncoding('', 'gzip') === false);

console.log('\n[2] 哪些响应不该压');
check('普通 HTML 可压', compressible(new Headers({ 'content-type': 'text/html; charset=utf-8' })) === true);
check('已压缩的不再压', compressible(new Headers({ 'content-encoding': 'gzip' })) === false);
check('SSE 不压（会被缓冲）', compressible(new Headers({ 'content-type': 'text/event-stream' })) === false);
check('图片不压', compressible(new Headers({ 'content-type': 'image/png' })) === false);

console.log('\n[3] 压缩输出：解压后必须逐字节还原');
{
  const big = ('<!DOCTYPE html><html><body>' + '代理内容 proxy content '.repeat(400) + '</body></html>');
  const h = new Headers({ 'content-type': 'text/html; charset=utf-8', 'content-length': '9999' });
  const res = finalizeResponse(200, big, h, 'gzip, deflate, br');
  const enc = res.headers.get('content-encoding');
  check('带上 Content-Encoding: gzip', enc === 'gzip', String(enc));
  check('清掉了过期的 Content-Length', res.headers.get('content-length') === null);
  check('带 Vary: Accept-Encoding', /accept-encoding/i.test(res.headers.get('vary') || ''));
  const gzRes = res.clone();
  const back = await gunzip(res);
  check('解压后与原文完全一致', back === big, `${big.length} 字符`);
  const rawLen = new TextEncoder().encode(big).byteLength;
  const gzLen = (await gzRes.arrayBuffer()).byteLength;
  check('确实变小了', gzLen < rawLen, `${rawLen}B -> ${gzLen}B`);
}

console.log('\n[4] 不该压的场景保持明文');
{
  const small = 'hi';
  const r1 = finalizeResponse(200, small, new Headers({ 'content-type': 'text/html' }), 'gzip');
  check('小于阈值不压缩', r1.headers.get('content-encoding') === null);
  const r2 = finalizeResponse(200, 'x'.repeat(3000), new Headers({ 'content-type': 'text/html' }), 'identity');
  check('浏览器不接受 gzip 时发明文', r2.headers.get('content-encoding') === null);
  const r3 = finalizeResponse(200, 'x'.repeat(3000),
    new Headers({ 'content-type': 'text/event-stream' }), 'gzip');
  check('SSE 保持明文', r3.headers.get('content-encoding') === null);
  const r4 = finalizeResponse(200, 'x'.repeat(3000),
    new Headers({ 'content-type': 'text/html', 'content-encoding': 'br' }), 'gzip');
  check('已压缩的不再二次压缩', r4.headers.get('content-encoding') === 'br');
}

console.log('\n[5] 上游请求：重试不再空等，且行为可控');
{
  const real = globalThis.fetch;
  const calls = [];
  const restore = () => { globalThis.fetch = real; };

  // 5xx 后重试一次
  calls.length = 0;
  globalThis.fetch = async () => {
    calls.push(Date.now());
    return new Response('x', { status: calls.length === 1 ? 500 : 200 });
  };
  let r = await fetchUpstream('https://a.test/', { method: 'GET' }, 0);
  check('5xx 会重试一次', calls.length === 2, `调用 ${calls.length} 次`);
  check('重试后拿到成功响应', r.status === 200);

  // 原本这里有 300ms sleep，现在应当是立即重试
  check('重试间隔接近 0（不再 sleep 300ms）', (calls[1] - calls[0]) < 100, `${calls[1] - calls[0]}ms`);

  // 对冲：GET 无 body 才触发
  calls.length = 0;
  let slowDone = false;
  globalThis.fetch = async () => {
    calls.push(Date.now());
    if (calls.length === 1) { await new Promise(r2 => setTimeout(r2, 5000)); slowDone = true; return new Response('slow'); }
    return new Response('fast', { status: 200 });
  };
  r = await fetchUpstream('https://a.test/', { method: 'GET' }, 300);
  check('GET 慢请求触发对冲，取快的那个', r.status === 200 && calls.length >= 2, `调用 ${calls.length} 次, text=${await r.text()}`);

  // 有 body 的请求绝不能重复发
  calls.length = 0;
  globalThis.fetch = async () => {
    calls.push(Date.now());
    if (calls.length === 1) await new Promise(r2 => setTimeout(r2, 5000));
    return new Response('ok');
  };
  try {
    await Promise.race([
      fetchUpstream('https://a.test/', { method: 'POST', body: 'a=1' }, 300),
      new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 1200)),
    ]);
  } catch { /* 预期：等慢请求，未被对冲打断 */ }
  check('POST 带 body 不重复发送', calls.length === 1, `调用 ${calls.length} 次`);

  restore();
  void slowDone;
}

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
console.log(`出口压缩与请求策略：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
