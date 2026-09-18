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
import { sweepMediaR2 } from './src/proxy.js';
import { readConfig, isActive, renderNotFound } from './src/disguise.js';
import { record as recordVisit, recordBytes } from './src/stats.js';
import { matchVisitScope } from './src/scopes.js';
import { getSite } from './src/sites.js';

/** WebSocket 升级响应没有正常响应体，不能套流计数 */
const WS_SWITCHING_PROTOCOLS = 101;

/**
 * 超过此声明体积的响应不再套流计数（与 proxy.js 的 MAX_CACHE_BYTES 同值）。
 * 原因见 countResponseBytes 透传分支的注释。
 */
const PASSTHROUGH_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 响应字节计数的两条路：
 *
 * 1. 小响应（页面 / 接口 / 图片 / JS / CSS）：套 TransformStream 边发边数**实际传输字节**。
 *    不信任响应头 Content-Length —— 后者是「声称的大小」，大文件请求一旦被客户端中途
 *    掐断（播放器放弃、弱网断流），头里整片的大小会被当成实际流量，日志里出现几十 GB
 *    的虚高（线上实测：边缘只发了 0.5GB，日志记了 20GB）。小响应量小，逐 chunk 累加的
 *    CPU 开销可忽略，无中断风险。
 *
 * 2. 媒体 / 大文件响应（206 分片、video/audio、带 Range、声明体积 > 4MB）：**直接透传，
 *    不套流**。教训：给所有响应套 TransformStream 后，高速转发时每个 chunk 都要执行 JS
 *    回调（累加 + enqueue），累计 CPU 撞上 CF 免费版 10ms/请求配额 → Worker 被冻结 →
 *    响应流随机被掐 → 播放器分片拿不全 → 重试 / 无 Range 全量重下 → 「流量虚高但播不了」。
 *    播放流畅优先于逐字节精度：此类响应用上游 Content-Length 头记账（完整传输时 == 实际
 *    字节，不虚高），客户端中途断开的交叉信号由 CF 用量驾驶舱的边缘 499 计数承担。
 *
 * 顺带记两个维度（回答「流量都去哪了 / 是不是播不了」）：
 *   - aborted：流没发完就断开（客户端放弃）→ 计入 aborts（仅套流路径可感知）；
 *   - media：206 / video|audio / 带 Range 的请求 → 计入 mbytes。
 */
export function countResponseBytes(response, scope, env, ctx, media) {
  if (!response || !response.body) return response;
  if (response.status === WS_SWITCHING_PROTOCOLS) return response;

  const declared = parseInt(response.headers.get('content-length') || '0', 10);
  const ct = response.headers.get('content-type') || '';
  // 只有「体积已知」的媒体/大文件才透传（头记账有据可依）；
  // 没有 content-length 的分块媒体流（直播/动态流）无法用头记账，仍套流精确计数，
  // 这类响应通常量小或短暂，逐 chunk 回调的 CPU 开销可接受。
  const isPassthrough = declared > 0 && (media || declared > PASSTHROUGH_MAX_BYTES || /^(?:video|audio)\//.test(ct));
  if (isPassthrough) {
    // 媒体/大文件：零 CPU 透传，按上游声明体积记账（完整传输时精确）。
    // 若站点配了 mediaSkipDetailLog=1（媒体流跳过明细记账降 CPU），调用方已提前放行。
    if (declared > 0) {
      try {
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(recordBytes({ scope, bytes: declared, media: true, aborted: false, env }));
        }
      } catch { /* 统计永不阻塞请求 */ }
    }
    return response;
  }

  let total = 0;
  let aborted = false;
  let settle = null;
  const finished = new Promise(resolve => { settle = resolve; });

  // ⚠️ waitUntil 必须在**请求还活着的时候**登记。字节数要等流发完才有，而那时请求
  // 上下文早已结束，再调 ctx.waitUntil() 会被运行时丢掉、异常又被下面吞掉，症状就是
  // 「请求数一切正常、流量永远是 0 B」——旧实现就是在 flush() 里才调，线上正是这个病。
  // 所以先用一个 Promise 占位登记（此刻 ctx 还在），流结束时再把它 resolve 掉。
  if (ctx && typeof ctx.waitUntil === 'function') {
    try {
      ctx.waitUntil(finished.then(r => recordBytes({ scope, bytes: r.bytes, aborted: r.aborted, media, env })));
    } catch { /* 统计永不阻塞请求 */ }
  }

  const counter = new TransformStream({
    transform(chunk, ctrl) {
      total += chunk && chunk.byteLength ? chunk.byteLength : 0;
      ctrl.enqueue(chunk);
    },
    flush() { if (settle) settle({ bytes: total, aborted: false }); },
    // 客户端中途断开（弱网断流 / 播放器放弃）→ 把已传输的字节与「中断」标记一起交账
    cancel() { aborted = true; if (settle) settle({ bytes: total, aborted: true }); },
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
          // 媒体流分类：206 分片 / video|audio 内容 / 带 Range 的请求 —— 播放链路专用维度
          const ct = response.headers.get('content-type') || '';
          const media = response.status === 206 || /^(?:video|audio)\//.test(ct) || !!request.headers.get('range');
          if (media) {
            // 流媒体模式的站点可配 mediaSkipDetailLog=1：媒体请求跳过明细记账，降 CPU 与
            // KV/D1 写放大（流量风暴时有效）；默认 0 = 记录。配置读取失败时保守默认记录。
            let skipMediaDetail = false;
            try {
              const site = await getSite(scope);
              skipMediaDetail = !!(site && site.mediaSkipDetailLog);
            } catch {}
            if (skipMediaDetail) return response;
          }
          response = countResponseBytes(response, scope, env, ctx, media);
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
  /** 定时任务：自动优选 IP 并更新 DNS（实际执行间隔由前端可配，默认 12 小时）+ 清理 R2 媒体分片缓存 */
  async scheduled(event, env, ctx) {
    bindRuntime(env);
    ctx.waitUntil(Promise.all([scheduledDnsCheck(env), sweepMediaR2(env)]));
  },
};
