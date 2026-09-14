/**
 * Any-Proxy · Cloudflare Workers 统一入口
 *
 * 本项目把一个 Worker 拆成职责单一的模块，入口只负责：
 *   1. 绑定运行时（KV / 口令）
 *   2. 把请求交给路由
 *
 * 模块分工见 README「目录结构」，想扩展能力时改动对应模块即可：
 *   src/router.js  路由与接入
 *   src/proxy.js   反向代理（HTTP / WebSocket）
 *   src/url.js     命名空间映射与内容重写（通用规则，不含站点特判）
 *   src/inject.js  注入到被代理页面的运行时脚本
 *   src/sites.js   站点配置持久化（KV）
 *   src/admin.js   管理 REST API 与管理页
 *   src/auth.js    登录 / 登出 / 登录页
 *   src/dns.js     优选 IP 与 DNS 自动更新
 *   src/util.js    无依赖小工具
 *   vendor/vless.js  第三方 edgetunnel 代理引擎（VLESS / Trojan / SS）
 */
import { bindRuntime } from './src/runtime.js';
import { handleRequest } from './src/router.js';
import { scheduledDnsCheck } from './src/dns.js';

export default {
  async fetch(request, env, ctx) {
    bindRuntime(env);
    return handleRequest(request, env, ctx);
  },
  /** 定时任务：自动优选 IP 并更新 DNS（实际执行间隔由前端可配，默认 12 小时） */
  async scheduled(event, env, ctx) {
    bindRuntime(env);
    ctx.waitUntil(scheduledDnsCheck(env));
  },
};
