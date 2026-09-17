/**
 * 主题引擎：让一套面板在不同"外观"之间整体切换。
 *
 * 设计原则（与全项目一致：不要写死、要可读可维护）：
 *   1. **主题就是数据** —— 每套主题只是一张「变量名 → 取值」的表，
 *      页面样式里不许出现 `data-theme="xxx"` 的散装分支。加第 11 套主题 =
 *      往 PRESETS 里加一条数据，其余代码一行不用动。
 *   2. **差异要足够大** —— 只换主色不叫换主题。每套主题同时定义：配色、字体（含等宽）、
 *      圆角、阴影、卡片风格，必要时再补一小段结构性样式（extra），
 *      力求切换后像换了另一个系统的界面。
 *   3. **缺失继承** —— 主题只需写它想覆盖的变量，没写的从 BASE_VARS 继承。
 *      这样每套主题十几行就够，不会出现「改个背景色要抄 30 行变量」。
 *   4. **开关走配置，不写代码** —— 默认主题、是否允许访客切换、是否允许自定义，
 *      全部是配置项（环境变量 / 面板），同样遵循「存储 → 环境变量 → 默认值」三级取值。
 *
 * 安全：自定义主题的内容会被拼进 <style>，属于「用户输入进 CSS」。
 * 变量名、变量值到这里会被严格过滤（见 sanitizeVars），宁可拒绝奇技淫巧，
 * 也不让一条自定义主题把整页样式打穿 —— 那比丑陋严重得多。
 */

import { runtime } from './runtime.js';
import { readSection, writeSection, sanitize } from './config.js';

const SECTION = 'theme';
const CUSTOM_KEY = 'THEME_CUSTOM';
const CACHE_TTL_MS = 3000;
/** 浏览器里存放「访客自己挑的主题」的键名。两处以上的地方要用，集中定义避免写歪 */
export const THEME_STORAGE_KEY = 'ap_theme';

// ===================== 基础变量 =====================
//
// 这是所有主题的兜底：任何主题没覆盖的变量都从这里取值。
// 它本身是一套完整可用的中性浅色外观，因此「自定义主题只填一个主色」也能正常用。
const BASE_VARS = {
  '--bg': '#f4f6fb',
  '--card': '#ffffff',
  '--card-2': '#f8fafc',
  '--line': '#e2e8f0',
  '--txt': '#0f172a',
  '--muted': '#64748b',
  '--accent': '#2563eb',
  '--accent-hover': '#1d4ed8',
  '--on-accent': '#ffffff',
  '--input': '#f1f5f9',
  '--ok': '#16a34a',
  '--err': '#dc2626',
  '--radius': '14px',
  '--radius-sm': '10px',
  '--radius-xs': '8px',
  '--shadow': '0 1px 2px rgba(15,23,42,.04), 0 6px 18px rgba(15,23,42,.06)',
  '--ring': '0 0 0 3px rgba(37,99,235,.18)',
  '--ok-bg': 'rgba(22,163,74,.10)',
  '--err-bg': 'rgba(220,38,38,.10)',
  '--hover': 'rgba(100,116,139,.06)',
  '--font': '-apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  '--font-mono': 'ui-monospace, Menlo, Consolas, monospace',
  '--sp-1': '8px',
  '--sp-2': '12px',
  '--sp-3': '16px',
  '--sp-4': '24px',
  '--bw': '1px',

  // ---- 布局度量：决定「一屏内容有多宽」 ----
  // 三个数各自只有一处声明，所有选项卡共用，因此不存在「某个页面的表单
  // 比别的选项卡窄一圈」这种事：
  //   --card-pad   卡片内边距；内容宽 = 页面宽 - 两侧页面留白 - 2×card-pad
  //   --field-min  表单栅格最小列宽，容器够宽时自动多排一列
  //   --grid-gap   栅格间距（横纵同值）
  // 想统一调松/调紧，改这里一处；自定义主题也可以覆盖它们。
  '--card-pad': '20px',
  '--field-min': '320px',
  '--grid-gap': 'var(--sp-3)',
};

