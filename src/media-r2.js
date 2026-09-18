import { runtime } from './runtime.js';

// R2 媒体分片缓存的策略配置（KV 可编辑，唯一真源）：
//   enabled      总开关：关闭后不再写入也不命中 R2 分片缓存，链路回到 Cache API + 透传；
//   ttlDays      分片保留天数：超过后由 cron 的 sweepMediaR2 定时删除（1~365，默认 7）；
//   maxObjectMB  单分片缓存上限：超过的 206 分片不写 R2，避免读大流打爆内存（1~256，默认 64）；
//   maxTotalMB   缓存总量上限：超过后 sweep 按最旧优先删到不超（0 不限，默认 10GB=免费额度）。
// 面板「配置中心 → R2 媒体缓存」可改并立即生效；R2_PREFIX 是结构键（改动会使旧缓存全部失效），
// 不属于策略参数，保持稳定，导出供 proxy.js 与面板统计共用（单一真源）。
// 存储统一走 runtime.KV（全局注入的 KV 抽象，binding 名为 SITES，与全项目一致）。
export const R2_PREFIX = 'media/';

export const R2_CACHE_SPEC = {
  enabled: { default: true, desc: 'R2 媒体分片缓存总开关' },
  ttlDays: { min: 1, max: 365, default: 7, desc: '分片保留天数' },
  maxObjectMB: { min: 1, max: 256, default: 64, desc: '单分片缓存上限（MB）' },
  maxTotalMB: { min: 0, max: 102400, default: 10240, desc: '缓存总量上限（MB，0 不限）' },
};

const KV_KEY = 'r2-cache-config.json';

/** 净化：开关必须是布尔；天数 1~365、单分片 1~256、总量 0~102400 的整数；非法字段回退默认 */
export function sanitizeR2Config(cfg) {
  const out = {
    enabled: R2_CACHE_SPEC.enabled.default,
    ttlDays: R2_CACHE_SPEC.ttlDays.default,
    maxObjectMB: R2_CACHE_SPEC.maxObjectMB.default,
    maxTotalMB: R2_CACHE_SPEC.maxTotalMB.default,
  };
  if (!cfg || typeof cfg !== 'object') return out;
  if (typeof cfg.enabled === 'boolean') out.enabled = cfg.enabled;
  const d = parseInt(cfg.ttlDays, 10);
  if (!Number.isNaN(d)) out.ttlDays = Math.min(R2_CACHE_SPEC.ttlDays.max, Math.max(R2_CACHE_SPEC.ttlDays.min, d));
  const m = parseInt(cfg.maxObjectMB, 10);
  if (!Number.isNaN(m)) out.maxObjectMB = Math.min(R2_CACHE_SPEC.maxObjectMB.max, Math.max(R2_CACHE_SPEC.maxObjectMB.min, m));
  const t = parseInt(cfg.maxTotalMB, 10);
  if (!Number.isNaN(t)) out.maxTotalMB = Math.min(R2_CACHE_SPEC.maxTotalMB.max, Math.max(R2_CACHE_SPEC.maxTotalMB.min, t));
  return out;
}

/**
 * 自己解析，不依赖 KV 的 'json' 选项。
 *
 * 真人踩过的坑：原先写的是 get(KV_KEY, 'json')。原生 KV binding 支持这个第二参数，
 * 但 D1 后端（createD1KV）的 get 只声明了一个形参，第二参数被丢掉、返回的是**字符串**。
 * sanitizeR2Config 收到字符串会整份回退默认值 —— 于是「面板提示已保存，刷新后又变回默认」。
 * 同一个项目两种存储后端，读取口径必须自己兜住，不能指望底层抽象。
 */
export async function readR2Config() {
  const raw = await runtime.KV.get(KV_KEY).catch(() => null);
  let v = null;
  if (raw && typeof raw === 'object') v = raw;
  else if (typeof raw === 'string' && raw.trim()) { try { v = JSON.parse(raw); } catch { v = null; } }
  return sanitizeR2Config(v);
}

export async function saveR2Config(patch) {
  const cur = await readR2Config();
  // 「留空保持不变」：patch 里的空值（undefined/null/空字符串）不覆盖原值
  const p = { ...(patch && typeof patch === 'object' ? patch : {}) };
  for (const k of Object.keys(p)) {
    if (p[k] === undefined || p[k] === null || String(p[k]).trim() === '') delete p[k];
  }
  const next = sanitizeR2Config({ ...cur, ...p });
  await runtime.KV.put(KV_KEY, JSON.stringify(next));
  return next;
}
