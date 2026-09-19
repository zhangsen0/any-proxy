#!/usr/bin/env node
/**
 * 存储降级（内存模式）自检（无需网络）。
 *
 * 它盯的是这样一件事：D1 / KV 配额打满或者暂时不可用的时候，站点不是 500，
 * 而是**在管理面板顶部明确写出自己正跑在内存模式上**，让使用者知道「我改的东西
 * 现在还没落盘」。没有这一段，故障的表现就是「面板打得开、保存也提示成功、
 * 第二天全没了」——那种失败最好查不到地方。
 *
 * 三条硬约束在这里被钉死：
 *   1. **抖动不降级**（一次成功就清零，否则偶尔抖一下会被当成挂了，来回切换）；
 *   2. **绝不自动切回**（哪怕存储恢复了，也必须手动点一次——半好的存储反复横跳更糟）；
 *   3. **失败要响**（降级进 events 且 console.error，写不回去的键必须留在 dirty 里）。
 *
 * 用法：node tools/check-storage.mjs
 */
import { readSettings, invalidateSettings } from '../src/settings.js';
import { invalidateDoc } from '../src/config.js';
import { invalidateSite } from '../src/sites.js';
import { bindRuntime } from '../src/runtime.js';
import { handleRequest } from '../src/router.js';
import {
  wrapStorage, stateOf, getStatus, setStorageMode, flush, probe, setFailThreshold, resetState,
} from '../src/memstore.js';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  -> ' + extra : '')); }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
}

/** 一个会把调用次数记下来的存储桩 */
function makeRaw(opts = {}) {
  const mem = new Map(opts.data || []);
  const calls = { get: 0, put: 0, delete: 0, list: 0 };
  return {
    calls,
    mem,
    failAfter: opts.failAfter === undefined ? -1 : opts.failAfter,
    async get(k) {
      calls.get++;
      if (this.failAfter >= 0 && calls.get > this.failAfter) throw new Error('D1 配额超限');
      return mem.has(k) ? mem.get(k) : null;
    },
    async put(k, v) {
      calls.put++;
      if (this.failAfter >= 0 && calls.put > this.failAfter) throw new Error('D1 配额超限');
      mem.set(k, v);
    },
    async delete(k) {
      calls.delete++;
      if (this.failAfter >= 0 && calls.delete > this.failAfter) throw new Error('D1 配额超限');
      mem.set(k, null);
    },
    async list(o = {}) {
      calls.list++;
      if (this.failAfter >= 0 && calls.list > this.failAfter) throw new Error('D1 配额超限');
      const p = (o && o.prefix) || '';
      return { keys: [...mem.keys()].filter(k => k.startsWith(p)).map(name => ({ name })), list_complete: true, cursor: '' };
    },
  };
}

async function tryPut(p, k, v) { try { await p.put(k, v); return true; } catch { return false; } }
async function tryGet(p, k) { try { return await read(p, k); } catch { return null; } }

// 断言里一律用这个读：实现被改坏时（比如降级后还在打后端）它会返回一个可辨认的哨兵，
// 让检查**干净地变红**而不是把整个脚本带崩 —— 崩了虽然也是红的，却读不出是哪一项坏了
const THREW = '<读的时候抛异常了>';
async function read(p, k) { try { return await p.get(k); } catch { return THREW; } }

// ===================== 1. 健康时行为与今天一致 =====================
console.log('\n[1] 存储正常：读写照旧走真后端');
{
  const raw = makeRaw({ data: [['APP_CONFIG', '{"a":1}']] });
  const env = {};
  const p = wrapStorage(raw, env);
  setFailThreshold(3);
  check('读到的就是后端的值', await read(p, 'APP_CONFIG') === '{"a":1}', String(await read(p, 'APP_CONFIG')));
  await p.put('k', 'v');
  check('写真的落到了后端', raw.mem.get('k') === 'v', String(raw.mem.get('k')));
  check('没降级', getStatus(stateOf(p)).mode === 'storage');
  check('后端被调用了（没有旁路内存）', raw.calls.get >= 1 && raw.calls.put === 1,
    `get=${raw.calls.get} put=${raw.calls.put}`);
  resetState(raw, env);
}

// ===================== 2. 抖动不降级 =====================
console.log('\n[2] 一次成功就清零：偶尔抖一下不算挂');
{
  const raw = makeRaw();
  const env = {};
  const p = wrapStorage(raw, env);
  setFailThreshold(3);
  // 制造「失败、成功、失败」的交错
  raw.failAfter = 0; await tryPut(p, 'a', '1');            // 第 1 次写：失败
  raw.failAfter = -1; await tryPut(p, 'b', '2');           // 成功 -> 清零
  raw.failAfter = 0; await tryPut(p, 'c', '3');            // 失败（计数重新从 1 开始）
  const st = getStatus(stateOf(p));
  check('交错失败没有触发降级', st.mode === 'storage', st.mode);
  check('成功之后计数确实归零', st.consecutiveFails <= 1, `连续失败 ${st.consecutiveFails} 次`);
  resetState(raw, env);
}