// ===================== 预设主题表 =====================
//
// 每套主题一份「骨架 + 配色 + 字体」，覆盖不同的视觉语言。
// 字段说明：
//   id      主题标识（小写）
//   name    面板里显示的名字
//   desc    一句副标题，帮助挑主题
//   scheme  light / dark，跟随系统时据此挑日夜
//   vars    覆盖的变量（缺的从 BASE_VARS 继承）
//   extra   可选：少量结构性补充样式（只允许声明，不允选择器嵌套）

const PRESETS = [
  {
    id: 'aurora',
    name: '晨曦蓝',
    desc: '现代控制台，蓝白高对比',
    scheme: 'light',
    vars: {
      '--bg': '#f4f6fb', '--card': '#ffffff', '--line': '#e2e8f0',
      '--txt': '#0f172a', '--muted': '#64748b',
      '--accent': '#2563eb', '--accent-hover': '#1d4ed8', '--on-accent': '#ffffff',
    },
  },
  {
    id: 'graphite',
    name: '石墨极简',
    desc: 'Notion 式克制灰，直角小圆角',
    scheme: 'light',
    vars: {
      '--bg': '#ffffff', '--card': '#ffffff', '--card-2': '#fafafa', '--line': '#e5e5e5',
      '--txt': '#1a1a1a', '--muted': '#8a8a8a',
      '--accent': '#111827', '--accent-hover': '#374151', '--on-accent': '#ffffff',
      '--radius': '6px', '--radius-sm': '4px', '--radius-xs': '3px',
      '--shadow': 'none',
      '--ring': '0 0 0 2px rgba(17,24,39,.16)',
      '--input': '#ffffff',
      '--bw': '1px',
    },
    // 极简派：去掉阴影、收紧间距，标签做成直角书签，整体像文档工具而不是控制台
    extra: '.wrap{max-width:760px;} .tabs{border-radius:2px;padding:2px;} .card{border-radius:2px;} .site{border-radius:2px;} h1{letter-spacing:-.02em;} .tag{border-radius:2px;} .sub{line-height:1.6;}',
  },
  {
    id: 'solar',
    name: '暖阳',
    desc: 'Solarized Light，编辑器配色',
    scheme: 'light',
    vars: {
      '--bg': '#fdf6e3', '--card': '#fffbf0', '--card-2': '#f6efdc', '--line': '#e3dac3',
      '--txt': '#3c3836', '--muted': '#928374',
      '--accent': '#b58900', '--accent-hover': '#cb4b16', '--on-accent': '#fdf6e3',
      '--input': '#f6efdc', '--ok': '#859900', '--err': '#dc322f',
      '--font': '"JetBrains Mono", Consolas, "PingFang SC", monospace',
      '--radius': '10px', '--radius-sm': '8px', '--radius-xs': '6px',
      '--ring': '0 0 0 3px rgba(181,137,0,.22)',
      '--ok-bg': 'rgba(133,153,0,.14)', '--err-bg': 'rgba(220,50,47,.12)',
      '--shadow': '0 1px 2px rgba(60,56,54,.08)',
    },
    // 纸感：正文铺满整个视口宽一点，标题加粗更像文档排版
    extra: '.wrap{max-width:920px;} .card h2,h1{font-weight:700;letter-spacing:-.01em;} .tabs{border-radius:8px;} .msg,.hint{font-family:var(--font);}',
  },
  {
    id: 'glass',
    name: '亚克力',
    desc: '半透明毛玻璃 + 彩色高光',
    scheme: 'light',
    vars: {
      '--bg': '#eef2ff', '--card': 'rgba(255,255,255,.62)', '--card-2': 'rgba(255,255,255,.45)',
      '--line': 'rgba(99,102,241,.22)',
      '--txt': '#1e1b4b', '--muted': '#6366f1',
      '--accent': '#4f46e5', '--accent-hover': '#6366f1', '--on-accent': '#ffffff',
      '--input': 'rgba(255,255,255,.70)',
      '--radius': '16px', '--radius-sm': '12px', '--radius-xs': '9px',
      '--shadow': '0 8px 32px rgba(79,70,229,.14)',
      '--ring': '0 0 0 3px rgba(99,102,241,.28)',
      '--hover': 'rgba(99,102,241,.10)',
    },
    extra: 'body{background-image:radial-gradient(1200px 480px at 12% -10%, rgba(147,197,253,.55), transparent 60%), radial-gradient(900px 420px at 105% 0%, rgba(196,181,253,.50), transparent 55%); background-attachment:fixed;} .card,.site{backdrop-filter:blur(14px) saturate(140%); -webkit-backdrop-filter:blur(14px) saturate(140%);}',
  },
  {
    id: 'sakura',
    name: '樱粉',
    desc: 'iOS 风柔和圆润',
    scheme: 'light',
    vars: {
      '--bg': '#fff5f7', '--card': '#ffffff', '--card-2': '#fff0f3', '--line': '#f8d7de',
      '--txt': '#3d2430', '--muted': '#a1748a',
      '--accent': '#e2557c', '--accent-hover': '#c93f68', '--on-accent': '#ffffff',
      '--input': '#fff5f8', '--ok': '#2f9e6f', '--err': '#dc3d54',
      '--radius': '22px', '--radius-sm': '16px', '--radius-xs': '12px',
      '--shadow': '0 2px 6px rgba(226,85,124,.10), 0 12px 28px rgba(226,85,124,.12)',
      '--ring': '0 0 0 3px rgba(226,85,124,.20)',
      '--ok-bg': 'rgba(47,158,111,.12)', '--err-bg': 'rgba(220,61,84,.10)',
      '--sp-3': '18px', '--sp-4': '28px',
    },
    // iOS 风：药丸标签 + 全圆角按钮，一眼就不是同一套界面
    extra: '.tabs{border-radius:999px;} .tab{border-radius:999px;} button:not(.mini):not(.ghost):not(.danger){border-radius:999px;} .card{border-radius:24px;padding:24px;} body{line-height:1.75;}',
  },
  {
    id: 'midnight',
    name: '午夜',
    desc: 'OLED 深黑，低亮度护眼',
    scheme: 'dark',
    vars: {
      '--bg': '#0b0f19', '--card': '#131a29', '--card-2': '#0f1522', '--line': '#222c42',
      '--txt': '#e6ecf7', '--muted': '#8fa2c4',
      '--accent': '#6aa8ff', '--accent-hover': '#8fbcff', '--on-accent': '#04101f',
      '--input': '#0e1421', '--ok': '#3ddc97', '--err': '#ff6b81',
      '--radius': '16px', '--radius-sm': '12px', '--radius-xs': '9px',
      '--shadow': '0 1px 2px rgba(0,0,0,.5), 0 10px 30px rgba(0,0,0,.45)',
      '--ring': '0 0 0 3px rgba(106,168,255,.28)',
      '--ok-bg': 'rgba(61,220,151,.12)', '--err-bg': 'rgba(255,107,129,.12)',
      '--hover': 'rgba(143,162,196,.10)',
    },
    // OLED：卡片靠细描边区分而不是阴影，深色下阴影基本看不见
    extra: '.card{border-color:rgba(106,168,255,.20);} .site{border-color:rgba(106,168,255,.14);} .tabs{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.06);} .tab.active{background:rgba(255,255,255,.08);}',
  },
  {
    id: 'terminal',
    name: '终端',
    desc: '复古 CRT，全等宽 + 方角',
    scheme: 'dark',
    vars: {
      '--bg': '#000000', '--card': '#04120a', '--card-2': '#06180d', '--line': '#1f6b3a',
      '--txt': '#b8ffcf', '--muted': '#5fbf82',
      '--accent': '#39ff88', '--accent-hover': '#7dffb0', '--on-accent': '#00220f',
      '--input': '#06180d', '--ok': '#39ff88', '--err': '#ff5f5f',
      '--radius': '0px', '--radius-sm': '0px', '--radius-xs': '0px',
      '--shadow': 'none',
      '--ring': '0 0 0 2px #39ff88',
      '--ok-bg': 'rgba(57,255,136,.10)', '--err-bg': 'rgba(255,95,95,.12)',
      '--hover': 'rgba(57,255,136,.10)',
      '--font': '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
      '--font-mono': '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
      '--bw': '1px',
    },
    extra: '.card,.site{border-style:solid;} body{text-shadow:0 0 1px rgba(57,255,136,.35);}',
  },
  {
    id: 'nord',
    name: '北境',
    desc: 'Nord 冷冽极地色',
    scheme: 'dark',
    vars: {
      '--bg': '#2e3440', '--card': '#3b4252', '--card-2': '#343c4a', '--line': '#434c5e',
      '--txt': '#eceff4', '--muted': '#a3b0c2',
      '--accent': '#88c0d0', '--accent-hover': '#8fbcbb', '--on-accent': '#2e3440',
      '--input': '#434c5e', '--ok': '#a3be8c', '--err': '#bf616a',
      '--radius': '12px', '--radius-sm': '9px', '--radius-xs': '7px',
      '--shadow': '0 1px 2px rgba(0,0,0,.28), 0 8px 20px rgba(0,0,0,.24)',
      '--ring': '0 0 0 3px rgba(136,192,208,.28)',
      '--ok-bg': 'rgba(163,190,140,.14)', '--err-bg': 'rgba(191,97,106,.14)',
      '--hover': 'rgba(236,239,244,.06)',
    },
    // 极地：左侧色条 + 深色渐变背景，卡片像贴在冰川上
    extra: 'body{background:linear-gradient(180deg,#2e3440 0%,#333c4a 100%);background-attachment:fixed;} .card{border-left:3px solid var(--accent);} .card h2{color:#eceff4;}',
  },
  {
    id: 'neon',
    name: '霓虹赛博',
    desc: '深紫背景 + 青紫发光',
    scheme: 'dark',
    vars: {
      '--bg': '#0a0616', '--card': '#150d2b', '--card-2': '#110a24', '--line': '#33215c',
      '--txt': '#f0e9ff', '--muted': '#a88fd6',
      '--accent': '#b14aff', '--accent-hover': '#c96bff', '--on-accent': '#12041f',
      '--input': '#1b1136', '--ok': '#22e6c8', '--err': '#ff4d94',
      '--radius': '14px', '--radius-sm': '11px', '--radius-xs': '8px',
      '--shadow': '0 0 0 1px rgba(177,74,255,.22), 0 8px 28px rgba(177,74,255,.18)',
      '--ring': '0 0 0 3px rgba(177,74,255,.35)',
      '--ok-bg': 'rgba(34,230,200,.12)', '--err-bg': 'rgba(255,77,148,.14)',
      '--hover': 'rgba(177,74,255,.12)',
      '--font': '"Avenir Next", "PingFang SC", system-ui, sans-serif',
    },
    extra: 'h1,.site-name{text-shadow:0 0 12px rgba(177,74,255,.45);} button:not(.ghost):not(.danger){box-shadow:0 0 14px rgba(177,74,255,.35);}',
  },
  {
    id: 'monokai',
    name: '代码深色',
    desc: 'Monokai 编辑器配色',
    scheme: 'dark',
    vars: {
      '--bg': '#272822', '--card': '#31322c', '--card-2': '#2d2e28', '--line': '#44453a',
      '--txt': '#f8f8f2', '--muted': '#a6a28c',
      '--accent': '#a6e22e', '--accent-hover': '#c2f05a', '--on-accent': '#1b1c16',
      '--input': '#3a3b32', '--ok': '#a6e22e', '--err': '#f92672',
      '--radius': '10px', '--radius-sm': '8px', '--radius-xs': '6px',
      '--shadow': '0 1px 2px rgba(0,0,0,.4), 0 6px 18px rgba(0,0,0,.35)',
      '--ring': '0 0 0 3px rgba(166,226,46,.30)',
      '--ok-bg': 'rgba(166,226,46,.14)', '--err-bg': 'rgba(249,38,114,.14)',
      '--hover': 'rgba(248,248,242,.06)',
      '--font': '"JetBrains Mono", Consolas, "PingFang SC", monospace',
      '--font-mono': '"JetBrains Mono", Consolas, "PingFang SC", monospace',
    },
    // Monokai：整页等宽 + 左侧强调条，像打开了一个编辑器而不是网页
    extra: '.card{border-left:3px solid var(--accent);} .tag{border-radius:2px;} .tabs{border-radius:6px;} .site{border-left:2px solid var(--line);}',
  },
];

