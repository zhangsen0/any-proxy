#!/usr/bin/env node
/**
 * CF 用量驾驶舱自检：数据聚合 → 缓存 → 降级 → 页面渲染 → 注入脚本沙盒。
 *
 * 数据源是真实 Cloudflare GraphQL / REST —— 测试里全部用 mock 拦截，绝不真出网：
 *   - GraphQL 按 query 内容分流到四个数据集（daily / status / paths / worker）；
 *   - REST 分流到 /accounts 与 /zones/{id}；
 *   - 其余请求一律当反代上游（HTML）。
 *
 * 为什么从 worker 入口打：面板接口 /__api/cf-analytics 挂在 admin 路由上，
 * 直接调 cfAnalytics() 会绕过「登录 + 路由」这一层。
 *
 * 用法：node tools/check-cf-panel.mjs
 */
import worker from '../worker.js';
import { bindRuntime } from '../src/runtime.js';
import { adminPage } from '../src/admin.js';
import { renderCfPane, CF_JS } from '../src/cf-panel.js';
import { cfAnalytics, clearCfCache, CF_DEFAULT_SCRIPT } from '../src/cf-analytics.js';
import { flatCatalog, TAB_LABELS } from '../src/api-catalog.js';

const ORIGIN = 'https://proxy.example.com';
const PASSWORD = 'dev';
const COOKIE = 'ap_auth=' + Buffer.from(PASSWORD).toString('base64');
const ZONE = 'z1zone123456789';
const ACCOUNT = 'a1acct123456789';

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
const env = {
  PASSWORD, SITES: kv, PROXY_HOST: 'proxy.example.com',
  CF_API_TOKEN: 'test-token', CF_ZONE_ID: ZONE,
};
bindRuntime(env);

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  -> ' + extra : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? '  -> ' + extra : ''}`); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

// ===================== CF API mock =====================

const DAILY_ROWS = [
  { dimensions: { date: '2026-09-16' }, sum: { requests: 100, bytes: 100000, cachedRequests: 40, cachedBytes: 30000 }, uniq: { uniques: 10 } },
  { dimensions: { date: '2026-09-17' }, sum: { requests: 200, bytes: 200000, cachedRequests: 80, cachedBytes: 60000 }, uniq: { uniques: 20 } },
];
const STATUS_ROWS = [
  { count: 150, dimensions: { edgeResponseStatus: 200 }, sum: { edgeResponseBytes: 90000 } },
  { count: 30, dimensions: { edgeResponseStatus: 499 }, sum: { edgeResponseBytes: 5000 } },
  { count: 20, dimensions: { edgeResponseStatus: 404 }, sum: { edgeResponseBytes: 5000 } },
];
const PATH_ROWS = [
  { count: 120, dimensions: { clientRequestPath: '/p/uhdnow/Videos/123/stream' }, sum: { edgeResponseBytes: 80000 } },
  { count: 30, dimensions: { clientRequestPath: '/p/uhdnow/System/Info/Public' }, sum: { edgeResponseBytes: 5000 } },
];
const WORKER_ROWS = [
  { dimensions: { date: '2026-09-16', scriptName: 'any-proxy' }, sum: { requests: 500, errors: 1, subrequests: 100 } },
  { dimensions: { date: '2026-09-17', scriptName: 'any-proxy' }, sum: { requests: 700, errors: 2, subrequests: 150 } },
  { dimensions: { date: '2026-09-17', scriptName: 'other-script' }, sum: { requests: 999, errors: 0, subrequests: 1 } },
];

let graphqlCalls = 0;
let restCalls = 0;
let failPaths = false;       // 测试「单源失败降级」的开关
let emptyAccounts = false;   // 测试「账户不可推导」的开关

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json' },
});

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === 'https://api.cloudflare.com/client/v4/graphql') {
    graphqlCalls++;
    const q = (JSON.parse(init.body) || {}).query || '';
    if (failPaths && q.includes('clientRequestPath')) return json({ data: null, errors: [{ message: 'boom: paths' }] });
    if (q.includes('httpRequests1dGroups')) return json({ data: { viewer: { zones: [{ httpRequests1dGroups: DAILY_ROWS }] } } });
    if (q.includes('edgeResponseStatus')) return json({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: STATUS_ROWS }] } } });
    if (q.includes('clientRequestPath')) return json({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: PATH_ROWS }] } } });
    if (q.includes('workersInvocationsAdaptive')) return json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: WORKER_ROWS }] } } });
    return json({ data: { viewer: { zones: [{}] } } });
  }
  if (u === 'https://api.cloudflare.com/client/v4/accounts') {
    restCalls++;
    return json({ result: emptyAccounts ? [] : [{ id: ACCOUNT, name: '测试账户' }], success: true });
  }
  if (u.startsWith('https://api.cloudflare.com/client/v4/zones/')) {
    restCalls++;
    return json({ result: { id: ZONE, name: 'proxy.example.com' }, success: true });
  }
  // 其余请求当反代上游
  return new Response('<!DOCTYPE html><html><body>up</body></html>', {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
  });
};

