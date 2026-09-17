/**
 * Cloudflare 用量驾驶舱的数据源：直接查 CF 的 GraphQL / REST API，
 * 让管理面板**不用登录 CF 控制台**就能看到当前 Worker 绑定账户的基础用量。
 *
 * 数据口径与 CF 控制台一致（都是边缘侧统计）：
 *   - daily   httpRequests1dGroups       按天请求数 / 边缘字节 / 缓存命中 / 唯一访客（近 30 天）
 *   - status  httpRequestsAdaptiveGroups 近 24h 状态码分布（组 count + edgeResponseBytes）
 *   - paths   httpRequestsAdaptiveGroups 近 24h Top 路径（组 count + edgeResponseBytes）
 *   - worker  workersInvocationsAdaptive 当前 Worker 脚本近 30 天请求 / 错误 / 子请求
 *
 * 字段与窗口约束（全部实测确认过，改字段名 / 窗口前先拿 token 验证）：
 *   - 自适应数据集窗口最多 1 天，跨更宽会被 CF 以 quota 拒绝 → 按天明细必须走 1d 数据集；
 *   - 1d 数据集的字节字段是 sum.bytes；自适应数据集是 sum.edgeResponseBytes；
 *     自适应数据集的请求数在「组顶层 count」而不是 sum.requests（sum.requests 不存在）；
 *   - workersInvocationsAdaptive 不暴露 CPU 时长（unknown field），只有 requests/errors/subrequests；
 *   - 账户 id 不要求额外配置：用 token 调 GET /accounts 自动取第一个（面板只展示用量，不改任何资源）。
 *
 * 降级纪律：
 *   - CF_API_TOKEN / CF_ZONE_ID 缺失 → enabled:false，面板给「去配置」引导，不报错；
 *   - 单个数据源失败 → 该源置 null 并记入 errors，其余源照常返回；
 *   - 所有外部调用带超时（FETCH_TIMEOUT_MS），失败绝不拖慢面板请求。
 *
 * 缓存：模块级 Map + TTL。GraphQL 分析查询有配额，每次打开面板都打会被限流；
 * 5 分钟内同一 isolate 只查一次（面板手动刷新也吃缓存，符合「看个大概」的用途）。
 */

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const REST_ROOT = 'https://api.cloudflare.com/client/v4';
const FETCH_TIMEOUT_MS = 8000;
/** 用量数据整体缓存时长：GraphQL 分析查询按次计费，宁可看 5 分钟前的数也不刷爆配额 */
const ANALYTICS_TTL_MS = 5 * 60 * 1000;
const DAILY_DAYS = 30;
const TOP_PATHS = 12;
/** Worker 脚本名：wrangler.toml 的 name，可用 WORKER_SCRIPT 覆盖（同一账户常挂着多个脚本） */
export const CF_DEFAULT_SCRIPT = 'any-proxy';

/** 模块级缓存：kind -> { at, data }。isolate 间不共享，但对单用户面板足够 */
const cache = new Map();

function cacheGet(kind) {
  const hit = cache.get(kind);
  return hit && Date.now() - hit.at < ANALYTICS_TTL_MS ? hit.data : null;
}
function cacheSet(kind, data) {
  cache.set(kind, { at: Date.now(), data });
}

function utcDate(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
}

function tokenOf(env) {
  return (env && (env.CF_API_TOKEN || env.CLOUDFLARE_API_TOKEN)) || '';
}
function zoneIdOf(env) {
  return (env && (env.CF_ZONE_ID || env.CLOUDFLARE_ZONE_ID)) || '';
}
function scriptOf(env) {
  return (env && env.WORKER_SCRIPT) || CF_DEFAULT_SCRIPT;
}