const PRESET_MAP = new Map(PRESETS.map(t => [t.id, t]));
const DEFAULT_PRESET_ID = PRESETS[0].id;

// ===================== 配置 =====================
// 默认主题 / 是否允许切换 / 是否允许自定义 —— 全是配置项，同样走三级取值。

const SPEC = {
  default_theme: {
    type: 'str',
    default: DEFAULT_PRESET_ID,
    maxLen: 32,
    env: 'THEME_DEFAULT',
    validate: (v) => (isValidId(v) ? null : '主题标识只能包含小写字母、数字与短横线（最长 24 位）'),
  },
  allow_switch: { type: 'bool', default: true, env: 'THEME_ALLOW_SWITCH' },
  allow_custom: { type: 'bool', default: true, env: 'THEME_ALLOW_CUSTOM' },
  remember_user: { type: 'bool', default: true, env: 'THEME_REMEMBER_USER' },
  // 跟随系统时的夜间主题；留空自动取第一套 scheme=dark 的预设
  auto_dark_theme: {
    type: 'str',
    default: '',
    maxLen: 32,
    env: 'THEME_AUTO_DARK',
    validate: (v) => (!v || isValidId(v) ? null : '夜间主题标识不合法'),
  },

  // ---- 主题轮换：长期不换面板会审美疲劳，让主题自己动起来 ----
  // off      不轮换（沿用 default_theme 或用户选择）
  // visit    每次加载随机一套 —— 图个新鲜
  // interval 按固定时间片整体切换 —— 同一时刻所有人看到的是同一套，适合部署上去就不用管
  rotate_mode: {
    type: 'str',
    default: 'off',
    maxLen: 8,
    env: 'THEME_ROTATE_MODE',
    validate: (v) => (['off', 'visit', 'interval'].includes(String(v).toLowerCase()) ? null : '轮换方式只能是 off / visit / interval'),
  },
  rotate_interval_minutes: {
    type: 'int',
    default: 60,
    min: 1,
    max: 10080,
    env: 'THEME_ROTATE_MINUTES',
  },
  // 参与轮换的主题清单，空格 / 逗号 / 换行分隔；留空表示全部主题
  rotate_pool: { type: 'str', default: '', maxLen: 400, env: 'THEME_ROTATE_POOL' },
  // 开启后，轮换优先于用户手动挑选的那套
  rotate_ignore_choice: { type: 'bool', default: false, env: 'THEME_ROTATE_IGNORE_CHOICE' },
};