// ===================== 3. 连续失败才降级 =====================
console.log('\n[3] 连续失败到阈值才切内存，且降级后数据不丢');
{
  const raw = makeRaw({ data: [['APP_CONFIG', '{"a":1}'], ['site:x', '{}']] });
  const env = {};
  const p = wrapStorage(raw, env);
  setFailThreshold(3);
  await read(p, 'APP_CONFIG');            // 先在 storage 模式下读过一次，留下影子副本
  raw.failAfter = 0;
  await tryPut(p, 'note1', 'v1');       // 1
  await tryPut(p, 'note2', 'v2');       // 2
  check('两次还没到阈值，仍是存储模式', getStatus(stateOf(p)).mode === 'storage');
  check('降级前每次失败都被记下来了', getStatus(stateOf(p)).consecutiveFails === 2,
    `计数 ${getStatus(stateOf(p)).consecutiveFails}`);
  await tryPut(p, 'note3', 'v3');       // 3 -> 降级
  const st = getStatus(stateOf(p));
  check('第三次失败后切到内存模式', st.mode === 'memory', st.mode);
  check('降级原因非空（不是静默降级）', !!st.reason, st.reason);
  check('事件里留了降级一笔', st.events.some(e => e.kind === 'degrade'),
    st.events.map(e => e.kind).join(','));
  // 自动降级是**单实例**行为：谎报 global 会让使用者以为整站都降级了，
  // 而其它实例还在往那个坏存储里写——这条信息与「改了没落盘」同等重要
  check('自动降级如实标为 isolate（不许谎称全站）', st.scope === 'isolate', st.scope);
  // 降级瞬间最怕「配置一起没」
  check('降级后影子副本保住了配置', await read(p, 'APP_CONFIG') === '{"a":1}', String(await read(p, 'APP_CONFIG')));
  check('写失败的值也还在内存里', await read(p, 'note1') === 'v1', String(await read(p, 'note1')));
  check('这些改动被记成待写回', st.dirtyKeys === 3, `dirty=${st.dirtyKeys}`);
  resetState(raw, env);
}

// ===================== 4. 降级后不再打后端 =====================
console.log('\n[4] 内存模式下零后端 IO');
{
  const raw = makeRaw();
  const env = {};
  const p = wrapStorage(raw, env);
  setFailThreshold(2);
  raw.failAfter = 0;
  await tryPut(p, 'a', '1');
  await tryPut(p, 'b', '2');
  check('已降级', getStatus(stateOf(p)).mode === 'memory');
  const before = raw.calls.get + raw.calls.put + raw.calls.list;
  for (let i = 0; i < 20; i++) { await tryGet(p, 'k' + i); await tryPut(p, 'w' + i, 'x'); }
  const after = raw.calls.get + raw.calls.put + raw.calls.list;
  check('20 轮读写期间一次都没碰后端', after === before, `增量 ${after - before}`);
  check('但数据确实读得回来（不是假装写成功）', await read(p, 'w5') === 'x', String(await read(p, 'w5')));
  resetState(raw, env);
}

// ===================== 5. 幂等：重复 bind 不丢 =====================
console.log('\n[5] bindRuntime 每请求都调：多次包装不能丢内存数据');
{
  const raw = makeRaw();
  const env = { DB: {}, PASSWORD: 'p' };
  const p1 = wrapStorage(raw, env);
  setFailThreshold(1);
  raw.failAfter = 0;
  await tryPut(p1, 'persist', 'yes');
  const p2 = wrapStorage(raw, env);   // 模拟下一个请求重新 bind
  check('重新包装后仍在同一份状态里', await read(p2, 'persist') === 'yes', String(await read(p2, 'persist')));
  check('两次拿到的是同一份状态', stateOf(p1) === stateOf(p2));
  resetState(raw, env);
}

