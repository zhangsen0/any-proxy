// 出口编码契约：Worker 一律发明文，压缩协商全权交给 CF 边缘。
//
// 为什么不允许 Worker 自己 gzip（真实事故：uhdnow 整站乱码，两次）：
//   1. 边缘会改写入站 Accept-Encoding——浏览器明确发了 `identity`，Worker 里读到的
//      仍可能包含 gzip，于是按「客户端接受压缩」误压缩；
//   2. 对没有要压缩的客户端，边缘会把响应头的 Content-Encoding 直接剥掉、**并不解压**
//      ——浏览器拿到裸 gzip 字节按文本渲染，整页乱码（线上抓包：body 前 2 字节 1f 8b、
//      响应头无 Content-Encoding，workers.dev 与自定义域行为一致）；
//   3. 而对支持压缩的客户端，边缘本来就会自动压（线上见过边缘发 zstd，Worker 根本
//      不生产 zstd）。Worker 再压一遍不但多余，还踩上面的剥头陷阱。
//
// 结论：明文出 Worker，能压的边缘会压，不能压的本来就明文，两头都对。

/**
 * 出口定稿：把改写完成的正文包装成响应。
 * 无论 acceptEncoding 是什么都发明文——参数仅为兼容旧调用点保留。
 * @param {number} status
 * @param {string|ArrayBuffer} text 已改写的正文（明文）
 * @param {Headers} headers 准备发出的响应头
 * @param {string} [acceptEncoding] 已废弃，忽略
 * @returns {Response}
 */
export function finalizeResponse(status, text, headers) {
  return new Response(text, { status, headers: new Headers(headers) });
}
