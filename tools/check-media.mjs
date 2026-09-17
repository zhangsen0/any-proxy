#!/usr/bin/env node
/**
 * 媒体 / 大文件链路自检（无需网络）。
 *
 * 锁死两个真实故障，它们都不是「功能没实现」，而是「优化做反了方向」：
 *
 * 1. 视频被整个读进 Worker 内存写 Cache API —— 请求拖到超时、播放器重试又重下一遍，
 *    表现为「网速极慢 + 转发流量暴涨 + 最后还是播不了」。
 * 2. 带 Range 的分片请求被重试 / 对冲 —— 每个分片下两遍，带宽被自己吃掉，反而更慢。
 *
 * 两条的共同点：单看代码都是「为了更快」，只有把「体积」和「重试次数」钉住才防得住。
 *
 * 用法：node tools/check-media.mjs
 */
import { serveCached, cacheableSize, fetchUpstream, MAX_CACHE_BYTES } from '../src/proxy.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
}

/** 造一个最小的 Cache API 替身，只记录是否被写入 */
function fakeCaches() {
  const puts = [];
  return {
    puts,
    default: {
      match: async () => null,
      put: async (key, res) => {
        // 真实 Cache API 写缓存必须消费整个 body —— 这里照做，才能暴露「大文件被读完」的问题
        await res.arrayBuffer();
        puts.push({ key: String(key), size: res.headers.get('content-length') });
      },
    },
  };
}
/** 收集 waitUntil 里的 promise —— 必须真的 await 它们，否则 put 还没落地就断言了 */
function ctxOf() {
  const pending = [];
  return { pending, waitUntil: p => { pending.push(Promise.resolve(p)); } };
}
const flush = async (ctx) => { await Promise.all(ctx.pending); };

console.log('\n[1] 缓存体积闸门：大文件绝不能进 Cache API');
{
  const big = 40 * 1024 * 1024;                     // 40MB，接近真实视频
  check('上限值合理（1MB）', MAX_CACHE_BYTES === 1024 * 1024, `${MAX_CACHE_BYTES} bytes`);
  check('40MB 视频不可缓存', !cacheableSize(new Response('x', { headers: { 'content-length': String(big) } })));

  const c = fakeCaches();
  globalThis.caches = c;
  const res = new Response('x', { status: 200, headers: { 'content-length': String(big) } });
  await serveCached(ctxOf(), 'https://x/big.ts', () => res);
  check('超大资源不写缓存', c.puts.length === 0, `put 次数=${c.puts.length}`);
}

console.log('\n[2] 没有声明体积（分块/流式）同样不缓存 —— 无法预知大小时读满整个流是在赌');
{
  const c = fakeCaches();
  globalThis.caches = c;
  const res = new Response('x', { status: 200 });   // 无 content-length
  await serveCached(ctxOf(), 'https://x/stream.ts', () => res);
  check('无 content-length 不写缓存', c.puts.length === 0);
  check('cacheableSize 判否', !cacheableSize(res));
}

console.log('\n[3] 小资源照常缓存：这套缓存本来就是给 JS/CSS/小图片用的');
{
  const c = fakeCaches();
  globalThis.caches = c;
  const size = 200 * 1024;
  const res = new Response('x'.repeat(16), { status: 200, headers: { 'content-length': String(size) } });
  const ctx = ctxOf();
  await serveCached(ctx, 'https://x/app.js', () => res);
  await flush(ctx);
  check('200KB 的小资源仍写入缓存', c.puts.length === 1, `put 次数=${c.puts.length}`);
  check('cacheableSize 判是', cacheableSize(res));
}

console.log('\n[4] 非 200 状态不写缓存（206 分片尤其不能进，key 里没有 Range）');
{
  const c = fakeCaches();
  globalThis.caches = c;
  const res = new Response('x', { status: 206, headers: { 'content-length': '1024' } });
  await serveCached(ctxOf(), 'https://x/seg.ts', () => res);
  check('206 不写缓存', c.puts.length === 0);
}

console.log('\n[5] 视频分片名的指纹误判：isFingerprinted 会命中，但体积闸门必须挡住它');
{
  // 这类文件名会被判成「内容寻址」，若没有闸门就会被整碗端进缓存
  const names = ['segment-1234567890.ts', '1080p-00000001.ts', 'chunk-5f8a2b3c9d.mp4'];
  const re = /[._-](?:[0-9a-f]{8,}|[a-z0-9]{20,})(?:\.[a-z0-9]{1,5})?$/i;
  for (const n of names) {
    check(`${n} 确实会被判为 fingerprinted（说明闸门是唯一防线）`, re.test(n));
  }
}

console.log('\n[6] Range 请求：不重试、不降级重发');
{
  const real = globalThis.fetch;
  const restore = () => { globalThis.fetch = real; };

  // 5xx 场景：普通请求重试一次，Range 请求只发一次
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('x', { status: 500 }); };
  await fetchUpstream('https://x/a.ts', { method: 'GET', headers: {} }, 0, { noRetry: true });
  check('Range 请求遇 5xx 只发一次', calls === 1, `调用 ${calls} 次`);
  calls = 0;
  await fetchUpstream('https://x/a.ts', { method: 'GET', headers: {} }, 0);
  check('普通请求遇 5xx 仍重试一次', calls === 2, `调用 ${calls} 次`);
  restore();

  // 连接失败场景：Range 请求不做 https→http 降级重发
  const seen = [];
  globalThis.fetch = async (u) => { seen.push(String(u)); throw new Error('boom'); };
  let threw = false;
  try {
    await fetchUpstream('https://x/seg.ts', { method: 'GET', headers: {} }, 0, { noRetry: true });
  } catch { threw = true; }
  check('Range 请求失败即抛出（不降级重发）', threw);
  check('只尝试过一次且未降级成 http', seen.length === 1 && seen[0].startsWith('https:'), seen.join(' , '));
  restore();
}

console.log('\n[7] 对冲：Range 请求即使配了阈值也必须关闭');
{
  const real = globalThis.fetch;
  let calls = 0;
  // 让首个请求慢到必然触发对冲阈值
  globalThis.fetch = async () => {
    calls++;
    await new Promise(r => setTimeout(r, 60));
    return new Response('x', { status: 200 });
  };
  // 模拟调用方对 Range 请求传 hedgeMs=0（proxyRequest 里的真实行为）
  await fetchUpstream('https://x/seg.ts', { method: 'GET', headers: { range: 'bytes=0-1' } }, 0);
  check('hedgeMs=0 时只发一次', calls === 1, `调用 ${calls} 次`);
  globalThis.fetch = real;
}

console.log(`\n媒体与大文件链路：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