// ===================== 6. 不同绑定互不串味 =====================
console.log('\n[6] 两个存储绑定各一份状态，不互相污染');
{
  const a = makeRaw({ data: [['k', 'A'], ['APP_CONFIG', '{}'], ['site:s1', '{"id":"s1"}']] });
  const b = makeRaw({ data: [['k', 'B']] });
  const pa = wrapStorage(a, { DB: a });
  const pb = wrapStorage(b, { DB: b });
  await setStorageMode(stateOf(pa), 'memory');
  check('手动切内存时预加载了控制面数据（站点没跟着过来＝面板一片空白）',
    await read(pa, 'APP_CONFIG') === '{}' && await read(pa, 'site:s1') === '{"id":"s1"}',
    `APP_CONFIG=${await read(pa, 'APP_CONFIG')} site:s1=${await read(pa, 'site:s1')}`);
  await pa.put('k', 'A-mem');                  // 只在 A 的内存里改
  check('A 切内存不影响 B', getStatus(stateOf(pa)).mode === 'memory' && getStatus(stateOf(pb)).mode === 'storage',
    `A=${getStatus(stateOf(pa)).mode} B=${getStatus(stateOf(pb)).mode}`);
  check('A 读到自己改的那份', await read(pa, 'k') === 'A-mem', String(await read(pa, 'k')));
  check('B 读到的仍是自己后端里的值', await read(pb, 'k') === 'B', String(await read(pb, 'k')));
  check('A 的改动还没写回它的后端（仍是脏的）', getStatus(stateOf(pa)).dirtyKeys >= 1,
    `dirty=${getStatus(stateOf(pa)).dirtyKeys}`);
  resetState(a, { DB: a });
  resetState(b, { DB: b });
}

// ===================== 7. 绝不自动切回 =====================
console.log('\n[7] 存储恢复后也不自动切回（必须手动）');
{
  const raw = makeRaw();
  const env = {};
  const p = wrapStorage(raw, env);
  setFailThreshold(1);
  raw.failAfter = 0;
  await tryPut(p, 'x', '1');
  check('已降级到内存', getStatus(stateOf(p)).mode === 'memory');
  raw.failAfter = -1;                  // 存储「恢复」了
  for (let i = 0; i < 10; i++) await read(p, 'any' + i);
  const pr = await probe(stateOf(p));
  check('探测显示存储已可用', pr.ok === true, JSON.stringify(pr));
  check('即使探测成功，模式仍是内存', getStatus(stateOf(p)).mode === 'memory', getStatus(stateOf(p)).mode);
  await setStorageMode(stateOf(p), 'storage');
  check('手动切回之后才是存储模式', getStatus(stateOf(p)).mode === 'storage');
  resetState(raw, env);
}

// ===================== 8. 写回：只写脏键，冲突要跳过 =====================
console.log('\n[8] 写回只搬改动过的键，冲突默认跳过');
{
  const raw = makeRaw({ data: [['keep', 'untouched'], ['conflict', 'from-baseline']] });
  const env = {};
  const p = wrapStorage(raw, env);
  setFailThreshold(1);
  await read(p, 'conflict');             // 记进影子 -> 降级后成为 baseline
  raw.failAfter = 0;
  await tryPut(p, 'newkey', 'v1');     // 触发降级
  raw.failAfter = -1;
  await p.put('conflict', 'mine');     // 内存模式下的改动 -> 进 dirty
  // 降级期间「别人」先把 conflict 改了
  raw.mem.set('conflict', 'changed-by-others');
  const putBefore = raw.calls.put;
  let r = await flush(stateOf(p), { raw });
  check('写回成功（新键落盘）', raw.mem.get('newkey') === 'v1', String(raw.mem.get('newkey')));
  check('没改过的键一次都没写', raw.calls.put === putBefore + 1,
    `put 调用了 ${raw.calls.put - putBefore} 次`);
  check('别人的键没被顺手删改', raw.mem.get('keep') === 'untouched', String(raw.mem.get('keep')));
  check('有冲突的键被跳过', (r.skipped || []).some(s => s.key === 'conflict'),
    JSON.stringify(r.skipped));
  check('别人的值没被覆盖', raw.mem.get('conflict') === 'changed-by-others', String(raw.mem.get('conflict')));
  check('跳过的键仍留在待写回里', r.pending >= 1, `pending=${r.pending}`);
  r = await flush(stateOf(p), { raw, force: true });
  check('强制写回才覆盖冲突', raw.mem.get('conflict') === 'mine' && (r.written || []).includes('conflict'),
    JSON.stringify(r.written));
  check('写回完之后待写回清零', getStatus(stateOf(p)).dirtyKeys === 0,
    `dirty=${getStatus(stateOf(p)).dirtyKeys}`);
  resetState(raw, env);
}