/** 轮换方式 -> 面板里的中文标签。UI 与服务端都从这里取，避免两处各写一份 */
const ROTATE_MODES = [
  { id: 'off', label: '不轮换', desc: '固定使用默认主题' },
  { id: 'visit', label: '每次访问随机', desc: '刷新页面换一套，纯粹图新鲜' },
  { id: 'interval', label: '按时轮换', desc: '每隔一段时间整体切换一套，同一时刻所有人一致' },
];

// ===================== 校验工具 =====================

const ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const VAR_RE = /^--[a-z][a-z0-9-]{0,31}$/;
const MAX_VALUE_LEN = 120;
const MAX_EXTRA_LEN = 600;
const MAX_CUSTOM = 20;
const MAX_VARS = 60;

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/**
 * 自定义主题的 CSS 过滤。
 * 只允许「变量名 → 值」的声明：出现选择器 / @规则 / HTML 标记一律拒绝。
 * 这不是洁癖 —— 主题内容会被拼进 <style>，放进来一个 `}` 就能改写整页样式。
 */
function sanitizeVars(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_VARS) break;
    if (!VAR_RE.test(name)) continue;
    const v = String(value == null ? '' : value).trim();
    if (!v || v.length > MAX_VALUE_LEN) continue;
    // 引号和反引号也要挡：变量值会被拼进元素的 style 属性，一个引号就能冲出属性边界
    if (/[{};@<>\\'"`]|\r|\n/.test(v)) continue;
    out[name] = v;
  }
  return out;
}

