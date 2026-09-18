#!/usr/bin/env node
/**
 * 优选链路自检：验证「浏览器优选从订阅拉候选」与「立即更新优选 IP 不会超时」两件事。
 * 只用 Node 内置模块，不需要 Cloudflare 账号。
 *
 * 用法：
 *   SUB_URL=https://your.domain/tsub/xxxx node tools/check-preferred.mjs
 *   CIDR_FILE=./cidrs.txt node tools/check-preferred.mjs   # 离线提供边缘 IP 段，跳过远端拉取
 *   SKIP_NETWORK=1 node tools/check-preferred.mjs          # 跳过所有需要联网的检查
 *
 * 环境变量：
 *   SUB_URL     订阅链接（也可在面板里填，这里仅为本地验证方便）
 *   CIDR_FILE   每行一个 CIDR 的文本文件，作为「边缘 IP 段」来源
 *   SKIP_NETWORK  非 0 时跳过联网检查（选是否可用由 CI 决定）
 */
import { readFileSync } from 'node:fs';
import { btoa } from 'node:buffer';
import { handleRequest } from '../src/router.js';
import { bindRuntime } from '../src/runtime.js';
import { filterUsableIps, autoUpdatePreferredDns } from '../src/dns.js';
import { SETTINGS_SPEC } from '../src/settings.js';

const PASSWORD = process.env.PASSWORD || 'dev';
const ORIGIN = process.env.PROBE_ORIGIN || 'https://proxy.example.com';
const SKIP_NETWORK = !!process.env.SKIP_NETWORK;

// ---- 内存版 KV ----
const mem = new Map();
if (process.env.CIDR_FILE) {
  mem.set('CF_IP_RANGES', readFileSync(process.env.CIDR_FILE, 'utf8').trim());
}
// 复现线上场景：优选池里混了一批非边缘网络的 IP（每个都会拖满单次超时）
if (process.env.SEED_POOL !== '0') {
  mem.set('PREF_IPS', [
    '104.17.144.135', '172.66.1.7', '64.186.254.109', '23.27.245.165',
    '104.168.152.245', '185.234.145.124', '151.241.88.6', '104.16.254.149',
  ].join('\n'));
}
const kv = {
  async list() { return { keys: [...mem.keys()].map(name => ({ name })), list_complete: true }; },
  async get(k) { return mem.has(k) ? mem.get(k) : null; },
  async put(k, v) { mem.set(k, v); },
  async delete(k) { mem.delete(k); },
};

const env = {
  PASSWORD,
  SITES: kv,
  PROXY_HOST: process.env.PROXY_HOST || new URL(ORIGIN).hostname,
  SUB_URL: process.env.SUB_URL || '',
};
bindRuntime(env);

const authCookie = `ap_auth=${btoa(unescape(encodeURIComponent(PASSWORD)))}`;
async function call(path, opts = {}) {
  const url = ORIGIN + path;
  const headers = { ...(opts.headers || {}) };
  if (opts.authed) headers.Cookie = authCookie;
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await handleRequest(
    new Request(url, { method: opts.method || 'GET', headers, body: opts.body }),
    env,
    {}
  );
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

let failed = 0;
function check(name, pass, detail) {
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) failed++;
}

console.log('\n=== Any-Proxy 优选链路自检 ===\n');

// 1) 订阅链接配置读写
const subUrl = process.env.SUB_URL || '';
if (subUrl) {
  const saved = await call('/__api/sub-config', { method: 'POST', authed: true, body: JSON.stringify({ sub_url: subUrl }) });
  check('保存订阅链接', saved.status === 200 && saved.data && saved.data.ok, 'HTTP ' + saved.status);
  const rejected = await call('/__api/sub-config', { method: 'POST', authed: true, body: JSON.stringify({ sub_url: '这不是链接' }) });
  check('非法订阅链接被拒绝', rejected.status === 400, 'HTTP ' + rejected.status);
} else {
  console.log('⏭  未设置 SUB_URL，跳过订阅相关检查（可在面板填写后验证）\n');
}

