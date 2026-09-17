#!/usr/bin/env node
/**
 * 防护三件套自检：限流与防滥用 / 告警通知 / 站点临时访问链接。
 *
 * 只用 Node 内置模块，不联网、不需要 Cloudflare 账号：
 *   - 限流走真实路由（handleRequest + 内存 KV），验证「真的会挡、该放的会放」；
 *   - 告警把 fetch 换成假实现，只验证「该发 / 不该发 / 发什么」，不碰任何外部地址；
 *   - 临时链接验证令牌校验、有效期、次数上限与路由前缀的保留段保护。
 *
 * 用法：
 *   node tools/check-guard.mjs
 */
import { handleRequest } from '../src/router.js';
import { bindRuntime } from '../src/runtime.js';
import { btoa } from 'node:buffer';
import { API_CATALOG } from '../src/api-catalog.js';

import {
  readLimitConfig, saveLimitConfig, listBans, clearBans, resetBuckets, inWhitelist, parseList,
} from '../src/ratelimit.js';
import {
  readAlertConfig, saveAlertConfig, safeAlertConfig, notify, testAlert, recentAlerts, resetThrottle,
} from '../src/alert.js';
import {
  readShareConfig, saveShareConfig, createShare, listShares, revokeShare, enableShare,
  deleteShare, resolve, clearShares, linkPath,
} from '../src/share.js';
import { addSite, buildTarget } from '../src/sites.js';

const PASSWORD = process.env.PASSWORD || 'dev';
const ORIGIN = process.env.PROBE_ORIGIN || 'https://proxy.example.com';
const TEST_IP = '203.0.113.9';

// ---- 内存版 KV（与 check-themes.mjs / check-smoke.mjs 同一约定）----
const mem = new Map();
const kv = {
  async list(o = {}) {
    const p = (o && o.prefix) || '';
    return { keys: [...mem.keys()].filter(k => k.startsWith(p)).map(name => ({ name })), list_complete: true, cursor: '' };
  },
  async get(k) { return mem.has(k) ? mem.get(k) : null; },
  async put(k, v) { mem.set(k, v); },
  async delete(k) { mem.delete(k); },
};
const env = { PASSWORD, SITES: kv, PROXY_HOST: new URL(ORIGIN).hostname };
bindRuntime(env);

const authCookie = `ap_auth=${btoa(unescape(encodeURIComponent(PASSWORD)))}`;

async function call(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.authed) headers.Cookie = authCookie;
  if (opts.ip) headers['CF-Connecting-IP'] = opts.ip;
  if (opts.body) headers['Content-Type'] = 'application/json';
  try {
    const res = await handleRequest(
      new Request(ORIGIN + path, { method: opts.method || 'GET', headers, body: opts.body }),
      env,
      {}
    );
    return { status: res.status, text: await res.text(), headers: res.headers };
  } catch (e) {
    return { status: 0, text: 'THROW: ' + (e && e.message), headers: new Headers() };
  }
}

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? passed++ : failed++;
}
function section(t) { console.log(`\n--- ${t} ---`); }

console.log('\n=== 防护三件套自检 ===');

// ===================== 限流与防滥用 =====================
section('限流：默认关闭时不挡任何请求');
{
  const cfg = await readLimitConfig(env);
  check('默认关闭', cfg.enabled === false, `enabled=${cfg.enabled}`);
  let blocked = 0;
  for (let i = 0; i < 8; i++) {
    const r = await call('/__api/sites', { ip: TEST_IP });
    if (r.status === 429) blocked++;
  }
  check('关闭时连打 8 次不被挡', blocked === 0, `被挡 ${blocked} 次`);
}

section('限流：开启后超阈值即挡');
{
  resetBuckets();
  await saveLimitConfig(env, {
    enabled: true, window_seconds: 60, max_requests: 3, scope: 'ip',
    whitelist: '', exempt_paths: '', exempt_authed: false,
    ban_enabled: false, ban_threshold: 5, ban_seconds: 600,
  });
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const r = await call('/__api/sites', { ip: TEST_IP });
    codes.push(r.status);
  }
  check('前 3 次放行、后 2 次 429', codes.slice(0, 3).every(c => c !== 429) && codes[3] === 429 && codes[4] === 429, codes.join(','));
  const limited = await call('/__api/sites', { ip: TEST_IP });
  check('被挡时带 Retry-After', Number(limited.headers.get('Retry-After')) > 0, `Retry-After=${limited.headers.get('Retry-After')}`);
}

