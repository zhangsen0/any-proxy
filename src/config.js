// 统一配置层：把「面板配置 → 环境变量种子 → 规范默认值」的三级取值收敛到一处。
//
// 为什么需要这一层：功能一多，每个模块各自读环境变量的话，取值口径会分叉
// （有人老大写tos、有人 env.X || env.x、有人发现没配就悄悄塞一个兜底值），
// 最后谁也说不清线上到底用的哪个值。这里只留三条允许的路径：
//
//   面板配置（存 KV / D1）  →  环境变量种子（首次写回存储）  →  规范默认值（写进 SCHEMA）
//
// 与项目纪律一致：**任何字段都不允许暗中实现“取不到就用某个域名/IP/ URL”**，
// 取不到就落回 SCHEMA 里明写的默认值，而这个默认值必须是与业务无关的中性值。
//
// 用法：每个功能模块自己声明一份 SCHEMA（放在模块内，读代码时一眼能看到），
// 再调用 readSection / writeSection 读写。

import { runtime, notifyConfigChange } from './runtime.js';

/** 整份配置的存储键。集中在一个键里：每个请求最多读一次存储，而不是每个功能各读一次。 */
const CONFIG_KEY = 'APP_CONFIG';

/**
 * 进程内缓存 TTL（**导出给其它模块复用**：settings.js 的运行参数、disguise.js 的伪装
 * 配置都用它，值只在这里定义一处 —— 曾经 disguise.js 自己抄了一份 3000，属于典型的
 * 「同一个设定两份定义」）。
 * 这些配置参与每个请求的判断（开关是否打开、阈值多少），逐请求读一次 D1/KV
 * 等于给全站加一次存储往返；写入时立即失效缓存，保证「面板保存 → 立刻生效」。
 *
 * 注意「立刻」的边界：写入只失效**当前 isolate** 的缓存，别处最多要等一个 TTL
 * 才看到新值。所以改完开关后短时间内可能新旧取值并存（最长 CONFIG_CACHE_TTL_MS），
 * 这是拿一点收敛延迟换掉「每个请求一次存储往返」的自觉取舍 —— 需要更快的收敛
 * 就调小这个值，别在业务代码里绕开它。
 *
 * 为什么这个值**不进面板**：它是这份配置自己读写的复用窗口，若再由这份配置决定，
 * 就成了「用配置去改读配置的窗口」的自指。它属于 AGENTS 第 0 节允许的
 * 「代码级具名常量」——只有这一处定义，不存在两份口径。
 */
export const CONFIG_CACHE_TTL_MS = 3000;

let cachedDoc = null;
let cachedTs = 0;

// ===================== 取值工具 =====================

/**
 * 布尔取值：接受 true/false、'1'/'0'、'true'/'false'、'yes'/'no'、'on'/'off'
 * 以及 enable/enabled/disable/disabled/none —— 两个词表是**全项目的唯一口径**。
 *
 * 为什么把词表放宽到这么全：这段逻辑原先散在三处各写一份
 * （本文件、geoip.js 的 toggle、admin.js 里对 SUB_STRICT 的判断），
 * 词表还不一致 —— 于是 `off` 在面板里能关掉、写 `none` 却被当成没配。
 * 现在统一走这里，模块只允许调用它，不许再自己写一份 includes 判断。
 */
const ON_WORDS = ['1', 'true', 'yes', 'on', 'enable', 'enabled'];
const OFF_WORDS = ['0', 'false', 'no', 'off', 'none', 'disable', 'disabled'];

function toBool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (ON_WORDS.includes(s)) return true;
  if (OFF_WORDS.includes(s)) return false;
  return fallback;
}

/** 整数：非法值回退默认值，并按 min/max 夹紧 */
function toInt(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  let out = n;
  if (typeof min === 'number' && out < min) out = min;
  if (typeof max === 'number' && out > max) out = max;
  return out;
}

/** 字符串：去空白、限长度；空串回退默认值 */
function toStr(v, fallback = '', maxLen = 0) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (!s) return fallback;
  return maxLen > 0 ? s.slice(0, maxLen) : s;
}

