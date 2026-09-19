import { slugify, randomSuffix, kvKey, validTarget, isIpv4 } from './util.js';
import { runtime } from './runtime.js';
import { CONFIG_CACHE_TTL_MS } from './config.js';

// 站点配置的持久化层：读写 Cloudflare KV，前缀 site:*
//
// 为什么这里要有一层进程内缓存（而不直接每请求读一次存储）：
// `getSite()` 落在**每个反代请求的热路径**上 —— 媒体播放时一个视频上百个分片、
// 每个分片都要过一遍；入口还会为同一个请求再读一次决定是否记账（worker.js 的媒体分支）。
// 一次播放就是两三百次存储读，而这些数据在秒级尺度上根本不会变。
//
// 窗口与其它模块共用同一个常量（config.js 的 CONFIG_CACHE_TTL_MS），
// 「多长算新鲜」这句话全项目只有一处定义。

const SITE_CACHE_MAX = 500;   // 站点数量级很小；超限整体清空比逐个淘汰简单也够用

let siteCache = new Map();    // slug -> { site, ts }（site 为 null 表示「确认没有」，负缓存）
let listCache = null;         // { sites, ts }

/**
 * 作废站点缓存。
 * @param {string} [slug] 只作废单个站点；不传则整表作废（新增 / 删除站点时用）
 *
 * 调用点必须是**每一次写入之后**（含改 slug 的 put+delete），漏一处就会出现
 * 「改完 slug 三秒内仍走旧值 / 刚添加的站点 404」—— 这类症状看起来像
 * 「保存成功、行为不变」，正是本项目最忌讳也最难查的一类。
 */
export function invalidateSite(slug) {
  if (slug === undefined || slug === null) { listCache = null; siteCache.clear(); return; }
  siteCache.delete(String(slug));
  listCache = null;
}

async function listSites() {
  if (listCache && Date.now() - listCache.ts < CONFIG_CACHE_TTL_MS) return listCache.sites;
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
  listCache = { sites, ts: Date.now() };
  return sites;
}

async function getSite(id) {
  const key = String(id || '');
  const hit = siteCache.get(key);
  // 负缓存：`autoSlug()` 会连着探测 8 个随机 slug，每次都是「不存在」。
  // 不把「没有」也记下来的话，加一个站点要先打 8 次存储 —— 缓存反而只帮了倒忙。
  if (hit && Date.now() - hit.ts < CONFIG_CACHE_TTL_MS) return hit.site;
  const v = await runtime.KV.get(kvKey(key));
  let site = null;
  if (v) {
    try { site = JSON.parse(v); } catch { site = null; }
  }
  if (siteCache.size >= SITE_CACHE_MAX) siteCache.clear();
  siteCache.set(key, { site, ts: Date.now() });
  return site;
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
    // 判定用 util.js 的唯一实现：这里原先自带一份只验段数的正则，
    // 与别处口径不一致（`999.999.999.999` 会被当成 IP 而走 http）
    if (isIpv4(host) || (port && port !== '443')) {
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
  // 新 slug 必须进缓存，否则「刚添加的站点打不开」—— 负缓存会把它当成不存在
  invalidateSite(slug);
  return site;
}

// ===================== 管理 API =====================

export { listSites, getSite, autoSlug, validSlug, buildTarget, addSite };
