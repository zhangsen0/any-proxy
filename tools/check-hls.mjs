#!/usr/bin/env node
/**
 * HLS 播放清单（m3u8）改写的纯函数校验（无需网络、无需 Cloudflare 运行时）。
 *
 * 这套用例锁死一个真实故障：HLS 清单的 Content-Type（application/vnd.apple.mpegurl）
 * 早先不在 isText 的白名单里，清单被当成「非文本资源」直接透传、不做任何 URL 改写。
 * 后果是播放器拿到的清单里写着源站根路径与原始 CDN 地址 —— 分片 404、
 * AES-128 密钥取不到解密失败，表现为「视频完全播不了」。
 *
 * 用法：node tools/check-hls.mjs
 */
import { rewriteContent, rewriteM3u8, contentKind, isHlsManifest } from '../src/url.js';

const site = { id: 'demo', host: 'demo.com', scheme: 'https', target: 'https://demo.com' };
const P = '/p/demo';
const ORIGIN = 'https://proxy.example.com';
const base = { host: 'demo.com', prefix: P, origin: ORIGIN };

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
}
const rw = (s) => rewriteM3u8(s, site, P, base);

console.log('\n[1] 类型判定：HLS 清单必须被识别为待改写的文本');
for (const ct of [
  'application/vnd.apple.mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/x-mpegURL',
  'application/vnd.apple.mpegurl; charset=utf-8',
]) {
  check(`${ct} → isHlsManifest`, isHlsManifest(ct));
  check(`${ct} → contentKind=m3u8`, contentKind(ct) === 'm3u8', contentKind(ct));
}
for (const ct of ['video/mp2t', 'video/mp4', 'text/html', 'application/json', '']) {
  check(`${ct || '(空)'} 不是 HLS 清单`, !isHlsManifest(ct));
}

console.log('\n[2] 根相对分片：必须落到代理命名空间（这是「播不了」的直接原因）');
{
  const out = rw('/hls/seg1.ts\n');
  check('根相对分片加前缀', out.trim() === '/p/demo/hls/seg1.ts', out.trim());
}

console.log('\n[3] 绝对 URL 与协议相对：走跨域通道，不直连源站');
{
  const abs = rw('https://cdn.example.com/hls/seg2.ts\n');
  check('绝对 URL 进跨域通道', abs.trim() === '/p/demo/__x/cdn.example.com/hls/seg2.ts', abs.trim());

  const sr = rw('//cdn.example.com/hls/seg3.ts\n');
  check('协议相对进跨域通道', sr.trim() === '/p/demo/__x/cdn.example.com/hls/seg3.ts', sr.trim());
}

console.log('\n[4] 相对文件名保持原样：播放器会按清单 URL 的目录解析，改写成根相对反而指错');
{
  const out = rw('seg0.ts\n');
  check('相对分片不被改写', out.trim() === 'seg0.ts', out.trim());
}

console.log('\n[5] 标签行只改 URI 属性，其余属性一个字都不能动');
{
  const out = rw('#EXT-X-KEY:METHOD=AES-128,URI="/hls/key.bin",IV=0x1234567890abcdef1234567890abcdef\n');
  check('密钥 URI 被改写', out.includes('URI="/p/demo/hls/key.bin"'), out.trim());
  check('IV 原样保留', out.includes('IV=0x1234567890abcdef1234567890abcdef'));
  check('METHOD 原样保留', out.includes('METHOD=AES-128'));

  const map = rw('#EXT-X-MAP:URI="/hls/init.mp4"\n');
  check('EXT-X-MAP 的 URI 被改写', map.includes('URI="/p/demo/hls/init.mp4"'), map.trim());
}

console.log('\n[6] 其他标签不受影响（标签不是 URL，误改会直接破坏清单结构）');
{
  const src = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n';
  check('纯标签原样返回', rw(src) === src);
  check('EXTINF 行原样', rw('#EXTINF:10.0,\n') === '#EXTINF:10.0,\n');
}

console.log('\n[7] 主清单（master playlist）里的子清单 URL');
{
  const src = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=720x480\n/hls/720p.m3u8\n';
  const out = rw(src);
  check('子清单 URL 被改写', out.includes('/p/demo/hls/720p.m3u8'), out.split('\n')[2]);
  check('BANDWIDTH 等属性保留', out.includes('BANDWIDTH=1280000,RESOLUTION=720x480'));
}

console.log('\n[8] 幂等：已在代理命名空间内的路径不再套第二次前缀');
{
  const once = rw('/hls/seg1.ts\n');
  const twice = rw(once);
  check('重复改写结果不变', once === twice, twice.trim());
  check('不出现双前缀', !twice.includes('/p/demo/p/demo'));
}

console.log('\n[9] 端到端：整份清单（含加密、分片、跨域）');
{
  const src = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-KEY:METHOD=AES-128,URI="/hls/key.bin",IV=0xabc',
    '#EXTINF:10.0,',
    'seg0.ts',
    '#EXTINF:10.0,',
    '/hls/seg1.ts',
    '#EXTINF:10.0,',
    'https://cdn.example.com/hls/seg2.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
  const out = rw(src);
  const lines = out.split('\n');
  check('结尾空行保留', lines[lines.length - 1] === '');
  check('总行数不变', lines.length === src.split('\n').length);
  check('密钥可取', out.includes('URI="/p/demo/hls/key.bin"'));
  check('根相对分片可取', out.includes('/p/demo/hls/seg1.ts'));
  check('跨域分片走通道', out.includes('/p/demo/__x/cdn.example.com/hls/seg2.ts'));
  check('相对分片原样', out.includes('\nseg0.ts\n'));
  check('结束标签保留', out.includes('#EXT-X-ENDLIST'));
}

console.log('\n[10] 经 rewriteContent 分发：kind=m3u8 必须走到专用改写');
{
  const src = '/hls/seg1.ts\n';
  const out = rewriteContent(src, site, P, base, 'm3u8');
  check('rewriteContent(m3u8) 生效', out.trim() === '/p/demo/hls/seg1.ts', out.trim());
}

console.log(`\nHLS 清单改写：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
