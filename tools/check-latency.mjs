#!/usr/bin/env node
// 节点 / 候选 IP 延迟实测的自检。
//
// 这个模块防的是一类很隐蔽的退化：**测出来的顺序根本不是按快慢排的**。
// 探测能通、接口能返回 200、统计数字也都有 —— 唯独顺序不对，于是「优选」选出来
// 的依然是随机那一个。这种问题不会报错，只能靠这里把排序本身钉死。
//
// 另外两条同样重要：
//   - **单次抖动不能误杀**（网络抖一下很常见，误杀的代价是少一个可用节点）
//   - **伪装下 404 必须算通**（未登录访问 /__api/config 就是 404，那恰恰说明 IP 是通的；
//     要是按状态码判，伪装一开所有 IP 都会被判死）

import { bindRuntime } from '../src/runtime.js';
import { median, measureTargets } from '../src/latency.js';
import { invalidateDoc } from '../src/config.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n[1] 中位数：比最小值抗抖动，比均值不受极端值拖累');
check('空数组得 null', median([]) === null);
check('奇数个取正中间', median([3, 1, 2]) === 2, String(median([3, 1, 2])));
check('偶数个取中间两数的均值', median([1, 2, 3, 4]) === 3, String(median([1, 2, 3, 4])));
check('只有一个数', median([7]) === 7);
check('极端值不拖动结果（不是均值）',
  median([1, 2, 3, 100]) === 3 && 3 !== Math.round((1 + 2 + 3 + 100) / 4),
  '中位数=' + median([1, 2, 3, 100]) + ' 均值=' + Math.round((1 + 2 + 3 + 100) / 4));

console.log('\n[2] 排序：通的必须按延迟升序，不通的必须出局');
{
  // 名字 → 模拟延迟（毫秒）
  const table = { a: 30, b: 10, c: 20 };
  const probe = async (t) => { if (table[t] === undefined) throw new Error('unreachable'); await sleep(table[t]); };
  // ⚠️ 这里必须串行（concurrency: 1）。并发下「快的先完成」，items 的完成顺序
  // 天然就等于延迟顺序 —— 就算把 .sort() 删掉，这条断言照样是绿的，判据等于没有。
  // 串行时完成顺序 = 队列顺序 a,b,c，而延迟顺序是 b,c,a，两者不同，才测得出来。
  // （做这条牙齿验证时发现并修掉的，别再改回并发。）
  const r = await measureTargets(['a', 'b', 'c'], { probe, concurrency: 1, samples: 1 });
  check('按延迟升序排好', r.ok.join(',') === 'b,c,a', r.ok.join(','));
  const seq = r.ok.map((t) => r.items.find((x) => x.target === t).ms);
  check('排出来的延迟序列非递减', seq.every((v, i) => i === 0 || seq[i - 1] <= v), seq.join(' → '));
  check('items 保留全部目标（含不通的，供诊断看）', r.items.length === 3);
  check('最快 ≤ 最慢', r.stats.fastest <= r.stats.slowest, `fastest=${r.stats.fastest} slowest=${r.stats.slowest}`);
}
{
  const probe = async (t) => { if (t !== 'a') throw new Error('unreachable'); await sleep(5); };
  const r = await measureTargets(['a', 'b'], { probe, concurrency: 2, samples: 1 });
  check('不通的不进可用集', r.ok.join(',') === 'a', r.ok.join(','));
  check('bad 计数正确', r.stats.bad === 1, JSON.stringify(r.stats));
  check('不通的 ms 是 null（不是 0，0 会被当成最快）',
    r.items.find((x) => x.target === 'b').ms === null);
}

console.log('\n[3] 单次抖动不能误杀');
{
  let n = 0;
  const probe = async () => { n++; if (n === 1) throw new Error('抖动一下'); await sleep(1); };
  const r = await measureTargets(['x'], { probe, concurrency: 1, samples: 2 });
  check('第一次失败、第二次成功 -> 仍算通', r.ok.length === 1 && r.items[0].ok === true,
    JSON.stringify(r.items[0]));
  check('只把成功的那次计入延迟', r.items[0].hits === 1, String(r.items[0].hits));
}

