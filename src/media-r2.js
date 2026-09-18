// R2 媒体分片缓存的策略配置（KV 可编辑，唯一真源）：
//   enabled      总开关：关闭后不再写入也不命中 R2 分片缓存，链路回到 Cache API + 透传；
//   ttlDays      分片保留天数：超过后由 cron 的 sweepMediaR2 定时删除（1~365，默认 7）；
//   maxObjectMB  单分片缓存上限：超过的 206 分片不写 R2，避免读大流打爆内存（1~256，默认 64）。
// 面板「配置中心 → R2 媒体缓存」可改并立即生效；R2_PREFIX（src/proxy.js）是结构键，
// 改动会使旧缓存全部失效，不属于策略参数，保持稳定。
export const R2_CACHE_SPEC = {
  enabled: { default: true, desc: 'R2 媒体分片缓存总开关' },
  ttlDays: { min: 1, max: 365, default: 7, desc: '分片保留天数' },
  maxObjectMB: { min: 1, max: 256, default: 64, desc: '单分片缓存上限（MB）' },
};

const KV_KEY = 'r2-cache-config.json';

/** 净化：开关必须是布尔；天数 1~365、上限 1~256 的整数；非法字段回退默认，保证 KV 里永远可用 */
export function sanitizeR2Config(cfg) {
  const out = {
    enabled: R2_CACHE_SPEC.enabled.default,
    ttlDays: R2_CACHE_SPEC.ttlDays.default,
    maxObjectMB: R2_CACHE_SPEC.maxObjectMB.default,
  };
  if (!cfg || typeof cfg !== 'object') return out;
  if (typeof cfg.enabled === 'boolean') out.enabled = cfg.enabled;
  const d = parseInt(cfg.ttlDays, 10);
  if (!Number.isNaN(d)) out.ttlDays = Math.min(R2_CACHE_SPEC.ttlDays.max, Math.max(R2_CACHE_SPEC.ttlDays.min, d));
  const m = parseInt(cfg.maxObjectMB, 10);
  if (!Number.isNaN(m)) out.maxObjectMB = Math.min(R2_CACHE_SPEC.maxObjectMB.max, Math.max(R2_CACHE_SPEC.maxObjectMB.min, m));
  return out;
}

export async function readR2Config(env) {
  const v = await env.KV.get(KV_KEY, 'json').catch(() => null);
  return sanitizeR2Config(v);
}

export async function saveR2Config(env, patch) {
  const cur = await readR2Config(env);
  const next = sanitizeR2Config({ ...cur, ...patch });
  await env.KV.put(KV_KEY, JSON.stringify(next));
  return next;
}
