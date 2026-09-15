import { runtime } from './runtime.js';

// 临时订阅管理：
//   在不改动代理面板主配置的前提下，创建一批「独立 UUID、限时有效」的订阅链接。
//   每条记录复用 edgetunnel 面板的全部节点配置（地址/路径/优选IP等），仅替换 UUID 与有效期。
//   持久化在 runtime.KV（D1 kv 表），前缀 tempsub:<id>，无需新建表。
//
// 记录结构：
//   { id, name, uuid, created_at, expires_at, disabled }
//   - uuid       创建时随机生成的 v4 节点 UUID（与面板主 UUID 不同）
//   - expires_at ISO 时间字符串；过期即视为失效
//   - disabled   手动置为失效（管理员一键停用，可再启用）

const PREFIX = 'tempsub:';
const DAY_MS = 86400000;
const MAX_DAYS = 3650;
const MIN_DAYS = 1;

function nowMs() { return Date.now(); }

function clampDays(days) {
  const n = parseInt(days, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, n));
}

function generateId() {
  return 't' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function generateUuid() {
  return (crypto.randomUUID ? crypto.randomUUID() : fallbackUuidv4()).toLowerCase();
}

function fallbackUuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

// 与 edgetunnel 订阅密钥口径一致：MD5MD5(text) = MD5(MD5(text).hex.slice(7,27))。
// 订阅 token = MD5MD5(host + uuid)，host 取请求 hostname（未配置 HOST 变量时的同一口径）。
async function md5Hex(s) {
  const buf = await crypto.subtle.digest('MD5', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function subToken(host, uuid) {
  const first = await md5Hex(String(host) + String(uuid));
  return (await md5Hex(first.slice(7, 27))).toLowerCase();
}

async function listAll() {
  if (!runtime.KV || typeof runtime.KV.list !== 'function') return [];
  const keys = [];
  let cursor;
  do {
    const page = await runtime.KV.list({ prefix: PREFIX, limit: 500, ...(cursor ? { cursor } : {}) });
    if (!page || !Array.isArray(page.keys)) break;
    keys.push(...page.keys);
    cursor = page.list_complete === true ? '' : (page.cursor || '');
  } while (cursor && keys.length < 5000);

  const now = nowMs();
  const items = (await Promise.all(keys.map(async (k) => {
    try {
      const v = await runtime.KV.get(k.name);
      return v ? JSON.parse(v) : null;
    } catch { return null; }
  }))).filter(Boolean);

  // 机会式清理：过期记录直接删除（停用但未过期的保留，便于管理员重新启用）。
  // 无需 Cron 触发器，管理员下次打开列表或客户端拉取过期链接时自然回收，避免 D1 堆积垃圾数据。
  const live = [];
  for (const item of items) {
    if (item && item.expires_at && new Date(item.expires_at).getTime() <= now) {
      try { await runtime.KV.delete(PREFIX + item.id); } catch {}
    } else if (item) {
      live.push(item);
    }
  }
  live.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return live;
}

async function get(id) {
  try {
    const v = await runtime.KV.get(PREFIX + String(id));
    if (!v) return null;
    const rec = JSON.parse(v);
    // 拉取命中已过期记录时顺手删除，避免失效链接长期残留。
    if (rec && rec.expires_at && new Date(rec.expires_at).getTime() <= nowMs()) {
      try { await runtime.KV.delete(PREFIX + String(id)); } catch {}
      return null;
    }
    return rec;
  } catch { return null; }
}

async function create({ name, days }) {
  const rec = {
    id: generateId(),
    name: String(name || '').trim() || ('临时订阅 ' + new Date().toISOString()),
    uuid: generateUuid(),
    created_at: new Date().toISOString(),
    expires_at: new Date(nowMs() + clampDays(days) * DAY_MS).toISOString(),
    disabled: false,
  };
  await runtime.KV.put(PREFIX + rec.id, JSON.stringify(rec));
  return rec;
}

async function update(id, { name, days, disabled }) {
  const rec = await get(id);
  if (!rec) return null;
  if (name !== undefined) rec.name = String(name).trim() || rec.name;
  if (disabled !== undefined) rec.disabled = !!disabled;
  if (days !== undefined && days !== null && String(days).trim() !== '') {
    rec.expires_at = new Date(nowMs() + clampDays(days) * DAY_MS).toISOString();
  }
  await runtime.KV.put(PREFIX + rec.id, JSON.stringify(rec));
  return rec;
}

async function remove(id) {
  await runtime.KV.delete(PREFIX + String(id));
}

// 公共判定：记录当前是否有效（未删除 / 未手动禁用 / 未过期）
function isActive(rec) {
  if (!rec || rec.disabled) return false;
  if (!rec.expires_at) return true;
  return new Date(rec.expires_at).getTime() > nowMs();
}

export { PREFIX, listAll, get, create, update, remove, isActive, subToken };