// ===================== 请求脚手架 =====================

async function visit(path, init = {}) {
  const pending = [];
  const ctx = { waitUntil: (p) => { pending.push(p); } };
  const headers = { ...(init.headers || {}) };
  const res = await worker.fetch(new Request(ORIGIN + path, { method: init.method || 'GET', headers, body: init.body }), env, ctx);
  const text = await res.text();
  await Promise.all(pending.map(p => Promise.resolve(p).catch(() => {})));
  return { status: res.status, text: async () => text };
}
async function apiGet(path, headers = {}) {
  const res = await visit(path, { headers });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: null, text }; }
}

// ===================== 1. 接口与聚合 =====================
section('1. /__api/cf-analytics 聚合（mock CF）');
{
  const r = await apiGet('/__api/cf-analytics', { Cookie: COOKIE });
  ok('接口 200', r.status === 200 && r.data && r.data.ok === true, `status=${r.status}`);
  const d = r.data;
  ok('enabled=true（凭据齐全）', d.enabled === true);
  ok('zone 信息带出（REST /zones）', !!d.zone && d.zone.name === 'proxy.example.com', d.zone ? d.zone.name : '(null)');
  ok('account 自动推导（REST /accounts，无需 CF_ACCOUNT_ID）', !!d.account && d.account.id === ACCOUNT, d.account ? d.account.id : '(null)');
  ok('daily 升序且字段齐', d.daily.length === 2 && d.daily[0].date === '2026-09-16' && d.daily[1].requests === 200,
    JSON.stringify(d.daily));
  ok('status 含 499（播放器放弃信号）', (d.status || []).some(x => x.code === 499 && x.requests === 30),
    JSON.stringify(d.status));
  ok('paths 按带宽降序', d.paths.length === 2 && d.paths[0].path.includes('/stream') && d.paths[0].bytes >= d.paths[1].bytes,
    (d.paths || []).map(p => p.path + ':' + p.bytes).join(' | '));
  ok('worker 只统计本脚本（账户其它脚本不掺）', !!d.worker && d.worker.totals.requests === 1200 && d.worker.accountHasOthers === true,
    d.worker ? `requests=${d.worker.totals.requests} hasOthers=${d.worker.accountHasOthers}` : '(null)');
  ok('errors 为空', Array.isArray(d.errors) && d.errors.length === 0, JSON.stringify(d.errors));
  ok('一轮完整数据 = 4 次 GraphQL + 2 次 REST', graphqlCalls === 4 && restCalls === 2,
    `graphql=${graphqlCalls} rest=${restCalls}`);
  ok('未登录被拦（返回 401/403/404 而非数据）', (await apiGet('/__api/cf-analytics')).status !== 200,
    `status=${(await apiGet('/__api/cf-analytics')).status}`);
}

// ===================== 2. 缓存：5 分钟内不再打 CF =====================
section('2. 服务端缓存（GraphQL 配额保护）');
{
  const beforeG = graphqlCalls;
  const beforeR = restCalls;
  await apiGet('/__api/cf-analytics', { Cookie: COOKIE });
  await apiGet('/__api/cf-analytics', { Cookie: COOKIE });
  ok('连续请求不再重复打 CF', graphqlCalls === beforeG && restCalls === beforeR,
    `graphql ${beforeG} -> ${graphqlCalls}，rest ${beforeR} -> ${restCalls}`);
}