section('限流：放行名单 / 豁免路径 / 已登录豁免');
{
  resetBuckets();
  await saveLimitConfig(env, { whitelist: `${TEST_IP}\n198.51.100.0/24`, exempt_paths: '/__api/login' });
  let blocked = 0;
  for (let i = 0; i < 6; i++) {
    const r = await call('/__api/sites', { ip: TEST_IP });
    if (r.status === 429) blocked++;
  }
  check('白名单内的 IP 不计数', blocked === 0, `被挡 ${blocked} 次`);
  check('CIDR 解析正确', inWhitelist('198.51.100.7', parseList('198.51.100.0/24')) && !inWhitelist('198.51.101.7', parseList('198.51.100.0/24')));

  resetBuckets();
  const other = '203.0.113.77';
  let b2 = 0;
  for (let i = 0; i < 6; i++) {
    const r = await call('/__api/login', { ip: other, method: 'POST', body: JSON.stringify({ password: 'x' }) });
    if (r.status === 429) b2++;
  }
  check('豁免路径不计数', b2 === 0, `被挡 ${b2} 次`);

  resetBuckets();
  await saveLimitConfig(env, { exempt_authed: true });
  let b3 = 0;
  for (let i = 0; i < 6; i++) {
    const r = await call('/__api/sites', { ip: other, authed: true });
    if (r.status === 429) b3++;
  }
  check('已登录豁免生效', b3 === 0, `被挡 ${b3} 次`);
  await saveLimitConfig(env, { exempt_authed: false });
}

section('限流：屡犯封禁落盘、可查可解');
{
  resetBuckets();
  await clearBans();
  await saveLimitConfig(env, {
    enabled: true, window_seconds: 60, max_requests: 1, whitelist: '', exempt_paths: '',
    exempt_authed: false, ban_enabled: true, ban_threshold: 2, ban_seconds: 600,
  });
  for (let i = 0; i < 8; i++) await call('/__api/sites', { ip: '203.0.113.200' });
  const bans = await listBans();
  check('达到阈值后写入封禁', bans.some(b => b.ip === '203.0.113.200'), JSON.stringify(bans.map(b => b.ip)));
  const after = await call('/__api/sites', { ip: '203.0.113.200' });
  check('封禁期内直接 429', after.status === 429, `status=${after.status}`);
  const cleared = await clearBans();
  check('一键解封返回清除条数', cleared >= 1, `cleared=${cleared}`);
  // 封禁与计数是两件事：解封只清封禁，窗口内的计数仍要自己走完（否则等于解封即无限刷）
  resetBuckets();
  const ok2 = await call('/__api/sites', { ip: '203.0.113.200' });
  check('解封且计数归零后恢复放行', ok2.status !== 429, `status=${ok2.status}`);
  await saveLimitConfig(env, { enabled: false });
}

// ===================== 告警通知 =====================
section('告警：未配置时静默跳过，不抛错');
{
  resetThrottle();
  const r1 = await notify(env, 'login_fail', '测试');
  check('未启用 → 跳过且不抛异常', r1.sent === false && r1.skipped === true, r1.reason);
  check('跳过原因可读', /未启用/.test(r1.reason || ''), r1.reason);

  await saveAlertConfig(env, { enabled: true });
  const r2 = await notify(env, 'login_fail', '测试');
  check('启用但没配地址 → 跳过', r2.skipped && /Webhook/.test(r2.reason || ''), r2.reason);
}

section('告警：发送链路与消息体格式');
{
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body || '{}') });
    return { ok: true, status: 200, text: async () => 'ok' };
  };

  resetThrottle();
  await saveAlertConfig(env, { enabled: true, webhook_url: 'https://example.invalid/hook', webhook_type: 'generic', cooldown_minutes: 0 });
  const r1 = await notify(env, 'login_fail', '有人撞口令');
  check('generic 发送成功', r1.sent === true, JSON.stringify(r1));
  check('generic 消息体含标题与详情', /登录失败/.test(sent[0].body.title || '') && /撞口令/.test(sent[0].body.text || ''));

  resetThrottle();
  await saveAlertConfig(env, { webhook_type: 'wecom' });
  await notify(env, 'ratelimit_block', '被封禁');
  check('wecom 走 markdown.content', !!sent[1].body.markdown && !!sent[1].body.markdown.content, JSON.stringify(sent[1].body).slice(0, 80));

  resetThrottle();
  await saveAlertConfig(env, { webhook_type: 'dingtalk' });
  await notify(env, 'upstream_fail', '上游 502');
  check('dingtalk 带 markdown.title', !!sent[2].body.markdown && !!sent[2].body.markdown.title, JSON.stringify(sent[2].body).slice(0, 80));

  resetThrottle();
  await saveAlertConfig(env, { webhook_type: 'generic', cooldown_minutes: 30 });
  await notify(env, 'login_fail', '第一次');
  const r2 = await notify(env, 'login_fail', '第二次');
  check('冷却期内同一事件被跳过', r2.skipped && /冷却/.test(r2.reason || ''), r2.reason);

  resetThrottle();
  await saveAlertConfig(env, { cooldown_minutes: 0, events: 'login_fail' });
  const r3 = await notify(env, 'dns_fail', '优选失败');
  check('未订阅的事件被跳过', r3.skipped && /未订阅/.test(r3.reason || ''), r3.reason);

  resetThrottle();
  await saveAlertConfig(env, { events: '', max_per_hour: 2, cooldown_minutes: 0 });
  await notify(env, 'login_fail', '1');
  await notify(env, 'ratelimit_block', '2');
  const r4 = await notify(env, 'upstream_fail', '3');
  check('每小时上限生效', r4.skipped && /上限/.test(r4.reason || ''), r4.reason);

  resetThrottle();
  const t = await testAlert(env);
  check('测试告警走完整链路', t.sent === true, JSON.stringify(t));

  const rec = recentAlerts();
  check('发送记录可回溯', Array.isArray(rec) && rec.length > 0, `${rec.length} 条`);
  const safe = safeAlertConfig(await readAlertConfig(env));
  check('敏感项脱敏：不回传 webhook_url', safe.webhook_url === undefined && safe.has_webhook_url === true, JSON.stringify(safe).slice(0, 120));

  globalThis.fetch = realFetch;
}

