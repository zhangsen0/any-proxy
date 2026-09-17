/**
 * 站点临时访问链接：给某个反代站点开一条「到期自动作废」的短链。
 *
 * 与 /p/<id>/ 的区别：
 *   /p/<id>/ 是站点自己的长期入口；临时链接是一条**另有有效期和访问次数上限**的旁路入口，
 *   适合「发给别人看一眼」的场景 —— 到期即失效，不用回头记得去删。
 *
 * 存储：runtime.KV（D1 kv 表），键 share:<token>，不新建表。
 * 校验：token 只认 [A-Za-z0-9_-]，其余一律当作无效（避免把存储键当路径遍历来打）。
 */

import { readSection, writeSection, sanitize } from './config.js';
import { runtime } from './runtime.js';
import { getSite } from './sites.js';

const PREFIX = 'share:';
const DAY_MS = 86400000;
const TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;

const SPEC = {
  enabled: { type: 'bool', default: false, env: 'SHARE_ENABLED' },
  // 链接前缀可配：默认 /s，想换成别的段（或避开既有路由）直接改这一项
  path_prefix: {
    type: 'str',
    default: '/s',
    maxLen: 32,
    env: 'SHARE_PATH_PREFIX',
    validate: (v) => {
      const s = String(v || '').trim();
      if (!s.startsWith('/')) return '链接前缀必须以 / 开头';
      if (/\s/.test(s)) return '链接前缀不能含空格';
      // 保留段：这些前缀由路由本身占用，占了会把正常功能顶掉
      for (const reserved of ['/p', '/__', '/edt', '/sub', '/tsub', '/admin']) {
        if (s === reserved || s.startsWith(reserved + '/')) return `链接前缀不能占用保留段 ${reserved}`;
      }
      return '';
    },
  },
  default_days: { type: 'int', default: 1, min: 1, max: 3650, env: 'SHARE_DEFAULT_DAYS' },
  max_days: { type: 'int', default: 30, min: 1, max: 3650, env: 'SHARE_MAX_DAYS' },
  // 0 = 不限次数
  default_max_hits: { type: 'int', default: 0, min: 0, max: 1000000, env: 'SHARE_DEFAULT_MAX_HITS' },
  // 访问计数是否落盘：链接访问量天然很低，默认落盘以便面板看到真实次数
  count_hits: { type: 'bool', default: true, env: 'SHARE_COUNT_HITS' },
};

// ===================== 配置读写 =====================

export async function readShareConfig(env) {
  return readSection(env, 'share', SPEC);
}

export async function saveShareConfig(env, patch) {
  return writeSection(env, 'share', SPEC, patch);
}

export function safeShareConfig(values) {
  return sanitize(SPEC, values);
}

// ===================== 记录读写 =====================