// ===================== 3. 降级 =====================
section('3. 降级（单源失败不拖垮整页 / 未配置给引导）');
{
  // 3a. paths 源失败：paths=null、errors 记录、其余源照常
  clearCfCache();
  failPaths = true;
  const d1 = (await apiGet('/__api/cf-analytics', { Cookie: COOKIE })).data;
  ok('paths 源失败 → paths=null 且其余源照常', d1.paths === null && d1.daily && d1.daily.length === 2,
    d1.paths === null ? 'paths=null' : 'paths 未降级');
  ok('失败原因进了 errors', (d1.errors || []).some(e => e.source === 'paths' && /boom/.test(e.message)),
    JSON.stringify(d1.errors));
  failPaths = false;

  // 3b. 账户不可推导：worker 与 account 一起降级，daily/status 不受影响
  clearCfCache();
  emptyAccounts = true;
  const d2 = (await apiGet('/__api/cf-analytics', { Cookie: COOKIE })).data;
  ok('账户取不到 → account/worker 为 null', d2.account === null && d2.worker === null,
    `account=${JSON.stringify(d2.account)} worker=${JSON.stringify(d2.worker)}`);
  ok('降级原因可读（提示配 CF_ACCOUNT_ID 或给读权限）', (d2.errors || []).some(e => e.source === 'worker'),
    JSON.stringify(d2.errors));
  ok('其余源不受影响', !!d2.daily && !!d2.status, `daily=${!!d2.daily} status=${!!d2.status}`);
  emptyAccounts = false;

  // 3c. 未配置凭据：enabled=false + 引导，且不打任何 CF 请求
  clearCfCache();
  const bareEnv = { PASSWORD, SITES: kv, PROXY_HOST: 'proxy.example.com' };
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('未配置时不应该有任何出网调用'); };
  const r3 = await cfAnalytics(bareEnv);
  globalThis.fetch = savedFetch;
  ok('无凭据 → enabled=false 且不打 CF', r3.enabled === false && r3.daily === null && r3.errors.length === 0,
    JSON.stringify(r3));
}