console.log('\n[4] 去重与上限');
{
  const probe = async () => { await sleep(1); };
  const r = await measureTargets(['a', 'a', 'b', 'c', 'd'], { probe, concurrency: 4, samples: 1, maxTargets: 2 });
  check('先去重再截断', r.stats.total === 2, String(r.stats.total));
}
{
  const probe = async () => { await sleep(40); };
  const r = await measureTargets(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    { probe, concurrency: 1, samples: 1, budgetMs: 60 });
  check('预算耗尽就收尾，不拖垮请求', r.stats.stoppedEarly === true, JSON.stringify(r.stats));
  check('预算内测到的结果照样返回', r.items.length > 0 && r.items.length < 8, String(r.items.length));
}

// ===================== 以下是 dns.js 的探测口径 =====================

const mem = new Map();
const kv = {
  async list(o = {}) {
    const p = (o && o.prefix) || '';
    return { keys: [...mem.keys()].filter((k) => k.startsWith(p)).map((name) => ({ name })), list_complete: true };
  },
  async get(k) { return mem.has(k) ? mem.get(k) : null; },
  async put(k, v) { mem.set(k, String(v)); },
  async delete(k) { mem.delete(k); },
};
bindRuntime({ PASSWORD: 'dev', SITES: kv, PROXY_HOST: 'proxy.example.com' });

const { probeLatency } = await import('../src/dns.js');

console.log('\n[5] 探测口径：只看连不连得上，不看状态码');
{
  // 伪装开启时，未登录访问 /__api/config 拿到的就是 404 —— 但这恰恰说明 IP 是通的
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  const r = await probeLatency(['1.1.1.1'], { host: 'proxy.example.com', env: {} });
  check('404 也算通（伪装下的正常表现）', r.ok.length === 1, JSON.stringify(r.stats));
}
{
  globalThis.fetch = async () => { throw new Error('connect failed'); };
  const r = await probeLatency(['1.1.1.1'], { host: 'proxy.example.com', env: {} });
  check('连不上才算不通', r.ok.length === 0 && r.stats.bad === 1, JSON.stringify(r.stats));
}

console.log('\n[6] 缺少目标域名时明确报错，不静默返回空');
{
  const r = await probeLatency(['1.1.1.1'], { env: {} });
  check('给出明确错误', !!r.error, String(r.error));
}

console.log('\n[7] 接口：/__api/latency-probe 真的能测出顺序');
{
  const delays = { '1.1.1.1': 60, '2.2.2.2': 5, '3.3.3.3': 30 };
  globalThis.fetch = async (u) => {
    const ip = String(u).match(/([\d.]+)/)[1];
    await sleep(delays[ip] ?? 1);
    return new Response('ok', { status: 200 });
  };
  const { handleRequest } = await import('../src/router.js');
  const cookie = 'ap_auth=' + Buffer.from('dev').toString('base64');
  const res = await handleRequest(new Request('https://proxy.example.com/__api/latency-probe', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ targets: ['1.1.1.1', '2.2.2.2', '3.3.3.3'] }),
  }), {}, {});
  const data = await res.json().catch(() => ({}));
  check('接口返回 200', res.status === 200, 'HTTP ' + res.status + ' ' + String(data.error || ''));
  check('返回了排序结果', Array.isArray(data.ranked) && data.ranked.length === 3,
    JSON.stringify(data.ranked));
  check('最快的排在最前', data.ranked && data.ranked[0] === '2.2.2.2', JSON.stringify(data.ranked));
  // 注意：接口走的是默认并发，「快的先完成」本身就会让顺序看起来是对的，
  // 所以这一段验的是**链路**（接口能通、结果带得上延迟数值），
  // 排序本身的正确性由 [2] 的串行用例保证 —— 那里才真测得出去掉 .sort() 的情况。
  const msOf = Object.fromEntries((data.items || []).map((x) => [x.target, x.ms]));
  const seq = (data.ranked || []).map((t) => msOf[t]);
  check('排序结果按延迟非递减', seq.length > 0 && seq.every((v, i) => i === 0 || seq[i - 1] <= v),
    seq.join(' → '));
  check('每个目标都带上了延迟数值',
    Array.isArray(data.items) && data.items.every((x) => typeof x.ms === 'number'),
    JSON.stringify((data.items || []).map((x) => x.target + '=' + x.ms)));
  check('统计里最快慢都有', data.stats && data.stats.fastest <= data.stats.slowest,
    data.stats ? `${data.stats.fastest}~${data.stats.slowest} ms` : '无');
}

