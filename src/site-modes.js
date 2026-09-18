// ===================== 站点模式注册表（默认值 + KV 可编辑覆盖） =====================
// 展示层（标签 / 徽标 / 说明）由 KV 里的 site-modes.json 覆盖，前端管理面板可增删改；
// 执行引擎 engine 只认 normal / media / ai 三选一（proxy.js 只实现这三条执行路径）。
// 设计要点：
//   - 未编辑过注册表时，返回 DEFAULT_SITE_MODES（代码内默认值，与改前行为一致）；
//   - 内置三个引擎键（normal/media/ai）禁止删除、禁止改 engine（改了会破坏执行语义），
//     但允许改展示文案与徽标；自定义键可增删，engine 三选一，执行时按 engine 走对应路径；
//   - 站点保存时把「模式键 → engine」解析结果冗余进 site.engine（proxy.js 零 KV 依赖，
//     注册表改动即时影响后续保存的站点）。
import { runtime } from './runtime.js';

const KV_KEY = 'site-modes.json';

export const SITE_MODES_KEY = ['normal', 'media', 'ai'];
export const SITE_ENGINES = ['normal', 'media', 'ai'];
export const BADGE_CLASSES = ['badge-normal', 'badge-media', 'badge-ai', 'badge-blue', 'badge-purple', 'badge-orange', 'badge-red'];

/** 代码内默认注册表：与历史行为完全一致（徽标类名兼容旧样式） */
export const DEFAULT_SITE_MODES = {
  normal: { label: '普通反代（默认）', badge: '普通', badgeClass: 'badge-normal', hint: '通用网页 / 接口反代', engine: 'normal' },
  media: { label: '流媒体（Emby / Jellyfin / 影视站）', badge: '流媒体', badgeClass: 'badge-media', hint: '视频分片走边缘缓存，加载像直连一样快', engine: 'media' },
  ai: { label: 'AI 中转（OpenAI / Gemini / Claude）', badge: 'AI 中转', badgeClass: 'badge-ai', hint: 'OpenAI 兼容接口转发，可配多上游 key 轮换与入口密钥', engine: 'ai' },
};

/** 净化用户提交的注册表：只保留合法字段，非法项丢弃，内置键保护 */
export function normalizeModes(input) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  const keys = Object.keys(src).filter(k => /^[a-z0-9-]{1,32}$/.test(k));
  for (const key of keys) {
    const item = src[key];
    if (!item || typeof item !== 'object') continue;
    const engine = SITE_ENGINES.includes(String(item.engine)) ? String(item.engine) : null;
    // 内置引擎键：engine 必须与其键名一致（不许改执行语义）
    if (SITE_MODES_KEY.includes(key)) {
      out[key] = {
        label: String(item.label || '').slice(0, 40) || DEFAULT_SITE_MODES[key].label,
        badge: String(item.badge || '').slice(0, 12) || DEFAULT_SITE_MODES[key].badge,
        badgeClass: BADGE_CLASSES.includes(String(item.badgeClass)) ? String(item.badgeClass) : DEFAULT_SITE_MODES[key].badgeClass,
        hint: String(item.hint || '').slice(0, 80) || DEFAULT_SITE_MODES[key].hint,
        engine: key,
      };
    } else if (engine) {
      // 自定义键：必须有合法 engine，否则丢弃
      out[key] = {
        label: String(item.label || '').slice(0, 40) || key,
        badge: String(item.badge || '').slice(0, 12) || key,
        badgeClass: BADGE_CLASSES.includes(String(item.badgeClass)) ? String(item.badgeClass) : 'badge-normal',
        hint: String(item.hint || '').slice(0, 80),
        engine,
      };
    }
  }
  // 内置键必须始终存在（即使前端误删也补回）
  for (const key of SITE_MODES_KEY) if (!out[key]) out[key] = DEFAULT_SITE_MODES[key];
  return out;
}

/** 读取当前生效的注册表（KV 未配置时用默认值），任何读取失败回退默认 */
export async function getSiteModes() {
  try {
    const raw = await runtime.KV.get(KV_KEY);
    if (raw) return normalizeModes(JSON.parse(raw));
  } catch {}
  return DEFAULT_SITE_MODES;
}

/** 保存注册表（已净化）；返回保存后的生效注册表 */
export async function saveSiteModes(modes) {
  const clean = normalizeModes(modes);
  await runtime.KV.put(KV_KEY, JSON.stringify(clean));
  return clean;
}

/** 单模式查找（未登记回退 normal） */
export async function getSiteMode(mode) {
  const all = await getSiteModes();
  return all[mode] || all.normal || DEFAULT_SITE_MODES.normal;
}

/** 站点 → 执行引擎：site.engine 优先（新保存的站点带解析结果），否则查注册表（含自定义键），
 *  旧数据再按 proxyMode 的 media/ai 兼容映射；全部不中回退 normal */
export function resolveEngine(site, modes) {
  if (!site) return 'normal';
  if (site.engine && SITE_ENGINES.includes(site.engine)) return site.engine;
  const all = modes || DEFAULT_SITE_MODES;
  const m = all[site.proxyMode];
  if (m && SITE_ENGINES.includes(m.engine)) return m.engine;
  if (site.proxyMode === 'media') return 'media';
  if (site.proxyMode === 'ai') return 'ai';
  return 'normal';
}

/** 取站点展示徽标（未登记的模式回退普通） */
export async function siteBadge(mode) {
  const all = await getSiteModes();
  return all[mode] || all.normal || DEFAULT_SITE_MODES.normal;
}