// 2) 候选拉取 + 地址归属过滤
if (subUrl && !SKIP_NETWORK) {
  const cands = await call('/__api/preferred-candidates');
  const ips = (cands.data && cands.data.ips) || [];
  const stats = (cands.data && cands.data.stats) || {};
  check('订阅候选拉取成功', ips.length > 0, `${ips.length} 个候选`);
  check('候选均为合法 IPv4', ips.every(ip => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)), '非法：' + ips.filter(ip => !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)).join(',') || '无');
  console.log(`   节点 ${stats.addresses || 0} 个｜过滤 ${stats.filtered || 0} 个｜备注：${cands.data.note || '无'}`);
  if (ips.length) console.log('   前 5 个候选：' + ips.slice(0, 5).join(' '));
}

// 3) 探测耗时：并发 + 预算必须远低于 Workers 30s 墙钟
if (!SKIP_NETWORK) {
  const pool = (mem.get('PREF_IPS') || '').split('\n').filter(Boolean);
  const host = env.PROXY_HOST;
  const serialStart = Date.now();
  let serialMs = 0;
  {
    // 串行基准：每个 IP 最多等 3s（修复前的实现）。
    // 带上登录态，保证对照组与新实现跑在完全相同的网络条件下，差别只在并发度。
    const probeHeaders = { Host: host, Cookie: authCookie };
    for (const ip of pool) {
      const t0 = Date.now();
      try {
        await fetch('http://' + ip + '/__api/config', { headers: probeHeaders, redirect: 'manual', signal: AbortSignal.timeout(3000) });
      } catch {}
    }
    serialMs = Date.now() - serialStart;
  }
  const concStart = Date.now();
  const usable = await filterUsableIps(pool, { host, budgetMs: 10000, deadlineMs: Date.now() + 15000 });
  const concMs = Date.now() - concStart;
  console.log(`\n   串行探测 ${pool.length} 个：${serialMs}ms`);
  console.log(`   并发+预算探测 ${pool.length} 个：${concMs}ms（可用 ${usable.length} 个）`);
  check('并发探测显著快于串行', concMs < serialMs, `提速 ${(serialMs / Math.max(concMs, 1)).toFixed(1)}x`);
  check('优选探测阶段留在预算内', concMs < 15000, concMs + 'ms < 15000ms');
}

// 4) 缺少 Cloudflare 凭据时必须快速给出可读错误，而不是拖到超时
{
  const started = Date.now();
  const run = await call('/__api/dns-run', { method: 'POST', authed: true });
  const cost = Date.now() - started;
  check('dns-run 缺少凭据时立即报错', run.status === 500 && !!run.data && !!run.data.error, `HTTP ${run.status}｜${(run.data && run.data.error) || '无错误详情'}`);
  check('dns-run 未陷入长时间等待', cost < 20000, cost + 'ms');
}

// 5) 定时任务（cron）拿不到请求 hostname：应能用「上次访问过的域名」兜底，而不是静默失效
{
  const saved = env.PROXY_HOST;
  delete env.PROXY_HOST;
  const withMemory = await autoUpdatePreferredDns(env, {});
  check(
    'cron 无 PROXY_HOST 时可用已记住的域名兜底',
    !String(withMemory.error || '').includes('无法确定优选目标域名'),
    (withMemory.error || '无错误').slice(0, 60)
  );
  mem.delete('SEEN_HOST');
  const noMemory = await autoUpdatePreferredDns(env, {});
  check(
    'cron 且无历史域名时给出明确错误（不猜域名）',
    String(noMemory.error || '').includes('无法确定优选目标域名'),
    (noMemory.error || '无错误').slice(0, 60)
  );
  env.PROXY_HOST = saved;
}

