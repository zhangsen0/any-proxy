// Cloudflare 注入的运行时绑定集中放在这里：所有模块共享同一份引用，避免各处各存一份副本

import { createD1KV } from './storage.js';

export const runtime = { KV: undefined, PASSWORD: undefined };

/** 每个请求进来时把平台注入的绑定挂到共享容器上。STORAGE_BACKEND 由 GitHub 环境变量控制。 */
export function bindRuntime(env) {
  const backend = String(env && env.STORAGE_BACKEND || 'd1').toLowerCase();
  runtime.KV = backend === 'kv' ? env && env.SITES : (env && env.DB ? createD1KV(env.DB) : env && env.SITES);
  runtime.PASSWORD = env && env.PASSWORD;
  return runtime;
}