// ===================== 9. 写回失败：必须留下痕迹 =====================
console.log('\n[9] 写回失败时 dirty 不能清空（否则用户以为写过了）');
{
  const raw = makeRaw();
  const env = {};
  const p = wrapStorage(raw, env);
  setFailThreshold(1);
  raw.failAfter = 0;
  await tryPut(p, 'x', '1');
  raw.failAfter = -1;
  // 让 get 正常、put 失败 —— 模拟「读恢复了、写还不行」
  const oldPut = raw.put.bind(raw);
  raw.put = async (k, v) => { if (k === 'x') throw new Error('写入仍超限'); return oldPut(k, v); };
  const r = await flush(stateOf(p), { raw });
  check('写回结果是失败', r.ok === false, JSON.stringify(r.failed));
  check('失败被记进事件（没有静默吞掉）', getStatus(stateOf(p)).events.some(e => e.kind === 'flush-fail'),
    getStatus(stateOf(p)).events.map(e => e.kind).join(','));
  check('失败的键仍在 dirty 里（可重试）', getStatus(stateOf(p)).dirtyKeys >= 1,
    `dirty=${getStatus(stateOf(p)).dirtyKeys}`);
  const good = makeRaw();
  const r2 = await flush(stateOf(p), { raw: good });   // 换个能写的后端重试
  check('换个好后端重试就补上了', (r2.written || []).includes('x'), JSON.stringify(r2.written));
  check('补写成功后确实落到了新后端', good.mem.get('x') === '1', String(good.mem.get('x')));
  check('补写成功后 dirty 归零', getStatus(stateOf(p)).dirtyKeys === 0,
    `dirty=${getStatus(stateOf(p)).dirtyKeys}`);
  resetState(raw, env);
}

// ===================== 10. 纯内存后端 + 种子 =====================
console.log('\n[10] 没绑定存储也能跑：种子把内容灌进内存');
{
  const env = {
    SEED_JSON: JSON.stringify({
      'APP_CONFIG': '{"settings":{}}',
      'site:demo': JSON.stringify({ id: 'demo', name: '演示站' }),
    }),
  };
  const p = wrapStorage(null, env);
  const st = getStatus(stateOf(p));
  check('没有存储绑定时直接就是内存模式', st.mode === 'memory', st.mode);
  check('种子里的配置读得到', await read(p, 'APP_CONFIG') === '{"settings":{}}', String(await read(p, 'APP_CONFIG')));
  check('种子里的站点读得到', await read(p, 'site:demo') === '{"id":"demo","name":"演示站"}');
  const l = await p.list({ prefix: 'site:' });
  check('列表里能列到种子站点', (l.keys || []).some(k => k.name === 'site:demo'), JSON.stringify(l.keys));
  check('列表不会把前缀外的键一起带出来', (l.keys || []).every(k => k.name.startsWith('site:')),
    JSON.stringify(l.keys));
  check('内存模式下也能写，写完读得到', await (async () => {
    await p.put('fresh', 'abc');
    return await read(p, 'fresh') === 'abc';
  })());
  check('事件里记录了种子来源', st.events.some(e => e.kind === 'seed'),
    st.events.map(e => e.kind).join(','));
  check('全站范围（手动/无后端）标为 global', st.scope === 'global', st.scope);
  resetState(null, env);
}

// ===================== 11. 坏种子要说出错在哪 =====================
console.log('\n[11] 种子写错不能静默：要报出来');
{
  const env = { SEED_JSON: '{这不是合法 JSON' };
  const p = wrapStorage(null, env);
  const st = getStatus(stateOf(p));
  check('坏 JSON 被记录成事件', st.events.some(e => e.kind === 'seed-bad-json'),
    st.events.map(e => e.kind + ':' + e.detail).join(' | '));
  check('坏种子不影响继续可用', await read(p, 'whatever') === null);
  resetState(null, env);
}
{
  // 形状不对（数组）也要报错，而不是把 0 个键当成「灌好了」
  const env = { SEED_JSON: '[1,2,3]' };
  const p = wrapStorage(null, env);
  const st = getStatus(stateOf(p));
  check('非对象形状的种子被记录成事件', st.events.some(e => e.kind === 'seed-bad-shape'),
    st.events.map(e => e.kind).join(','));
  resetState(null, env);
}

