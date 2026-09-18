#!/usr/bin/env node
/**
 * 访问统计自检：采集 → 聚合 → 驾驶舱。
 *
 * 为什么必须从 worker 入口打：统计的采集点是「请求出口」（worker.js 的 fetch 包装），
 * 直接调 handleRequest 会绕过它 —— 那正是这次改动之前的真实状态：
 * stats.record() 写好了却没有任何调用方，接口永远返回空数组，
 * 而所有单测都是绿的（它们只测 summarize 的纯函数行为）。
 * 所以这一层从 **worker 默认导出** 进入，真发请求、真等 waitUntil、真读回聚合结果。
 *
 * 用法：node tools/check-stats.mjs
 */
import worker from '../worker.js';
import { bindRuntime } from '../src/runtime.js';
import { adminPage } from '../src/admin.js';
import { flush, recordBytes } from '../src/stats.js';
import { STATS_JS, renderStatsPane } from '../src/stats-ui.js';
import { CONFIG_JS } from '../src/config-ui.js';
import { VISIT_SCOPES, matchVisitScope, isAdminScope, scopeLabels } from '../src/scopes.js';

const ORIGIN = 'https://proxy.example.com';
const PASSWORD = 'dev';
const COOKIE = 'ap_auth=' + Buffer.from(PASSWORD).toString('base64');
// Cloudflare 每个请求都会注入它；统计的「来访者」口径就基于这个头
const VISITOR = { 'CF-Connecting-IP': '203.0.113.9' };

const mem = new Map();
const kv = {
  async list(o = {}) {
    const p = (o && o.prefix) || '';
    return { keys: [...mem.keys()].filter(k => k.startsWith(p)).map(name => ({ name })), list_complete: true };
  },
  async get(k) { return mem.has(k) ? mem.get(k) : null; },
  async put(k, v) { mem.set(k, String(v)); },
  async delete(k) { mem.delete(k); },
};
const env = { PASSWORD, SITES: kv, PROXY_HOST: 'proxy.example.com' };
bindRuntime(env);

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  -> ' + extra : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? '  -> ' + extra : ''}`); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

// 上游一律用假源站，绝不真出网。注意 proxy.js 内部有 30 秒 HTML 缓存，
// 所以同一个路径请求两次会命中缓存 —— 要测真实字节数就得换路径。
const UP_BODY = '<!DOCTYPE html><html><body>ok</body></html>';
globalThis.fetch = async () => new Response(UP_BODY, {
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(UP_BODY)) },
});

/**
 * 真实模拟一次请求：收集 waitUntil 的落盘任务并等它跑完，否则统计还在内存里没落盘。
 *
 * ⚠️ 顺序：必须**先读完 body，再等 waitUntil**。走流式计数的响应，那个 waitUntil
 * Promise 要等响应体发完（flush）才会 settle —— 先 await waitUntil 就成了互相等待的
 * 死锁。线上由运行时负责读 body，所以只有测试脚手架上会踩到这一点。
 */
async function visit(path, init = {}) {
  const pending = [];
  const ctx = { waitUntil: (p) => { pending.push(p); } };
  const headers = { ...(init.headers || {}) };
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGIN + path, { method: init.method || 'GET', headers, body: init.body }), env, ctx);
  const text = await res.text();
  await Promise.all(pending.map(p => Promise.resolve(p).catch(() => {})));
  // 落盘可能还挂在下一轮 waitUntil（flush 内部再挂任务的情况），多等一拍
  await new Promise(r => setTimeout(r, 10));
  return { status: res.status, text: async () => text };
}

async function apiGet(path, headers = {}) {
  const res = await visit(path, { headers });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: null, text }; }
}
async function apiPost(path, body, headers = {}) {
  const res = await visit(path, { method: 'POST', body: JSON.stringify(body), headers: { Cookie: COOKIE, ...headers } });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: null, text }; }
}

const today = new Date().toISOString().slice(0, 10);

