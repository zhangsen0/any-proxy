import { runtime } from './runtime.js';

// DNS 自动优选：候选池 -> HTTP 探测 -> 写 A 记录 -> 自校验
// 存储统一走 runtime.KV（bindRuntime 按 STORAGE_BACKEND 选择 KV 或 D1），与本项目其余模块保持一致
const DEFAULT_PREF_DOMAINS = ['www.cloudflare.com', 'speed.cloudflare.com', 'time.cloudflare.com', 'one.one.one.one', 'www.gstatic.com', 'cdn.jsdelivr.net'];

/**
 * 定时入口：每 5 分钟触发一次（细粒度守底），按用户配置的间隔（默认 720 分钟 = 12 小时）
 * 决定是否真正执行自动优选 DNS 更新，避免高频无谓刷新。
 */
async function scheduledDnsCheck(env) {
  try {
    // 读取配置间隔（分钟），默认 720（12 小时）
    let interval = 720;
    try {
      const c = await runtime.KV.get('DNS_CONFIG');
      if (c) {
        const v = parseInt(c, 10);
        if (v >= 5 && v <= 1440) interval = v;
      }
    } catch {}
    // 距上次运行不足间隔则跳过
    const now = Date.now();
    let last = 0;
    try {
      last = parseInt(await runtime.KV.get('DNS_LAST_RUN'), 10) || 0;
    } catch {}
    if (now - last < interval * 60000) return;
    await runtime.KV.put('DNS_LAST_RUN', String(now));
    await autoUpdatePreferredDns(env);
  } catch (e) {}
}


/**
 * 自动更新 proxy.520215.xyz 的 A 记录为优选 IP：
 * 1. 候选池优先取存储中的 PREF_IPS（主页保存的优选池）与 GOOD_IPS，否则用内置 CF 官方优选段随机生成
 * 2. 逐个测通（TLS 握手到 CF 边缘）
 * 3. 取前 3 个可用 IP 更新 / 补齐 A 记录（多 A 记录浏览器自动负载均衡 + 容错）
 * 需要 Secret：CF_API_TOKEN（DNS 编辑权限）、CF_ZONE_ID
 */
const PREFERRED_IP_RANGES = ['104.16.', '104.17.', '104.18.', '104.19.', '108.162.', '162.159.', '172.64.', '172.66.', '172.67.', '188.164.', '198.41.'];

async function autoUpdatePreferredDns(env) {
  try {
    const zone = env.CF_ZONE_ID;
    const token = env.CF_API_TOKEN;
    const host = 'proxy.520215.xyz';
    if (!zone || !token) return { ok: false, error: '缺少 CF_API_TOKEN / CF_ZONE_ID Secret' };

    // 1. 候选优先级：GOOD_IPS（外部 curl 验证过的可用集，最安全）→ 优选池（浏览器测速保存）→ 兜底
    //    （1034 Edge IP Restricted 状态会变，服务端无法自行验证，只有外部 HTTPS 访问（SNI=域名）能区分，
    //    因此自动优选优先用「已验证可用集」，避免把 1034 IP 写进 A 记录。）
    let goodPool = [];
    try {
      const good = await runtime.KV.get('GOOD_IPS');
      if (good) goodPool = good.split(/\r?\n/).map(s => s.trim().split('#')[0].trim()).filter(s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s));
    } catch {}
    let basePool = [];
    try {
      const add = await runtime.KV.get('PREF_IPS');
      if (add) {
        basePool = add.split(/\r?\n/).map(s => s.trim().split('#')[0].trim()).filter(s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s));
      }
    } catch {}
    const FALLBACK_IPS = ['104.16.249.7', '104.17.110.8', '104.18.34.9', '108.162.192.5'];
    const candidates = [...new Set([...goodPool, ...basePool, ...FALLBACK_IPS])];
    if (!candidates.length) {
      for (let i = 0; i < 12; i++) {
        const r = PREFERRED_IP_RANGES[i % PREFERRED_IP_RANGES.length];
        candidates.push(r + (10 + Math.floor(Math.random() * 220)) + '.' + (1 + Math.floor(Math.random() * 250)));
      }
    }

    // 2. HTTP 探测过滤死 IP → 应用 DNS（应用后自检，1034 自动回滚）
    //    说明：CF Worker 出站到 CF 泛播 IP 时 SNI=IP，无法用 HTTPS 复测 1034/可用；浏览器负责测延迟排序，
    //    服务端用 HTTP(80) 探测排除不可达 IP，写入后用「访问自己域名」自检，1034 立即回滚，绝不写坏。
    const usable = await filterUsableIps(candidates);
    const result = await applyDnsWithSelfCheck(env, usable);
    return { ok: result.ok, ips: result.ips || [], pool: usable.length, changed: result.changed || 0, verified: result.verified, error: result.error };
  } catch (e) {
    return { ok: false, error: '自动优选执行异常：' + (e && e.message ? e.message : e) };
  }
}

