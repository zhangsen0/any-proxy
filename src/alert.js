/**
 * 告警通知：把「该让人知道的事」推到一个可配置的 Webhook。
 *
 * 三条硬规矩：
 *   1. 通道完全由配置决定。代码里不内置任何厂商地址，也不猜格式 ——
 *      配了 URL 才发，没配就直接跳过（并说明原因），绝不会因为发不出去而拖慢请求。
 *   2. 告警不能变成新的噪音。冷却时间 + 每小时上限两道闸，同一件事不会刷屏；
 *      发送失败不抛异常，只记状态，请求链路不受影响。
 *   3. 发送一律带超时。外部 Webhook 卡住不该占用 Worker 的墙钟预算。
 */

import { readSection, writeSection, sanitize } from './config.js';

/** 可订阅的事件清单：新增一处告警点 = 在这里加一条，UI 与校验自动跟上 */
const EVENTS = [
  { id: 'login_fail', label: '登录失败', desc: '有人用错口令敲管理入口' },
  { id: 'ratelimit_block', label: '触发限流', desc: '来访者被限流挡下或封禁' },
  { id: 'upstream_fail', label: '上游异常', desc: '反代目标站连续取不到内容' },
  { id: 'dns_fail', label: '优选失败', desc: '定时任务测通 / 改写 A 记录失败' },
  { id: 'temp_link_expired', label: '临时链接失效', desc: '有人访问已过期或被停用的分享链接' },
];

const EVENT_IDS = EVENTS.map(e => e.id);

/** 支持的消息体格式：不同机器人的字段长得不一样，这里只做「薄适配」，不做业务判断 */
const FORMATS = ['generic', 'wecom', 'dingtalk'];

const SPEC = {
  enabled: { type: 'bool', default: false, env: 'ALERT_ENABLED' },
  webhook_url: { type: 'str', default: '', maxLen: 2000, env: 'ALERT_WEBHOOK_URL', secret: true },
  webhook_type: {
    type: 'str',
    default: 'generic',
    maxLen: 16,
    env: 'ALERT_WEBHOOK_TYPE',
    validate: v => (FORMATS.includes(String(v).toLowerCase()) ? '' : `webhook_type 只能是 ${FORMATS.join(' / ')}`),
  },
  title_prefix: { type: 'str', default: '', maxLen: 60, env: 'ALERT_TITLE_PREFIX' },
  // 同一事件多久内只报一次（0 表示每次都报）
  cooldown_minutes: { type: 'int', default: 30, min: 0, max: 1440, env: 'ALERT_COOLDOWN_MINUTES' },
  max_per_hour: { type: 'int', default: 20, min: 1, max: 1000, env: 'ALERT_MAX_PER_HOUR' },
  timeout_ms: { type: 'int', default: 4000, min: 500, max: 25000, env: 'ALERT_TIMEOUT_MS' },
  // 订阅哪些事件：留空 = 全部订阅（默认行为最省心，也便于首次部署直接生效）
  events: { type: 'str', default: '', maxLen: 1000, env: 'ALERT_EVENTS' },
};

// ===================== 进程内节流 =====================

/** event -> 上次发送时间戳（毫秒） */
const lastSent = new Map();
/** 最近一小时内的发送记录，用于 max_per_hour */
let hourBucket = { start: Date.now(), count: 0 };
/** 最近的发送结果，面板与自检据此判断「到底发出去没有」 */
const recent = [];
const RECENT_MAX = 20;

function subscribed(cfg, eventId) {
  const wanted = String(cfg.events || '')
    .split(/[\n,;\s]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length) return true;
  return wanted.includes(String(eventId).toLowerCase());
}

function hourQuotaLeft(cfg) {
  const now = Date.now();
  if (now - hourBucket.start > 3600000) hourBucket = { start: now, count: 0 };
  return Math.max(0, cfg.max_per_hour - hourBucket.count);
}

function pushRecent(rec) {
  recent.unshift(rec);
  if (recent.length > RECENT_MAX) recent.pop();
}

// ===================== 配置读写 =====================

export async function readAlertConfig(env) {
  return readSection(env, 'alert', SPEC);
}

export async function saveAlertConfig(env, patch) {
  return writeSection(env, 'alert', SPEC, patch);
}

export function safeAlertConfig(values) {
  return sanitize(SPEC, values);
}

// ===================== 发送 =====================