const COERCERS = { bool: toBool, int: toInt, str: toStr };

/**
 * 按字段声明归一化一个取值。
 * 默认值必须由调用方在 SCHEMA 里显式给出 —— 这里不认识 SCHEMA，也不会替谁编一个出来。
 */
function coerceField(field, value) {
  const fn = COERCERS[field.type] || toStr;
  if (field.type === 'int') return toInt(value, field.default, field.min, field.max);
  if (field.type === 'bool') return toBool(value, field.default);
  return toStr(value, field.default, field.maxLen || 0);
}

/** 环境变量读取：兼容大写与小写两种写法（wrangler secrets 与 GitHub Actions 变量习惯不同） */
function envValue(env, name, fallbackKey) {
  if (!env) return undefined;
  for (const k of [name, name.toLowerCase(), fallbackKey, fallbackKey && fallbackKey.toLowerCase()]) {
    if (!k) continue;
    const v = env[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// ===================== 文档读写 =====================

/** 整份配置里每个分区都必须是一个普通对象，别的东西（脏数据）一律丢掉 */
function normalizeDoc(raw) {
  const doc = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = v;
  }
  return out;
}

async function loadDoc(env) {
  let doc = null;
  try {
    const raw = await runtime.KV.get(CONFIG_KEY);
    if (raw) doc = normalizeDoc(JSON.parse(raw));
  } catch {}
  if (!doc) doc = await seedFromEnv(env);
  return doc;
}

/**
 * 环境变量种子：整段 JSON（APP_CONFIG）优先，其次各分区键（STATS_CONFIG 等）。
 * 取到就回写存储，让后续可以在面板里维护。
 */
async function seedFromEnv(env) {
  const whole = String(envValue(env, 'APP_CONFIG') || '').trim();
  if (whole) {
    try {
      const doc = normalizeDoc(JSON.parse(whole));
      if (Object.keys(doc).length) {
        await writeQuiet(doc);
        return doc;
      }
    } catch {}
  }
  return {};
}

function writeQuiet(doc) {
  try {
    Promise.resolve(runtime.KV.put(CONFIG_KEY, JSON.stringify(doc))).catch(() => {});
  } catch {}
}

async function readDoc(env) {
  if (cachedDoc && Date.now() - cachedTs < CONFIG_CACHE_TTL_MS) return cachedDoc;
  cachedDoc = await loadDoc(env);
  cachedTs = Date.now();
  return cachedDoc;
}

function invalidateDoc() {
  cachedDoc = null;
  cachedTs = 0;
}

/**
 * 只取「确实存在存储里」的原始分区，不叠加环境变量与默认值。
 *
 * 为什么需要它：判断某个字段「用户到底有没有显式配过」不能靠比较最终值 ——
 * 用户把值显式改成与默认值相同，最终值看起来和「没配」一模一样。
 * 历史遗留键（早期的独立 KV 键）迁移就靠这个区分：只有真没配过才去看遗留键，
 * 否则会出现「面板显示新值、生效的是遗留旧值」。
 */
export async function readStoredSection(env, section) {
  const doc = await readDoc(env);
  const stored = doc[section];
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
}

/** 环境变量是否给了值（含大小写两种写法）。同样用于「有没有显式配过」的判断。 */
export function readEnvValue(env, name) {
  return envValue(env, name);
}

/**
 * 取整份配置文档（含所有分区）的可写副本。
 *
 * 只给「删除某个字段」这类需要动原始结构的操作用 —— 常规读写请走 readSection / writeSection，
 * 它们才会做归一化与脱敏。这里刻意不导出到业务模块之外。
 */
export async function readRawDoc(env) {
  const doc = await readDoc(env);
  return JSON.parse(JSON.stringify(doc || {}));
}

// ===================== 分区 API =====================

/**
 * 读取某分区的最终取值。
 * 优先级：存储的面板配置 → 环境变量（分区 JSON 优先，其次逐字段变量）→ SCHEMA 默认值。
 * 返回纯值对象，调用方再也不用关心来源。
 */
export async function readSection(env, section, spec) {
  const doc = await readDoc(env);
  const stored = doc[section] && typeof doc[section] === 'object' ? doc[section] : {};
  const whole = String(envValue(env, `${section.toUpperCase()}_CONFIG`) || '').trim();
  let envDoc = {};
  if (whole) {
    try { envDoc = JSON.parse(whole) || {}; } catch {}
  }
  const out = {};
  for (const [key, field] of Object.entries(spec)) {
    const fromEnv = envDoc[key] !== undefined
      ? envDoc[key]
      : (field.env ? envValue(env, field.env) : undefined);
    const source = stored[key] !== undefined ? stored[key] : (fromEnv !== undefined ? fromEnv : field.default);
    out[key] = coerceField(field, source);
  }
  return out;
}

/**
 * 写入某分区（只覆盖传入的键）。
 * 返回 { values, safe }：values 是含敏感项的完整值（服务端内部用），
 * safe 是可下发给前端的脱敏快照。校验失败返回 { error }。
 */
export async function writeSection(env, section, spec, patch) {
  const doc = await readDoc(env);
  const cur = doc[section] && typeof doc[section] === 'object' ? doc[section] : {};
  const next = { ...cur };
  const forValidation = {};
  for (const [key, field] of Object.entries(spec)) {
    // 「留空保持不变」：未传 / 空值（null、空字符串）一律不覆盖原值，只有显式有效值才写入。
    // 例外：字段声明 allowEmpty 时，空字符串是它的合法取值（如告警 events 空 = 订阅全部）
    if (!(key in (patch || {}))) continue;
    const raw = patch[key];
    if (raw === undefined || raw === null) continue;
    if (String(raw).trim() === '' && !field.allowEmpty) continue;
    let value = coerceField(field, raw);
    if (field.validate) {
      const err = field.validate(value);
      if (err) return { error: err };
    }
    next[key] = value;
    forValidation[key] = value;
  }
  doc[section] = next;
  await runtime.KV.put(CONFIG_KEY, JSON.stringify(doc));
  invalidateDoc();
  // 广播给各模块清掉自己的进程内快照（geoip 的段表、CF 用量的缓存等），
  // 让「面板保存」在下一个请求就生效，而不是等各模块自己的 TTL 过期
  notifyConfigChange(section);
  const values = await readSection(env, section, spec);
  return { values, safe: sanitize(spec, values) };
}

/**
 * 脱敏：secret 字段不出现在返回值里，改为 has_<key> 布尔。
 * 与 disguise.js 处理入口口令同一口径 —— 敏感配置不该经由面板 HTML 二次泄漏。
 */
export function sanitize(spec, values) {
  const out = {};
  for (const [key, field] of Object.entries(spec)) {
    if (field.secret) out[`has_${key}`] = !!values[key];
    else out[key] = values[key];
  }
  return out;
}

/**
 * 归一化器对外暴露一份。
 *
 * 为什么必须共用：`settings.js` 的运行参数有一部分并不存在 `APP_CONFIG` 里
 * （代理引擎的 `config.json`、历史遗留的独立 KV 键），它们的读写要自己实现，
 * 但**归一化口径必须与分区配置完全一致** —— 否则同一个 `int` 字段在两条路径上
 * 会有两套夹紧规则，正是本项目最忌讳的「同一设定两份定义」。
 */
export { coerceField as coerceBySpec };

/** 取一处说明书式的字段清单，供管理页渲染表单（也能用于自检脚本核对） */
export function describeSpec(spec) {
  return Object.entries(spec).map(([key, field]) => ({
    key,
    type: field.type,
    default: field.default,
    secret: !!field.secret,
    env: field.env || '',
    min: typeof field.min === 'number' ? field.min : null,
    max: typeof field.max === 'number' ? field.max : null,
  }));
}

export { toBool, toInt, toStr, invalidateDoc, CONFIG_KEY };