/** GraphQL 请求：失败或返回 errors 一律抛错，由调用方按数据源收集降级 */
async function graphql(env, query) {
  const tok = tokenOf(env);
  if (!tok) throw Object.assign(new Error('未配置 CF_API_TOKEN'), { code: 'NO_TOKEN' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: ctrl.signal,
    });
    let body = null;
    try { body = await res.json(); } catch {}
    if (!res.ok || !body || body.errors) {
      const msg = (body && body.errors && body.errors[0] && body.errors[0].message) || ('HTTP ' + res.status);
      throw Object.assign(new Error(msg), { code: 'GRAPHQL' });
    }
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

/** REST GET：解析 JSON，非 2xx 抛错 */
async function restJson(env, path) {
  const tok = tokenOf(env);
  if (!tok) throw Object.assign(new Error('未配置 CF_API_TOKEN'), { code: 'NO_TOKEN' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REST_ROOT + path, { headers: { Authorization: 'Bearer ' + tok }, signal: ctrl.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.success === false) {
      const msg = (body && body.errors && body.errors[0] && body.errors[0].message) || ('HTTP ' + res.status);
      throw Object.assign(new Error(msg), { code: 'REST' });
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/** 账户信息：优先 env.CF_ACCOUNT_ID（纯 id），否则用 token 列账户取第一个 */
let accountInflight = null; // 单飞：account 源与 worker 源会并行打这个函数，避免同一时刻重复请求
async function accountInfo(env) {
  if (env && env.CF_ACCOUNT_ID) return { id: env.CF_ACCOUNT_ID, name: null };
  const cached = cacheGet('account');
  if (cached) return cached;
  if (accountInflight) return accountInflight;
  accountInflight = (async () => {
    try {
      const list = await restJson(env, '/accounts');
      const first = Array.isArray(list) && list[0];
      if (first && first.id) {
        const info = { id: first.id, name: first.name || null };
        cacheSet('account', info);
        return info;
      }
    } catch { /* 取不到账户是「worker 源降级」的可观测原因（cfAnalytics 会记入 errors） */ }
    return null;
  })().finally(() => { accountInflight = null; });
  return accountInflight;
}

/** Zone 信息：用 token 调 GET /zones/{id}，面板能显示「这个域名绑在哪个账户」 */
async function zoneInfo(env) {
  const zid = zoneIdOf(env);
  if (!zid) return null;
  const cached = cacheGet('zone');
  if (cached) return cached;
  try {
    const zone = await restJson(env, '/zones/' + encodeURIComponent(zid));
    if (zone && zone.id) {
      const info = { id: zone.id, name: zone.name || null };
      cacheSet('zone', info);
      return info;
    }
  } catch {}
  return null;
}

async function collectDaily(env) {
  const zid = zoneIdOf(env);
  if (!zid) throw Object.assign(new Error('未配置 CF_ZONE_ID'), { code: 'NO_ZONE' });
  const data = await graphql(env,
    `query { viewer { zones(filter:{zoneTag:"${zid}"}) { ` +
    `httpRequests1dGroups(limit: ${DAILY_DAYS}, filter:{date_geq:"${utcDate(DAILY_DAYS - 1)}"}) { ` +
    `dimensions { date } sum { requests bytes cachedRequests cachedBytes } uniq { uniques } } } } }`);
  const zones = ((data || {}).viewer || {}).zones || [];
  const rows = (zones[0] && zones[0].httpRequests1dGroups) || [];
  return (rows || []).map(r => ({
    date: r.dimensions.date,
    requests: r.sum.requests || 0,
    bytes: r.sum.bytes || 0,
    cachedRequests: r.sum.cachedRequests || 0,
    cachedBytes: r.sum.cachedBytes || 0,
    uniques: (r.uniq && r.uniq.uniques) || 0,
  })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)); // 按日期升序，画趋势图从左到右（CF 返回顺序不保证）
}

/** 近 24h 状态码分布。自适应窗口 ≤1 天是硬限制（超过直接 quota 报错），这里取整 24h */
async function collectStatus(env) {
  const zid = zoneIdOf(env);
  if (!zid) throw Object.assign(new Error('未配置 CF_ZONE_ID'), { code: 'NO_ZONE' });
  const from = new Date(Date.now() - 86400000).toISOString();
  const to = new Date().toISOString();
  const data = await graphql(env,
    `query { viewer { zones(filter:{zoneTag:"${zid}"}) { ` +
    `httpRequestsAdaptiveGroups(limit: 30, filter:{datetime_geq:"${from}", datetime_leq:"${to}"}) { ` +
    `count dimensions { edgeResponseStatus } sum { edgeResponseBytes } } } } }`);
  const zones = ((data || {}).viewer || {}).zones || [];
  const rows = (zones[0] && zones[0].httpRequestsAdaptiveGroups) || [];
  return (rows || []).map(r => ({
    code: r.dimensions.edgeResponseStatus,
    requests: r.count || 0,
    bytes: r.sum.edgeResponseBytes || 0,
  })).sort((a, b) => b.requests - a.requests);
}

/** 近 24h Top 路径：回答「流量都打在哪条路由上」（排障时最有用的一屏） */
async function collectPaths(env) {
  const zid = zoneIdOf(env);
  if (!zid) throw Object.assign(new Error('未配置 CF_ZONE_ID'), { code: 'NO_ZONE' });
  const from = new Date(Date.now() - 86400000).toISOString();
  const to = new Date().toISOString();
  const data = await graphql(env,
    `query { viewer { zones(filter:{zoneTag:"${zid}"}) { ` +
    `httpRequestsAdaptiveGroups(limit: ${TOP_PATHS}, filter:{datetime_geq:"${from}", datetime_leq:"${to}"}) { ` +
    `count dimensions { clientRequestPath } sum { edgeResponseBytes } } } } }`);
  const zones = ((data || {}).viewer || {}).zones || [];
  const rows = (zones[0] && zones[0].httpRequestsAdaptiveGroups) || [];
  return (rows || []).map(r => ({
    path: r.dimensions.clientRequestPath || '(空路径)',
    requests: r.count || 0,
    bytes: r.sum.edgeResponseBytes || 0,
  })).sort((a, b) => b.bytes - a.bytes);
}

/** 当前 Worker 脚本近 30 天调用：只统计本脚本，账户里别的脚本不掺进来 */
async function collectWorker(env) {
  const acct = await accountInfo(env);
  if (!acct || !acct.id) throw Object.assign(new Error('无法确定 CF 账户（配置 CF_ACCOUNT_ID，或给 token 账号列表读权限）'), { code: 'NO_ACCOUNT' });
  const script = scriptOf(env);
  const data = await graphql(env,
    `query { viewer { accounts(filter:{accountTag:"${acct.id}"}) { ` +
    `workersInvocationsAdaptive(limit: ${DAILY_DAYS}, filter:{date_geq:"${utcDate(DAILY_DAYS - 1)}"}) { ` +
    `dimensions { date scriptName } sum { requests errors subrequests } } } } }`);
  const rows = (((data || {}).viewer || {}).accounts || [{}])[0] && ((data || {}).viewer.accounts[0].workersInvocationsAdaptive || []);
  const mine = (rows || []).filter(r => r.dimensions.scriptName === script);
  const daily = mine.map(r => ({
    date: r.dimensions.date,
    requests: r.sum.requests || 0,
    errors: r.sum.errors || 0,
  })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const totals = daily.reduce((a, x) => ({
    requests: a.requests + x.requests,
    errors: a.errors + x.errors,
  }), { requests: 0, errors: 0 });
  return {
    script,
    totals,
    daily,
    // 同一账户还挂着别的脚本时提示一句，避免用户以为「账户全部流量 = 这个数」
    accountHasOthers: (rows || []).some(r => !!r.dimensions.scriptName && r.dimensions.scriptName !== script),
  };
}

/** 清空用量缓存（测试隔离 / 手动强制重查用） */
export function clearCfCache() {
  cache.clear();
}

/**
 * 汇总一次完整驾驶舱数据。整个结果按 ANALYTICS_TTL_MS 缓存：
 * 5 分钟内任何打开面板的请求都吃同一份，GraphQL 配额只花一份。
 */
export async function cfAnalytics(env) {
  const cached = cacheGet('all');
  if (cached) return cached;

  const enabled = !!(tokenOf(env) && zoneIdOf(env));
  const out = {
    ok: true,
    enabled,
    updated_at: new Date().toISOString(),
    zone: null,
    account: null,
    daily: null,
    status: null,
    paths: null,
    worker: null,
    errors: [],
  };
  if (!enabled) return out; // 面板据此渲染「去配置」空态

  const errors = out.errors;
  const safe = async (kind, fn) => {
    try {
      return await fn();
    } catch (e) {
      errors.push({ source: kind, message: String((e && e.message) || e) });
      return null;
    }
  };

  // 各数据源互不依赖，并行打；单源失败只记 errors，其余照常
  const [zone, account, daily, status, paths, worker] = await Promise.all([
    safe('zone', () => zoneInfo(env)),
    safe('account', () => accountInfo(env)),
    safe('daily', () => collectDaily(env)),
    safe('status', () => collectStatus(env)),
    safe('paths', () => collectPaths(env)),
    safe('worker', () => collectWorker(env)),
  ]);
  out.zone = zone;
  out.account = account;
  out.daily = daily;
  out.status = status;
  out.paths = paths;
  out.worker = worker;

  cacheSet('all', out);
  return out;
}
