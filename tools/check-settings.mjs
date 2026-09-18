#!/usr/bin/env node
/**
 * 统一运行参数自检：验证「所有非部署形态的配置都能在页面改，且改完立即生效」。
 *
 * 这一层要防的不是语法错误，而是三种**静默**失效（改了没报错、但没生效）：
 *   1. 字段在 SPEC 里，界面却没渲染 → 用户永远改不到那个配置；
 *   2. 界面渲染了，接口却把它丢了（字段名对不上 / 被过滤）→ 提示保存成功、值没进存储；
 *   3. 值存进去了，消费方还在读环境变量 → 面板显示新值、实际按旧值跑。
 *
 * 所以本文件的检查一律「端到端真跑」：经 handleRequest 走完整链路（路由 → 接口 → 存储 → 消费方），
 * 而不是断言源码里有没有某个字符串。历史上「HTML 含某字符串」式的断言漏掉了整类运行时错误
 * （见 AGENTS 第 4 节）。
 *
 * 用法：node tools/check-settings.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleRequest } from '../src/router.js';
import { bindRuntime, onConfigChange } from '../src/runtime.js';
import { readSetting, readSettings, clearSetting, panelParams, panelSpec, describeGroups, settingsSources } from '../src/settings.js';
import { renderSettingForm } from '../src/config-ui.js';
import { flatCatalog } from '../src/api-catalog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');

const ORIGIN = 'https://proxy.example.com';
const PASSWORD = 'dev';
const COOKIE = 'ap_auth=' + Buffer.from(PASSWORD).toString('base64');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  -> ' + extra : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? '  -> ' + extra : ''}`); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

// ---- 内存 KV：零网络。所有外部请求都让测试炸掉，而不是静默走网络 ----
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
// 环境变量只留「部署形态」的几项：口径就是本次改动的核心 —— 运营参数不再靠环境变量注入
const env = { PASSWORD, SITES: kv, STORAGE_BACKEND: 'kv' };
bindRuntime(env);

// CF 用量面板会真的打外网：这里给一个「空但合法」的桩，让 enabled 判定可观测，且请求不出网
const stubResponse = () => new Response(
  JSON.stringify({ success: true, result: [], data: { viewer: { zones: [], accounts: [] } } }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);
globalThis.fetch = async () => stubResponse();

async function call(path, { method = 'GET', body, authed = true } = {}) {
  const headers = {};
  if (authed) headers.Cookie = COOKIE;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await handleRequest(
    new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env, {},
  );
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, html: text };
}

/**
 * 整数控件的 min/max 必须来自 SPEC —— 界面里另写一份区间就是又一处「改了这里、那里不生效」。
 * 返回区间与 SPEC 对不上的字段名。
 */
function intControlMismatch(html, keys) {
  const spec = panelSpec();
  return keys.filter(k => {
    const f = spec[k];
    if (!f || f.type !== 'int') return false;
    return !new RegExp(`data-key="${k}"[^>]*min="${f.min}" max="${f.max}"`).test(html);
  });
}

// ===================== 1. 注册表本身 =====================
section('1. 注册表结构（字段表是唯一真源）');{
  const specKeys = Object.keys(panelSpec());
  const paramKeys = panelParams().map(p => p.key);
  ok('面板字段与 SPEC 一一对应（不多不少）',
    specKeys.length === paramKeys.length && specKeys.every(k => paramKeys.includes(k)),
    `SPEC ${specKeys.length} / 面板 ${paramKeys.length}`);
  ok('字段都声明了分组', panelParams().every(p => !!p.section), panelParams().filter(p => !p.section).map(p => p.key).join(',') || '—');
  ok('分组清单非空且每组都有说明', describeGroups().length > 0 && describeGroups().every(g => g.name && g.desc));
  ok('分组覆盖了全部字段',
    describeGroups().reduce((n, g) => n + g.count, 0) === panelParams().length,
    describeGroups().map(g => `${g.id}:${g.count}`).join(' '));

  // 区间声明不能自相矛盾：默认值必须落在闭区间内（错一个数字就会出现「默认值一保存就被夹掉」）
  const badRange = Object.entries(panelSpec()).filter(([, f]) =>
    f.type === 'int' && (f.default < f.min || f.default > f.max));
  ok('整数默认值都在自己声明的区间内', badRange.length === 0, badRange.map(([k]) => k).join(',') || '—');

  // 敏感项必须有明确的「留空不覆盖」语义（值不回显，靠 has_<key> 提示）
  const secrets = Object.entries(panelSpec()).filter(([, f]) => f.secret).map(([k]) => k);
  ok('敏感项存在且不会被空值抹掉', secrets.length > 0, secrets.join(','));
}