// ===================== 1. 采集真的接上了 =====================
section('1. 请求出口的采集（曾经 record() 没有任何调用方）');
{
  mem.set('site:demo', JSON.stringify({
    id: 'demo', name: '演示站', host: '127.0.0.1', target: 'http://127.0.0.1', scheme: 'http',
  }));

  const before = await apiGet('/__api/stats?days=7', { Cookie: COOKIE });
  ok('统计默认关闭时接口可读且为空', before.status === 200 && before.data && before.data.enabled === false,
    `enabled=${before.data && before.data.enabled}`);

  const on = await apiPost('/__api/stats-config', { enabled: true });
  ok('开启统计（面板接口）', on.status === 200 && on.data && on.data.config && on.data.config.enabled === true);

  // 第一个请求必须由 waitUntil 自动落盘（这是「不逐请求写存储、批量落盘」的关键路径）
  await visit('/p/demo/a', { headers: VISITOR });
  ok('首个请求由 waitUntil 自动落盘', !!mem.get('stat:p:demo:' + today),
    mem.has('stat:p:demo:' + today) ? 'stat:p:demo:' + today : '(未落盘)');

  // 换路径避开 proxy 的 30 秒 HTML 缓存，保证第二个请求真的走上游
  await visit('/p/demo/b', { headers: VISITOR });
  await visit('/robots.txt', { headers: VISITOR });                       // 噪声路径：不该计入任何通道
  await visit('/__api/stats', { headers: { Cookie: COOKIE, ...VISITOR } }); // 管理通道：record_admin 关闭时不计入
  // 落盘是按间隔（默认 15s）触发的，测试里手动催一次，把内存里剩余计数写下去
  await flush(env);

  const after = await apiGet('/__api/stats?days=7', { Cookie: COOKIE });
  const d = after.data || {};
  const scopes = (d.series || []).map(s => s.scope);
  const demo = (d.series || []).find(s => s.scope === 'p:demo');
  ok('反代站点请求被计入 p:<站点id>', !!demo && demo.hits === 2, demo ? `hits=${demo.hits}` : `scopes=${scopes.join(',')}`);  ok('伪装噪声路径（robots.txt）不计入', !scopes.includes('robots.txt') && !scopes.some(s => /robots|\.txt/.test(s)), scopes.join(','));
  ok('record_admin 关闭时管理通道不计入', !scopes.includes('admin'), scopes.join(',') || '(空)');
  ok('总量与通道一致', d.totals && d.totals.hits === 2, `totals.hits=${d.totals && d.totals.hits}`);
  ok('当日桶出现在 daily 里', (d.daily || []).some(x => x.date === today && x.hits === 2),
    (d.daily || []).map(x => x.date + ':' + x.hits).join(' ') || '(空)');
  ok('记录了来访者（uv > 0，且不落原始 IP）', !!demo && demo.uv >= 1, demo ? `uv=${demo.uv}` : '');
  const rawKey = 'stat:p:demo:' + today;
  const raw = mem.get(rawKey);
  ok('落盘内容不含原始 IP', !!raw && !raw.includes('203.0.113.9'), raw ? raw.slice(0, 90) : '(无)');
}