function escapeMarkdown(s) {
  return String(s == null ? '' : s).replace(/[`>*_[\]]/g, m => `\\${m}`);
}

/** 按 webhook_type 组装请求体；generic 就是裸 JSON，方便接自建服务 */
function buildBody(type, title, text, payload) {
  const t = String(type || 'generic').toLowerCase();
  if (t === 'wecom') {
    return { msgtype: 'markdown', markdown: { content: `**${escapeMarkdown(title)}**\n${escapeMarkdown(text)}` } };
  }
  if (t === 'dingtalk') {
    return { msgtype: 'markdown', markdown: { title, text: `**${title}**\n\n${text}` } };
  }
  return { title, text, payload: payload || {} };
}

function buildText(eventId, title, detail) {
  const when = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return [
    `事件：${title}`,
    `时间：${when}（UTC+8）`,
    detail ? `详情：${detail}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * 发一条告警。
 * 返回 { sent, skipped, reason, error? }：调用方不需要 try/catch ——
 * 告警是旁路，任何异常都在这里收敛成 skipped + reason。
 */
export async function notify(env, eventId, detail = '', extra = {}) {
  const meta = EVENTS.find(e => e.id === eventId);
  const title = `${(extra.titlePrefix || '') || ''}${meta ? meta.label : eventId}`;
  try {
    const cfg = await readAlertConfig(env);
    if (!cfg.enabled) return skipped('未启用告警', eventId);
    if (!cfg.webhook_url) return skipped('未配置 Webhook 地址', eventId);
    if (!subscribed(cfg, eventId)) return skipped('该事件未订阅', eventId);

    const now = Date.now();
    const last = lastSent.get(eventId) || 0;
    if (cfg.cooldown_minutes > 0 && now - last < cfg.cooldown_minutes * 60000) {
      return skipped(`冷却中（${cfg.cooldown_minutes} 分钟）`, eventId);
    }
    if (hourQuotaLeft(cfg) <= 0) return skipped('已达到每小时上限', eventId);

    const body = JSON.stringify(buildBody(cfg.webhook_type, title, detail, extra.payload || {}));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeout_ms);
    let ok = false;
    let status = 0;
    try {
      const res = await fetch(cfg.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
      status = res.status;
      ok = res.ok;
    } finally {
      clearTimeout(timer);
    }

    lastSent.set(eventId, now);
    hourBucket.count += 1;
    const rec = { at: now, event: eventId, sent: ok, status, title };
    pushRecent(rec);
    return { sent: ok, skipped: !ok, reason: ok ? '' : `Webhook 返回 ${status}`, event: eventId, status };
  } catch (e) {
    pushRecent({ at: Date.now(), event: eventId, sent: false, status: 0, title });
    return skipped(`发送失败：${e && e.message ? e.message : '未知错误'}`, eventId);
  }
}

function skipped(reason, eventId) {
  pushRecent({ at: Date.now(), event: eventId, sent: false, status: 0, reason });
  return { sent: false, skipped: true, reason, event: eventId };
}

/** 面板「发一条测试告警」用的入口：绕过冷却，走完整发送链路 */
export async function testAlert(env) {
  const cfg = await readAlertConfig(env);
  if (!cfg.webhook_url) return { sent: false, skipped: true, reason: '未配置 Webhook 地址' };
  const title = `${cfg.title_prefix || ''}测试告警`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeout_ms);
  try {
    const res = await fetch(cfg.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(cfg.webhook_type, title, buildText('test', title, '这是一条测试消息'), {})),
      signal: ctrl.signal,
    });
    pushRecent({ at: Date.now(), event: 'test', sent: res.ok, status: res.status, title });
    return { sent: res.ok, skipped: !res.ok, reason: res.ok ? '' : `Webhook 返回 ${res.status}`, status: res.status };
  } catch (e) {
    return { sent: false, skipped: true, reason: `发送失败：${e && e.message ? e.message : '未知错误'}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 最近的发送记录（面板展示 / 自检核对） */
export function recentAlerts() {
  return recent.slice();
}

/** 清空节流状态（自检脚本用） */
export function resetThrottle() {
  lastSent.clear();
  hourBucket = { start: Date.now(), count: 0 };
  recent.length = 0;
}

export { SPEC as ALERT_SPEC, EVENTS as ALERT_EVENTS, EVENT_IDS as ALERT_EVENT_IDS, FORMATS as ALERT_FORMATS };
