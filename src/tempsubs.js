import { runtime } from './runtime.js';
import { md5md5 } from './util.js';

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

// 默认名称：未填名称时用创建时间占位。服务端无浏览器时区，按 UTC+8 格式化并标注，
// 避免把 UTC 时间误读成本地时间（与列表下方的本地时间展示保持一致）。
function defaultName() {
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 偏移到 UTC+8
  const iso = d.toISOString().slice(0, 19).replace('T', ' ');
  return '临时订阅 ' + iso + ' 北京时间';
}

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
// 实现取 util.js 的那一份 —— 全项目只有一处，避免与主订阅的 token 算法分叉。
async function subToken(host, uuid) {
  return await md5md5(String(host) + String(uuid));
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

  const items = (await Promise.all(keys.map(async (k) => {
    try {
      const v = await runtime.KV.get(k.name);
      return v ? JSON.parse(v) : null;
    } catch { return null; }
  }))).filter(Boolean);
  items.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return items;
}

async function get(id) {
  try {
    const v = await runtime.KV.get(PREFIX + String(id));
    return v ? JSON.parse(v) : null;
  } catch { return null; }
}

async function create({ name, days }) {
  const rec = {
    id: generateId(),
    name: String(name || '').trim() || defaultName(),
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
