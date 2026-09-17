import { runtime } from './runtime.js';
import { b64, parseIpv4List, parseDomainList } from './util.js';
import { fetchSubscriptionCandidates, resolveDomains } from './subs.js';

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

// 时间预算：Workers 单次 HTTP 请求的墙钟上限约 30s，超时会被平台直接杀掉，前端只看到「请求失败」。
// 优选链路（拉候选 + 逐个探测 + 改 DNS + 自检）原先全串行且无预算，候选一多必然超时。
// 这里给整条链路一个硬预算，每个阶段按剩余时间收敛，保证任何情况下都能返回可读结果。
const TOTAL_BUDGET_MS = 22000;
const PROBE_TIMEOUT_MS = 2500;
const PROBE_CONCURRENCY = 12;
const MAX_TARGETS = 2; // A 记录条数（多 A 记录由浏览器自动负载均衡）
const DNS_SETTLE_MS = 2500; // 写完 A 记录后等它生效再自检
const MAX_PROBE_LIMIT = 32; // 单轮最多探测多少个候选，防止池里塞满不可达 IP 时拖垮整次请求

/**
 * 自动优选频率（分钟）的默认值与允许区间。
 *
 * 为什么导出：这个值的「默认 720、区间 5~1440」曾经同时写在 dns.js（调度器）和
 * admin.js（面板接口）里，两边一旦改成不一致，就会出现「面板显示 12 小时、实际按别的间隔跑」
 * 这种查不出来的偏差。现在只在这里定义，面板侧引用同一份。
 */
const DNS_INTERVAL = { default: 720, min: 5, max: 1440 };

/** 优选池（PREF_IPS）与已验证可用集（GOOD_IPS）各自最多保留多少条 —— 面板写入与运行时读取共用 */
const POOL_LIMIT = 30;

/** 候选域名池最多用多少个域名（解析成本随条数上升，且 A 记录只留 MAX_TARGETS 条） */
const DOMAIN_POOL_LIMIT = 12;

/**
 * 优选/自愈的目标域名 —— 不写死。
 * 优先级：环境变量 PROXY_HOST（Actions 变量注入）→ 当前请求的 hostname → 都没有则明确报错。
 * 早期版本把 'proxy.520215.xyz' 硬编码在本文件六处，fork 后自选域名部署会静默地改到别人的 DNS 上。
 */