// ===================== 订阅出口：把「多快」落到客户端拿到的顺序上 =====================
//
// 这一段防的是另一类退化：**测出来的快慢根本没作用到订阅上**。
// 延迟数字全都有、接口也返回 200，唯独 /sub 吐出去的节点顺序还是上游原文的顺序 ——
// 而客户端通常拿第一个节点用，于是用户体感一点没变。延迟实测就成了个只能看的数字。

const { reorderByLatency, sortSubscriptionResponse } = await import('../src/sublat.js');

const node = (ip, name) =>
  `vless://00000000-0000-4000-8000-000000000000@${ip}:443?encryption=none&security=tls&type=ws&host=proxy.example.com&path=%2F#${name}`;

/** 造一个「延迟表 → 测量函数」：出现的 IP 按表里的毫秒返回，没出现就抛（不通）。 */
function fakeMeasure(table, calls) {
  return async (targets) => {
    calls.push(targets.slice());
    const items = targets.map((t) => (table[t] === undefined
      ? { target: t, ok: false, ms: null }
      : { target: t, ok: true, ms: table[t] }));
    const ok = items.filter((x) => x.ok).sort((a, b) => a.ms - b.ms).map((x) => x.target);
    return { items, ok, stats: { total: items.length, good: ok.length, bad: items.length - ok.length } };
  };
}