function sanitizeExtra(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v || v.length > MAX_EXTRA_LEN) return '';
  if (/[{}@<>]|\\|\r|\n/.test(v)) return '';
  return v;
}

// ===================== 自定义主题存储 =====================

let cache = null;
let cacheTs = 0;

async function listCustom(force = false) {
  if (cache && !force && Date.now() - cacheTs < CACHE_TTL_MS) return cache;
  let items = [];
  try {
    const raw = await runtime.KV.get(CUSTOM_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) items = parsed.filter(i => i && isValidId(i.id)).map(i => ({
        id: i.id,
        name: String(i.name || i.id).slice(0, 40),
        desc: String(i.desc || '').slice(0, 80),
        vars: sanitizeVars(i.vars),
        extra: sanitizeExtra(i.extra),
      }));
    }
  } catch {}
  cache = items;
  cacheTs = Date.now();
  return items;
}

function invalidate() {
  cache = null;
  cacheTs = 0;
}

async function persistCustom(items) {
  await runtime.KV.put(CUSTOM_KEY, JSON.stringify(items));
  invalidate();
  return items;
}

// ===================== 对外 API =====================

export async function readThemeConfig(env) {
  const cfg = await readSection(env, SECTION, SPEC);
  // 默认主题可能在删掉某套自定义主题后变成悬空引用：落回第一套预设，避免整页没样式
  if (!PRESET_MAP.has(cfg.default_theme) && !customHas(cfg.default_theme)) {
    cfg.default_theme = DEFAULT_PRESET_ID;
  }
  return cfg;
}

