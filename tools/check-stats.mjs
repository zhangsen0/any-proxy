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
import { flush } from '../src/stats.js';
import { STATS_JS, renderStatsPane } from '../src/stats-ui.js';
import { CONFIG_JS } from '../src/config-ui.js';

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

// 上游一律用假源站，绝不真出网
globalThis.fetch = async () => new Response('<!DOCTYPE html><html><body>ok</body></html>', {
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': '120' },
});

/** 真实模拟一次请求：收集 waitUntil 的落盘任务并等它跑完，否则统计还在内存里没落盘 */
async function visit(path, init = {}) {
  const pending = [];
  const ctx = { waitUntil: (p) => { pending.push(p); } };
  const headers = { ...(init.headers || {}) };
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGIN + path, { method: init.method || 'GET', headers, body: init.body }), env, ctx);
  await Promise.all(pending.map(p => Promise.resolve(p).catch(() => {})));
  // 落盘可能还挂在下一轮 waitUntil（flush 内部再挂任务的情况），多等一拍
  await new Promise(r => setTimeout(r, 10));
  return res;
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
  await visit('/p/demo/', { headers: VISITOR });
  ok('首个请求由 waitUntil 自动落盘', !!mem.get('stat:p:demo:' + today),
    mem.has('stat:p:demo:' + today) ? 'stat:p:demo:' + today : '(未落盘)');

  await visit('/p/demo/', { headers: VISITOR });
  await visit('/robots.txt', { headers: VISITOR });                       // 噪声路径：不该计入任何通道
  await visit('/__api/stats', { headers: { Cookie: COOKIE, ...VISITOR } }); // 管理通道：record_admin 关闭时不计入
  // 落盘是按间隔（默认 15s）触发的，测试里手动催一次，把内存里剩余计数写下去
  await flush(env);

  const after = await apiGet('/__api/stats?days=7', { Cookie: COOKIE });
  const d = after.data || {};
  const scopes = (d.series || []).map(s => s.scope);
  const demo = (d.series || []).find(s => s.scope === 'p:demo');
  ok('反代站点请求被计入 p:<站点id>', !!demo && demo.hits === 2, demo ? `hits=${demo.hits}` : `scopes=${scopes.join(',')}`);
  ok('伪装噪声路径（robots.txt）不计入', !scopes.includes('robots.txt') && !scopes.some(s => /robots|\.txt/.test(s)), scopes.join(','));
  ok('record_admin 关闭时管理通道不计入', !scopes.includes('admin'), scopes.join(',') || '(空)');
  ok('总量与通道一致', d.totals && d.totals.hits === 2, `totals.hits=${d.totals && d.totals.hits}`);
  ok('当日桶出现在 daily 里', (d.daily || []).some(x => x.date === today && x.hits === 2),
    (d.daily || []).map(x => x.date + ':' + x.hits).join(' ') || '(空)');
  ok('记录了来访者（uv > 0，且不落原始 IP）', !!demo && demo.uv >= 1, demo ? `uv=${demo.uv}` : '');
  const rawKey = 'stat:p:demo:' + today;
  const raw = mem.get(rawKey);
  ok('落盘内容不含原始 IP', !!raw && !raw.includes('203.0.113.9'), raw ? raw.slice(0, 90) : '(无)');
}

// ===================== 2. record_admin 打开后管理通道计入 =====================
section('2. record_admin 语义（面板自己的访问单独控制）');
{
  await apiPost('/__api/stats-config', { record_admin: true });
  await visit('/__api/stats-config', { headers: { Cookie: COOKIE, ...VISITOR } });
  await flush(env);
  const d = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  const admin = (d.series || []).find(s => s.scope === 'admin');
  ok('打开后管理通道被计入', !!admin && admin.hits >= 1, admin ? `hits=${admin.hits}` : '未出现');
}

// ===================== 3. 关闭统计后停止记录 =====================
section('3. 关闭后不再记录（但已有数据保留）');
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

// ===================== 4. 汇总口径 =====================
section('4. 汇总口径（日期补齐 / 保留天数上限）');
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

  const clamped = (await apiGet('/__api/stats?days=9999', { Cookie: COOKIE })).data || {};
  ok('请求天数被保留天数上限夹住', clamped.days === clamped.retention_days, `days=${clamped.days} retention=${clamped.retention_days}`);
}

// ===================== 5. 清空 =====================
section('5. 清空数据（保留配置）');
{
  const r = await apiPost('/__api/stats/clear', {});
  ok('清空返回成功并报出删除条数', r.status === 200 && r.data && r.data.ok === true && r.data.removed >= 3,
    `removed=${r.data && r.data.removed}`);
  const d = (await apiGet('/__api/stats?days=7', { Cookie: COOKIE })).data || {};
  ok('清空后没有残留桶', (d.daily || []).length === 0 && (d.series || []).length === 0,
    `daily=${(d.daily || []).length} series=${(d.series || []).length}`);
  ok('清空只删数据，不动配置', !!d.retention_days, `retention=${d.retention_days}`);
}

// ===================== 6. 驾驶舱渲染与脚本 =====================
section('6. 驾驶舱页面与注入脚本');
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
}

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
console.log(`访问统计与驾驶舱：${pass + fail} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：' + failures.join('、')); process.exit(1); }