// 6) 浏览器自动优选「怎么跑」必须是运行参数，不是写死在面板脚本里的数字
//
// 以前脚本里写死 40 / 15 / 8 / 3500 / 9000：注册表里把「订阅候选上限」调到 100，
// 浏览器那边依旧只测 40 个 —— 面板上有开关、行为不变，是最难查的一类问题。
// 这里钉死两件事：①接口真的下发这些口径；②前端源码里不再留第二套数字。
{
  const EXPECT = {
    pick_scan_limit: 40, pick_keep: 15, pick_concurrency: 8,
    pick_timeout_ms: 3500, pick_candidate_timeout_ms: 9000,
  };
  for (const [key, want] of Object.entries(EXPECT)) {
    check(
      `注册表里有 ${key}，默认值沿用旧行为（${want}）`,
      !!SETTINGS_SPEC[key] && SETTINGS_SPEC[key].default === want,
      SETTINGS_SPEC[key] ? String(SETTINGS_SPEC[key].default) : '缺失'
    );
  }

  const cands = await call('/__api/preferred-candidates');
  const limits = (cands.data && cands.data.limits) || null;
  // 无论订阅拉没拉到都要回带：拉不到时前端还要走「当前池」兜底，那条路同样按这套数字跑
  check('候选接口回带浏览器测速口径', !!limits, JSON.stringify(limits || {}));
  if (limits) {
    check('口径四个键齐全且为正数',
      ['scan_limit', 'keep', 'concurrency', 'timeout_ms'].every(k => Number(limits[k]) > 0),
      JSON.stringify(limits));
  }
  const poolRes = await call('/__api/preferred-ips', { authed: true });
  check('优选池接口也回带口径（兜底路径要用）',
    !!(poolRes.data && poolRes.data.limits), JSON.stringify((poolRes.data || {}).limits || {}));

  // 「可自定义」的本体：改完立刻生效。只断言字段存在是不够的 —— 存在但不下发等于没改
  const saved = await call('/__api/settings', {
    method: 'POST', authed: true,
    body: JSON.stringify({ pick_scan_limit: 7, pick_keep: 3, pick_concurrency: 2, pick_timeout_ms: 1234 }),
  });
  check('保存浏览器测速口径', saved.status === 200 && !!(saved.data && saved.data.ok), 'HTTP ' + saved.status);
  const after = await call('/__api/preferred-candidates');
  const L2 = (after.data && after.data.limits) || {};
  check('改完立刻下发新值（不是写死的旧值）',
    L2.scan_limit === 7 && L2.keep === 3 && L2.concurrency === 2 && L2.timeout_ms === 1234,
    JSON.stringify(L2));

  const src = readFileSync(new URL('../src/admin.js', import.meta.url), 'utf8');
  const deadNums = [
    ['一次测几个写死 40', /slice\(0,\s*40\)/],
    ['保留条数写死 15', /slice\(0,\s*15\)/],
    ['并发写死 8', /CONC\s*=\s*8\b/],
    ['单次测速超时写死 3500', /timeout\(3500\)/],
    ['拉候选超时写死 9000', /timeout\(9000\)/],
  ];
  for (const [name, re] of deadNums) {
    check('前端不再写死：' + name, !re.test(src));
  }
  check('测速函数签名带超时参数（不自带数字）', /function measureIp\([^)]*timeoutMs/.test(src));
  check('测速调用真的把超时传进去', /measureIp\([^)]*limits\.timeout_ms/.test(src));
  // 候选接口的每个出口都要带口径：拉订阅失败那条路后面还会走「当前池」兜底，
  // 少了它前端就会因为拿不到参数直接停住 —— 这种「只在失败时才出问题」的分支最容易漏。
  const block = src.slice(
    src.indexOf("path === '/__api/preferred-candidates'"),
    src.indexOf("path === '/__api/pick-speed'")
  );
  // 窗口按「到本条语句的分号为止」取，不能按固定字符数 —— 固定窗口会越过 `);` 读到
  // 下一个 return 里的 limits，于是「失败分支没带」也被判成带了（牙齿验证抓出来的）。
  const rets = [...block.matchAll(/return json\(/g)].map((m) => m.index);
  const withLimits = rets.filter((i) => /^[^;]{0,400}limits/.test(block.slice(i)));
  check('候选接口每个出口都带口径（含失败分支）',
    rets.length >= 2 && withLimits.length === rets.length, `${withLimits.length}/${rets.length}`);
}

console.log(`\n=== ${failed === 0 ? '全部通过' : failed + ' 项失败'} ===\n`);
process.exit(failed === 0 ? 0 : 1);