function customHas(id) {
  return !!(cache && cache.some(t => t.id === id));
}

export async function saveThemeConfig(env, patch) {
  return await writeSection(env, SECTION, SPEC, patch);
}

/**
 * 全部可用主题 = 预设 + 自定义。返回给面板的摘要里带上主色，用于渲染色卡预览。
 */
export async function listThemes(env) {
  const custom = await listCustom();
  const cfg = await readThemeConfig(env);
  const toItem = (t, isCustom) => ({
    id: t.id,
    name: t.name,
    desc: t.desc || '',
    scheme: t.scheme || 'light',
    custom: isCustom,
    swatch: {
      bg: t.vars['--bg'] || BASE_VARS['--bg'],
      card: t.vars['--card'] || BASE_VARS['--card'],
      accent: t.vars['--accent'] || BASE_VARS['--accent'],
      txt: t.vars['--txt'] || BASE_VARS['--txt'],
    },
  });
  const ids = [...PRESETS.map(t => t.id), ...custom.map(t => t.id)];
  const rotating = rotatingTheme(cfg, ids);
  return {
    ok: true,
    themes: [...PRESETS.map(t => toItem(t, false)), ...custom.map(t => toItem({ ...t, scheme: 'custom' }, true))],
    default_theme: cfg.default_theme,
    allow_switch: cfg.allow_switch,
    allow_custom: cfg.allow_custom,
    remember_user: cfg.remember_user,
    auto_dark_theme: cfg.auto_dark_theme,
    // 轮换：面板要能把这几项渲染成表单，同时显示「当前轮换到哪套」
    rotate_mode: cfg.rotate_mode,
    rotate_interval_minutes: cfg.rotate_interval_minutes,
    rotate_pool: cfg.rotate_pool,
    rotate_ignore_choice: cfg.rotate_ignore_choice,
    rotate_modes: ROTATE_MODES,
    rotating_theme: rotating,
  };
}

/**
 * 按 id 取出主题（含变量与补充样式）。未知 id 一律返回第一套预设，
 * 绝不让页面处于「没有变量」的裸奔状态。
 */
export async function getTheme(env, id) {
  if (isValidId(id)) {
    const preset = PRESET_MAP.get(id);
    if (preset) return { ...preset, vars: { ...preset.vars } };
    const custom = (await listCustom()).find(t => t.id === id);
    if (custom) return { id: custom.id, name: custom.name, desc: custom.desc, vars: { ...custom.vars }, extra: custom.extra };
  }
  return { ...PRESETS[0], vars: { ...PRESETS[0].vars } };
}

