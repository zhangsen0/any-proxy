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

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
console.log(`节点延迟实测：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