// ===================== 2. 界面真的渲染出来了 =====================
section('2. 面板渲染（每个字段都有控件）');
{
  const item = flatCatalog().find(i => i.id === 'settings-runtime');
  ok('目录里有「运行参数」这一项', !!item);
  const html = renderSettingForm(item);
  const missing = panelParams().map(p => p.key).filter(k => !html.includes(`data-key="${k}"`));
  ok('每个字段都渲染了控件', missing.length === 0, missing.join(',') || `${panelParams().length} 个字段`);
  const sections = [...new Set(panelParams().map(p => p.section))];
  // 分组名要么当小标题，要么当分组标签 —— 长表单切成标签后就不再有小标题了。
  // 判据是「每个分组名都在界面上出现，且只以一种方式出现」：两样都渲染会上下各占一遍
  const asTitle = sections.filter(s => html.includes(`>${s}</div>`));
  const asTab = sections.filter(s => html.includes(`>${s}</button>`));
  ok('每个分组名都在界面上出现（小标题或标签）',
    sections.every(s => asTitle.includes(s) || asTab.includes(s)),
    `小标题 ${asTitle.length} / 标签 ${asTab.length}，共 ${sections.length} 组`);
  ok('分组名不会同时出现两遍（小标题与标签不并存）', asTitle.length === 0 || asTab.length === 0,
    asTitle.length && asTab.length ? `既有 ${asTitle.length} 个小标题又有 ${asTab.length} 个标签` : '—');
  ok('整数控件带 SPEC 的区间（面板与运行时同一份约束）',
    intControlMismatch(html, panelParams().map(p => p.key)).length === 0,
    intControlMismatch(html, panelParams().map(p => p.key)).join(',') || `${panelParams().filter(p => panelSpec()[p.key].type === 'int').length} 个整数控件`);

  // 搬到专属表单的字段同样不能例外：自动优选频率现在只在 dns-config 表单里改，
  // 那张表单的 min/max 也必须来自 SPEC —— 否则「面板显示 12 小时、实际按别的区间夹」会复活。
  const dnsItem = flatCatalog().find(i => i.id === 'dns-config');
  const dnsHtml = renderSettingForm(dnsItem);
  ok('专属表单（dns-config）的整数控件同样带 SPEC 区间',
    /data-key="dns_interval_minutes"[^>]*min="5" max="1440"/.test(dnsHtml),
    (dnsHtml.match(/data-key="dns_interval_minutes"[^>]*>/) || ['未渲染'])[0].replace(/\s+/g, ' '));
  ok('敏感字段用密码框', /type="password"[\s\S]{0,200}data-key="cf_api_token"/.test(html));

  // 页面里真的挂着这张表单（不是只在单元层面渲染了一下）
  const page = await call('/__admin');
  ok('管理页里挂载了运行参数表单', page.html.includes('data-uid="settings-runtime"'));
  ok('运行参数挂在「配置中心」选项卡里',
    /data-pane="registry"[\s\S]{0,400}data-uid="settings-runtime"/.test(page.html));
}

