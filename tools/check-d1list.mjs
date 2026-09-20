#!/usr/bin/env node
/**
 * D1 列前缀查询自检：list() 必须走索引范围查找，而不是全索引扫描。
 *
 * 为什么要单开这一项：
 * `key LIKE 'x%' ORDER BY key` 在本表的索引形态（key 是 TEXT PRIMARY KEY，BINARY 索引，
 * 而 case_sensitive_like 默认关闭）下，**执行计划是全索引扫描** —— 表里有多少行就扫多少行。
 * 2026-09-18 那天 kv 表 2994 行，D1 rows read 打到 5,092,939（免费日限额 500 万），
 * 站点因此降级到内存模式、两条订阅同时失效。算下来那天发生了约 1700 次这样的全扫描，
 * 贡献了几乎全部的超额。详见 docs/07-踩坑记录.md 第 33 条。
 *
 * ⚠️ 这里刻意**不走捷径**：真正的 SQL 必须从 src/storage.js 的实现里取，而不是在检查里
 * 誊一份来自比。第一版就是誊了一份 —— 于是「把实现改回全表扫描」这种退化在系统里
 * 全绿通过，检查空转（tools/tooth-d1list.mjs 当场抓住了这个漏洞）。
 * 现在的做法是：起一个真的 SQLite（近三千行），用假的 db 句柄把 createD1KV 接进去，
 * 断言它实际下发的那条 SQL 的执行计划必须是 SEARCH 而不是 SCAN。
 *
 * 用法：
 *   node tools/check-d1list.mjs
 */
import { spawn } from 'node:child_process';
import { prefixUpperBound, createD1KV } from '../src/storage.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  -> ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  -> ' + extra : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// ——————————————————————————————————————————————————————————
// 1) 上界函数本身（纯函数，直接测）
// ——————————————————————————————————————————————————————————
section('1) prefixUpperBound：算出前缀区间的另一端');

ok('普通前缀取到下一个字符', prefixUpperBound('site:') === 'site;',
  `site: -> ${prefixUpperBound('site:')}`);
ok('空前缀不做上界限制（要列全部）', prefixUpperBound('') === undefined,
  String(prefixUpperBound('')));
ok('单字符也成立', prefixUpperBound('a') === 'b', String(prefixUpperBound('a')));
{
  // 期望值交给代码算，别手打 —— 手算汉字码位 +1 会算错（我第一版写成「站奀」，实际是「站為」）
  const p = '站点';
  const want = p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1);
  const got = prefixUpperBound(p);
  ok('中文键按码位 +1', got === want, `${p} -> ${got}`);
}
const emoji = '🙂';
ok('emoji 结尾时放弃优化（返回 undefined），不能算出一个可能漏键的上界',
  prefixUpperBound(emoji) === undefined, String(prefixUpperBound(emoji)));
ok('含 emoji 但不结尾时仍能取上界',
  prefixUpperBound('🙂x') === '🙂y', String(prefixUpperBound('🙂x')));
ok('末字符已达码位上限时放弃优化',
  prefixUpperBound('￿') === undefined, String(prefixUpperBound('￿')));

{
  const cases = ['site:', 'geoip:1', 'a', '站点', 'A_z'];
  const sample = ['site:demo', 'geoip:1.2.3.4', 'abc', '站点abc', 'A_zZz', 'A_z'];
  let allLt = true;
  for (const p of cases) {
    const u = prefixUpperBound(p);
    for (const k of sample) if (k.startsWith(p) && !(k < u)) allLt = false;
  }
  ok('语义校验：所有以该前缀开头的键都严格小于上界（不会漏行）', allLt);
}

// ——————————————————————————————————————————————————————————
// 2) 真 SQLite × 真实现
// ——————————————————————————————————————————————————————————
section('2) 真 SQLite（近三千行）× src/storage.js 的真实实现');

const dir = mkdtempSync(join(tmpdir(), 'd1list-'));
const py = join(dir, 'srv.py');