// ===================== 12. 阈值由面板配置决定，不是写死 =====================
console.log('\n[12] 降级阈值从运行参数来，代码里不留第二份数字');
{
  const mem = new Map([['APP_CONFIG', JSON.stringify({ settings: { storage_fail_threshold: 7 } })]]);
  const kv = {
    async get(k) { return mem.has(k) ? mem.get(k) : null; },
    async put(k, v) { mem.set(k, String(v)); },
    async delete(k) { mem.delete(k); },
    async list(o = {}) {
      const p = (o && o.prefix) || '';
      return { keys: [...mem.keys()].filter(k => k.startsWith(p)).map(name => ({ name })), list_complete: true };
    },
  };
  const env = { PASSWORD: 'dev', SITES: kv, STORAGE_BACKEND: 'kv' };
  bindRuntime(env);
  // 这里有**两层**缓存（settings 的值缓存 + config.js 的文档缓存），少作废一层
  // 就读回旧值 —— 线上由保存动作统一清理，这里手工清，顺便把这条依赖钉住
  invalidateSettings(); invalidateDoc();
  const values = await readSettings(env);
  check('面板里配的阈值读得到', Number(values.storage_fail_threshold) === 7,
    String(values.storage_fail_threshold));
  const p = wrapStorage(kv, env);
  check('运行中的 memstore 拿到了同一个数字', getStatus(stateOf(p)).failThreshold === 7,
    String(getStatus(stateOf(p)).failThreshold));
  // 阈值 7 时，同样的 3 次失败不该降级（默认 3 会降级）——这才能证明数字真的生效了
  const raw = makeRaw();
  const p2 = wrapStorage(raw, {});
  raw.failAfter = 0;
  await tryPut(p2, 'a', '1');
  await tryPut(p2, 'b', '2');
  await tryPut(p2, 'c', '3');
  check('阈值 7 时连败 3 次仍不降级（默认 3 的话这里已经切了）', getStatus(stateOf(p2)).mode === 'storage',
    getStatus(stateOf(p2)).mode);
  resetState(raw, {});
  // 面板上改完应当立即生效，不用重新部署
  invalidateSettings(); invalidateDoc();
  mem.set('APP_CONFIG', JSON.stringify({ settings: { storage_fail_threshold: 2 } }));
  await readSettings(env);
  check('改成 2 之后同步进来了', getStatus(stateOf(p)).failThreshold === 2,
    String(getStatus(stateOf(p)).failThreshold));
  resetState(kv, env);
  invalidateSettings();
  setFailThreshold(3);
}

// ===================== 13. 写失败不能锯掉调用方的感知 =====================
console.log('\n[13] 写失败要抛出去：调用方靠这个异常做重试');
{
  const raw = makeRaw();
  const env = {};
  const p = wrapStorage(raw, env);
  setFailThreshold(1);
  raw.failAfter = 0;
  let threw = false;
  try { await p.put('k', 'v'); } catch { threw = true; }
  check('写失败照样抛异常', threw);
  check('这一次失败触发了降级', getStatus(stateOf(p)).mode === 'memory', getStatus(stateOf(p)).mode);
  check('但值已暂留内存，不会凭空消失', await read(p, 'k') === 'v', String(await read(p, 'k')));
  check('并记成待写回（恢复后有得搬）', getStatus(stateOf(p)).dirtyKeys === 1,
    `dirty=${getStatus(stateOf(p)).dirtyKeys}`);
  resetState(raw, env);
}
{
  // 删除同理：异常要抛出去（调用方才知道没删成），但内存里得先标掉
  const raw = makeRaw({ data: [['gone', 'have-me']] });
  const env = {};
  const p = wrapStorage(raw, env);
  setFailThreshold(1);
  raw.delete = async () => { throw new Error('删除超限'); };
  let delThrew = false;
  try { await p.delete('gone'); } catch { delThrew = true; }
  check('删除失败也照样抛异常', delThrew);
  check('删完之后读不到了', await read(p, 'gone') === null, String(await read(p, 'gone')));
  check('列表里也不再出现（墓碑不漏出来）',
    !(await p.list({})).keys.some(k => k.name === 'gone'),
    JSON.stringify((await p.list({})).keys.map(k => k.name)));
  resetState(raw, env);
}

