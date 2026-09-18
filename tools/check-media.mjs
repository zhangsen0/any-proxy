#!/usr/bin/env node
/**
 * 媒体 / 大文件链路自检（无需网络）。
 *
 * 锁死两个真实故障，它们都不是「功能没实现」，而是「优化做反了方向」：
 *
 * 1. 视频被整个读进 Worker 内存写 Cache API —— 请求拖到超时、播放器重试又重下一遍，
 *    表现为「网速极慢 + 转发流量暴涨 + 最后还是播不了」。
 * 2. 带 Range 的分片请求被重试 / 对冲 —— 每个分片下两遍，带宽被自己吃掉，反而更慢。
 * 3. 所有响应套 TransformStream 计数 —— 高速转发时 JS 回调累计 CPU 撞 CF 免费版
 *    10ms/请求配额 → 流随机被掐 → 播放器分片拿不全 → 重试 → 流量虚高（随机中断的根因）。
 * 4. 流媒体模式（proxyMode=media）：媒体分片边缘缓存 key 必须绑 Range 与（可选）鉴权，
 *    否则不同分片区间互相污染、不同用户共享缓存（盗链）。
 *
 * 两条的共同点：单看代码都是「为了更快」，只有把「体积」「重试次数」「是否套流」
 * 「缓存 key 粒度」钉住才防得住。
 *
 * 用法：node tools/check-media.mjs
 */
import { serveCached, cacheableSize, fetchUpstream, MAX_CACHE_BYTES, isMediaRequest, mediaCacheKeyOf } from '../src/proxy.js';
import { countResponseBytes } from '../worker.js';

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
  const big = 40 * 1024 * 1024;                     // 40MB，接近真实整片视频
  const seg4k = 4 * 1024 * 1024;                    // 4MB，主流 4K HLS 分片上限
  check('上限值合理（4MB）', MAX_CACHE_BYTES === 4 * 1024 * 1024, `${MAX_CACHE_BYTES} bytes`);
  check('40MB 视频不可缓存', !cacheableSize(new Response('x', { headers: { 'content-length': String(big) } })));
  check('4MB HLS 分片可缓存（边缘缓存对视频的主要价值点）', cacheableSize(new Response('x', { headers: { 'content-length': String(seg4k) } })));

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

console.log('\n[8] 流式计数：媒体 / 大文件直接透传（修复随机中断），小响应保留套流精确计数');
{
  // 206 分片（media=true）：必须返回原响应引用（不套 TransformStream，零 CPU 透传）
  const ctx = { waitUntil: () => {} };
  const part = new Response('x'.repeat(64), { status: 206, headers: { 'content-length': '64' } });
  check('206 分片直接透传（返回原响应，不套流）', countResponseBytes(part, 'uhdnow', {}, ctx, true) === part);

  // 无 Range 但 Content-Type 是 video/*（整片 200）：同样透传
  const full = new Response('x'.repeat(64), { status: 200, headers: { 'content-length': '64', 'content-type': 'video/mp4' } });
  check('video/mp4 整片直接透传（返回原响应，不套流）', countResponseBytes(full, 'uhdnow', {}, ctx, false) === full);

  // 声明体积 > 4MB 的响应（大 JS bundle / 大文件）：同样透传
  const big = new Response('x'.repeat(64), { status: 200, headers: { 'content-length': String(MAX_CACHE_BYTES + 1) } });
  check('声明 >4MB 的大响应直接透传（返回原响应，不套流）', countResponseBytes(big, 'uhdnow', {}, ctx, false) === big);

  // 小响应（页面 / 接口 / 图片）：仍套流精确计数（返回新 Response）
  const small = new Response('x'.repeat(64), { status: 200, headers: { 'content-length': '64' } });
  const smallOut = countResponseBytes(small, 'uhdnow', {}, ctx, false);
  check('小响应仍套流精确计数（返回新 Response）', smallOut !== small && smallOut instanceof Response);
}

console.log('\n[9] 流媒体请求判定（isMediaRequest）：宁可宽不可漏，普通页面不误伤');
{
  check('带 Range 头判媒体', isMediaRequest(new Request('https://x/v.m3u8', { headers: { range: 'bytes=0-1' } }), ''));
  check('路径含 /stream 判媒体', isMediaRequest(new Request('https://x/play/video/123'), ''));
  check('路径含 /hls 判媒体', isMediaRequest(new Request('https://x/hls/main/index.m3u8'), ''));
  check('HLS 清单 Content-Type 判媒体', isMediaRequest(new Request('https://x/v.m3u8'), 'application/vnd.apple.mpegurl'));
  check('DASH 清单 Content-Type 判媒体', isMediaRequest(new Request('https://x/v.mpd'), 'application/dash+xml'));
  check('video Content-Type 判媒体', isMediaRequest(new Request('https://x/a.mp4'), 'video/mp4'));
  check('普通页面不判媒体', !isMediaRequest(new Request('https://x/'), 'text/html'));
  check('JSON 接口不判媒体', !isMediaRequest(new Request('https://x/api/data'), 'application/json'));
}

console.log('\n[10] 媒体分片缓存 key：不绑 Range（cache.match 命中 200 完整响应时 CF 会按 Range 自动切 206），鉴权按开关绑定（防盗链）');
{
  const req = (range) => new Request('https://x/v.mp4?api_key=sec1', { headers: range ? { range } : {} });
  const k1 = mediaCacheKeyOf('https://x/v.mp4?api_key=sec1', req('bytes=0-99'), false);
  check('缓存 key 不绑定 Range 区间（绑了会挡住 CF 的 Range→206 切片能力）', !k1.includes('__r='), k1);
  const kAuth = mediaCacheKeyOf('https://x/v.mp4?api_key=sec1', req('bytes=0-99'), true);
  check('盗链保护开：key 绑定鉴权身份（用户缓存隔离）', kAuth.includes('__auth=sec1'));
  const kNoAuth = mediaCacheKeyOf('https://x/v.mp4?api_key=sec1', req('bytes=0-99'), false);
  check('盗链保护关：key 不含鉴权身份（共享缓存）', !kNoAuth.includes('__auth='));
}

console.log('\n[11] 分片边缘缓存：CF Cache API 拒绝 206（cache.put 对 206 直接抛错），只缓存 200 媒体小响应');
{
  const c = fakeCaches();
  globalThis.caches = c;
  const part = new Response('x'.repeat(16), { status: 206, headers: { 'content-length': '1024', 'content-range': 'bytes 0-1023/10240' } });
  const ctx = ctxOf();
  await serveCached(ctx, 'https://x/seg.ts?__apv=1', () => part);
  await flush(ctx);
  check('206 分片绝不写入缓存（平台限制，写缓存必然报错）', c.puts.length === 0, `put 次数=${c.puts.length}`);

  const c2 = fakeCaches();
  globalThis.caches = c2;
  const ok = new Response('y'.repeat(16), { status: 200, headers: { 'content-length': '1024' } });
  const ctx2 = ctxOf();
  await serveCached(ctx2, 'https://x/seg2.ts?__apv=1', () => ok);
  await flush(ctx2);
  check('200 媒体小响应（HLS/DASH 分片）写入缓存', c2.puts.length === 1, `put 次数=${c2.puts.length}`);
}

console.log(`\n媒体与大文件链路：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
