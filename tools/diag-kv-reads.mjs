#!/usr/bin/env node
/**
 * 手动诊断工具：一个 HTTP 请求到底触发了多少次底层存储读、都读了哪些键、各自从哪行代码来。
 *
 * 起因：9-18 当天 D1 rows read 打到 509 万（免费上限 500 万），站点降级、两条订阅失效。
 * 算笔账：当天 Worker 请求 10,106，D1 readQueries 79,660 —— 平均每个 HTTP 请求
 * 触发约 7.9 次存储查询。这个脚本就是要把这 7.9 次拆开，看清楚了再动手改。
 *
 * 冷启动才是成本所在：Worker 的进程内缓存是 per-isolate 的，isolate 被回收后一切从头。
 * 所以每个场景都测两遍 —— 第一遍前清空全部缓存（`cold()`）代表冷启动，第二遍不重置，
 * 代表「同一个 isolate 里的第二个请求」。只测一遍会看到 0 次，那是假象。
 * 注意第一版把 `cold()` 写进了每次循环，两次都是冷的，对比出来的 15→14 让人误以为
 * 「缓存几乎没起作用」，其实是自己把缓存清掉了。
 *
 * 为什么叫 diag- 而不是 check-：它给的是**观察值**而不是是非判断，需要人来读
 * （哪个键被读了几次、调用栈是什么），所以不挂 CI —— 挂上去只会得到一条恒绿的作业。
 * 要落的硬约束另见 tools/check-d1list.mjs。
 *
 * 用法：node tools/diag-kv-reads.mjs
 *
 * 为什么不在读完代码后直接下结论：上一轮靠猜连续三轮全错（踩坑记录第 32 条），
 * 差一点就按错误的假设去给 list() 加索引了。这里一律用真跑出来的计数说话。
 */
import { handleRequest } from '../src/router.js';
import { bindRuntime } from '../src/runtime.js';
import { resetState } from '../src/memstore.js';
import { invalidateSettings } from '../src/settings.js';
import { invalidateSite } from '../src/sites.js';
import { kvKey } from '../src/util.js';

const ORIGIN = 'https://proxy.example.com';
const PASSWORD = 'dev';
const UUID = '90cd4a77-141a-43c9-991b-08263cfe9c10';

const mem = new Map();
let calls = null;

const raw = {
  async list(o = {}) {
    const p = (o && o.prefix) || '';
    if (calls) calls.push({ op: 'list', key: p + '*' });
    return {
      keys: [...mem.keys()].filter(k => k.startsWith(p)).map(name => ({ name })),
      list_complete: true,
    };
  },
  async get(k) {
    if (calls) calls.push({ op: 'get', key: k, stack: capture() });
    return mem.has(k) ? mem.get(k) : null;
  },
  async put(k, v) {
    if (calls) calls.push({ op: 'put', key: k });
    mem.set(k, v);
  },
  async delete(k) {
    if (calls) calls.push({ op: 'delete', key: k });
    mem.delete(k);
  },
};

/**
 * 抓一段精简调用栈：只留 src/ 下的帧，并掐掉 node 内部那一大串。
 * 目的是回答「这行存储读是谁发起的」 —— 只看 key 名是没法归因的。
 */
