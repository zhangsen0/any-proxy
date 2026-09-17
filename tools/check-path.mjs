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

console.log(`\n路径归一化自检：通过 ${pass}，失败 ${fail}\n`);
if (fail) process.exit(1);