const HOST = 'proxy.example.com';
const names = (text) => text.split('\n').map((l) => (l.match(/#(.+)$/) || [, ''])[1]);

console.log('\n[8] 订阅排序：最快的必须排到最前');
{
  const calls = [];
  const src = [node('1.1.1.1', 'A'), node('2.2.2.2', 'B'), node('3.3.3.3', 'C')].join('\n');
  const r = await reorderByLatency(src, {
    env: {}, host: HOST, measure: fakeMeasure({ '1.1.1.1': 300, '2.2.2.2': 100, '3.3.3.3': 200 }, calls),
  });
  check('顺序按延迟升序（B→C→A）', names(r.text).join('') === 'BCA', names(r.text).join(''));
  check('三个节点都拿到了延迟', r.ranked === 3, JSON.stringify(r.stats));
  check('统计里最快是 100ms', r.stats.fastest === 100, String(r.stats.fastest));
  check('只测了缺失的那批（首次全测）', calls.length === 1 && calls[0].length === 3, JSON.stringify(calls));
}

console.log('\n[9] 缓存：TTL 内不重复探测，过期才重测');
{
  mem.delete('LATENCY_CACHE');   // 上一节的缓存会污染这一节，先清掉
  const calls = [];
  const measure = fakeMeasure({ '1.1.1.1': 300, '2.2.2.2': 100 }, calls);
  const src = [node('1.1.1.1', 'A'), node('2.2.2.2', 'B')].join('\n');
  await reorderByLatency(src, { env: {}, host: HOST, measure });
  const r2 = await reorderByLatency(src, { env: {}, host: HOST, measure });
  check('TTL 内复用缓存，一次探测都不发', calls.length === 1, JSON.stringify(calls));
  check('命中缓存时如实标注', r2.stats.cached === true, JSON.stringify(r2.stats));
  check('缓存期内顺序保持最快在前', names(r2.text).join('') === 'BA', names(r2.text).join(''));

  // 把缓存的时间戳推到 TTL 之外：下次必须重测，否则网络变了永远发现不了
  const raw = JSON.parse(mem.get('LATENCY_CACHE'));
  mem.set('LATENCY_CACHE', JSON.stringify({ ...raw, ts: Date.now() - 3600000 }));
  await reorderByLatency(src, { env: {}, host: HOST, measure });
  check('缓存过期后重新探测', calls.length === 2, JSON.stringify(calls));
}

console.log('\n[10] 不通的垫底、没测过的不动、原样兜底');
{
  mem.delete('LATENCY_CACHE');
  const calls = [];
  const src = [node('1.1.1.1', 'A'), node('2.2.2.2', 'B'), node('3.3.3.3', 'C')].join('\n');
  // 2.2.2.2 不通（记 null）；3.3.3.3 压根没出现在测量结果里（预算耗尽，等同「没测过」）
  const r = await reorderByLatency(src, {
    env: {}, host: HOST,
    measure: async () => ({
      items: [{ target: '1.1.1.1', ok: true, ms: 200 }, { target: '2.2.2.2', ok: false, ms: null }],
      ok: ['1.1.1.1'], stats: {},
    }),
  });
  check('通的排最前，其次没测过，不通的垫底', names(r.text).join('') === 'ACB', names(r.text).join(''));
  check('不通的记成 null（不是 0，0 会被当成最快）',
    JSON.parse(mem.get('LATENCY_CACHE')).ms['2.2.2.2'] === null,
    JSON.stringify(JSON.parse(mem.get('LATENCY_CACHE')).ms));
}
{
  // 整段测量失败（网络炸了 / 预算耗尽）：顺序必须保持原样，绝不能返回一份乱序的订阅。
  // 用没测过的 IP，免得命中上一节的缓存 —— 缓存里已有的结果本来就该生效
  const src = [node('4.4.4.4', 'A'), node('5.5.5.5', 'B')].join('\n');
  const r = await reorderByLatency(src, { env: {}, host: HOST, measure: async () => { throw new Error('boom'); } });
  check('测量失败时原样返回', r.text === src && r.ranked === 0, JSON.stringify(r.stats));
  const r0 = await reorderByLatency(src, { env: {}, host: HOST, measure: async () => null });
  check('测量结果为空时原样返回', r0.text === src);
}
{
  // 编码形态：整份 base64 进去，必须整份 base64 出来，换成明文会让一部分客户端直接不认
  mem.delete('LATENCY_CACHE');
  const src = [node('1.1.1.1', 'A'), node('2.2.2.2', 'B')].join('\n');
  const b64sub = Buffer.from(src, 'utf-8').toString('base64');
  const r = await reorderByLatency(b64sub, {
    env: {}, host: HOST, measure: fakeMeasure({ '1.1.1.1': 300, '2.2.2.2': 50 }, []),
  });
  check('base64 进 → base64 出', !r.text.includes('://'), r.text.slice(0, 12) + '…');
  check('解码后顺序是 B→A', names(Buffer.from(r.text, 'base64').toString('utf-8')).join('') === 'BA');
}

console.log('\n[11] 响应出口：开关关着就原样透传，非节点内容不碰');
{
  mem.delete('LATENCY_CACHE');
  const src = [node('1.1.1.1', 'A'), node('2.2.2.2', 'B')].join('\n');
  const mk = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
  // 关掉开关：连 body 都不该被读（读了就必须重建响应，那是无谓的开销与风险）
  mem.set('APP_CONFIG', JSON.stringify({ settings: { sub_latency_sort: false } }));
  invalidateDoc();
  const off = await sortSubscriptionResponse(mk(src), { env: {}, host: HOST, measure: fakeMeasure({ '1.1.1.1': 1, '2.2.2.2': 2 }, []) });
  const offText = await off.text();
  check('开关关闭 → 原样透传', offText === src, offText === src ? '' : offText.slice(0, 40));
  mem.delete('APP_CONFIG');
  invalidateDoc();

  const on = await sortSubscriptionResponse(mk(src), { env: {}, host: HOST, measure: fakeMeasure({ '1.1.1.1': 9, '2.2.2.2': 300 }, []) });
  const onText = await on.text();
  check('开关开启 → 最快的排最前', names(onText).join('') === 'AB', names(onText).join(''));

  const bad = await sortSubscriptionResponse(new Response('nope', { status: 500 }), { env: {}, host: HOST });
  check('非 200 响应不处理', bad.status === 500);

  // 订阅里常带注释行与空行：重排只能动节点行，其余必须原样留在原位。
  // 换一组没测过的 IP：上一节已经把 1.1.1.1/2.2.2.2 的结果写进缓存了
  const mixed = ['# 这是一份订阅', node('6.6.6.6', 'A'), '', node('7.7.7.7', 'B'), '// 结尾说明'].join('\n');
  const r = await reorderByLatency(mixed, { env: {}, host: HOST, measure: fakeMeasure({ '6.6.6.6': 300, '7.7.7.7': 20 }, []) });
  const out = r.text.split('\n');
  check('注释与空行留在原位', out[0] === '# 这是一份订阅' && out[2] === '' && out[4] === '// 结尾说明', JSON.stringify(out));
  check('节点行之间完成重排', names(out[1])[0] === 'B' && names(out[3])[0] === 'A', out[1] + ' | ' + out[3]);
}

// ===================== 浏览器测速：让「你的网络」的快慢走到 A 记录上 =====================
//
// 服务端只能从 Cloudflare 自己的网络往外探，那个「最快」跟用户的网络基本无关
// （实测两个视角的排序近似零相关）。所以顺序必须由浏览器那边定 —— 但前提是这个顺序
// **真的被用上**。这一段防的退化是：测完了、也存了，自动优选却还是按服务端探测的顺序写。

const { readPickSpeed, savePickSpeed, orderByPickSpeed, rankByPickSpeed, spread } =
  await import('../src/pickspeed.js');

console.log('\n[12] 浏览器测速表：存取与排序');
{
  mem.delete('PICK_SPEED');
  const saved = await savePickSpeed({}, [
    { ip: '1.1.1.1', ms: 300 }, { ip: '2.2.2.2', ms: 100 },
    { ip: 'not-an-ip', ms: 5 }, { ip: '3.3.3.3', ms: -1 },
  ]);
  check('只收合法 IPv4 + 非负毫秒（脏数据不进表）', saved.ok && saved.n === 2, JSON.stringify(saved));
  const t = await readPickSpeed({});
  check('存进去能原样读出来', t.ms['1.1.1.1'] === 300 && t.ms['2.2.2.2'] === 100 && !('not-an-ip' in t.ms),
    JSON.stringify(t.ms));
  check('带时间戳（过期判定靠它）', typeof t.ts === 'number' && t.ts > 0, String(t.ts));

  const r = orderByPickSpeed(['1.1.1.1', '2.2.2.2', '9.9.9.9', '8.8.8.8'], t.ms);
  check('测过的按毫秒升序在前，没测过的垫后且保持原顺序',
    r.ips.join(',') === '2.2.2.2,1.1.1.1,9.9.9.9,8.8.8.8', r.ips.join(','));
  check('命中数如实回报（0 命中要能被发现）', r.matched === 2, String(r.matched));
}
{
  const ips = ['1.1.1.1', '2.2.2.2'];
  mem.set('PICK_SPEED', JSON.stringify({ ts: Date.now(), ms: { '1.1.1.1': 300, '2.2.2.2': 100 } }));
  const off = await rankByPickSpeed({}, ips, { cfg: { pick_speed_enabled: false, pick_speed_ttl_ms: 43200000 } });
  check('开关关闭 → 不排序，且说清原因',
    off.applied === false && off.reason === 'disabled' && off.ips.join(',') === ips.join(','), JSON.stringify(off));
  const on = await rankByPickSpeed({}, ips, { cfg: { pick_speed_enabled: true, pick_speed_ttl_ms: 43200000 } });
  check('开关开启 → 最快的排到最前', on.applied === true && on.ips.join(',') === '2.2.2.2,1.1.1.1', JSON.stringify(on));

  // 换网络（回家 / 出国）之后旧数字就是错的，宁可不用也不能一直信
  mem.set('PICK_SPEED', JSON.stringify({ ts: Date.now() - 86400000, ms: { '1.1.1.1': 300, '2.2.2.2': 100 } }));
  const stale = await rankByPickSpeed({}, ips, { cfg: { pick_speed_enabled: true, pick_speed_ttl_ms: 3600000 } });
  check('结果过期 → 不用它', stale.applied === false && stale.reason === 'stale', JSON.stringify(stale));

  mem.delete('PICK_SPEED');
  const empty = await rankByPickSpeed({}, ips, { cfg: { pick_speed_enabled: true } });
  check('压根没测过 → 原样并说清原因', empty.applied === false && empty.reason === 'empty', JSON.stringify(empty));

  // 表里全是别的批次的 IP：不能因为「查了表」就宣称排过序
  mem.set('PICK_SPEED', JSON.stringify({ ts: Date.now(), ms: { '5.5.5.5': 10 } }));
  const nomatch = await rankByPickSpeed({}, ips, { cfg: { pick_speed_enabled: true, pick_speed_ttl_ms: 43200000 } });
  check('一个都没命中 → 不算排过', nomatch.applied === false && nomatch.reason === 'no-match', JSON.stringify(nomatch));
  mem.delete('PICK_SPEED');
}

console.log('\n[13] 区分度自检：代理状态下测出来的「全挤在一起」必须被识破');
{
  check('全挤在一起 → 判定无区分度', spread([730, 731, 729, 732]).ok === false, JSON.stringify(spread([730, 731, 729, 732])));
  check('差距明显 → 判定有效', spread([80, 200, 500]).ok === true, JSON.stringify(spread([80, 200, 500])));
  check('样本不足三个不妄下结论', spread([10, 20]).ok === false);
}

console.log('\n[14] 接口链路：/__api/pick-speed 存得进去也读得回来');
{
  mem.delete('PICK_SPEED');
  mem.delete('APP_CONFIG');
  invalidateDoc();
  const { handleRequest } = await import('../src/router.js');
  const cookie = 'ap_auth=' + Buffer.from('dev').toString('base64');
  const post = await handleRequest(new Request('https://proxy.example.com/__api/pick-speed', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ ip: '1.1.1.1', ms: 300 }, { ip: '2.2.2.2', ms: 100 }] }),
  }), {}, {});
  const pd = await post.json().catch(() => ({}));
  check('POST 返回 200', post.status === 200, 'HTTP ' + post.status + ' ' + String(pd.error || ''));
  check('记住了 2 个 IP 的延迟', pd.n === 2, JSON.stringify(pd));

  const get = await handleRequest(new Request('https://proxy.example.com/__api/pick-speed', {
    headers: { Cookie: cookie },
  }), {}, {});
  const gd = await get.json().catch(() => ({}));
  check('GET 读回来且按快慢排好', gd.items && gd.items[0].ip === '2.2.2.2' && gd.items[0].ms === 100,
    JSON.stringify(gd.items));
  check('刚存的不算过期', gd.stale === false, JSON.stringify({ ts: gd.ts, ttl: gd.ttl }));

  const bad = await handleRequest(new Request('https://proxy.example.com/__api/pick-speed', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ ip: 'x', ms: 1 }] }),
  }), {}, {});
  check('全是脏数据时明确报错（不假装保存成功）', bad.status === 400, 'HTTP ' + bad.status);
  mem.delete('PICK_SPEED');
}

