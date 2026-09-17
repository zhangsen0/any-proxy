#!/usr/bin/env node
// 出口编码契约 + 上游请求策略的自检。
//
// 出口编码曾经是「优化」类改动里最危险的一类：Worker 自己按入站 Accept-Encoding
// 决定是否 gzip，结果被 CF 边缘的两个行为合伙搞成整站乱码（详见 src/compress.js
// 顶部说明）——边缘会改写入站 AE，又会给没要压缩的客户端剥掉 Content-Encoding
// 却不解压。现在契约收敛为一句话：**Worker 一律发明文，谁都不许在这里压缩**。
// 本文件就是这条契约的牙齿：谁把 gzip 加回来，这里必须变红。

import { finalizeResponse } from '../src/compress.js';
import { fetchUpstream } from '../src/proxy.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
}

const PAGE = '<!DOCTYPE html><html><body>' + '代理内容 proxy content '.repeat(400) + '</body></html>';

async function wireOf(ae) {
  const res = finalizeResponse(200, PAGE, new Headers({ 'content-type': 'text/html; charset=utf-8' }), ae);
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(buf);
  return { buf, text, res };
}

console.log('\n[1] 出口编码契约：任何 Accept-Encoding 都必须发明文');
for (const ae of ['gzip', 'gzip, deflate, br', 'identity', 'xyz', '*', '', undefined]) {
  const { buf, text, res } = await wireOf(ae);
  const label = 'AE=' + JSON.stringify(ae ?? '(未传)');
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  check(label + ' 明文输出（不是 gzip 字节）', !isGzip && text.includes('<!DOCTYPE'), `len=${buf.length}`);
  check(label + ' 不带 Content-Encoding', res.headers.get('content-encoding') === null,
    String(res.headers.get('content-encoding')));
}

console.log('\n[2] 状态码与头透传不受影响');
{
  const h = new Headers({ 'content-type': 'text/html', 'cache-control': 'no-store' });
  const res = finalizeResponse(404, PAGE, h, 'gzip, br');
  check('上游状态码原样保留', res.status === 404);
  check('业务头原样保留', res.headers.get('cache-control') === 'no-store');
  const text = await res.text();
  check('正文逐字节还原', text === PAGE, `${PAGE.length} 字符`);
}

console.log('\n[3] 上游请求：重试不再空等，且行为可控');
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
console.log(`出口编码契约与请求策略：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