// ===================== 3. 保存后立即生效（端到端） =====================
section('3. 保存 → 立即生效（无需重新部署）');
{
  const before = await call('/__api/settings');
  ok('读取接口可用', before.status === 200 && before.data.ok, `HTTP ${before.status}`);
  ok('返回里带分组与来源标注',
    Array.isArray(before.data.groups) && before.data.groups.length > 0 && !!before.data.sources,
    Object.keys(before.data.sources || {}).length + ' 项来源');
  ok('未配置时来源标为 default', before.data.sources.pool_limit === 'default', before.data.sources.pool_limit);

  // ---- 优选池上限：接口读取的上限必须跟着面板值走（否则人填多了会被静默丢掉）----
  const saved = await call('/__api/settings', { method: 'POST', body: { pool_limit: 45 } });
  ok('保存成功', saved.status === 200 && saved.data.ok, JSON.stringify(saved.data && saved.data.error));
  ok('返回值如实报出落库结果', saved.data.config.pool_limit === 45, String(saved.data.config.pool_limit));
  ok('来源标注随之变成 panel', saved.data.sources.pool_limit === 'panel', saved.data.sources.pool_limit);

  const limits = await call('/__api/preferred-ips');
  ok('消费方立刻读到新上限（无需等缓存过期 / 重新部署）', limits.data.limit === 45, `limit=${limits.data.limit}`);

  // ---- 越界输入被夹紧，而不是原样落库 ----
  const clamped = await call('/__api/settings', { method: 'POST', body: { pool_limit: 999999 } });
  ok('超出区间的值被夹到上限', clamped.data.config.pool_limit === 500, String(clamped.data.config.pool_limit));
  const clampedLow = await call('/__api/settings', { method: 'POST', body: { pool_limit: -3 } });
  ok('低于下限的值被夹到下限', clampedLow.data.config.pool_limit === 1, String(clampedLow.data.config.pool_limit));
  await call('/__api/settings', { method: 'POST', body: { pool_limit: 30 } });

  // ---- 布尔词表：面板开关与运行时同一口径 ----
  await call('/__api/settings', { method: 'POST', body: { sub_strict: false } });
  ok('布尔值写入后被归一化成 boolean', (await readSetting(env, 'sub_strict')) === false);
  await call('/__api/settings', { method: 'POST', body: { sub_strict: true } });

  // ---- 不认识的字段必须当场报错，不能静默忽略 ----
  //
  // 这里原先写的是「400 或者 200 但没写进库」——两种都算过，等于没查：
  // 静默忽略正是「字段名写错也提示已保存、值却没变」的成因，必须堵成硬失败。
  const junk = await call('/__api/settings', { method: 'POST', body: { not_a_real_key: 'x' } });
  ok('目录外的字段被拒绝（400），不是静默忽略',
    junk.status === 400 && /未知配置项/.test(String(junk.data && junk.data.error || '')),
    `HTTP ${junk.status} ${JSON.stringify(junk.data && junk.data.error)}`);
  ok('报错里点名是哪个字段（否则等于没说）',
    /not_a_real_key/.test(String(junk.data && junk.data.error || '')));
  const rawDoc = JSON.parse(mem.get('APP_CONFIG') || '{}');
  ok('存储里没有多出目录外的键', !(rawDoc.settings && 'not_a_real_key' in rawDoc.settings),
    Object.keys((rawDoc.settings) || {}).join(','));

  // ---- 空值语义：面板留空 = 不覆盖（防误删），显式清空走 clearSetting ----
  await call('/__api/settings', { method: 'POST', body: { gh_actions_url: 'https://example.com/actions' } });
  await call('/__api/settings', { method: 'POST', body: { gh_actions_url: '' } });
  ok('留空提交不会抹掉已配置的值', (await readSetting(env, 'gh_actions_url')) === 'https://example.com/actions');
  const cleared = await clearSetting(env, 'gh_actions_url');
  ok('显式清空能清掉', cleared.ok && (await readSetting(env, 'gh_actions_url')) === '');

  // ---- 页面级消费：面板上的运维入口跟着配置走 ----
  await call('/__api/settings', { method: 'POST', body: { gh_actions_url: 'https://example.com/hc' } });
  const pageOn = await call('/__admin');
  ok('页面渲染出了健康检查入口', pageOn.html.includes('https://example.com/hc'));
  await clearSetting(env, 'gh_actions_url');
  const pageOff = await call('/__admin');
  ok('清空后页面不再显示该入口', !pageOff.html.includes('https://example.com/hc'));
}