// ===================== 2. 流量口径 =====================
section('2. 流量口径（Content-Length 与 chunked 两条路都要记上）');
{
  // 2a. 上游给了 Content-Length → 字节由出口流的**实际传输计数**回填。
  //     （旧实现是 record() 照响应头记——头是「声称的大小」，客户端中途掐断时
  //       整片大小被当成实际流量，线上实测边缘只发了 0.5GB、日志记了 20GB。）
  const d0 = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  const before = ((d0.series || []).find(s => s.scope === 'p:demo') || {}).bytes || 0;
  await visit('/p/demo/d', { headers: VISITOR });
  await flush(env);
  const d1 = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  const after = ((d1.series || []).find(s => s.scope === 'p:demo') || {}).bytes || 0;
  ok('普通反代响应的流量不为 0（面板上这一项曾经恒为 0 B）', after - before >= UP_BODY.length,
    `本次 +${after - before} 字节，响应体 ${UP_BODY.length} 字节`);

  // 2b. 上游 chunked（无 Content-Length）：只有在流发完才知道字节数，必须边发边数。
  //     这正是反代 HTML 页面的真实形态 —— proxy.js 会删掉 content-length。
  const CHUNK = 'x'.repeat(500);
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(CHUNK));
      c.enqueue(new TextEncoder().encode(CHUNK));
      c.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

  const pending = [];
  const ctx = { waitUntil: (p) => { pending.push(p); } };
  // 换一个没请求过的路径：proxy 的 30 秒 HTML 缓存会让我们测到缓存体而不是上游流
  const res = await worker.fetch(new Request(ORIGIN + '/p/demo/c', { headers: VISITOR }), env, ctx);
  const body = await res.text();
  ok('响应体被原样透传（未被计数影响）', body.length === 1000, `${body.length} 字节`);
  // 流发完后计数才会回填：等 waitUntil + 一拍
  await Promise.all(pending.map(p => Promise.resolve(p).catch(() => {})));
  await new Promise(r => setTimeout(r, 10));
  await flush(env);

  const d2 = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  const demo = (d2.series || []).find(s => s.scope === 'p:demo');
  ok('无 Content-Length 的响应也记到了流量', !!demo && demo.bytes >= 1000, demo ? `bytes=${demo.bytes}` : '未找到 p:demo');
  ok('请求数与流量不互相干扰', !!demo && demo.hits === 4, demo ? `hits=${demo.hits}` : '');

  // 2c. ⭐ 登记时机：waitUntil 必须在**响应交出去之前**就登记。
  //     Cloudflare 在 handler 返回后再调 ctx.waitUntil() 会直接丢弃（抛错），
  //     而字节数只有流发完才有 —— 旧实现就是在流的 flush() 里才调，于是线上
  //     请求数一切正常、流量永远 0。这里把「时机错了」变成红灯，而不是线上那种静默丢数据。
  mem.set('site:demo2', JSON.stringify({
    id: 'demo2', name: '二号码头', host: '127.0.0.1', target: 'http://127.0.0.1', scheme: 'http',
  }));
  const CHUNK2 = 'y'.repeat(250);
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(CHUNK2)); c.close(); },
  }), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

  const registered = [];
  let returned = false;
  const timingCtx = {
    waitUntil(p) {
      if (returned) throw new Error('waitUntil 在响应发出之后才调用（运行时不会等它）');
      registered.push(p);
    },
  };
  const res2 = await worker.fetch(new Request(ORIGIN + '/p/demo2/x', { headers: VISITOR }), env, timingCtx);
  ok('响应返回前就已经登记了流量统计', registered.length >= 2, `已登记 ${registered.length} 个任务`);
  returned = true;               // 之后一切 waitUntil 都视为非法，和运行时一致
  await res2.text();             // 流发完；旧实现恰在这一刻才去登记
  await Promise.all(registered.map(p => Promise.resolve(p).catch(() => {})));
  await flush(env);

  const d3 = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  const demo2 = (d3.series || []).find(s => s.scope === 'p:demo2');
  ok('「响应后才登记」的约束下 chunked 流量仍然记上了', !!demo2 && demo2.bytes === 250,
    demo2 ? `bytes=${demo2.bytes}（期望 250）` : '未找到 p:demo2');

  // 恢复成常规假源站
  globalThis.fetch = async () => new Response(UP_BODY, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(UP_BODY)) },
  });
}

// ===================== 2.5 落盘健壮性：写失败不能丢账 =====================
section('2.5 落盘失败自动重试（KV 抖动不再蒸发计数）');
{
  // 旧实现 flush() 先清内存再写，写失败被 catch 吞掉 → 整段计数静默蒸发，
  // 线上表现为「日志的请求数/流量与边缘日志对不上」。这里把写失败变成红灯。
  const before = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  const b0 = ((before.series || []).find(s => s.scope === 'p:demo') || {}).bytes || 0;

  await recordBytes({ scope: 'p:demo', bytes: 777, env });
  const realPut = kv.put;
  let putFail = 0;
  kv.put = async () => { putFail++; throw new Error('KV 抖动'); };
  await flush(env);
  kv.put = realPut;
  ok('模拟存储抖动并观察到写失败', putFail >= 1, `${putFail} 次失败`);

  await flush(env);   // 恢复后再落盘
  const d = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  const b1 = ((d.series || []).find(s => s.scope === 'p:demo') || {}).bytes || 0;
  ok('写失败的那笔在恢复后补上了（数据不丢）', b1 - b0 >= 777, `bytes ${b0} -> ${b1}`);
}