function newToken() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function clampInt(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function readRecord(token) {
  if (!runtime.KV || !TOKEN_RE.test(token)) return null;
  try {
    const raw = await runtime.KV.get(PREFIX + token);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

async function writeRecord(rec) {
  if (!runtime.KV) return;
  try {
    await runtime.KV.put(PREFIX + rec.token, JSON.stringify(rec));
  } catch {}
}

/** 列表：按创建时间倒序，顺带算出「还剩多久 / 是否已失效」 */
export async function listShares() {
  if (!runtime.KV || typeof runtime.KV.list !== 'function') return [];
  const out = [];
  let cursor;
  do {
    let page;
    try {
      page = await runtime.KV.list({ prefix: PREFIX, limit: 500, ...(cursor ? { cursor } : {}) });
    } catch { break; }
    if (!page || !Array.isArray(page.keys)) break;
    for (const k of page.keys) {
      const rec = await readRecord(k.name.slice(PREFIX.length));
      if (rec) out.push(decorate(rec));
    }
    cursor = page.cursor;
  } while (cursor);
  return out.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

function decorate(rec) {
  const now = Date.now();
  const leftMs = (rec.expires_at || 0) - now;
  const byTime = leftMs > 0;
  const byHits = !(rec.max_hits > 0) || (Number(rec.hits) || 0) < rec.max_hits;
  return {
    ...rec,
    expired_by_time: !byTime,
    expired_by_hits: !byHits,
    disabled: !!rec.disabled,
    active: byTime && byHits && !rec.disabled,
    left_ms: leftMs > 0 ? leftMs : 0,
    left_hours: leftMs > 0 ? Math.round(leftMs / 3600000 * 10) / 10 : 0,
  };
}

/**
 * 新建一条临时链接。
 * 站点必须存在（否则链接指向一个 404，看着像坏链）；天数按配置上限夹紧。
 */
export async function createShare(env, input = {}) {
  const cfg = await readShareConfig(env);
  const siteId = String(input.site || '').trim();
  if (!siteId) return { error: '缺少站点 id' };
  const site = await getSite(siteId);
  if (!site) return { error: `站点 ${siteId} 不存在` };

  const days = clampInt(input.days, cfg.default_days, 1, cfg.max_days);
  const maxHits = clampInt(input.max_hits, cfg.default_max_hits, 0, 1000000);
  const now = Date.now();
  const rec = {
    token: newToken(),
    site: siteId,
    note: String(input.note || '').trim().slice(0, 120),
    created_at: now,
    expires_at: now + days * DAY_MS,
    max_hits: maxHits,
    hits: 0,
    days,
    disabled: false,
  };
  await writeRecord(rec);
  return { ok: true, share: decorate(rec), path: linkPath(cfg, rec.token) };
}

export function linkPath(cfg, token) {
  const prefix = String((cfg && cfg.path_prefix) || '/s').replace(/\/+$/, '');
  return `${prefix}/${token}/`;
}

/** 停用（保留记录，便于事后回溯；面板可再删除） */
export async function revokeShare(token) {
  const rec = await readRecord(token);
  if (!rec) return { error: '链接不存在' };
  rec.disabled = true;
  await writeRecord(rec);
  return { ok: true, share: decorate(rec) };
}

/** 启用（把误停用的链接放回来） */
export async function enableShare(token) {
  const rec = await readRecord(token);
  if (!rec) return { error: '链接不存在' };
  rec.disabled = false;
  await writeRecord(rec);
  return { ok: true, share: decorate(rec) };
}

export async function deleteShare(token) {
  if (!runtime.KV || !TOKEN_RE.test(token)) return { error: '链接不存在' };
  try { await runtime.KV.delete(PREFIX + token); } catch {}
  return { ok: true };
}

/**
 * 解析一次访问：命中且有效才返回站点 id。
 * 命中但已失效时返回 { expired: true }，调用方据此决定提示文案（并可触发告警）。
 */
export async function resolve(env, token) {
  const cfg = await readShareConfig(env);
  if (!cfg.enabled) return { status: 'disabled' };
  const rec = await readRecord(token);
  if (!rec) return { status: 'missing' };
  const view = decorate(rec);
  if (!view.active) return { status: 'expired', share: view };
  if (cfg.count_hits) {
    rec.hits = (Number(rec.hits) || 0) + 1;
    await writeRecord(rec);
  }
  return { status: 'ok', site: rec.site, share: decorate(rec) };
}

/** 清空全部链接（自检脚本用；生产上由面板逐条删除） */
export async function clearShares() {
  if (!runtime.KV || typeof runtime.KV.list !== 'function') return 0;
  let n = 0;
  let cursor;
  do {
    let page;
    try {
      page = await runtime.KV.list({ prefix: PREFIX, limit: 500, ...(cursor ? { cursor } : {}) });
    } catch { break; }
    if (!page || !Array.isArray(page.keys)) break;
    for (const k of page.keys) {
      try { await runtime.KV.delete(k.name); n++; } catch {}
    }
    cursor = page.cursor;
  } while (cursor);
  return n;
}

export { SPEC as SHARE_SPEC, TOKEN_RE as SHARE_TOKEN_RE };
