// 出口压缩：把 Worker 改写后的正文压一遍再发给浏览器。
//
// 为什么需要它：反代的正文链路是「上游压缩 → Worker 读 body 解压 → 改写 → 明文输出」。
// 解出的明文若不再压缩，浏览器拿到的就是原始体量——几百 KB 的 JS bundle、
// 上百 KB 的 HTML 都是裸奔。同一个首屏在这段路上能差好几倍。
//
// Workers runtime 提供 CompressionStream('gzip')（brotli 在 Worker 里不可用），
// 压缩在流上做，不需要额外复制一整个大字符串。
//
// 两条硬约束：
//   1. 任何异常都必须退回未压缩版本。慢一点没关系，发出去坏 body 会让整站 JS/CSS 挂掉。
//   2. 只在明确可压缩时压缩：流式响应（SSE）、二进制、已压缩的都不碰。

const MIN_BYTES = 512; // 太小的正文压了反而变大（gzip 头本身就要十几个字节）

/**
 * 解析 Accept-Encoding：明确列出目标编码且 q>0 才算接受，`*` 视为通配。
 * 手写解析是因为 "gzip;q=0" 这种写法不能用 includes 判断，误判后会发出浏览器解不开的 body。
 */
export function acceptsEncoding(header, name) {
  const raw = String(header || '').trim();
  if (!raw) return false;
  for (const part of raw.split(',')) {
    const [token, ...params] = part.split(';');
    const tok = String(token).trim().toLowerCase();
    if (tok !== name && tok !== '*') continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) {
        const v = parseFloat(m[1]);
        if (!Number.isNaN(v)) q = v;
      }
    }
    if (q > 0) return true;
  }
  return false;
}

/** 响应是否适合压缩：已压缩过、二进制、流式（SSE）都不能再压。 */
export function compressible(headers) {
  try {
    if (headers.get('content-encoding')) return false;
    const ct = String(headers.get('content-type') || '').toLowerCase();
    // SSE / streaming 一旦压缩就会被缓冲住，实时性直接没了
    if (/event-stream|video\/|audio\/|image\/|octet-stream|zip\/|pdf|protobuf/i.test(ct)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 条件性 gzip 输出。
 * @param {number} status
 * @param {string} text 已改写的正文（明文）
 * @param {Headers} headers 准备发出的响应头
 * @param {string} acceptEncoding 浏览器原始 Accept-Encoding
 * @returns {Response}
 */
export function finalizeResponse(status, text, headers, acceptEncoding) {
  const plain = () => new Response(text, { status, headers: new Headers(headers) });
  try {
    const enabled = acceptsEncoding(acceptEncoding, 'gzip');
    if (!enabled) return plain();
    if (typeof CompressionStream !== 'function') return plain();
    if (typeof Blob !== 'function') return plain();
    if (!compressible(headers)) return plain();
    if (text === null || text === undefined) return plain();
    const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
    if (!bytes || bytes.byteLength < MIN_BYTES) return plain();

    const gz = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    const out = new Headers(headers);
    out.set('Content-Encoding', 'gzip');
    out.delete('Content-Length'); // 长度已经变了，留着会导致浏览器截断或一直等
    // 同一份资源会按是否支持 gzip 发出两种形态，必须让缓存区分开
    const vary = out.get('Vary');
    out.set('Vary', vary && !/accept-encoding/i.test(vary) ? `${vary}, Accept-Encoding` : (vary || 'Accept-Encoding'));
    return new Response(gz, { status, headers: out });
  } catch {
    return plain(); // 压缩失败就发明文，绝不因为优化把页面搞坏
  }
}