console.log('\n[15] 「把当前池子写入 DNS」也要按浏览器测速排序');
{
  // 这条接口（/__api/preferred-ips?apply）与「立即更新优选 IP」（/__api/dns-run）是两个入口。
  // 这里防的退化：只给主链路接了测速表，手动应用这条路悄悄退回「谁先探到谁在前」——
  // 两条入口一个口径，否则用户点不同按钮会得到不同顺序，还以为是网络变了。
  mem.delete('PICK_SPEED');
  mem.set('PICK_SPEED', JSON.stringify({ ts: Date.now(), ms: { '9.9.9.1': 500, '9.9.9.2': 50 } }));
  mem.set('PREF_IPS', '9.9.9.1\n9.9.9.2');   // 优选池是 store:'kv'，键 PREF_IPS
  mem.set('APP_CONFIG', JSON.stringify({ settings: {
    cf_zone_id: 'zone1', cf_api_token: 'tok', proxy_host: 'proxy.example.com', dns_settle_ms: 0,
  } }));
  invalidateDoc();
  // mock 分流：HTTP 探测（http://IP/...）全部连通；CF API 读到 0 条 A 记录、写入成功；域名自检 200
  globalThis.fetch = async (u, opts = {}) => {
    const s = String(u);
    if (s.startsWith('http://') && /\/__api\//.test(s)) return new Response('ok', { status: 200 });
    if (s.includes('/dns_records')) {
      if (opts.method === 'POST') return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
      return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
    }
    return new Response('ok', { status: 200 });
  };
  const { handleRequest } = await import('../src/router.js');
  const cookie = 'ap_auth=' + Buffer.from('dev').toString('base64');
  const res = await handleRequest(new Request('https://proxy.example.com/__api/preferred-ips', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ apply: true }),
  }), {}, {});
  const data = await res.json().catch(() => ({}));
  const upd = data.updated || {};
  check('apply 返回 200 且写入了 A 记录', res.status === 200 && upd.ok === true && (upd.changed || 0) >= 1,
    'HTTP ' + res.status + ' ' + JSON.stringify(upd).slice(0, 120));
  check('写进 A 记录的第一个是浏览器测速最快的（50ms 在前）',
    Array.isArray(upd.ips) && upd.ips[0] === '9.9.9.2', JSON.stringify(upd.ips));
  check('note 如实说明按测速排序', /按浏览器测速排序（命中 2\/2 个）/.test(upd.note || ''), String(upd.note));
  mem.delete('PICK_SPEED');
  mem.delete('APP_CONFIG');
  invalidateDoc();
}

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
console.log(`节点延迟实测：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