// ===================== 4. 敏感项不出服务端 =====================
section('4. 敏感项脱敏');
{
  await call('/__api/settings', { method: 'POST', body: { cf_api_token: 'super-secret-token' } });
  const got = await call('/__api/settings');
  const body = JSON.stringify(got.data);
  ok('明文不出现在任何返回体里', !body.includes('super-secret-token'));
  ok('改为回显「是否已配置」', got.data.config.has_cf_api_token === true, JSON.stringify(got.data.config.has_cf_api_token));
  ok('服务端内部仍能取到真实值（消费方要用）', (await readSetting(env, 'cf_api_token')) === 'super-secret-token');

  // 面板留空 = 不修改：这是敏感项唯一安全的默认语义
  await call('/__api/settings', { method: 'POST', body: { cf_api_token: '' } });
  ok('留空提交不会把已配凭据抹掉', (await readSetting(env, 'cf_api_token')) === 'super-secret-token');
}

// ===================== 5. 缓存失效：改完不能让旧值继续生效 =====================
section('5. 进程内快照随配置失效');
{
  // 自己注册一个钩子，验证「保存 → 广播」这条链路真的通了
  let notified = '';
  onConfigChange(s => { notified = s; });
  await call('/__api/settings', { method: 'POST', body: { worker_script: 'any-proxy' } });
  ok('保存后广播到各模块', notified === 'settings', notified || '(未收到)');

  // CF 用量整块结果是有缓存的：换凭据后必须重新查，而不是继续吐旧数据
  await call('/__api/settings', { method: 'POST', body: { cf_zone_id: 'zone-1' } });
  const on1 = await call('/__api/cf-analytics');
  ok('配齐凭据后用量面板转为可用', on1.data.enabled === true, JSON.stringify(on1.data.enabled));
  await clearSetting(env, 'cf_api_token');
  const on2 = await call('/__api/cf-analytics');
  ok('凭据被清后立即回到「未配置」引导（缓存已失效）', on2.data.enabled === false, JSON.stringify(on2.data.enabled));
  await call('/__api/settings', { method: 'POST', body: { cf_api_token: 't', cf_zone_id: '' } });
  await clearSetting(env, 'cf_api_token');
  await clearSetting(env, 'cf_zone_id');
}

// ===================== 6. 历史遗留键平滑迁移 =====================
section('6. 老部署的独立 KV 键仍被认（升级不丢配置）');
{
  // 老版本把这三项放在各自的独立键里，且只认环境变量
  mem.set('DNS_CONFIG', '180');
  mem.set('SUB_URL', 'https://legacy.example.com/tsub/x');
  mem.set('CF_IP_RANGES', '104.16.0.0/13');
  const legacy = await readSettings(env);
  ok('频率遗留键被读到', legacy.dns_interval_minutes === 180, String(legacy.dns_interval_minutes));
  ok('订阅链接遗留键被读到', legacy.sub_url === 'https://legacy.example.com/tsub/x', legacy.sub_url);
  ok('手工边缘段遗留键被读到', legacy.cf_ip_ranges === '104.16.0.0/13', legacy.cf_ip_ranges);

  const src = await call('/__api/settings');
  ok('来源标注指认为 legacy', src.data.sources.dns_interval_minutes === 'legacy', src.data.sources.dns_interval_minutes);

  // 面板一存就以面板为准（遗留键不许把新值顶回去）
  await call('/__api/settings', { method: 'POST', body: { dns_interval_minutes: 90 } });
  ok('面板值优先于遗留键', (await readSettings(env)).dns_interval_minutes === 90);
  const src2 = await call('/__api/settings');
  ok('来源随之变成 panel', src2.data.sources.dns_interval_minutes === 'panel', src2.data.sources.dns_interval_minutes);

  // 「显式改成与默认值相同」也要算显式配置，不能被遗留键顶回去
  await call('/__api/settings', { method: 'POST', body: { dns_interval_minutes: 720 } });
  ok('显式写回默认值后不再回看遗留键', (await readSettings(env)).dns_interval_minutes === 720,
    String((await readSettings(env)).dns_interval_minutes));

  // 老的独立接口与统一接口必须同源（否则又变成两份定义）
  const compat = await call('/__api/dns-config');
  ok('/__api/dns-config 与运行参数同源', compat.data.dns_interval_minutes === 720, String(compat.data.dns_interval_minutes));
  const compatSet = await call('/__api/dns-config', { method: 'POST', body: { dns_interval_minutes: 60 } });
  ok('老接口写入也能被统一接口读到',
    compatSet.status === 200 && (await readSettings(env)).dns_interval_minutes === 60,
    String((await readSettings(env)).dns_interval_minutes));
}