/**
 * 生成所有主题对应的 CSS 块。
 * 页面只需要保留一份「BASE_VARS + 组件样式」，主题差异全在这里，按 data-theme 命中。
 */
export async function themeCss(env) {
  const custom = await listCustom();
  const blocks = [];
  for (const t of [...PRESETS, ...custom]) {
    const decls = Object.entries(t.vars || {})
      .filter(([k]) => VAR_RE.test(k))
      .map(([k, v]) => `${k}:${String(v)}`)
      .join(';');
    if (!decls) continue;
    // 每套主题各自一个块，靠 html 上的 data-theme 命中；<html> 的默认值由服务端渲染，
    // 因此这里不需要再把某套主题额外挂到 :root 上
    // 预设的 extra 是我们自己写的数据，直接用；自定义主题在入库时已经过 sanitizeExtra 过滤，
    // 这里若再过滤一次，会连预设那部分结构样式一起清掉（各主题就没区别了）
    blocks.push(`:root[data-theme="${t.id}"]{${decls}}${scopeExtra(t.extra, t.id)}`);
  }
  return blocks.join('\n');
}

/**
 * 把补充样式限定在主题作用域内。
 * extra 里写的是 `.card{...}` 这样的选择器，直接输出会让它在**所有**主题下生效
 * （互相覆盖、越积越乱），因此统一给每个选择器加上 `[data-theme="id"]` 前缀。
 * 这里的拆分只处理「选择器清单 { 声明 }」这一种形状 —— 更复杂的写法在校验阶段已被拒绝。
 */
function scopeExtra(extra, themeId) {
  if (!extra) return '';
  const out = [];
  for (const chunk of extra.split('}')) {
    const i = chunk.indexOf('{');
    if (i < 0) continue;
    const selectors = chunk.slice(0, i).trim();
    const body = chunk.slice(i + 1).trim();
    if (!selectors || !body) continue;
    const scoped = selectors.split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => `:root[data-theme="${themeId}"] ${s}`)
      .join(',');
    out.push(`${scoped}{${body}}`);
  }
  return out.join('');
}

/** :root 兜底变量声明，页面 CSS 里替代原先写死的那份 */
export function baseVarsCss() {
  return `:root{${Object.entries(BASE_VARS).map(([k, v]) => `${k}:${v}`).join(';')}}`;
}

/**
 * 轮换捞出本次该用哪套主题；没开启轮换返回 null（调用方继续走默认主题 / 用户选择）。
 *
 * 「按时轮换」用**绝对时间切片**定主题（`epoch 分钟数 / 间隔` 取模），而不是起点自增：
 * 这样分布在全球的 isolate 各自算出来的结果是同一套，不会出现「同一个人刷新两次换两套」。
 */
export function rotatingTheme(cfg, availableIds) {
  return pickRotate(cfg, availableIds, false);
}

/** 轮换候选池：配置留空 = 全部主题；配了却一个都匹配不上时也退回全部（配错不该等于永远第一套） */
export function rotatePool(cfg, availableIds) {
  return resolvePool(cfg && cfg.rotate_pool, availableIds);
}

function resolvePool(raw, availableIds) {
  const ids = Array.isArray(availableIds) ? availableIds : [];
  const wanted = String(raw || '').split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const matched = wanted.filter(id => ids.includes(id));
  return matched.length ? matched : ids.slice();
}

function pickRotate(cfg, availableIds, randomize) {
  const mode = String((cfg && cfg.rotate_mode) || 'off').toLowerCase();
  if (mode !== 'visit' && mode !== 'interval') return null;
  const pool = resolvePool(cfg && cfg.rotate_pool, availableIds);
  if (!pool.length) return null;
  if (mode === 'visit' || randomize) return pool[Math.floor(Math.random() * pool.length)];
  const minutes = Math.max(1, Number(cfg.rotate_interval_minutes) || 60);
  const slot = Math.floor(Date.now() / (minutes * 60000));
  return pool[slot % pool.length];
}