function capture() {
  const st = (new Error().stack || '').split('\n').slice(1);
  const kept = [];
  for (const line of st) {
    const m = /at (.+?) \((.+?)\)/.exec(line.trim()) || /at (.+)/.exec(line.trim());
    if (!m) continue;
    const loc = m[2] || m[1];
    if (!loc.includes('/any-proxy/') && !loc.includes('file://')) continue;
    const fn = (m[1] || '').split(' ')[0] || '(anonymous)';
    const short = loc.replace(/^file:\/\//, '').split('/any-proxy/').pop();
    kept.push(`${fn} @ ${short}`);
    if (kept.length >= 4) break;
  }
  return kept;
}

const env = { PASSWORD, UUID, SITES: raw, PROXY_HOST: new URL(ORIGIN).hostname };
bindRuntime(env);

// —— 铺最小数据 ——
const site = {
  slug: 'demo', id: 'demo', name: '演示站',
  target: 'https://example.org', enabled: true, created_at: Date.now(),
};
mem.set(kvKey('site', 'demo'), JSON.stringify(site));
mem.set('config.json', JSON.stringify({ uuid: UUID, host: 'ex.example.com', port: 443 }));
mem.set('APP_CONFIG', JSON.stringify({}));

const ctx = { waitUntil: () => {} };

/** 清掉全部进程内缓存，让下一个请求走冷启动路径 */
function cold() {
  resetState(raw, env);
  invalidateSettings();
  invalidateSite();
}

async function measure(label, path, init = {}, repeat = 1) {
  const snapshots = [];
  // 只在第一次之前重置，让第 2 次真正代表「同一个 isolate 里的第二个请求」。
  // 一开始写成 `if (i > 0) cold()`，等于每次都重置 —— 两次都是冷启动，
  // 对比出来的 15→14 让人误以为「缓存几乎没用」，其实是自己把缓存清掉了。
  for (let i = 0; i < repeat; i++) {
    if (i === 0) cold();
    calls = [];
    let status = 0;
    let err = null;
    try {
      const res = await handleRequest(new Request(ORIGIN + path, init), env, ctx);
      status = res.status;
      await res.arrayBuffer().catch(() => {});
    } catch (e) {
      err = e;
    }
    snapshots.push({ calls: calls, status, err });
    calls = null;
  }

  console.log(`\n=== ${label} ===`);
  console.log(`  ${path}`);
  const tag = repeat > 1 ? ['冷启动', '第 2 次（有缓存）'] : ['单次'];
  snapshots.forEach((s, i) => {
    const reads = s.calls.filter(c => c.op === 'get' || c.op === 'list').length;
    const writes = s.calls.filter(c => c.op === 'put' || c.op === 'delete').length;
    console.log(`  [${tag[i] || ('第 ' + (i + 1) + ' 次')}] 状态 ${s.status}`
      + `${s.err ? ' 抛异常: ' + s.err.message : ''}  读 ${reads} 次 / 写 ${writes} 次`);
  });

  // 明细打印第一次（冷启动）的
  const tally = new Map();
  const stacks = new Map();
  for (const c of snapshots[0].calls) {
    const k = `${c.op} ${c.key}`;
    tally.set(k, (tally.get(k) || 0) + 1);
    if (c.stack && c.stack.length && !stacks.has(k)) stacks.set(k, c.stack);
  }
  const rows = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  console.log('  冷启动明细（含调用来源）：');
  for (const [k, n] of rows.slice(0, 30)) {
    console.log(`    ${n}×  ${k}`);
    const st = stacks.get(k);
    if (st && st.length) console.log(`          ← ${st.join('  ←  ')}`);
  }
  if (rows.length > 30) console.log(`    …另外 ${rows.length - 30} 项`);

  return {
    cold: snapshots[0].calls.filter(c => c.op === 'get' || c.op === 'list').length,
    warm: snapshots.length > 1
      ? snapshots[1].calls.filter(c => c.op === 'get' || c.op === 'list').length
      : null,
  };
}

const results = [];
results.push(['站点反代首页', await measure('站点反代首页 /p/demo/',
  '/p/demo/', { headers: { 'User-Agent': 'Mozilla/5.0' } }, 2)]);
cold();
results.push(['根路径', await measure('根路径 /',
  '/', { headers: { 'User-Agent': 'Mozilla/5.0' } }, 2)]);
cold();
results.push(['面板 /__api/storage', await measure('面板 /__api/storage',
  '/__api/storage', { headers: { Cookie: 'ap_auth=' + Buffer.from(PASSWORD).toString('base64') } }, 2)]);

console.log('\n=== 汇总（冷启动 vs 命中缓存）===');
for (const [name, r] of results) {
  console.log(`  ${name.padEnd(20)} 冷启动 ${String(r.cold).padStart(3)} 次读`
    + `${r.warm === null ? '' : '  →  第 2 次 ' + String(r.warm).padStart(3) + ' 次读'}`);
}
