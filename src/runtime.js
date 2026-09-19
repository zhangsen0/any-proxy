// Cloudflare 注入的运行时绑定集中放在这里：所有模块共享同一份引用，避免各处各存一份副本

import { createD1KV } from './storage.js';
import { wrapStorage } from './memstore.js';

export const runtime = { KV: undefined, PASSWORD: undefined };

/**
 * 每个请求进来时把平台注入的绑定挂到共享容器上。STORAGE_BACKEND 由 GitHub 环境变量控制。
 *
 * 三个后端：d1（默认）/ kv / memory。第三个不碰任何存储，全部落在进程内内存里，
 * 用在 D1 / KV 配额打满或绑定缺失的时候 —— 宁可退化运行，也不要整站不可用。
 *
 * 三个后端之上都套一层 wrapStorage：它在真实存储读写出问题时自动切到内存，
 * 保证上层拿到的永远是一个「能用的」KV 同形对象。
 */
export function bindRuntime(env) {
  const backend = String((env && env.STORAGE_BACKEND) || 'd1').toLowerCase();
  let raw = null;
  if (backend === 'kv') raw = env && env.SITES;
  else if (backend === 'memory') raw = null;      // 显式不用存储
  else raw = env && env.DB ? createD1KV(env.DB) : env && env.SITES;
  runtime.KV = wrapStorage(raw, env);
  runtime.PASSWORD = env && env.PASSWORD;
  return runtime;
}

// ===================== 配置变更钩子 =====================
//
// 背景：除了 config.js 那份按 3 秒 TTL 复用的配置文档，各模块还有自己的「进程内快照」——
// geoip 的官方 IP 段、cf-analytics 的用量缓存、限流的封禁快照等。这些快照一旦建立，
// 面板里改完配置也不会被感知，于是「保存成功、行为不变」——用户只会以为改错了地方。
//
// 所以：模块把自己快照的清理函数注册进来，config.js 每次写入配置后统一通知一遍，
// 保证「面板保存 → 下一个请求就用新值」，不必等 TTL 过期、也不必重新部署。
// 钩子只做内存清理，失败不影响写入结果，故静默 —— 这是**唯一的**静默理由。
const configHooks = [];

/** 注册一个「配置变了就丢掉快照」的回调 */
export function onConfigChange(fn) {
  if (typeof fn === 'function' && !configHooks.includes(fn)) configHooks.push(fn);
}

/** 配置写入后广播。section 是变动的分区名，便于模块只清自己关心的那部分。 */
export function notifyConfigChange(section = '') {
  for (const fn of configHooks) {
    try { fn(section); } catch { /* 清理动作不该把写入结果带崩 */ }
  }
}

/** 单测用：清空注册表，避免用例之间互相影响 */
export function resetConfigHooks() { configHooks.length = 0; }