// ===================== 2.6 媒体分类与传输中断（播放链路诊断维度） =====================
section('2.6 媒体流量 mbytes 与传输中断 aborts');
{
  // 2e. 媒体流分类：video/mp4 直通 → 流量单独进 mbytes，回答「流量都去哪了」
  // 无 content-length（分块流式）的媒体没有可用的头记账，仍走套流精确计数
  mem.set('site:demo4', JSON.stringify({
    id: 'demo4', name: '四号片场', host: '127.0.0.1', target: 'http://127.0.0.1', scheme: 'http',
  }));
  const MOV = 'M'.repeat(1200);
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(MOV)); c.close(); },
  }), { status: 200, headers: { 'content-type': 'video/mp4' } });

  await visit('/p/demo4/film.mp4', { headers: VISITOR });
  await flush(env);
  const d5 = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  const demo4 = (d5.series || []).find(s => s.scope === 'p:demo4');
  ok('视频响应计入媒体流量（无长度分块流仍套流精确计数）', !!demo4 && demo4.mbytes === MOV.length,
    demo4 ? `mbytes=${demo4.mbytes}（期望 ${MOV.length}）` : '未找到 p:demo4');
  ok('这条只有媒体：总流量 == 媒体流量', !!demo4 && demo4.bytes === demo4.mbytes,
    demo4 ? `bytes=${demo4.bytes} mbytes=${demo4.mbytes}` : '');

  // 2f. ⭐ 传输中断的两条路径（播放器放弃 / 弱网断流）：
  //   - 带 content-length 的媒体/大文件（Emby 206 分片、200 整片都是）→ 零 CPU 透传，
  //     按上游头记账（完整传输时 == 实际字节，不虚高）。客户端中途断开在透传路径
  //     无法感知，**不误报 aborts**，中断信号交给 CF 用量驾驶舱的边缘 499 计数交叉验证。
  //   - 小响应（页面/接口/图片）→ 套流精确计数，cancel 时 aborts +1 且只记已传字节。
  mem.set('site:demo5', JSON.stringify({
    id: 'demo5', name: '五号基站', host: '127.0.0.1', target: 'http://127.0.0.1', scheme: 'http',
  }));
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('P'.repeat(8000))); /* 故意不 close：等客户端放弃 */ },
  }), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '80000' } });

  const pending2 = [];
  const ctx2 = { waitUntil: (p) => { pending2.push(p); } };
  const res5 = await worker.fetch(new Request(ORIGIN + '/p/demo5/live', { headers: VISITOR }), env, ctx2);
  const reader = res5.body.getReader();
  await reader.read();          // 先消费一部分
  await reader.cancel();        // 客户端中途放弃
  await Promise.all(pending2.map(p => Promise.resolve(p).catch(() => {})));
  await new Promise(r => setTimeout(r, 10));
  await flush(env);

  const d6 = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  const demo5 = (d6.series || []).find(s => s.scope === 'p:demo5');
  ok('带 content-length 的媒体按头记账（零 CPU 透传，完整传输时精确）', !!demo5 && demo5.bytes === 80000,
    demo5 ? `bytes=${demo5.bytes}（期望 80000）` : '未找到 p:demo5');
  ok('透传路径不误报中断（aborts=0，交叉验证走 CF 边缘 499）', !!demo5 && demo5.aborts === 0,
    demo5 ? `aborts=${demo5.aborts}` : '');
  ok('媒体字节同样进 mbytes', !!demo5 && demo5.mbytes === 80000,
    demo5 ? `mbytes=${demo5.mbytes}` : '');

  // 2g. 小响应中断：套流路径保留 aborts 检测（页面/图片半路放弃 → 只记已传部分）
  // 用非文本小响应（image/png）：走直传分支、不读 body，套流后 cancel 才能触发中断信号
  mem.set('site:demo6', JSON.stringify({
    id: 'demo6', name: '六号小站', host: '127.0.0.1', target: 'http://127.0.0.1', scheme: 'http',
  }));
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('Q'.repeat(5000))); /* 故意不 close */ },
  }), { status: 200, headers: { 'content-type': 'image/png', 'content-length': '90000' } });

  const pending3 = [];
  const ctx3 = { waitUntil: (p) => { pending3.push(p); } };
  const res6 = await worker.fetch(new Request(ORIGIN + '/p/demo6/cover.png', { headers: VISITOR }), env, ctx3);
  const reader6 = res6.body.getReader();
  await reader6.read();
  await reader6.cancel();
  await Promise.all(pending3.map(p => Promise.resolve(p).catch(() => {})));
  await new Promise(r => setTimeout(r, 10));
  await flush(env);

  const d7 = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  const demo6 = (d7.series || []).find(s => s.scope === 'p:demo6');
  ok('小响应中断被计入（aborts=1）', !!demo6 && demo6.aborts === 1, demo6 ? `aborts=${demo6.aborts}` : '未找到 p:demo6');
  ok('中断时已传输的字节照记（远小于头部声称的 90000）', !!demo6 && demo6.bytes > 0 && demo6.bytes < 90000,
    demo6 ? `bytes=${demo6.bytes}` : '');

  // 恢复成常规假源站
  globalThis.fetch = async () => new Response(UP_BODY, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(UP_BODY)) },
  });
}