// 一个常驻的 sqlite 服务端：因为要测的是同一份内存数据库上的执行计划，
// 每次 spawn 一个新进程就连不上前面铺的数据了。
writeFileSync(py, `
import json, sys, sqlite3

con = sqlite3.connect(':memory:')
con.execute('CREATE TABLE kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
con.execute('CREATE INDEX idx_kv_key ON kv(key)')

rows = [('APP_CONFIG', 'v'), ('config.json', 'v'),
        ('site:alpha', 'v'), ('site:beta', 'v'), ('site:gamma', 'v'),
        # 刻意放几个「正好等于某个前缀上界」的键：=< 写成 <= 时它们会被多捞出来
        ('site;', 'v'), ('B', 'v'), ('Ab', 'v'),
        ('A_z', 'v'), ('A_zoo', 'v'), ('Aab', 'v'), ('中文字', 'v'), ('中文乙', 'v')]
for i in range(2500):
    rows.append(('geoip:203.0.%d.%d' % (i // 256, i % 256), 'US'))
for i in range(300):
    rows.append(('stat:s%d:%04d' % (i % 8, i), 'x'))
for i in range(180):
    rows.append(('share:s%d' % i, 'x'))
con.executemany('INSERT INTO kv(key, value) VALUES(?,?)', rows)
con.commit()

sys.stdout.write(json.dumps({'ok': True, 'total': con.execute('SELECT COUNT(*) FROM kv').fetchone()[0]}) + chr(10))
sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        req = json.loads(line)
    except Exception as e:
        sys.stdout.write(json.dumps({'error': 'bad json: %s' % e}) + chr(10)); sys.stdout.flush(); continue
    try:
        op = req.get('op')
        sql = req['sql']; args = req.get('args') or []
        if op == 'plan':
            got = ' ; '.join(r[3] for r in con.execute('EXPLAIN QUERY PLAN ' + sql, args))
            res = {'plan': got}
        else:
            cur = con.execute(sql, args)
            res = {'results': [{'key': r[0]} for r in cur.fetchall()]}
    except Exception as e:
        res = {'error': repr(e)}
    sys.stdout.write(json.dumps(res, ensure_ascii=False) + chr(10))
    sys.stdout.flush()
`);

const child = spawn('python3', [py], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
let waiter = null;
child.stdout.on('data', (d) => {
  buf += String(d);
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (waiter) { const w = waiter; waiter = null; w(line); }
  }
});
child.stderr.on('data', () => {});

function rpc(req) {
  return new Promise((resolve) => {
    waiter = (line) => {
      try { resolve(JSON.parse(line)); } catch { resolve({ error: 'bad reply' }); }
    };
    child.stdin.write(JSON.stringify(req) + '\n');
  });
}

const hello = await new Promise((resolve) => {
  waiter = (line) => { try { resolve(JSON.parse(line)); } catch { resolve(null); } };
});
const total = (hello && hello.total) || 0;

if (!total) {
  fail++;
  console.log('  ❌ SQLite 没起来，后面的断言无从谈起');
  child.kill();
  console.log(`\n=== D1 列前缀自检：${pass} 项通过，${fail} 项失败 ===`);
  process.exit(1);
}
console.log(`  （铺了 ${total} 行）`);

// —— 假 db 句柄：把 createD1KV 真正下发的东西记下来，转交 sqlite ——
const seen = [];
const fakeDb = {
  prepare(sql) {
    seen.push(sql);
    return {
      bind(...args) {
        return {
          async all() { return await rpc({ op: 'all', sql, args }); },
          async first() { const r = await rpc({ op: 'all', sql, args }); return (r.results || [])[0] || null; },
          async run() { return { success: true }; },
        };
      },
    };
  },
};

const kv = createD1KV(fakeDb);