section('告警：发送失败不影响调用方');
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('boom'); };
  resetThrottle();
  const r = await notify(env, 'login_fail', 'x');
  check('外部异常被收敛成 skipped', r.sent === false && r.skipped === true, r.reason);
  globalThis.fetch = realFetch;
  await saveAlertConfig(env, { enabled: false, events: '', max_per_hour: 20, cooldown_minutes: 30 });
}

// ===================== 站点临时访问链接 =====================
section('临时链接：路由开关与保留段保护');
{
  await clearShares();
  const cfg = await readShareConfig(env);
  check('默认关闭', cfg.enabled === false, `enabled=${cfg.enabled}`);
  const r = await call('/s/whatever/');
  check('关闭时不接管该路径', r.status !== 200 || /不存在|404|可用/.test(r.text), `status=${r.status}`);

  const bad = await saveShareConfig(env, { path_prefix: '/p' });
  check('前缀不能占用 /p', !!bad.error, bad.error || '（未拦截）');
  const bad2 = await saveShareConfig(env, { path_prefix: 's' });
  check('前缀必须以 / 开头', !!bad2.error, bad2.error || '（未拦截）');
}

section('临时链接：创建 / 生效 / 失效 / 停用');
{
  await clearShares();
  const site = await addSite('自检站点', 'guard-demo', buildTarget('example.com', ''));
  await saveShareConfig(env, { enabled: true, path_prefix: '/s', default_days: 2, max_days: 30, count_hits: true });
  check('站点创建成功', !!site, site && site.id);

  const created = await createShare(env, { site: site.id, days: 2, max_hits: 1, note: '给同事看一眼' });
  check('创建返回链接路径', !created.error && /^\/s\/[A-Za-z0-9_-]+\/$/.test(created.path || ''), created.path || created.error);
  check('路径生成与配置前缀一致', linkPath(await readShareConfig(env), created.share.token) === created.path);

  const bad = await createShare(env, { site: 'no-such-site', days: 1 });
  check('站点不存在时拒绝创建', !!bad.error, bad.error || '（未拦截）');

  const r1 = await resolve(env, created.share.token);
  check('首次访问放行并返回站点', r1.status === 'ok' && r1.site === site.id, JSON.stringify(r1).slice(0, 80));
  const r2 = await resolve(env, created.share.token);
  check('次数用尽后失效', r2.status === 'expired' && r2.share && r2.share.expired_by_hits, JSON.stringify(r2.status));

  const list = await listShares(env);
  check('列表含该条且标记失效', list.length === 1 && list[0].active === false, `${list.length} 条`);

  const rv = await revokeShare(created.share.token);
  check('可手动停用', rv.ok && rv.share.disabled === true);
  const en = await enableShare(created.share.token);
  check('可再启用', en.ok && en.share.disabled === false);

  const weird = await resolve(env, '../../etc/passwd');
  check('非法 token 不查存储', weird.status === 'missing' || weird.status === 'disabled', weird.status);

  // 带浏览器导航头才会拿到 HTML 提示页；接口类请求按项目口径静默 204（不把 HTML 当 JS 解析）
  const routed = await call(created.path, { headers: { Accept: 'text/html' } });
  check('失效链接走路由返回 404 提示页', routed.status === 404, `status=${routed.status}`);
  check('提示文案不泄漏 token', !/token|share:/i.test(routed.text), routed.text.slice(0, 60));
  const silent = await call(created.path);
  check('非导航请求静默 204', silent.status === 204, `status=${silent.status}`);

  await deleteShare(created.share.token);
  check('删除后列表为空', (await listShares(env)).length === 0);
  await saveShareConfig(env, { enabled: false, path_prefix: '/s' });
  await clearShares();
}

// ===================== 接口目录 =====================
section('接口目录：新增配置在面板里有入口');
{
  const ids = API_CATALOG.map(g => g.id);
  for (const need of ['ratelimit', 'alert', 'share']) {
    check(`目录含 ${need} 分组`, ids.includes(need), ids.join(','));
  }
  const paths = API_CATALOG.flatMap(g => g.items.map(i => i.path));
  for (const p of ['/__api/ratelimit', '/__api/alert', '/__api/shares', '/__api/share-config']) {
    check(`目录含 ${p}`, paths.includes(p));
  }
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log('❌ 存在失败项');
  process.exit(1);
}
console.log('✅ 全部通过');
