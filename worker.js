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
 *   src/stats.js   访问统计（内存聚合 + 批量落盘）
 *   src/util.js    无依赖小工具
 *   vendor/vless.js  第三方 edgetunnel 代理引擎（VLESS / Trojan / SS）
 */
import { bindRuntime } from './src/runtime.js';
import { handleRequest } from './src/router.js';
import { scheduledDnsCheck } from './src/dns.js';
import { readConfig, isActive, renderNotFound } from './src/disguise.js';
import { record as recordVisit } from './src/stats.js';

/**
 * 请求路径 -> 统计通道。放在入口而不是路由内部：路由里分支太多，
 * 每加一个出口就要记得补一次统计，漏一个就是「某个通道的数据永远为空」。
 * 返回空字符串表示不计入（伪装页、favicon、robots 这类噪声）。
 */
function visitScope(pathname) {
  const p = String(pathname || '');
  let m = /^\/p\/([^/]+)/.exec(p);
  if (m) return 'p:' + decodeURIComponent(m[1]);
  if (/^\/s\/[^/]+/.test(p)) return 'share';
  if (p === '/tsub' || p.startsWith('/tsub/')) return 'tsub';
  if (p === '/sub' || p.startsWith('/sub/')) return 'sub';
  if (p === '/edt' || p.startsWith('/edt/')) return 'edt';
  if (p === '/admin' || p.startsWith('/admin/')) return 'edt-admin';
  if (p === '/__admin' || p === '/__tsub' || p.startsWith('/__api')) return 'admin';
  if (p === '/__login' || p === '/login') return 'login';
  return '';
}

export default {
  async fetch(request, env, ctx) {
    try {
      bindRuntime(env);
      const response = await handleRequest(request, env, ctx);
      // 统计永不阻塞、永不抛：record 内部把落盘挂到 waitUntil，异常就地吞掉
      try {
        const scope = visitScope(new URL(request.url).pathname);
        if (scope) {
          recordVisit({
            scope,
            response,
            ip: request.headers.get('CF-Connecting-IP'),
            env,
            ctx,
            failed: response.status >= 500,
          });
        }
      } catch {}
      return response;
    } catch (e) {
      // 全局兜底：任何未捕获异常返回 500 + 错误信息，避免 CF 层 530（并发突发时曾集体 530）。
      // 但伪装开启时不能把内部异常原文吐给陌生人 —— 那等于替攻击者解释了一次失败原因，
      // 也可能顺带泄漏内部路径与配置。此时代之以「用当前伪装模板渲染的 404」。
      try {
        const cfg = await readConfig(env);
        if (isActive(cfg)) return renderNotFound(cfg, request);
      } catch {}
      return new Response('proxy error: ' + String(e && e.message || e).slice(0, 500), {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  },
  /** 定时任务：自动优选 IP 并更新 DNS（实际执行间隔由前端可配，默认 12 小时） */
  async scheduled(event, env, ctx) {
    bindRuntime(env);
    ctx.waitUntil(scheduledDnsCheck(env));
  },
};