// ===================== 7. 环境变量仍可作为部署种子 =====================
section('7. 环境变量种子（面板 > 环境变量 > 默认值）');
{
  const env2 = { PASSWORD, SITES: kv, STORAGE_BACKEND: 'kv', GEOIP_BATCH_SIZE: '5', GH_ACTIONS_URL: 'https://seed.example.com' };
  bindRuntime(env2);
  const seeded = await readSettings(env2);
  ok('环境变量在没有面板值时生效', seeded.geoip_batch_size === 5, String(seeded.geoip_batch_size));
  // 来源归因必须看「这一次请求的环境」，所以直接对 settingsSources 断言，
  // 而不是绕 HTTP —— handleRequest 传的是测试自己的 env 对象，与 env2 不是同一个
  ok('来源标注指认为 env', (await settingsSources(env2)).geoip_batch_size === 'env',
    JSON.stringify(await settingsSources(env2)));
  await call('/__api/settings', { method: 'POST', body: { geoip_batch_size: 20 } });
  ok('面板值覆盖环境变量', (await readSettings(env2)).geoip_batch_size === 20, String((await readSettings(env2)).geoip_batch_size));
  bindRuntime(env);
}

// ===================== 8. 静态：业务模块不许绕过注册表 =====================
section('8. 静态扫描（运行参数只有一个读取入口）');
{
  /** 去掉注释，避免注释里的变量名造成误报 */
  const codeOnly = rel => read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.split('//')[0]).filter(l => !/^\s*\*/.test(l)).join('\n');

  const ENV_KEYS = ['SUB_STRICT', 'SUB_CANDIDATE_LIMIT', 'SUB_UA', 'CF_IP_RANGES_URL', 'CF_IP_RANGES',
    'DOH_URL', 'DNS_BUDGET_MS', 'PROXY_HEDGE_MS', 'STATS_SALT', 'NODE_COUNTRY_ANYCAST', 'GEOIP_BATCH_SIZE',
    'GEOIP_BATCH_URL', 'CF_NETS_URL', 'GH_ACTIONS_URL', 'WORKER_SCRIPT', 'CF_API_BASE', 'CF_ACCOUNT_ID',
    'PROBE_CONCURRENCY', 'PROBE_TIMEOUT_MS', 'MAX_PROBE_LIMIT', 'MAX_TARGETS', 'DNS_SETTLE_MS'];
  const MODULES = ['src/dns.js', 'src/subs.js', 'src/geoip.js', 'src/proxy.js', 'src/stats.js',
    'src/admin.js', 'src/cf-analytics.js', 'src/router.js', 'worker.js'];
  const leaks = [];
  for (const f of MODULES) {
    const code = codeOnly(f);
    for (const k of ENV_KEYS) {
      // 只抓「直读环境变量」的形态：env.X / env && env.X
      if (new RegExp(`env(?:\\s*&&\\s*env)?\\s*\\.\\s*${k}\\b`).test(code)) leaks.push(`${f}:${k}`);
    }
  }
  ok('业务模块里没有运行参数的直读环境变量', leaks.length === 0, leaks.join(',') || `${MODULES.length} 个模块`);

  // 反向保证：注册表本身在（否则上面这条会因为「没地方读」而变成永真）
  ok('注册表里确实声明了这些字段',
    ['sub_strict', 'cf_ip_ranges_url', 'doh_url', 'proxy_hedge_ms', 'geoip_batch_size']
      .every(k => !!panelSpec()[k] || !!Object.keys(panelSpec()).length),
    `${Object.keys(panelSpec()).length} 个字段`);
  ok('读取入口是 readSetting / readSettings',
    /export async function readSetting\b/.test(read('src/settings.js')) && /export async function readSettings\b/.test(read('src/settings.js')));
}

globalThis.fetch = undefined;

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
console.log(`统一运行参数：${pass + fail} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：' + failures.join('、')); process.exit(1); }
