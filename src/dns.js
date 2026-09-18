import { runtime } from './runtime.js';
import { b64, parseIpv4List, parseDomainList } from './util.js';
import { fetchSubscriptionCandidates, resolveDomains } from './subs.js';
import { SETTINGS_SPEC, readSettings } from './settings.js';
import { measureTargets } from './latency.js';

/**
 * 探活目标：伪装开启后任何 /__api/* 都要求登录，内部 fetch 必须自己带上登录态。
 * 口令在进程内直接可得（runtime.PASSWORD），不需要额外配置。
 * 注意 device：若某天探活改成走外部（如浏览器跨站测速），带不上 cookie，
 * 那时应该改打根路径 /（伪装页始终 200），而不是放宽 /__api 的权限。
 */
const PROBE_PATH = '/__api/config';

function probeHeaders(host) {
  const h = { Host: host };
  if (runtime.PASSWORD) h.Cookie = `ap_auth=${b64(runtime.PASSWORD)}`;
  return h;
}
// 存储统一走 runtime.KV（bindRuntime 按 STORAGE_BACKEND 选择 KV 或 D1），与本项目其余模块保持一致

// ===================== 可运营参数的默认值 =====================
//
// 这一节原先全是裸常量：时间预算、探测并发、A 记录条数…改一个数字要改代码 + 重新部署，
// 而 AGENTS 第 0 节要求「面向运营的数值必须可配置」。现在**默认值**仍然只在这里读一次
// （从 settings.js 的 SPEC 取，不在本文件重抄一遍），**运行时取值**则一律走
// readSettings(env) —— 面板改完立即生效。
//
// 时间预算：Workers 单次 HTTP 请求的墙钟上限约 30s，超时会被平台直接杀掉，
// 前端只看到「请求失败」。优选链路（拉候选 + 逐个探测 + 改 DNS + 自检）原先全串行且无预算，
// 候选一多必然超时。现在给整条链路一个硬预算，每个阶段按剩余时间收敛。
const DEFAULT_SETTINGS = {
  dns_budget_ms: SETTINGS_SPEC.dns_budget_ms.default,
  probe_timeout_ms: SETTINGS_SPEC.probe_timeout_ms.default,
  probe_concurrency: SETTINGS_SPEC.probe_concurrency.default,
  max_targets: SETTINGS_SPEC.max_targets.default,
  dns_settle_ms: SETTINGS_SPEC.dns_settle_ms.default,
  max_probe_limit: SETTINGS_SPEC.max_probe_limit.default,
  pool_limit: SETTINGS_SPEC.pool_limit.default,
  domain_pool_limit: SETTINGS_SPEC.domain_pool_limit.default,
  dns_interval_minutes: SETTINGS_SPEC.dns_interval_minutes.default,
};

/**
 * 自动优选频率（分钟）的默认值与允许区间。
 *
 * 为什么导出：这个值的「默认 720、区间 5~1440」曾经同时写在 dns.js（调度器）和
 * admin.js（面板接口）里，两边一旦改成不一致，就会出现「面板显示 12 小时、实际按别的间隔跑」
 * 这种查不出来的偏差。现在只由 settings.js 的 SPEC 定义一次，两边引用同一份。
 */
const DNS_INTERVAL = {
  default: SETTINGS_SPEC.dns_interval_minutes.default,
  min: SETTINGS_SPEC.dns_interval_minutes.min,
  max: SETTINGS_SPEC.dns_interval_minutes.max,
};

/** 优选池（PREF_IPS）与已验证可用集（GOOD_IPS）各自最多保留多少条 —— 面板写入与运行时读取共用 */
const POOL_LIMIT = SETTINGS_SPEC.pool_limit.default;

/** 候选域名池最多用多少个域名（解析成本随条数上升，且 A 记录只留 MAX_TARGETS 条） */
const DOMAIN_POOL_LIMIT = SETTINGS_SPEC.domain_pool_limit.default;

/** A 记录条数的默认值（多 A 记录由浏览器自动负载均衡），运行时取值见 readSettings */
const MAX_TARGETS = SETTINGS_SPEC.max_targets.default;

