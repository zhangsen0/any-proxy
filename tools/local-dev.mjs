#!/usr/bin/env node
/**
 * 本地验证服务器：不依赖 Cloudflare，直接在 Node 上跑真实的入口逻辑。
 *
 * 用法：node tools/local-dev.mjs [端口]
 *
 * 预置站点 github -> https://github.com；github.com 若被本机网络限制，
 * 可先跑 node tools/seed-demo.mjs 加一个可达站点做功能验证。
 */
import http from 'node:http';
import { handleRequest } from '../src/router.js';
import { bindRuntime } from '../src/runtime.js';

const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const PASSWORD = process.env.PASSWORD || 'dev';

// ---- 内存版 KV ----
const mem = new Map();
mem.set('site:github', JSON.stringify({
  id: 'github', name: 'github', scheme: 'https', host: 'github.com',
  port: null, target: 'https://github.com', created_at: new Date().toISOString(),
}));
const kv = {
  async list(o = {}) {
    const p = o.prefix || '';
    return { keys: [...mem.keys()].filter(k => k.startsWith(p)).map(name => ({ name })), list_complete: true };
  },
  async get(k) { return mem.has(k) ? mem.get(k) : null; },
  async put(k, v) { mem.set(k, v); },
  async delete(k) { mem.delete(k); },
};

// 可选：额外预置站点，格式 "id=target,id2=target2"，便于把本地 fixture 站点直接挂进来验证
for (const pair of String(process.env.SEED_SITES || '').split(',').filter(Boolean)) {
  const [id, target] = pair.split('=');
  if (!id || !target) continue;
  let u;
  try { u = new URL(target); } catch { continue; }
  mem.set('site:' + id, JSON.stringify({
    id, name: id, scheme: u.protocol.replace(':', ''), host: u.host,
    port: u.port || null, target: u.origin, created_at: new Date().toISOString(),
  }));
}

// 可选：预置一个 fixture 站点（FIXTURE=http://127.0.0.1:8799），方便本地直接用 fixtures 做反代验证
if (process.env.FIXTURE) {
  try {
    const u = new URL(process.env.FIXTURE);
    mem.set('site:fix', JSON.stringify({
      id: 'fix', name: 'fixture', scheme: u.protocol.replace(':', ''), host: u.host,
      port: u.port || null, target: u.origin, created_at: new Date().toISOString(),
    }));
  } catch {}
}

const env = { PASSWORD, SITES: kv };
bindRuntime(env);

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const url = new URL(req.url, `http://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
    else headers.set(k, v);
  }
  const bodyBuf = req.method === 'GET' || req.method === 'HEAD'
    ? undefined
    : await new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

  let out;
  try {
    out = await handleRequest(new Request(url.toString(), { method: req.method, headers, body: bodyBuf }), env, {});
  } catch (e) {
    out = new Response('worker error: ' + (e && e.stack || e), { status: 500 });
  }
  res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
  res.end(Buffer.from(await out.arrayBuffer()));
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Any-Proxy 本地验证服务已启动');
  console.log(`  反代示例:  http://127.0.0.1:${PORT}/p/github/zhangsen0/any-proxy`);
  console.log(`  管理页:    http://127.0.0.1:${PORT}/__admin   (口令: ${PASSWORD})`);
  console.log('');
});