// ===================== 3. record_admin 打开后管理通道计入 =====================
section('3. record_admin 语义（面板自己的访问单独控制）');
{
  await apiPost('/__api/stats-config', { record_admin: true });
  await visit('/__api/stats-config', { headers: { Cookie: COOKIE, ...VISITOR } });
  await flush(env);
  const d = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  const admin = (d.series || []).find(s => s.scope === 'admin');
  ok('打开后管理通道被计入', !!admin && admin.hits >= 1, admin ? `hits=${admin.hits}` : '未出现');
}

// ===================== 4. 总量口径：不能被 top_limit 截断 =====================
section('4. 总量口径（totals 曾经取的是「榜内之和」，榜外通道被悄悄扣掉）');
{
  // top_limit 只该影响「排行显示几条」，不该影响总量：
  // daily 从不截断，所以「总量 == 按天之和」是必须成立的硬约束。
  await apiPost('/__api/stats-config', { enabled: true, record_admin: false, top_limit: 1 });
  const d = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  const dailyHits = (d.daily || []).reduce((a, x) => a + x.hits, 0);
  const dailyBytes = (d.daily || []).reduce((a, x) => a + x.bytes, 0);
  const dailyErrors = (d.daily || []).reduce((a, x) => a + x.errors, 0);

  ok('top_limit=1 时排行确实只剩 1 条', (d.series || []).length === 1, `series=${(d.series || []).length}`);
  ok('总请求数与按天汇总一致（榜外通道没被扣掉）', d.totals && d.totals.hits === dailyHits,
    `totals=${d.totals && d.totals.hits} daily=${dailyHits}`);
  ok('总流量与按天汇总一致', d.totals && d.totals.bytes === dailyBytes,
    `totals=${d.totals && d.totals.bytes} daily=${dailyBytes}`);
  ok('错误数与按天汇总一致', d.totals && d.totals.errors === dailyErrors,
    `totals=${d.totals && d.totals.errors} daily=${dailyErrors}`);

  await apiPost('/__api/stats-config', { top_limit: 10 });
}

// ===================== 4. 关闭统计后停止记录 =====================
section('5. 关闭后不再记录（但已有数据保留）');
{
  // 一并关掉 record_admin：否则「读取统计」这一步自身也会被计入，把断言搅浑
  await apiPost('/__api/stats-config', { enabled: false, record_admin: false });
  const before = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  await visit('/p/demo/', { headers: VISITOR });
  await visit('/p/demo/', { headers: VISITOR });
  await flush(env);
  const after = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  const demoBefore = ((before.series || []).find(s => s.scope === 'p:demo') || {}).hits;
  const demoAfter = ((after.series || []).find(s => s.scope === 'p:demo') || {}).hits;
  ok('关闭后该通道不再增长', demoAfter === demoBefore, `p:demo ${demoBefore} -> ${demoAfter}`);
  ok('已有数据仍然可读（关≠清）', after.totals && after.totals.hits > 0, `hits=${after.totals && after.totals.hits}`);
}