/**
 * 优选/自愈的目标域名 —— 不写死。
 * 优先级：面板配置（运行参数 proxy_host）→ 环境变量 PROXY_HOST → 当前请求的 hostname → 都没有则明确报错。
 * 早期版本把 'proxy.520215.xyz' 硬编码在本文件六处，fork 后自选域名部署会静默地改到别人的 DNS 上。
 *
 * 拆成两个函数的原因：面板值要 await 才能读到（走配置文档），而 hostname 归一化是纯字符串处理。
 * 归一化只有这一份实现，两个入口共用 —— 否则「面板填的域名」与「环境变量填的域名」会各有一套清洗规则。
 */
function normalizeHost(raw) {
  return String(raw || '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .split(':')[0]
    .trim()
    .toLowerCase();
}

/** 同步版本：只认环境变量，保留给无法 await 的调用点 */
function proxyHost(env, hostname) {
  const cleaned = normalizeHost(env && (env.PROXY_HOST || env.proxy_host));
  if (cleaned) return cleaned;
  return String(hostname || '').trim().toLowerCase();
}

/** 面板优先版本：先读运行参数，再退回环境变量 / 本次请求的 hostname */
async function resolveProxyHost(env, hostname) {
  let fromPanel = '';
  try {
    fromPanel = normalizeHost((await readSettings(env)).proxy_host);
  } catch { /* 读配置失败就退回环境变量，不让一次存储抖动把优选停掉 */ }
  if (fromPanel) return fromPanel;
  return proxyHost(env, hostname);
}

/**
 * 一次读取全部运行参数，供本模块内部复用（一次调用只读一次存储）。
 * 跨请求一律重新读 —— 面板保存会失效配置文档缓存，这里跟着拿到新值，保证「改完即生效」。
 */
async function readDnsSettings(env) {
  try {
    return await readSettings(env);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 记住「最后一次真实访问过的 hostname」，供定时任务兜底使用。
 * cron 触发时拿不到请求上下文，若用户没配 PROXY_HOST 就无从推导目标域名；
 * 这里利用 HTTP 请求侧记住的域名补齐，避免「定时优选静默失效」。
 */
async function rememberHost(host) {
  if (!host) return;
  try {
    if ((await runtime.KV.get('SEEN_HOST')) !== host) await runtime.KV.put('SEEN_HOST', host);
  } catch {}
}

/** 目标域名的最终解析顺序：面板/环境变量 → 本次请求 hostname → 上次访问过的 hostname。都拿不到才报错（绝不猜）。 */
async function targetHost(env, hostname) {
  const direct = await resolveProxyHost(env, hostname);
  if (direct) {
    await rememberHost(direct);
    return direct;
  }
  try {
    const seen = String((await runtime.KV.get('SEEN_HOST')) || '').trim().toLowerCase();
    if (seen) return seen;
  } catch {}
  return '';
}

/**
 * 定时入口：每 5 分钟触发一次（细粒度守底），按用户配置的间隔（默认 720 分钟 = 12 小时）
 * 决定是否真正执行自动优选 DNS 更新，避免高频无谓刷新。
 * 间隔本身走运行参数（面板可改），历史独立 KV 键 DNS_CONFIG 由 settings.js 兜底。
 */
async function scheduledDnsCheck(env) {
  try {
    const cfg = await readDnsSettings(env);
    const interval = cfg.dns_interval_minutes || DNS_INTERVAL.default;
    const now = Date.now();
    let last = 0;
    try {
      last = parseInt(await runtime.KV.get('DNS_LAST_RUN'), 10) || 0;
    } catch {}
    if (now - last < interval * 60000) return;
    await runtime.KV.put('DNS_LAST_RUN', String(now));
    await autoUpdatePreferredDns(env, { deadlineMs: Date.now() + (cfg.dns_budget_ms || DEFAULT_SETTINGS.dns_budget_ms) });
  } catch (e) {}
}

/**
 * 自动更新目标域名的 A 记录为优选 IP：
 * 1. 候选来源（全部可配置，无硬编码）：已验证可用集 GOOD_IPS → 优选池 PREF_IPS → 订阅节点 → 候选域名池解析
 * 2. HTTP 并发探测过滤不可达 IP（受总预算约束）
 * 3. 取前 N 个写入 A 记录，写完用域名自检，不通过自动回滚
 * 需要 CF API 凭据：面板「配置中心 → Cloudflare 接口」可填（等价于环境变量 CF_API_TOKEN / CF_ZONE_ID）
 */
async function autoUpdatePreferredDns(env, opts = {}) {
  const cfg = await readDnsSettings(env);
  const deadlineMs = opts.deadlineMs || (Date.now() + (cfg.dns_budget_ms || DEFAULT_SETTINGS.dns_budget_ms));
  // targetHost 内部走「面板/环境变量 → 本次 hostname → 上次访问过的 hostname」，
  // cron 触发时没有请求上下文，靠的就是最后那层兜底 —— 不能在这里图省事直接读配置
  const host = await targetHost(env, opts.hostname);
  // 凭据取值就走注册表（面板 → 环境变量种子 → 默认），不在这里再兜一次环境变量 ——
  // 那样同一个变量会有两处读法，迟早出现「面板填了却用了环境变量的值」
  const zone = cfg.cf_zone_id;
  const token = cfg.cf_api_token;
  if (!host) return { ok: false, error: '无法确定优选目标域名：请在「配置中心 → 代理与转发」填写优选目标域名' };
  if (!zone || !token) return { ok: false, error: '缺少 CF API 凭据：请在「配置中心 → Cloudflare 接口」填写 API Token 与 Zone ID' };

  try {
    // 1. 候选优先级：GOOD_IPS（外部验证过的可用集，最安全）→ 优选池（浏览器测速保存）→ 订阅节点 → 域名池解析
    //    （1034 Edge IP Restricted 状态会变，服务端无法自行验证，只有外部 HTTPS 访问（SNI=域名）能区分，
    //    因此自动优选优先用「已验证可用集」，避免把 1034 IP 写进 A 记录。）
    // 两个池直接取注册表解析后的值：截断长度与面板显示、与面板写入完全一致
    // （旧版这里读 KV 时用的是代码里的默认上限，面板把上限改大之后运行时只取前 30 条）
    const goodPool = Array.isArray(cfg.pool_good_ips) ? cfg.pool_good_ips : [];
    const basePool = Array.isArray(cfg.preferred_ips) ? cfg.preferred_ips : [];
    let candidates = [...new Set([...goodPool, ...basePool])];
    let note = '';

    if (candidates.length < 8 && Date.now() < deadlineMs) {
      try {
        const sub = await fetchSubscriptionCandidates(env, {
          origin: opts.origin,
          hostname: host,
          limit: cfg.candidate_limit || SETTINGS_SPEC.candidate_limit.default,
          signal: AbortSignal.timeout(Math.max(1000, Math.min(8000, deadlineMs - Date.now()))),
        });
        if (sub.ips.length) {
          candidates = [...new Set([...candidates, ...sub.ips])];
          note = sub.note || (sub.filtered ? `订阅共 ${sub.addresses} 个节点，已过滤非本网 ${sub.filtered} 个` : '');
        }
      } catch {}
    }

    // 池子仍然为空时，按候选域名池动态解析出当前边缘 IP，而不是退回写死的 IP 列表
    if (!candidates.length && Date.now() < deadlineMs) {
      const domains = Array.isArray(cfg.pref_domains) ? cfg.pref_domains : [];
      if (domains.length) {
        try {
          const resolved = await resolveDomains(domains, {
            dohUrl: cfg.doh_url,
            deadlineMs,
            signal: AbortSignal.timeout(Math.max(1000, Math.min(6000, deadlineMs - Date.now()))),
          });
          if (resolved.length) {
            candidates = resolved;
            note = '候选由域名池动态解析得到';
          }
        } catch {}
      }
    }

    if (!candidates.length) {
      return {
        ok: false,
        error: '没有任何候选 IP：请先在面板粘贴订阅链接或保存优选池，再执行优选',
      };
    }

    // 2. HTTP 探测过滤死 IP → 应用 DNS（应用后自检，1034 自动回滚）
    //    说明：Worker 出站到边缘 IP 时 SNI=IP，无法用 HTTPS 复测 1034/可用；浏览器负责测延迟排序，
    //    服务端用 HTTP(80) 探测排除不可达 IP，写入后用「访问自己域名」自检，1034 立即回滚，绝不写坏。
    const budget = Math.max(2000, Math.min(12000, deadlineMs - Date.now() - 4000));
    const usable = await filterUsableIps(candidates, {
      host,
      deadlineMs,
      budgetMs: budget,
      maxProbeLimit: cfg.max_probe_limit,
      probeTimeoutMs: cfg.probe_timeout_ms,
      concurrency: cfg.probe_concurrency,
      // 延迟排序是**可选增强**：关着的时候走的还是原来那条二值判定的路。
      sortByLatency: cfg.latency_enabled === true,
      latencySamples: cfg.latency_samples,
      latencyBudgetMs: cfg.latency_budget_ms,
    });
    const result = await applyDnsWithSelfCheck(env, usable, { host, deadlineMs });
    return {
      ok: result.ok,
      ips: result.ips || [],
      pool: usable.length,
      changed: result.changed || 0,
      verified: result.verified,
      note: note || result.note || '',
      error: result.error,
    };
  } catch (e) {
    return { ok: false, error: '自动优选执行异常：' + (e && e.message ? e.message : e) };
  }
}

/**
 * 生成「探一个 IP 要多久」的探测函数。**探测口径全项目只有这一份**：
 * 二值判定的 filterUsableIps 和带延迟的 probeLatency 都用它，免得两边分叉成
 * 「同一次优选里两个 IP 用不同的标准测」。
 *
 * ⚠️ 刻意**不看状态码**：伪装开启时未登录访问 /__api/config 拿到的是 404，
 * 但那恰恰说明这个 IP 是通的。判定标准只有一个：连不连得上。
 */
function latencyProbe(host, probeTimeoutMs) {
  return async (ip, timeoutMs) => {
    await fetch('http://' + ip + PROBE_PATH, {
      headers: probeHeaders(host),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs || probeTimeoutMs),
    });
  };
}

/**
 * 对外：手动触发一次延迟实测（面板「延迟实测」按钮走这里）。
 * 目标列表由调用方给；不填则由接口侧用当前优选池兜底。
 * 并发 / 取样次数 / 预算全部取自注册表，这里不自己定值。
 */
export async function probeLatency(targets, opts = {}) {
  const host = opts.host || '';
  if (!host) {
    return { items: [], ok: [], stats: { total: 0, good: 0, bad: 0, stoppedEarly: false }, error: '缺少目标域名（无法探测）' };
  }
  const cfg = await cfgOf(opts.env, opts);
  const probeTimeoutMs = opts.probeTimeoutMs || cfg.probe_timeout_ms || DEFAULT_SETTINGS.probe_timeout_ms;
  return await measureTargets(targets, {
    probe: latencyProbe(host, probeTimeoutMs),
    concurrency: opts.concurrency || cfg.probe_concurrency || DEFAULT_SETTINGS.probe_concurrency,
    samples: opts.samples || cfg.latency_samples || SETTINGS_SPEC.latency_samples.default,
    maxTargets: opts.maxTargets || cfg.max_probe_limit || DEFAULT_SETTINGS.max_probe_limit,
    timeoutMs: probeTimeoutMs,
    budgetMs: opts.budgetMs || cfg.latency_budget_ms || SETTINGS_SPEC.latency_budget_ms.default,
    deadlineMs: opts.deadlineMs,
  });
}

/**
 * HTTP 探测过滤：从 Worker 出站到候选 IP 的 80 端口（无 TLS/SNI 限制），能拿到响应说明该 IP 可达；
 * 连接失败（不可达 / 死 IP）排除。全部探测失败时信任原列表（不误伤），保证可用性优先。
 *
 * 原先「串行 + 每个 IP 等满 3s」，实测一批不可达候选就能吃掉 20s+，叠加后续步骤必然超出 Workers 墙钟；
 * 现改为并发 + 单次超时 + **总预算**：预算耗尽后立即返回已探到的结果。
 * 并发数 / 超时 / 单轮上限都是运行参数（面板可改），这里只消费不再自己定值。
 */
async function filterUsableIps(ips, opts = {}) {
  const host = opts.host || '';
  if (!host) return ips;
  const deadline = opts.deadlineMs || 0;
  const budgetEnd = Date.now() + (opts.budgetMs || 12000);
  const hardEnd = deadline ? Math.min(budgetEnd, deadline - 500) : budgetEnd;
  const maxProbe = opts.maxProbeLimit || DEFAULT_SETTINGS.max_probe_limit;
  const probeTimeoutMs = opts.probeTimeoutMs || DEFAULT_SETTINGS.probe_timeout_ms;
  const concurrency = opts.concurrency || DEFAULT_SETTINGS.probe_concurrency;
  const queue = [...new Set(ips)].slice(0, maxProbe);
  if (!queue.length) return [];

  // 延迟实测：同一套探测口径，只是每个目标多测几次，把「多快」也量出来。
  // 只在调用方显式要求时走这条路（由注册表里的 latency_enabled 控制），
  // 默认仍走下面的二值判定 —— 行为与加这个功能之前完全一致。
  if (opts.sortByLatency) {
    const r = await measureTargets(queue, {
      probe: latencyProbe(host, probeTimeoutMs),
      concurrency,
      samples: opts.latencySamples || SETTINGS_SPEC.latency_samples.default,
      maxTargets: maxProbe,
      timeoutMs: probeTimeoutMs,
      budgetMs: opts.latencyBudgetMs || SETTINGS_SPEC.latency_budget_ms.default,
      deadlineMs: hardEnd,
    });
    return r.ok.length ? r.ok : ips;
  }

  const good = [];
  const probe = async () => {
    while (queue.length) {
      if (Date.now() > hardEnd) return;
      const ip = queue.shift();
      try {
        const r = await fetch('http://' + ip + PROBE_PATH, {
          headers: probeHeaders(host),
          redirect: 'manual',
          signal: AbortSignal.timeout(probeTimeoutMs),
        });
        if (r) good.push(ip);
      } catch {}
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, () => probe().catch(() => {}))
  );
  return good.length ? good : ips;
}

/** 取本模块需要的运行参数：调用方已经读过就复用（同一请求不重复读存储），没读就现读一次 */
async function cfgOf(env, opts) {
  if (opts && opts.cfg) return opts.cfg;
  return await readDnsSettings(env);
}

// Cloudflare DNS API 基础地址（平台地址，非业务数据；面板「Cloudflare 接口」可改，环境变量 CF_API_BASE 作种子）
function dnsApiBase(cfg, zone) {
  const base = String((cfg && cfg.cf_api_base) || SETTINGS_SPEC.cf_api_base.default).replace(/\/+$/, '');
  return `${base}/zones/${zone}/dns_records`;
}

// 更新 DNS A 记录（DNS-only）：多了删、少了补。返回 {changed, error}，失败不再静默吞掉。
async function updateDnsRecords(env, ips, opts = {}) {
  const cfg = await cfgOf(env, opts);
  const zone = cfg.cf_zone_id;
  const token = cfg.cf_api_token;
  const host = opts.host;
  // A 记录条数上限是运行参数：面板写入的条数与运行时保留的条数必须同一口径，否则「面板显示 3 条、实际只留 2 条」
  const maxTargets = cfg.max_targets || DEFAULT_SETTINGS.max_targets;
  if (!zone || !token) return { changed: 0, error: '缺少 CF API 凭据（API Token / Zone ID）' };
  if (!host) return { changed: 0, error: '未指定目标域名' };
  const base = dnsApiBase(cfg, zone);
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let records = [];
  try {
    const response = await fetch(`${base}?name=${encodeURIComponent(host)}&type=A`, { headers: auth });
    const list = await response.json();
    if (!response.ok || list.success === false) {
      const detail = (list.errors || []).map(e => e.message || e.code).join('; ');
      throw new Error(detail || `Cloudflare API HTTP ${response.status}`);
    }
    records = (list.result || []).filter(r => r.type === 'A' && r.name === host);
  } catch (e) {
    return { changed: 0, error: '读取 DNS 记录失败：' + (e && e.message ? e.message : e) };
  }

  let changed = 0;
  const errors = [];
  for (let i = 0; i < records.length; i++) {
    const newIp = ips[i];
    try {
      if (!newIp) {
        await fetch(`${base}/${records[i].id}`, { method: 'DELETE', headers: auth });
        changed++;
        continue;
      }
      if (records[i].content !== newIp) {
        await fetch(`${base}/${records[i].id}`, {
          method: 'PATCH',
          headers: auth,
          body: JSON.stringify({ content: newIp, ttl: 300 }),
        });
        changed++;
      }
    } catch (e) {
      errors.push(e && e.message ? e.message : String(e));
    }
  }
  for (let i = records.length; i < ips.length && i < maxTargets; i++) {
    try {
      await fetch(base, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ type: 'A', name: host, content: ips[i], ttl: 300, proxied: false }),
      });
      changed++;
    } catch (e) {
      errors.push(e && e.message ? e.message : String(e));
    }
  }
  return { changed, error: errors.length ? errors.join('; ') : '' };
}