// ===================== 4. 页面渲染 =====================
section('4. 管理页挂载（tab / 卡片 / 未登录隐藏 / 脚本注入）');
{
  const page = await (await adminPage(true, ORIGIN, env)).text();
  ok('tab 按钮出现', page.includes('data-tab="edge"') && page.includes('>CF 用量<'));
  ok('驾驶舱卡片挂在 edge 选项卡', /data-pane="edge"/.test(page) && page.includes('id="cfCard"'));
  for (const id of ['cfKpis', 'cfChart', 'cfAxis', 'cfStatus', 'cfPaths', 'cfSrc', 'cfMetric', 'cfRefresh', 'cfAlert', 'cfUpdated']) {
    ok('容器 ' + id + ' 已渲染', page.includes(`id="${id}"`));
  }
  ok('懒加载钩子已接线（切到 edge 才取数）', page.includes('__cfEnsure') && page.includes("name === 'edge'"));
  ok('未登录时不渲染', !(await (await adminPage(false, ORIGIN, env)).text()).includes('cfCard'));

  const plain = renderCfPane();
  ok('渲染阶段不发网络请求', !/fetch\(/.test(plain));
  ok('目录工具（原始 JSON）出现在卡片里', plain.includes('data-uid="cf-analytics"'));

  let parsed = true; let err = '';
  try { new Function(CF_JS); } catch (e) { parsed = false; err = String(e && e.message); }
  ok('注入脚本语法可解析', parsed, err);
  ok('脚本自带 __name 兜底', CF_JS.startsWith('var __name='));
  for (const marker of ['/__api/cf-analytics', '__cfEnsure', 'cfKpis', 'CF_STATUS_KLASS']) {
    ok('脚本覆盖 ' + marker, CF_JS.includes(marker));
  }
}

// ===================== 5. 注入脚本沙盒真跑 =====================
section('5. 脚本在裸沙盒里能跑（闭包不引用模块 import）');
{
  const today = new Date().toISOString().slice(0, 10);
  const payload = {
    ok: true, enabled: true,
    updated_at: '2026-09-17T12:00:00.000Z',
    zone: { id: ZONE, name: 'proxy.example.com' },
    account: { id: ACCOUNT, name: '测试账户' },
    daily: [
      { date: today, requests: 100, bytes: 1024 * 1024, cachedRequests: 40, cachedBytes: 512 * 1024, uniques: 9 },
    ],
    status: [
      { code: 200, requests: 150, bytes: 90000 },
      { code: 499, requests: 30, bytes: 5000 },
    ],
    paths: [
      { path: '/p/uhdnow/Videos/123/stream', requests: 120, bytes: 80000 },
    ],
    worker: { script: 'any-proxy', totals: { requests: 1200, errors: 3 }, daily: [], accountHasOthers: false },
    errors: [],
  };
  const freshEl = () => ({
    innerHTML: '', textContent: '', hidden: false, className: '', style: {},
    disabled: false, value: '', onclick: null,
    addEventListener() {}, appendChild() {}, contains: () => true,
    getAttribute: () => null, setAttribute() {},
    classList: { toggle() {}, add() {}, remove() {} },
    querySelectorAll: () => [], querySelector: () => null,
  });
  const nodes = new Map();
  const nodeOf = sel => { const k = String(sel).replace(/^#/, ''); if (!nodes.has(k)) nodes.set(k, freshEl()); return nodes.get(k); };
  const sandboxDoc = {
    getElementById: nodeOf,
    querySelector: nodeOf,
    querySelectorAll: () => [],
    body: { contains: () => true },
    addEventListener() {},
  };
  const fakeApi = (path) => Promise.resolve({ data: payload });

  let sandboxErr = '';
  try {
    new Function('document', 'window', 'api', CF_JS)(sandboxDoc, {}, fakeApi);
  } catch (e) { sandboxErr = String((e && e.message) || e); }
  ok('脚本在裸沙盒里能跑起来', !sandboxErr, sandboxErr);
  await new Promise(r => setTimeout(r, 30));
  ok('KPI 渲染出数字（今日请求 / Worker）', /\d/.test(nodeOf('#cfKpis').innerHTML), nodeOf('#cfKpis').innerHTML.slice(0, 80) || '(空)');
  ok('KPI 渲染出 Worker 与缓存命中维度', nodeOf('#cfKpis').innerHTML.includes('Worker') && nodeOf('#cfKpis').innerHTML.includes('缓存命中率'),
    nodeOf('#cfKpis').innerHTML.slice(0, 160) || '(空)');
  ok('状态码分布渲染（含 499 标注）', /cf-code/.test(nodeOf('#cfStatus').innerHTML) && nodeOf('#cfStatus').innerHTML.includes('客户端放弃'),
    nodeOf('#cfStatus').innerHTML.slice(0, 120) || '(空)');
  ok('Top 路径渲染', /cf-path/.test(nodeOf('#cfPaths').innerHTML) && nodeOf('#cfPaths').innerHTML.includes('/p/uhdnow'),
    nodeOf('#cfPaths').innerHTML.slice(0, 120) || '(空)');
  ok('数据源状态渲染出 zone 与账户', nodeOf('#cfSrc').innerHTML.includes('proxy.example.com') && nodeOf('#cfSrc').innerHTML.includes('测试账户'),
    nodeOf('#cfSrc').innerHTML.slice(0, 160) || '(空)');
  ok('渲染异常没有被显示成「读取失败」', !/读取失败/.test(nodeOf('#cfAlert').textContent || ''),
    nodeOf('#cfAlert').textContent || '(无报错)');
  ok('更新时间戳被写上', /更新于/.test(nodeOf('#cfUpdated').textContent || ''), nodeOf('#cfUpdated').textContent || '(空)');

  // 未配置空态：enabled=false 也要渲染出引导而非报错
  nodes.clear();
  const emptyPayload = { ok: true, enabled: false, zone: null, account: null, daily: null, status: null, paths: null, worker: null, errors: [] };
  let emptyErr = '';
  try {
    new Function('document', 'window', 'api', CF_JS)(sandboxDoc, {}, () => Promise.resolve({ data: emptyPayload }));
  } catch (e) { emptyErr = String((e && e.message) || e); }
  await new Promise(r => setTimeout(r, 30));
  ok('未配置空态能渲染（引导文案）', !emptyErr && /未配置/.test(nodeOf('#cfAlert').textContent || ''), emptyErr || nodeOf('#cfAlert').textContent || '(空)');
}

// ===================== 6. 目录与真源 =====================
section('6. 目录登记（api-catalog 单一真源）');
{
  const item = flatCatalog().find(i => i.id === 'cf-analytics');
  ok('目录里登记了 cf-analytics 接口', !!item && item.path === '/__api/cf-analytics', item ? item.path : '(无)');
  ok('tab 中文名只有一处定义', TAB_LABELS.edge === 'CF 用量', TAB_LABELS.edge);
  ok('默认脚本名来自模块常量（可被 WORKER_SCRIPT 覆盖）', CF_DEFAULT_SCRIPT === 'any-proxy', CF_DEFAULT_SCRIPT);
  ok('面板卡片里的工具与目录同源', renderCfPane().includes('data-uid="cf-analytics"'));
}

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
console.log(`CF 用量驾驶舱：${pass + fail} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：' + failures.join('、')); process.exit(1); }
