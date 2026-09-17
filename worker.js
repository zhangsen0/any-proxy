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
 *   src/scopes.js  访问通道登记表（路径 → 通道 / 中文名 / 是否管理通道）
 *   src/util.js    无依赖小工具
 *   vendor/vless.js  第三方 edgetunnel 代理引擎（VLESS / Trojan / SS）
 */
import { bindRuntime } from './src/runtime.js';
import { handleRequest } from './src/router.js';
import { scheduledDnsCheck } from './src/dns.js';
import { readConfig, isActive, renderNotFound } from './src/disguise.js';
import { record as recordVisit, recordBytes } from './src/stats.js';
import { matchVisitScope } from './src/scopes.js';

/** WebSocket 升级响应没有正常响应体，不能套流计数 */
const WS_SWITCHING_PROTOCOLS = 101;

/**
 * 响应没有 Content-Length 时（上游 chunked 很常见）边发边数真实字节数。
 * 用 TransformStream 只做累加，不缓存内容，所以大文件也不会多占内存。
 * 数完回填给统计：这一步失败只影响「流量」，不影响请求数。
 */
function countResponseBytes(response, scope, env, ctx) {
  if (!response || !response.body) return response;
  if (response.status === WS_SWITCHING_PROTOCOLS) return response;
  // 有 Content-Length 的：record() 已经照响应头记过字节数，这里直接放行（省掉一层流）
  if (response.headers.get('content-length')) return response;

  let total = 0;
  let settle = null;
  const finished = new Promise(resolve => { settle = resolve; });

  // ⚠️ waitUntil 必须在**请求还活着的时候**登记。字节数要等流发完才有，而那时请求
  // 上下文早已结束，再调 ctx.waitUntil() 会被运行时丢掉、异常又被下面吞掉，症状就是
  // 「请求数一切正常、流量永远是 0 B」——旧实现就是在 flush() 里才调，线上正是这个病。
  // 所以先用一个 Promise 占位登记（此刻 ctx 还在），流结束时再把它 resolve 掉。
  if (ctx && typeof ctx.waitUntil === 'function') {
    try {
      ctx.waitUntil(finished.then(n => recordBytes({ scope, bytes: n, env })));
    } catch { /* 统计永不阻塞请求 */ }
  }

  const counter = new TransformStream({
    transform(chunk, ctrl) {
      total += chunk && chunk.byteLength ? chunk.byteLength : 0;
      ctrl.enqueue(chunk);
    },
    flush() { if (settle) settle(total); },
  });

  return new Response(response.body.pipeThrough(counter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    try {
      bindRuntime(env);
      let response = await handleRequest(request, env, ctx);
      // 统计永不阻塞、永不抛：record 内部把落盘挂到 waitUntil，异常就地吞掉
      try {
        const scope = matchVisitScope(new URL(request.url).pathname);
        if (scope) {
          recordVisit({
            scope,
            response,
            ip: request.headers.get('CF-Connecting-IP'),
            env,
            ctx,
            failed: response.status >= 500,
          });
          response = countResponseBytes(response, scope, env, ctx);
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
