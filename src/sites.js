import { slugify, randomSuffix, kvKey, validTarget } from './util.js';
import { runtime } from './runtime.js';

// 站点配置的持久化层：读写 Cloudflare KV，前缀 site:*

async function listSites() {
  if (!runtime.KV || typeof runtime.KV.list !== 'function' || typeof runtime.KV.get !== 'function') {
    throw new Error('站点存储未绑定');
  }
  // KV.list 可能分页；只读取 site:*，避免超过 1000 个站点时静默丢列表。
  const keys = [];
  let cursor;
  do {
    const page = await runtime.KV.list({ prefix: 'site:', limit: 1000, ...(cursor ? { cursor } : {}) });
    if (!page || !Array.isArray(page.keys)) throw new Error('站点存储返回格式异常');
    keys.push(...page.keys);
    cursor = page.list_complete === true ? '' : (page.cursor || '');
  } while (cursor && keys.length < 10000);
  const sites = (await Promise.all(keys.map(async k => {
    try {
      const v = await runtime.KV.get(k.name);
      if (!v) return null;
      return JSON.parse(v);
    } catch {
      // 单条损坏或瞬时读取失败不应拖垮整个首页列表。
      return null;
    }
  }))).filter(Boolean);
  return sites;
}

async function getSite(id) {
  const v = await runtime.KV.get(kvKey(id));
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/** 自动生成一个尚未占用的访问后缀 */
async function autoSlug() {
  for (let i = 0; i < 8; i++) {
    const s = `site-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await getSite(s))) return s;
  }
  return `site-${Date.now().toString(36)}`;
}

function validSlug(s) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(s);
}

/**
 * 根据「网址 + 可选端口」构建目标。
 * rawTarget 兼容：https://host、host、host:8080、http://ip:80 等
 * 返回 { scheme, host(含端口), port, url } 或 null
 */

/**
 * 根据「网址 + 可选端口」构建目标。
 * rawTarget 兼容：https://host、host、host:8080、http://ip:80 等
 * 返回 { scheme, host(含端口), port, url } 或 null
 */
function buildTarget(rawTarget, rawPort) {
  let t = String(rawTarget || '').trim();
  if (!t) return null;

  // 显式协议（用户指定则优先）
  let scheme = null;
  const protoMatch = t.match(/^(https?):\/\//i);
  if (protoMatch) {
    scheme = protoMatch[1].toLowerCase();
    t = t.replace(/^https?:\/\//i, '');
  }

  // 只保留 host[:port]
  t = t.split('/')[0].split('?')[0].split('#')[0];
  if (!t) return null;

  let host = t;
  let port = String(rawPort || '').trim().replace(/[^0-9]/g, '');
  if (!port) {
    const m = t.match(/^(.*):(\d+)$/);
    if (m) {
      host = m[1];
      port = m[2];
    }
  } else {
    host = host.replace(/:\d+$/, '');
  }
  if (!host) return null;

  // 未显式指定协议时自动判断：
  //  - IP 地址 -> http
  //  - 带端口（非 443，通常为自建服务）-> http
  //  - 纯域名 -> https
  if (!scheme) {
    const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    if (isIpv4 || (port && port !== '443')) {
      scheme = 'http';
    } else {
      scheme = 'https';
    }
  }

  const hostWithPort = port ? `${host}:${port}` : host;
  return {
    scheme,
    host: hostWithPort,
    port: port || null,
    url: `${scheme}://${hostWithPort}`,
  };
}

async function addSite(name, slug, built) {
  const site = {
    id: slug,
    name: String(name).trim(),
    scheme: built.scheme,
    host: built.host,
    port: built.port,
    target: built.url,
    created_at: new Date().toISOString(),
  };
  await runtime.KV.put(kvKey(slug), JSON.stringify(site));
  return site;
}

// ===================== 管理 API =====================

export { listSites, getSite, autoSlug, validSlug, buildTarget, addSite };