// HTTP 探测过滤：从 Worker 出站到候选 IP 的 80 端口（无 TLS/SNI 限制），能拿到 CF 响应（301/200/403）说明该 IP 是可达的 CF 泛播节点；
// 连接失败（非 CF / 死 IP）排除。全部探测失败时信任原列表（不误伤），保证可用性优先。

async function filterUsableIps(ips) {
  const good = [];
  for (const ip of ips) {
    try {
      const r = await fetch('http://' + ip + '/__api/config', { headers: { Host: 'proxy.520215.xyz' }, redirect: 'manual', signal: AbortSignal.timeout(3000) });
      if (r) good.push(ip);
    } catch {}
  }
  return good.length ? good : ips;
}

// 更新 DNS A 记录（DNS-only，保留 2 条）：多了删、少了补，返回变更数

async function updateDnsRecords(env, ips) {
  const zone = env.CF_ZONE_ID;
  const token = env.CF_API_TOKEN;
  const host = 'proxy.520215.xyz';
  if (!zone || !token) return 0;
  const base = `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records`;
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
  } catch {
    return 0;
  }
  let changed = 0;
  for (let i = 0; i < records.length; i++) {
    const newIp = ips[i];
    if (!newIp) {
      await fetch(`${base}/${records[i].id}`, { method: 'DELETE', headers: auth });
      changed++;
      continue;
    }
    if (records[i].content !== newIp) {
      await fetch(`${base}/${records[i].id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ content: newIp, ttl: 300 }) });
      changed++;
    }
  }
  for (let i = records.length; i < ips.length && i < 2; i++) {
    await fetch(base, { method: 'POST', headers: auth, body: JSON.stringify({ type: 'A', name: host, content: ips[i], ttl: 300, proxied: false }) });
    changed++;
  }
  return changed;
}

// 读取当前 A 记录（id + content，最多 2 条）

async function getARecords(env) {
  const zone = env.CF_ZONE_ID;
  const token = env.CF_API_TOKEN;
  if (!zone || !token) return [];
  try {
    const list = await (await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/dns_records?name=proxy.520215.xyz&type=A`, { headers: { Authorization: `Bearer ${token}` } })).json();
    return (list.result || []).filter(r => r.type === 'A' && r.name === 'proxy.520215.xyz').slice(0, 2).map(r => ({ id: r.id, content: r.content }));
  } catch { return []; }
}

// 应用 DNS 后自检：等 DNS 生效后从 CF 网络访问自己域名（SNI=域名），新 A 记录若 1034（403）则自动回滚旧记录。
// 这是防止「池里 no-cors 测速通过的 1034 IP 被写进 A 记录」的关键防线：HTTP(80) 探测过滤不了 1034，只有域名访问（SNI=域名）能暴露。

async function applyDnsWithSelfCheck(env, ips) {
  const old = await getARecords(env);
  const changed = await updateDnsRecords(env, ips.slice(0, 2));
  // 没变更（与当前一致）且当前记录可用 → 无需自检
  if (!changed) {
    try {
      const r = await fetch('https://proxy.520215.xyz/__api/config', { headers: { 'User-Agent': 'selfcheck' }, signal: AbortSignal.timeout(6000) });
      if (r.status === 200) return { ok: true, ips: ips.slice(0, 2), changed: 0, verified: true };
    } catch {}
    return { ok: false, error: '当前 A 记录验证失败（可能 1034），请手动检查 DNS', verified: false };
  }
  await new Promise(r => setTimeout(r, 2500)); // 等 DNS 生效
  try {
    const r = await fetch('https://proxy.520215.xyz/__api/config', { headers: { 'User-Agent': 'selfcheck' }, signal: AbortSignal.timeout(6000) });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    return { ok: true, ips: ips.slice(0, 2), changed, verified: true };
  } catch (e) {
    // 新 IP 1034/不可用 → 回滚旧记录，宁可保持原样也不写坏
    try { await updateDnsRecords(env, old.map(x => x.content)); } catch {}
    return { ok: false, error: '新 IP 访问验证失败（可能 1034），已自动回滚旧记录', verified: false, rolledBack: true };
  }
}


export { scheduledDnsCheck, autoUpdatePreferredDns, filterUsableIps, updateDnsRecords, getARecords, applyDnsWithSelfCheck, PREFERRED_IP_RANGES, DEFAULT_PREF_DOMAINS };