// ===================== 5. 汇总口径 =====================
section('6. 汇总口径（日期补齐 / 保留天数上限）');
{
  // 直接种两天的桶：验证「某个通道缺某天时补 0」而不是把日期拉直
  const y1 = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const y2 = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  mem.set('stat:p:other:' + y2, JSON.stringify({ hits: 5, bytes: 500, errors: 1, uv: 2, ips: ['a', 'b'] }));
  mem.set('stat:sub:' + y1, JSON.stringify({ hits: 3, bytes: 300, errors: 0, uv: 1, ips: ['c'] }));

  const d = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  const dates = d.dates || [];
  ok('日期升序且去重', dates.length === new Set(dates).size && dates.every((x, i) => i === 0 || dates[i - 1] < x), dates.join(','));
  const other = (d.series || []).find(s => s.scope === 'p:other');
  ok('通道的天数与全局日期对齐（缺的那天补 0）', !!other && other.days.length === dates.length,
    other ? `${other.days.length} 天 / 全局 ${dates.length} 天` : '未找到 p:other');
  ok('补齐的那天确实是 0', !!other && other.days.some(x => x.hits === 0), other ? other.days.map(x => x.date + ':' + x.hits).join(' ') : '');
  ok('daily 与 dates 一一对应', (d.daily || []).length === dates.length, `daily=${(d.daily || []).length}`);
  ok('错误数被计入', !!other && other.errors === 1, other ? `errors=${other.errors}` : '');
  ok('流量被计入', !!other && other.bytes === 500, other ? `bytes=${other.bytes}` : '');
  ok('旧格式桶（无新字段）聚合不报错，新字段为 0', !!other && other.aborts === 0 && other.mbytes === 0,
    other ? `aborts=${other.aborts} mbytes=${other.mbytes}` : '');

  const clamped = (await apiGet('/__api/stats?days=9999', { Cookie: COOKIE })).data || {};
  ok('请求天数被保留天数上限夹住', clamped.days === clamped.retention_days, `days=${clamped.days} retention=${clamped.retention_days}`);
}

// ===================== 6. 清空 =====================
section('7. 清空数据（保留配置）');
{
  const r = await apiPost('/__api/stats/clear', {});
  ok('清空返回成功并报出删除条数', r.status === 200 && r.data && r.data.ok === true && r.data.removed >= 3,
    `removed=${r.data && r.data.removed}`);
  const d = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  ok('清空后没有残留桶', (d.daily || []).length === 0 && (d.series || []).length === 0,
    `daily=${(d.daily || []).length} series=${(d.series || []).length}`);
  ok('清空只删数据，不动配置', !!d.retention_days, `retention=${d.retention_days}`);
}