function proxyHost(env, hostname) {
  const raw = String((env && (env.PROXY_HOST || env.proxy_host)) || '').trim();
  const cleaned = raw
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .split(':')[0]
    .toLowerCase();
  if (cleaned) return cleaned;
  return String(hostname || '').trim().toLowerCase();
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

/** 目标域名的最终解析顺序：环境变量 → 本次请求 hostname → 上次访问过的 hostname。都拿不到才报错（绝不猜）。 */
async function targetHost(env, hostname) {
  const direct = proxyHost(env, hostname);
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

async function poolFrom(key, limit = POOL_LIMIT) {
  try {
    const v = await runtime.KV.get(key);
    if (!v) return [];
    return parseIpv4List(v, limit);
  } catch {
    return [];
  }
}

/**
 * 定时入口：每 5 分钟触发一次（细粒度守底），按用户配置的间隔（默认 720 分钟 = 12 小时）
 * 决定是否真正执行自动优选 DNS 更新，避免高频无谓刷新。
 */
async function scheduledDnsCheck(env) {
  try {
    let interval = DNS_INTERVAL.default;
    try {
      const c = await runtime.KV.get('DNS_CONFIG');
      if (c) {
        const v = parseInt(c, 10);
        if (v >= DNS_INTERVAL.min && v <= DNS_INTERVAL.max) interval = v;
      }
    } catch {}
    const now = Date.now();
    let last = 0;
    try {
      last = parseInt(await runtime.KV.get('DNS_LAST_RUN'), 10) || 0;
    } catch {}
    if (now - last < interval * 60000) return;
    await runtime.KV.put('DNS_LAST_RUN', String(now));
    await autoUpdatePreferredDns(env, { deadlineMs: Date.now() + TOTAL_BUDGET_MS });
  } catch (e) {}
}

/**
 * 自动更新目标域名的 A 记录为优选 IP：
 * 1. 候选来源（全部可配置，无硬编码）：已验证可用集 GOOD_IPS → 优选池 PREF_IPS → 订阅节点 → 候选域名池解析
 * 2. HTTP 并发探测过滤不可达 IP（受总预算约束）
 * 3. 取前 N 个写入 A 记录，写完用域名自检，不通过自动回滚
 * 需要 Secret：CF_API_TOKEN（DNS 编辑权限）、CF_ZONE_ID
 */
async function autoUpdatePreferredDns(env, opts = {}) {
  const deadlineMs = opts.deadlineMs || (Date.now() + TOTAL_BUDGET_MS);
  const host = await targetHost(env, opts.hostname);
  if (!host) return { ok: false, error: '无法确定优选目标域名：请配置 PROXY_HOST' };
  const zone = env && (env.CF_ZONE_ID || env.cf_zone_id);
  const token = env && (env.CF_API_TOKEN || env.cf_api_token);
  if (!zone || !token) return { ok: false, error: '缺少 CF_API_TOKEN / CF_ZONE_ID Secret' };

  try {
    // 1. 候选优先级：GOOD_IPS（外部验证过的可用集，最安全）→ 优选池（浏览器测速保存）→ 订阅节点 → 域名池解析
    //    （1034 Edge IP Restricted 状态会变，服务端无法自行验证，只有外部 HTTPS 访问（SNI=域名）能区分，
    //    因此自动优选优先用「已验证可用集」，避免把 1034 IP 写进 A 记录。）
    const goodPool = await poolFrom('GOOD_IPS');
    const basePool = await poolFrom('PREF_IPS');
    let candidates = [...new Set([...goodPool, ...basePool])];
    let note = '';

    if (candidates.length < 8 && Date.now() < deadlineMs) {
      try {
        const sub = await fetchSubscriptionCandidates(env, {
          origin: opts.origin,
          hostname: host,
          limit: 40,
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
      const domains = await domainPool(env);
      if (domains.length) {
        try {
          const resolved = await resolveDomains(domains, {
            dohUrl: env && (env.DOH_URL || env.doh_url),
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
    const usable = await filterUsableIps(candidates, { host, deadlineMs, budgetMs: budget });
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

/** 候选域名池：KV（面板可配）优先，否则取环境变量 PREF_DOMAINS。都没有则返回空 —— 不内置写死列表。 */
async function domainPool(env) {
  const stored = await runtime.KV.get('PREF_DOMAINS').catch(() => null);
  const raw = stored || (env && (env.PREF_DOMAINS || env.pref_domains)) || '';
  return parseDomainList(raw, DOMAIN_POOL_LIMIT);
}

/**
 * HTTP 探测过滤：从 Worker 出站到候选 IP 的 80 端口（无 TLS/SNI 限制），能拿到响应说明该 IP 可达；
 * 连接失败（不可达 / 死 IP）排除。全部探测失败时信任原列表（不误伤），保证可用性优先。
 *
 * 原先「串行 + 每个 IP 等满 3s」，实测一批不可达候选就能吃掉 20s+，叠加后续步骤必然超出 Workers 墙钟；
 * 现改为并发 + 单次超时 + **总预算**：预算耗尽后立即返回已探到的结果。
 */
async function filterUsableIps(ips, opts = {}) {
  const host = opts.host || '';
  if (!host) return ips;
  const deadline = opts.deadlineMs || 0;
  const budgetEnd = Date.now() + (opts.budgetMs || 12000);
  const hardEnd = deadline ? Math.min(budgetEnd, deadline - 500) : budgetEnd;
  const queue = [...new Set(ips)].slice(0, MAX_PROBE_LIMIT);
  if (!queue.length) return [];

  const good = [];
  const probe = async () => {
    while (queue.length) {
      if (Date.now() > hardEnd) return;
      const ip = queue.shift();
      try {
        const r = await fetch('http://' + ip + PROBE_PATH, {
          headers: probeHeaders(host),
          redirect: 'manual',
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (r) good.push(ip);
      } catch {}
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, () => probe().catch(() => {}))
  );
  return good.length ? good : ips;
}

// Cloudflare DNS API 基础地址（平台地址，非业务数据，可用 CF_API_BASE 覆盖）
function dnsApiBase(env, zone) {
  const base = String((env && (env.CF_API_BASE || env.cf_api_base)) || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
  return `${base}/zones/${zone}/dns_records`;
}

// 更新 DNS A 记录（DNS-only）：多了删、少了补。返回 {changed, error}，失败不再静默吞掉。
async function updateDnsRecords(env, ips, opts = {}) {
  const zone = env && (env.CF_ZONE_ID || env.cf_zone_id);
  const token = env && (env.CF_API_TOKEN || env.cf_api_token);
  const host = opts.host;
  if (!zone || !token) return { changed: 0, error: '缺少 CF_API_TOKEN / CF_ZONE_ID Secret' };
  if (!host) return { changed: 0, error: '未指定目标域名' };
  const base = dnsApiBase(env, zone);
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
  for (let i = records.length; i < ips.length && i < MAX_TARGETS; i++) {
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

// 读取当前 A 记录（id + content，最多 MAX_TARGETS 条）
async function getARecords(env, opts = {}) {
  const zone = env && (env.CF_ZONE_ID || env.cf_zone_id);
  const token = env && (env.CF_API_TOKEN || env.cf_api_token);
  const host = opts.host;
  if (!zone || !token || !host) return [];
  try {
    const list = await (await fetch(
      `${dnsApiBase(env, zone)}?name=${encodeURIComponent(host)}&type=A`,
      { headers: { Authorization: `Bearer ${token}` } }
    )).json();
    return (list.result || [])
      .filter(r => r.type === 'A' && r.name === host)
      .slice(0, MAX_TARGETS)
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
  const host = opts.host || '';
  if (!host) return { ok: false, error: '未指定目标域名' };
  const deadlineMs = opts.deadlineMs || 0;
  const targets = ips.slice(0, MAX_TARGETS);
  if (!targets.length) return { ok: false, error: '没有可用 IP 可写入 A 记录' };

  const old = await getARecords(env, { host });
  const applied = await updateDnsRecords(env, targets, { host });
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
  const wait = Math.min(DNS_SETTLE_MS, Math.max(0, (deadlineMs || Date.now() + DNS_SETTLE_MS) - Date.now() - 2000));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));

  const checked = await selfCheck(host, deadlineMs);
  if (checked.ok) return { ok: true, ips: targets, changed: applied.changed, verified: true };

  // 新 IP 不可用 → 回滚旧记录，宁可保持原样也不写坏
  try {
    await updateDnsRecords(env, old.map(x => x.content), { host });
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
  applyDnsWithSelfCheck, proxyHost, targetHost, rememberHost, MAX_TARGETS,
  DNS_INTERVAL, POOL_LIMIT, DOMAIN_POOL_LIMIT,
};