// 读取当前 A 记录（id + content，最多 max_targets 条）
async function getARecords(env, opts = {}) {
  const cfg = await cfgOf(env, opts);
  const zone = cfg.cf_zone_id;
  const token = cfg.cf_api_token;
  const host = opts.host;
  if (!zone || !token || !host) return [];
  try {
    const list = await (await fetch(
      `${dnsApiBase(cfg, zone)}?name=${encodeURIComponent(host)}&type=A`,
      { headers: { Authorization: `Bearer ${token}` } }
    )).json();
    return (list.result || [])
      .filter(r => r.type === 'A' && r.name === host)
      .slice(0, cfg.max_targets || DEFAULT_SETTINGS.max_targets)
      .map(r => ({ id: r.id, content: r.content }));
  } catch {
    return [];
  }
}

/**
 * 应用 DNS 后自检：等 DNS 生效后访问自己的域名（SNI=域名），新 A 记录若不可用则自动回滚旧记录。
 * 这是防止「池里 no-cors 测速通过但其实不可用的 IP 被写进 A 记录」的关键防线：
 * HTTP(80) 探测过滤不了域名维度的拒绝，只有域名访问（SNI=域名）能暴露。
 */
async function applyDnsWithSelfCheck(env, ips, opts = {}) {
  const cfg = await cfgOf(env, opts);
  const host = opts.host || '';
  if (!host) return { ok: false, error: '未指定目标域名' };
  const deadlineMs = opts.deadlineMs || 0;
  const maxTargets = cfg.max_targets || DEFAULT_SETTINGS.max_targets;
  const settleMs = cfg.dns_settle_ms === undefined ? DEFAULT_SETTINGS.dns_settle_ms : cfg.dns_settle_ms;
  const targets = ips.slice(0, maxTargets);
  if (!targets.length) return { ok: false, error: '没有可用 IP 可写入 A 记录' };

  const old = await getARecords(env, { host, cfg });
  const applied = await updateDnsRecords(env, targets, { host, cfg });
  if (applied.error) {
    return { ok: false, error: '更新 DNS 失败：' + applied.error, ips: targets, changed: 0, verified: false };
  }

  // 没变更（与当前一致）且当前记录可用 → 无需自检
  if (!applied.changed) {
    const r = await selfCheck(host, deadlineMs);
    if (r.ok) return { ok: true, ips: targets, changed: 0, verified: true, note: 'A 记录已是优选结果，无需变更' };
    return { ok: false, error: `当前 A 记录验证失败（${r.detail}），目标域名：${host}`, verified: false };
  }

  // 等 DNS 生效，但要留在预算内，绝不把请求拖过 Workers 墙钟
  const wait = Math.min(settleMs, Math.max(0, (deadlineMs || Date.now() + settleMs) - Date.now() - 2000));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));

  const checked = await selfCheck(host, deadlineMs);
  if (checked.ok) return { ok: true, ips: targets, changed: applied.changed, verified: true };

  // 新 IP 不可用 → 回滚旧记录，宁可保持原样也不写坏
  try {
    await updateDnsRecords(env, old.map(x => x.content), { host, cfg });
  } catch {}
  return {
    ok: false,
    error: `新 IP 访问验证失败（${checked.detail}），已自动回滚旧记录`,
    verified: false,
    rolledBack: true,
  };
}

async function selfCheck(host, deadlineMs) {
  const remain = deadlineMs ? deadlineMs - Date.now() - 200 : 6000;
  const timeout = Math.max(1000, Math.min(6000, remain));
  try {
    const r = await fetch(`https://${host}${PROBE_PATH}`, {
      headers: { ...probeHeaders(host), 'User-Agent': 'selfcheck' },
      signal: AbortSignal.timeout(timeout),
    });
    if (r.status === 200) return { ok: true };
    return { ok: false, detail: 'HTTP ' + r.status };
  } catch (e) {
    return { ok: false, detail: '连接失败' + (e && e.name === 'TimeoutError' ? '（超时）' : '') };
  }
}

export {
  scheduledDnsCheck, autoUpdatePreferredDns, filterUsableIps, updateDnsRecords, getARecords,
  applyDnsWithSelfCheck, proxyHost, resolveProxyHost, targetHost, rememberHost, MAX_TARGETS,
  DNS_INTERVAL, POOL_LIMIT, DOMAIN_POOL_LIMIT,
};