/** 旧写法，用来做行为对比；只在这里出现，实现的变化不会影响它 */
async function legacyList(prefix, limit = 1000) {
  const r = await rpc({
    op: 'all',
    sql: 'SELECT key FROM kv WHERE key LIKE ? ORDER BY key LIMIT ?',
    args: [prefix + '%', limit],
  });
  return (r.results || []).map(x => x.key);
}

async function realList(prefix, limit) {
  seen.length = 0;
  const r = await kv.list({ prefix, limit });
  return { keys: r.keys.map(x => x.name), sql: seen[0] || '' };
}

// 2.1 行为等价
{
  const prefixes = ['site:', 'geoip:203.0.1', 'stat:s', 'share:s', '', '中文字', 'A_z', 'A', 'APP_'];
  let same = 0;
  const bad = [];
  for (const p of prefixes) {
    const got = await realList(p, 1000);
    const want = await legacyList(p, 1000);
    if (JSON.stringify(got.keys) === JSON.stringify(want)) same++;
    else bad.push({ prefix: p, real: got.keys.slice(0, 6), legacy: want.slice(0, 6) });
  }
  ok('常见前缀下与旧写法返回完全相同的键序列（行为等价）', bad.length === 0,
    `${same} 个前缀一致${bad.length ? '，不一致: ' + JSON.stringify(bad) : ''}`);
}

// 2.2 limit 边界
{
  const cs = [];
  for (const L of [1, 2, 3, 1000]) {
    const a = (await realList('site:', L)).keys.length;
    const b = (await legacyList('site:', L)).length;
    cs.push(a === b);
  }
  ok('各种 limit 下条数一致', cs.every(Boolean), JSON.stringify(cs));
}

// 2.3 执行计划 —— 这是真正的靶心：断言「实现实际下发的那条 SQL」走索引查找
{
  const site = await realList('site:', 1000);
  const plan = (await rpc({ op: 'plan', sql: site.sql, args: ['site:', 'site;', 1000] })).plan || '';
  ok('有上界时：实现下发的 SQL 走索引范围查找（SEARCH）',
    /SEARCH/.test(plan) && !/SCAN/.test(plan), plan);

  const all = await realList('', 1000);
  const planAll = (await rpc({ op: 'plan', sql: all.sql, args: ['' , 1000] })).plan || '';
  ok('空前缀（列全部）时同样走索引查找',
    /SEARCH/.test(planAll) && !/SCAN/.test(planAll), planAll);
}

// 2.4 对照组：证明这套判据确实能区分两种写法（不然「绿」可能是恒真的）
{
  const planOld = (await rpc({
    op: 'plan',
    sql: 'SELECT key FROM kv WHERE key LIKE ? ORDER BY key LIMIT ?',
    args: ['site:%', 1000],
  })).plan || '';
  ok('对照组：LIKE 写法在同一份数据上确实被判成全索引扫描',
    /SCAN/.test(planOld) && !/SEARCH/.test(planOld), planOld);
}

// 2.5 前缀里的通配符：LIKE 会把 _ 和 % 当通配符用
{
  // 坑要挑对的才演示得出来：是「前缀以 _ 结尾」时 LIKE 才会把它当通配符。
  // 我一开始用 'A_z'，pattern 变成 A_z%，那条 'z' 是字面量，反而缩小了范围，
  // 于是两条都返回一样的集合 —— 一条假绿就这样把真正的差异盖住了。
  const p = 'A_';
  const real = (await realList(p, 1000)).keys;
  const legacy = await legacyList(p, 1000);
  ok('含 `_` 的前缀：实现返回的都真的以该前缀开头',
    real.length > 0 && real.every(k => k.startsWith(p)), JSON.stringify(real));
  ok('含 `_` 的前缀：LIKE 写法会把不相干的键也捞进来（通配符语义）',
    legacy.some(k => !k.startsWith(p)),
    `旧: ${JSON.stringify(legacy)} vs 新: ${JSON.stringify(real)}`);
}

child.kill();
console.log(`\n=== D1 列前缀自检：${pass} 项通过，${fail} 项失败 ===`);
process.exit(fail ? 1 : 0);