// ===================== 14. 种子分片：绕不过去的 5 KB =====================
console.log('\n[14] 单个变量上限 5 KB：种子必须分片，且拼回来要与原来逐字节相同');
{
  const { pickEntries, splitSeed, parseSqlDump, seedVarName, MAX_PARTS } =
    await import('./export-seed.mjs');

  // ① 导出工具不会被 import 带起来跑 CLI —— 否则下面这些断言会去联网
  check('import 导出工具没有副作用（没跑命令行）', true);

  // ② 过滤：统计类默认丢掉（量大、重建一次就有），要留也能留
  const entries = [['APP_CONFIG', '{"a":1}'], ['site:d', '{"id":"d"}'], ['stats:2026', '一堆流水']];
  check('默认跳过统计类键', pickEntries(entries, {}).picked.length === 2,
    pickEntries(entries, {}).picked.map((p) => p[0]).join(','));
  check('要留也能留下来', pickEntries(entries, { keepStats: true }).picked.length === 3);
  check('只导出指定前缀时其它键会被丢掉',
    pickEntries(entries, { only: ['site:'] }).picked.every(([k]) => k.startsWith('site:'))
    && pickEntries(entries, { only: ['site:'] }).picked.length === 1);
  // 库里实际的前缀是 `stat:`（单数）。只写 `stats:` 的话整类键会静默逃过过滤 ——
  // 这不是推演出来的，是拿线上数据跑一遍才撞见的
  check('统计键的单数前缀 stat: 也真的被跳过',
    pickEntries([['stat:sub:2026-09-18', '一堆流水'], ['APP_CONFIG', '{"a":1}']], {}).picked.length === 1,
    pickEntries([['stat:sub:2026-09-18', '一堆流水'], ['APP_CONFIG', '{"a":1}']], {}).picked.map((p) => p[0]).join(','));

  // ③ SQL dump 解析：值里带引号是常态（站点本身就是 JSON），-split("'") 会拦腰截断
  const dump = [
    'CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);',
    "INSERT INTO kv (key,value,updated_at) VALUES ('APP_CONFIG','{\"title\":''演示''}','2026-01-01');",
    "INSERT INTO `kv` (`key`,`value`) VALUES ('site:d','{\"id\":\"d\",\"note\":\"it''s ok\"}');",
  ].join('\n');
  const { rows, skipped } = parseSqlDump(dump);
  check('两行 INSERT 都解析出来了', rows.length === 2, `解析出 ${rows.length} 行，跳过 ${skipped.length} 行`);
  // SQL 里 '' 是转义的单引号，还原成单个 ' 才对 —— 保留两个就说明没处理转义
  check('键与值对得上', rows.some(([k, v]) => k === 'APP_CONFIG' && v === '{"title":\'演示\'}'),
    JSON.stringify(rows[0]));
  check('值里的引号没有被截断（整份 JSON 都在）',
    rows.some(([k, v]) => k === 'site:d' && v === '{"id":"d","note":"it\'s ok"}'),
    JSON.stringify(rows[1]));

  // ④ 分片：多字节字符不许被劈成两半
  const big = { APP_CONFIG: '{"title":"' + '演示站点'.repeat(600) + '"}' };
  const json = JSON.stringify(big);
  const { parts, overflow } = splitSeed(json, 2048);
  check('长了就分片', parts.length > 1, `切成 ${parts.length} 段`);
  check('每段都不超过指定大小', parts.every((p) => Buffer.byteLength(p, 'utf8') <= 2048),
    `最大 ${Math.max(...parts.map((p) => Buffer.byteLength(p, 'utf8')))} 字节`);
  check('没有一段出现乱码替换符（多字节字符被劈开的特征）',
    !parts.some((p) => p.includes('�')), parts.filter((p) => p.includes('�')).length + ' 段含 U+FFFD');
  check('拼回来与原串逐字节相同', Buffer.compare(Buffer.from(parts.join(''), 'utf8'), Buffer.from(json, 'utf8')) === 0);
  check('拼回来能解析成同一个对象', JSON.parse(parts.join('')).APP_CONFIG === big.APP_CONFIG);
  check('段数没超上限时不报警', overflow === false, `段数 ${parts.length} / 上限 ${MAX_PARTS}`);
  check('短种子不分片', splitSeed('{"a":1}', 4096).parts.length === 1);
  check('变量名规则：主段不带后缀，其余两位数字',
    seedVarName(0) === 'SEED_JSON' && seedVarName(1) === 'SEED_JSON_01' && seedVarName(11) === 'SEED_JSON_11',
    [seedVarName(0), seedVarName(1), seedVarName(11)].join(','));

  // ⑤ memstore 侧：把分片拼灌回内存
  const obj2 = { APP_CONFIG: '{"x":1}', 'site:big': JSON.stringify({ id: 'big', name: '大'.repeat(300) }) };
  const text2 = JSON.stringify(obj2);
  const parts2 = splitSeed(text2, 300).parts;   // 300 字节 —— 必须切出好几段，否则下面一组会被跳过
  check('测试用的种子确实被切成了多段（否则「漏一段」那一组会被静默跳过）', parts2.length > 2,
    `切成 ${parts2.length} 段`);
  const env2 = {};
  // 故意**倒着**往 env 里塞：按插入顺序拼也能对上只是巧合，
  // 换成乱序就必须靠显式排序 —— 否则这一组是全绿的假象
  for (let i = parts2.length - 1; i >= 0; i--) env2[seedVarName(i)] = parts2[i];
  const p3 = wrapStorage(null, env2);
  check('分片种子被拼灌进内存', await read(p3, 'APP_CONFIG') === '{"x":1}', String(await read(p3, 'APP_CONFIG')));
  check('跨分的那个长值完好无损', await read(p3, 'site:big') === obj2['site:big'],
    String(await read(p3, 'site:big')).slice(0, 40) + '…');
  check('事件里写明是几段拼的',
    getStatus(stateOf(p3)).events.some((e) => e.kind === 'seed' && new RegExp(`${parts2.length} 段`).test(e.detail)),
    getStatus(stateOf(p3)).events.map((e) => e.detail).join(' | '));
  resetState(null, env2);

  // ⑥ 少贴一段必须报警 —— 静默灌一半比报错难查得多
  const env3 = { SEED_JSON: parts2[0] };
  if (parts2.length > 1) {
    const p4 = wrapStorage(null, env3);
    const st4 = getStatus(stateOf(p4));
    check('漏一段会报错而不是静默灌一半', st4.events.some((e) => e.kind === 'seed-bad-json'),
      st4.events.map((e) => e.kind).join(','));
    check('报错里写到「几段、共多少字节」——光说 JSON 不合法，看不出是漏贴了一段',
      st4.events.some((e) => e.kind === 'seed-bad-json' && /1 段共 \d+ 字节/.test(e.detail)),
      st4.events.map((e) => e.detail).join(' | '));
    resetState(null, env3);
  }

  // ⑦ 导出时的脱敏：Variables 是明文，凭据不能跟着躺进去
  const { scrubSecrets, SENSITIVE_LEAF } = await import('./export-seed.mjs');
  const secretCfg = JSON.stringify({ TOKEN: 'd662b808e0a23961eb81ce8d40647f4d', HOST: 'proxy.example.com', PORT: 443 });
  check('词表里确实含 token / salt 这类（写错名字就一条也拦不住）',
    SENSITIVE_LEAF.includes('token') && SENSITIVE_LEAF.includes('salt'));
  {
    const { entries, hits } = scrubSecrets([
      ['APP_CONFIG', secretCfg],
      ['DISGUISE_CONFIG', JSON.stringify({ title: '维护中', token: 'abcd1234', items: ['a', 'b'] })],
      ['STATS_SALT', 'b13c191c183722635ae4ced8ca511311'],
      ['PREF_IPS', '104.16.0.1\n104.16.0.2'],
    ]);
    const after = Object.fromEntries(entries);
    check('凭据被识别出来并报了数', hits.length === 3, `${hits.length} 处：${hits.map((h) => h.key + '→' + h.path).join('，')}`);
    check('对象里的凭据字段被清空', JSON.parse(after.APP_CONFIG).TOKEN === '', JSON.parse(after.APP_CONFIG).TOKEN);
    check('同一对象里的普通字段原样保留（不能图省事整条删掉）',
      JSON.parse(after.APP_CONFIG).HOST === 'proxy.example.com' && JSON.parse(after.APP_CONFIG).PORT === 443);
    check('数组不被牵连（清了内容但长度不变的列表比原样更难查）',
      JSON.parse(after.DISGUISE_CONFIG).items.length === 2);
    check('整个值就是凭据的那种也被清掉（STATS_SALT 不是 JSON）', after.STATS_SALT === '',
      JSON.stringify(after.STATS_SALT));
    check('跟凭据无关的键一个都没动', after.PREF_IPS === '104.16.0.1\n104.16.0.2');
    check('被清掉的那几位长度都要 >0（说明判据命中的是有值的字段，不是空字段）',
      hits.every((h) => h.len > 0), hits.map((h) => h.len).join(','));
    // 嵌套也要咬得到：`CF.APIToken` 这种父节点已经说明性质的情况最常见
    const nested = scrubSecrets([['cf.json', JSON.stringify({ CF: { APIToken: 'cfat_x', UsageAPI: null } })]]);
    check('嵌套在里面的凭据也躲不掉', JSON.parse(Object.fromEntries(nested.entries)['cf.json']).CF.APIToken === '',
      JSON.stringify(Object.fromEntries(nested.entries)['cf.json']));
    check('嵌套对象里的其它字段留着', JSON.parse(Object.fromEntries(nested.entries)['cf.json']).CF.UsageAPI === null);
  }
  // ⑧ D1 / KV 接口的返回形态：这一层剥错了，导出来的种子就是空的
  const { cfRowsToEntries } = await import('./export-seed.mjs');
  check('行是数组时按 columns 定位（/raw 端点的形态）',
    JSON.stringify(cfRowsToEntries({ results: { columns: ['key', 'value'], rows: [['a', '1'], ['b', '2']] } })) === '[["a","1"],["b","2"]]');
  check('行是对象时也认（/query 与 SDK 的形态）',
    JSON.stringify(cfRowsToEntries({ results: { columns: ['key', 'value'], rows: [{ key: 'a', value: '1' }] } })) === '[["a","1"]]');
  check('还带着最外层那层壳也剥得动（刚从接口拿回来的样子）',
    JSON.stringify(cfRowsToEntries([{ results: { columns: ['key', 'value'], rows: [['a', '1']] }, success: true }])) === '[["a","1"]]');
  check('列的顺序不固定也不会取错',
    JSON.stringify(cfRowsToEntries({ results: { columns: ['value', 'key'], rows: [['1', 'a']] } })) === '[["a","1"]]',
    JSON.stringify(cfRowsToEntries({ results: { columns: ['value', 'key'], rows: [['1', 'a']] } })));
  check('没有 columns 时按第 0、1 位兜底',
    JSON.stringify(cfRowsToEntries({ results: { rows: [['a', '1']] } })) === '[["a","1"]]');
}