// ===================== 8. 驾驶舱渲染与脚本 =====================
section('8. 驾驶舱页面与注入脚本');
{
  const html = await (await adminPage(true, ORIGIN, env)).text();
  ok('驾驶舱卡片挂在 stats 选项卡上', /data-pane="stats"/.test(html));
  ok('选项卡按钮存在', /data-tab="stats"/.test(html) && html.includes('数据驾驶舱'));
  for (const id of ['statsCard', 'stDays', 'stKpis', 'stChart', 'stAxis', 'stRank', 'stMetric', 'stRefresh', 'stAlert']) {
    ok('驾驶舱容器 ' + id + ' 已渲染', html.includes(`id="${id}"`));
  }
  ok('统计设置表单在驾驶舱里（单一入口）', /id="statsCard"[\s\S]*data-path="\/__api\/stats-config"/.test(html));
  ok('原始 JSON 与清空工具都在页面上', html.includes('data-uid="stats"') && html.includes('data-uid="stats-clear"'));
  ok('未登录时不渲染驾驶舱', !(await (await adminPage(false, ORIGIN, env)).text()).includes('statsCard'));

  const plain = renderStatsPane();
  ok('渲染阶段不发网络请求（已由 mock fetch 拦截全文）', !/fetch\(/.test(plain));

  let parsed = true; let err = '';
  try { new Function(STATS_JS); } catch (e) { parsed = false; err = String(e && e.message); }
  ok('驾驶舱脚本语法可解析', parsed, err);
  ok('脚本自带 __name 兜底（防 keep-names 把整段脚本打断）', STATS_JS.startsWith('var __name='));
  // 打包后（esbuild --keep-names）函数体里的箭头函数会变成 __name(...)；
  // 未打包时源码里根本没有 __name( —— 两种情况下都必须「兜底在最前」或「压根不需要」
  const firstUse = STATS_JS.indexOf('__name(', STATS_JS.indexOf('\n'));
  ok('注入脚本里 __name 兜底先于任何调用', firstUse < 0 || STATS_JS.indexOf('var __name=') < firstUse,
    firstUse < 0 ? '源码形态无 __name 调用' : `首次调用位于 ${firstUse}`);
  for (const marker of ['/__api/stats?days=', '/__api/sites', '__statsEnsure', 'stKpis']) {
    ok('脚本覆盖 ' + marker, STATS_JS.includes(marker));
  }
  ok('驾驶舱脚本与配置页脚本共存（页面同时注入）', html.includes('cfg-switch-label') && html.includes('__statsEnsure'));
  ok('配置页脚本同样带兜底', CONFIG_JS.startsWith('var __name='));

  // ⭐ 把 STATS_JS 丢进一个「只有浏览器全局」的裸沙盒真跑一遍。
  //    注入出去的脚本会被 toString() 带走，闭包里只剩它自己声明的东西：
  //    一旦引用了本模块 import 进来的任何标识符（比如从 util.js 来的 esc），
  //    浏览器里就是 ReferenceError，整块排行渲染不出来。
  //    而源码里 esc「明明存在」，所以查字符串的自检永远是绿的 —— 只有真跑才抓得到。
  const freshEl = () => ({
    innerHTML: '', textContent: '', hidden: false, className: '', style: {},
    disabled: false, value: '', onclick: null,
    addEventListener() {}, appendChild() {}, contains: () => true,
    getAttribute: () => null, setAttribute() {},
    classList: { toggle() {}, add() {}, remove() {} },
    querySelectorAll: () => [], querySelector: () => null,
  });
  const nodes = new Map();
  // getElementById('stRank') 与 querySelector('#stRank') 必须落到同一个节点，
  // 否则断言会读到一个谁也写不到的空壳（脚本里两种取法都有用）
  const nodeOf = sel => { const k = String(sel).replace(/^#/, ''); if (!nodes.has(k)) nodes.set(k, freshEl()); return nodes.get(k); };
  const sandboxDoc = {
    getElementById: nodeOf,
    querySelector: nodeOf,
    querySelectorAll: () => [],
    body: { contains: () => true },
    addEventListener() {},
  };
  const payload = {
    ok: true, enabled: true, days: 7, retention_days: 30, top_limit: 10,
    dates: [today],
    daily: [{ date: today, hits: 9, bytes: 1536, errors: 1, aborts: 2, mbytes: 1024 }],
    totals: { hits: 9, bytes: 1536, errors: 1, aborts: 2, mbytes: 1024, uv: 3 },
    series: [{
      scope: 'p:demo', hits: 9, bytes: 1536, errors: 1, aborts: 2, mbytes: 1024, uv: 3,
      days: [{ date: today, hits: 9, bytes: 1536, errors: 1, aborts: 2, mbytes: 1024, uv: 0 }],
    }],
  };
  const fakeApi = (path) => Promise.resolve(
    path.includes('/sites') ? { data: { sites: [{ id: 'demo', name: '演示站' }] } } : { data: payload });

  let sandboxErr = '';
  try {
    new Function('document', 'window', 'api', STATS_JS)(sandboxDoc, {}, fakeApi);
  } catch (e) { sandboxErr = String(e && e.message || e); }
  ok('脚本在裸沙盒里能跑起来（没有引用模块级变量）', !sandboxErr, sandboxErr);
  // 数据是异步来的，放一拍再断言
  await new Promise(r => setTimeout(r, 30));
  ok('KPI 区渲染出了数字', /\d/.test(nodeOf('#stKpis').innerHTML), nodeOf('#stKpis').innerHTML.slice(0, 60) || '(空)');
  ok('KPI 渲染出媒体流量与传输中断维度', nodeOf('#stKpis').innerHTML.includes('媒体流量') && nodeOf('#stKpis').innerHTML.includes('传输中断'),
    nodeOf('#stKpis').innerHTML.slice(0, 120) || '(空)');
  ok('通道排行渲染出了内容（esc 之类闭包变量缺失会整块空白）',
    /st-row-name/.test(nodeOf('#stRank').innerHTML) && nodeOf('#stRank').innerHTML.includes('演示站'),
    nodeOf('#stRank').innerHTML.slice(0, 90) || '(空)');
  ok('渲染异常没有被显示成「读取失败」', !/读取失败/.test(nodeOf('#stAlert').textContent || ''),
    nodeOf('#stAlert').textContent || '(无报错)');
  ok('更新时间戳被写上（render 跑到底了）', /更新于/.test(nodeOf('#stUpdated').textContent || ''),
    nodeOf('#stUpdated').textContent || '(空)');
}

// ===================== 9. 通道登记表 =====================
section('9. 通道登记表（路径 / 中文名 / 是否管理通道只有一处真源）');
{
  // 这张表同时喂三个地方：入口认路径、统计判管理通道、驾驶舱显示中文名。
  // 所以「加一个通道」必须只改 scopes.js 一处 —— 下面这些用例就是钉住这件事。
  const cases = [
    ['/p/uhdnow/', 'p:uhdnow'],
    ['/p/uhdnow/a/b', 'p:uhdnow'],
    ['/p/', ''],
    ['/s/abc123', 'share'],
    ['/tsub', 'tsub'],
    ['/tsub/xyz', 'tsub'],
    ['/sub', 'sub'],
    ['/sub/x', 'sub'],
    ['/edt', 'edt'],
    ['/admin', 'edt-admin'],
    ['/__admin', 'admin'],
    ['/__tsub', 'admin'],
    ['/__api/stats', 'admin'],
    ['/__login', 'login'],
    ['/login', 'login'],
    // 噪声与边界：前缀匹配不能吃掉同前缀的其它路径
    ['/', ''],
    ['/robots.txt', ''],
    ['/favicon.ico', ''],
    ['/administrator', ''],
    ['/pdan', ''],
  ];
  for (const [path, want] of cases) {
    const got = matchVisitScope(path);
    ok(`路径 ${path} → ${want || '（不计入）'}`, got === want, got || '（空）');
  }

  ok('管理通道由登记表判定（stats.js 不再自带一份名单）',
    isAdminScope('admin') && isAdminScope('login') && isAdminScope('edt-admin') && isAdminScope('__x') === false,
    `admin=${isAdminScope('admin')} login=${isAdminScope('login')} edt-admin=${isAdminScope('edt-admin')}`);
  ok('动态通道按基名判管理属性', isAdminScope('p:uhdnow') === false && isAdminScope('edt-admin:9') === true);

  const labels = scopeLabels();
  ok('每个通道都有中文名', VISIT_SCOPES.length > 0 && VISIT_SCOPES.every(s => !!s.label && labels[s.id] === s.label),
    VISIT_SCOPES.map(s => s.id).join(','));
  ok('中文名表是注入的纯数据（前端没有另抄一份映射）',
    VISIT_SCOPES.every(s => STATS_JS.includes(`"${s.id}":"${s.label}"`)),
    JSON.stringify(labels).slice(0, 120));
  // 前端拿到的是数据，所以「改名」只改 scopes.js，不用碰脚本里的分支
  ok('注入的标签表可直接被脚本读取', /var SCOPE_LABELS=\{/.test(STATS_JS));
}

// ===================== 10. 驾驶舱的可配置项 =====================
section('10. 驾驶舱可配置项（天数档位 / 指标都是数据表驱动，不在两处各写一份）');
{
  const pane = renderStatsPane();
  const days = [...pane.matchAll(/data-days="(\d+)"/g)].map(m => Number(m[1]));
  ok('天数档位由档位表生成且升序', days.length >= 2 && days.every((d, i, a) => i === 0 || a[i - 1] < d), days.join(','));
  ok('默认档位标在第一个按钮上', /data-days="\d+" class="active"/.test(pane));

  const opts = [...pane.matchAll(/<option value="([a-z]+)"[^>]*>([^<]+)</g)].map(m => m[1]);
  ok('指标下拉由指标表生成', opts.length >= 2 && opts[0] === 'hits', opts.join(','));
  ok('指标表也以数据形式注入了脚本', /var STATS_METRICS=\[/.test(STATS_JS));
  // 页面上的选项与注入脚本里的表必须是同一份，否则会出现「能选但画不出来」
  const injected = JSON.parse((STATS_JS.match(/var STATS_METRICS=(\[[\s\S]*?\]);/) || [])[1] || '[]');
  ok('页面下拉与注入的指标表一致',
    injected.length === opts.length && injected.every(m => opts.includes(m.key) && !!m.fmt),
    JSON.stringify(injected.map(m => m.key + ':' + m.fmt)));
}

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
console.log(`访问统计与驾驶舱：${pass + fail} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：' + failures.join('、')); process.exit(1); }