/**
 * 生成「在首屏前应用用户选择」的内联脚本。
 * 必须在 <style> 之后、<body> 之前插入：晚了会先画一遍默认主题再跳过去（闪一下）。
 */
export function applyScript(cfg, knownIds, pool) {
  const allowSwitch = cfg.allow_switch !== false;
  const remember = cfg.remember_user !== false;
  const fallbackDark = (PRESETS.find(t => t.scheme === 'dark') || PRESETS[0]).id;
  const autoDark = cfg.auto_dark_theme || fallbackDark;
  const mode = String(cfg.rotate_mode || 'off').toLowerCase();
  const payload = JSON.stringify({
    d: cfg.default_theme || DEFAULT_PRESET_ID,
    a: autoDark,
    s: allowSwitch,
    r: remember,
    k: Array.isArray(knownIds) ? knownIds : [],
    rm: mode,
    ri: cfg.rotate_ignore_choice === true,
    p: Array.isArray(pool) ? pool : [],
  });
  // 浏览器里可能残留旧版本的取值（light / dark），或被删掉的自定义主题 id。
  // 认不出来的一律忽略、回到服务端渲染的默认主题 —— 否则页面会停在「没有变量」的裸奔状态。
  // 轮换优先级：visit 模式每次加载重新抽（用户没手动挑过，或配置了「轮换优先」时才生效）。
  return `<script>(function(){var C=${payload};var G=localStorage.getItem('ap_theme');`
    + `var okAuto=(G==='auto'),ok=G&&C.k.indexOf(G)>=0;`
    + `if(!C.s){okAuto=false;ok=false;}`
    + `var pick=function(){return C.p[Math.floor(Math.random()*C.p.length)];};`
    + `if(C.rm==='visit'&&C.p.length&&(C.ri||!ok)){document.documentElement.dataset.theme=pick();}`
    + `else if(okAuto){var m=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;`
    + `document.documentElement.dataset.theme=m?C.a:C.d;}`
    + `else{document.documentElement.dataset.theme=ok?G:C.d;}`
    + `window.__apThemeDefault=C.d;window.__apCanRemember=C.r;window.__apThemeIds=C.k;})();</script>`;
}

/** 新增 / 更新一套自定义主题 */
export async function upsertCustom(env, input) {
  const cfg = await readThemeConfig(env);
  if (!cfg.allow_custom) return { error: '当前配置已关闭自定义主题' };
  const id = String((input && input.id) || '').trim().toLowerCase();
  if (!isValidId(id)) return { error: '主题标识不合法：1~24 位小写字母 / 数字 / 短横线，且以字母或数字开头' };
  if (PRESET_MAP.has(id)) return { error: `标识 ${id} 已被内置主题占用` };
  const vars = sanitizeVars(input && input.vars);
  if (!Object.keys(vars).length) return { error: '至少要填一个 CSS 变量（例如 --accent）' };
  const items = await listCustom(true);
  const idx = items.findIndex(t => t.id === id);
  const rec = {
    id,
    name: String((input && input.name) || id).trim().slice(0, 40) || id,
    desc: String((input && input.desc) || '').trim().slice(0, 80),
    vars,
    extra: sanitizeExtra(input && input.extra),
  };
  if (idx >= 0) items[idx] = rec;
  else {
    if (items.length >= MAX_CUSTOM) return { error: `自定义主题最多 ${MAX_CUSTOM} 套` };
    items.push(rec);
  }
  await persistCustom(items);
  return { ok: true, item: rec, themes: await listThemes(env) };
}

export async function removeCustom(env, id) {
  const items = await listCustom(true);
  const next = items.filter(t => t.id !== String(id || '').trim().toLowerCase());
  if (next.length === items.length) return { error: 'not found' };
  await persistCustom(next);
  return { ok: true, themes: await listThemes(env) };
}

export { PRESETS, BASE_VARS, SPEC as THEME_SPEC, DEFAULT_PRESET_ID, isValidId, sanitizeVars, ROTATE_MODES };