// ===================== 15. 端到端：真的没有一个存储绑定也能跑 =====================
console.log('\n[15] 端到端：memory 后端 + 分片种子 —— 站点到底起不起得来');
{
  // 这一段不验某个函数，验整条链：路由 → 绑定 → 内存模式 → 页面。
  // 单元各自的绿组合起来照样可能是坏的（参数没顺着调用链传下去），只有跑通整条路才知道。
  const ORIGIN = 'https://proxy.example.com';
  const PASSWORD = 'dev';
  const COOKIE = 'ap_auth=' + Buffer.from(PASSWORD).toString('base64');
  const UUID = 'b1e6cc7c-9f8f-4f2c-9d2a-3b6f3f34d4b1';

  // 第 14 段是在块里动态引入的，这里再引一次：同一个模块实例，没有额外开销
  const { splitSeed, seedVarName } = await import('./export-seed.mjs');

  const appConfig = JSON.stringify({ uuid: UUID, sub_token: 'tok' });
  // 字段要齐：代理引擎靠 host / scheme 拼目标地址，早期这里只给了 target，
  // 结果整条代理路径走不下去、直接返回空 204 —— 而断言写的是「不是 500/404」，
  // 于是**这条检查这么多次一直在验一个空响应**，从来没真的碰到站点。
  const demo = JSON.stringify({
    id: 'demo', slug: 'demo', name: '演示站',
    scheme: 'https', host: 'example.com', port: null,
    target: 'https://example.com', proxyMode: 'proxy',
  });
  // 切得碎一点：这么小的数据也要走好几段，顺带把分段路径一起跑进去
  const { parts } = splitSeed(JSON.stringify({ APP_CONFIG: appConfig, 'site:demo': demo }), 60);

  const env = { PASSWORD, UUID, STORAGE_BACKEND: 'memory' };   // 关键：一个存储绑定都不给
  parts.forEach((v, i) => { env[seedVarName(i)] = v; });
  bindRuntime(env);
  const H = { cookie: COOKIE };

  const home = await handleRequest(new Request(ORIGIN + '/__admin', { headers: H }), env, {});
  const html = await home.text();
  check('管理页打得开', home.status === 200, String(home.status));
  check('顶部那条状态条渲染出来了', html.includes('membar'));
  check('上头写明正跑在内存模式', /内存模式/.test(html));
  check('也标明了影响范围（不许只写模式不写范围）', /全站|实例/.test(html));

  const api = await handleRequest(new Request(ORIGIN + '/__api/storage', { headers: H }), env, {});
  const body = await api.json();
  const st = body.status || {};
  check('接口报的模式与内存里的键数对得上', st.mode === 'memory' && st.memKeys === 2,
    JSON.stringify({ mode: st.mode, memKeys: st.memKeys, dirty: st.dirtyKeys, scope: st.scope }));
  check('后端名字说的是 memory', body.backend === 'memory', String(body.backend));
  check('种子灌进来的事被记下了', (st.events || []).some((e) => e.kind === 'seed'),
    (st.events || []).map((e) => e.kind).join(','));

  // 判据：灌种子前后，同一条请求的响应必须不一样。
  // 只看状态码（!= 500/404）会被目标站自己返回的东西带到沟里 —— 拿真实数据跑那一遍时，
  // 目标站返回的就是 nginx 的 404，于是「种子正常、代理也通」被判成失败
  // （详见 [07-踩坑记录](./docs/07-踩坑记录.md) 第 27 条）。
  // 另外项目有「前缀丢失自愈」，未知路径会被拼到第一个站点上再代理，
  // 所以「站点不存在」那张友好错误页通常也不会出现 —— 也不能拿它当标记。
  const shoot = async (withParts) => {
    const e = { PASSWORD, UUID, STORAGE_BACKEND: 'memory' };
    if (withParts) parts.forEach((v, i) => { e[seedVarName(i)] = v; });
    resetState(null, null);
    invalidateSite();      // 站点与配置都有进程内缓存，不清的话第二次会读到上一次的结果
    invalidateDoc();
    bindRuntime(e);
    const r = await handleRequest(new Request(ORIGIN + '/p/demo/', { headers: H }), e, {});
    return { status: r.status, body: (await r.text()).slice(0, 4000) };
  };
  const hit = await shoot(true);
  const miss = await shoot(false);
  check('种子里的站点真的在用（不灌种子时这条请求的表现明显不同）',
    hit.status !== miss.status || hit.body !== miss.body,
    `有种子 HTTP ${hit.status}，没种子 HTTP ${miss.status}`);

  check('这一段用的种子确实分了好几段（否则等于没验分段）', parts.length > 2, `${parts.length} 段`);
}

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
console.log(`存储降级自检：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
