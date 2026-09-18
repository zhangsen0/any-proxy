/**
 * 运行参数注册表 —— 全站「可运营配置」的唯一真源。
 *
 * ## 它解决什么问题
 *
 * 在此之前，同一个设定常常有两套入口：面板管一部分（站点、统计、限流、告警、伪装…），
 * 另一部分只认环境变量（`env.SUB_STRICT`、`env.GEOIP_BATCH_SIZE`、`env.PROXY_HEDGE_MS`…）。
 * 后者的问题不是「没做界面」，而是**改了要重新部署才生效**，而面板上又看不到它 ——
 * 运营者只能翻 wrangler.toml 猜线上到底用的哪个值。
 *
 * 这个文件把「只能靠环境变量」的那部分全部收进来，一处声明：
 *
 *   1. 怎么取值（类型 / 默认值 / 区间 / 校验）—— 面板与运行时读同一份（AGENTS 第 1 节）；
 *   2. 怎么呈现（分组 / 标签 / 提示 / 单位 / 折叠级别）—— 目录按它生成表单，不手抄；
 *   3. 老部署怎么平滑迁移（历史独立 KV 键，见 field.legacyKey）。
 *
 * 读取优先级仍是 config.js 定下的三级：**面板配置 → 环境变量种子 → 这里的默认值**。
 * 所以环境变量继续可用（首次部署给个种子），只是不再是唯一的入口。
 *
 * ## 什么不该进来
 *
 * 只有两类东西留在环境变量 / wrangler.toml 里，且都是**部署形态**而非**运营参数**：
 *   - 绑定与后端：`STORAGE_BACKEND`、`DB`、`SITES`、`MEDIA_R2` —— 改它等于换存储，
 *     必须和 wrangler.toml 的绑定一起改，面板改不动也不该改；
 *   - 进站口令与引擎密钥：`PASSWORD`、`KEY` —— 是凭据而非配置，混进 KV 会多一处泄漏面。
 *
 * 其余「面向运营的数值」一律进这张表：AGENTS 第 0 节要求的就是「判据不是代码里有没有
 * 常量，而是同一个设定有没有两份定义」。表里每个字段都只有这一份定义，
 * 由 `tools/check-single-source.mjs` 静态钉住（别处出现 `env.X` 直接变红）。
 */

import {
  readSection, writeSection, readStoredSection, readEnvValue, readRawDoc,
  sanitize, invalidateDoc, CONFIG_KEY,
} from './config.js';
import { runtime, notifyConfigChange } from './runtime.js';

/** 配置文档里的分区名。整表存 APP_CONFIG[section]，与其它模块的分区同一份文档、同一份缓存。 */
export const SETTINGS_SECTION = 'settings';

// ===================== 分组 =====================
//
// 分组只决定「在配置中心的哪张卡片里」，字段自己声明属于哪一组（field.group）。
// 加一组 = 这里加一条；加一个字段 = SETTINGS_SPEC 加一条。两边都不需要改界面代码。

export const SETTINGS_GROUPS = [
  { id: 'preferred', name: '优选与候选', desc: '订阅候选怎么拉、优选池留多少、探测多快多重。改完下一个请求就按新值跑。' },
  { id: 'datasource', name: '边缘段与外部数据源', desc: '判定「节点是否归属边缘网络」以及国家标注所用的外部接口地址。' },
  { id: 'proxy', name: '代理与转发', desc: '优选目标域名与转发侧的可用性取舍。' },
  { id: 'cloudflare', name: 'Cloudflare 接口', desc: '「CF 用量」驾驶舱与 DNS 优选调用 CF API 所需的凭据与端点。凭据只回显「是否已配置」。' },
  { id: 'ops', name: '运维与隐私', desc: '面板上的运维入口与来访者哈希盐值。' },
];

// ===================== 字段表 =====================
//
// type        bool / int / str —— 与控制方式、归一化方式同一份定义（config.js 的 COERCERS）
// default     默认值。必须是与具体部署无关的中性值（不含域名 / IP / 口令）
// min / max   整数区间。面板的 min/max 与运行时的夹紧都由它插值，不手写
// env         对应的环境变量名，作为首次部署的种子
// legacyKey   历史独立 KV 键：升级后首次读取时兜底，避免「面板显示默认值、实际沿用旧值」
// secret      敏感项：面板只回显「是否已配置」，值不出现在任何返回体里
// label/hint/unit/level/wide  呈现信息，目录按它渲染表单

export const SETTINGS_SPEC = {
  // ---------- 优选与候选 ----------
  dns_interval_minutes: {
    type: 'int', default: 720, min: 5, max: 1440, env: 'DNS_INTERVAL',
    legacyKey: 'DNS_CONFIG',
    group: 'preferred', label: '自动优选频率', unit: '分钟',
    hint: '定时任务按这个间隔执行优选；改完立即生效，不等下一个周期',
  },
  pool_limit: {
    type: 'int', default: 30, min: 1, max: 500, env: 'POOL_LIMIT',
    group: 'preferred', label: '优选池上限', unit: '条',
    hint: '优选池 / 已验证可用集各最多保留多少条；面板写入与运行时读取共用同一上限',
  },
  domain_pool_limit: {
    type: 'int', default: 12, min: 1, max: 100, env: 'DOMAIN_POOL_LIMIT',
    group: 'preferred', label: '候选域名池上限', unit: '个',
    hint: '解析成本随条数上升，且 A 记录只留「A 记录条数」那么多条', level: 'advanced',
  },
  candidate_limit: {
    type: 'int', default: 40, min: 1, max: 500, env: 'SUB_CANDIDATE_LIMIT',
    group: 'preferred', label: '订阅候选上限', unit: '个',
    hint: '一次「拉取优选候选」最多返回多少个 IP', level: 'advanced',
  },
  sub_strict: {
    type: 'bool', default: true, env: 'SUB_STRICT',
    group: 'preferred', label: '只保留边缘网络内的候选',
    hint: '第三方订阅常混入不可达节点；关掉会把它们也当作候选，通常更慢',
  },
  sub_ua: {
    type: 'str', default: 'Mozilla/5.0', maxLen: 200, env: 'SUB_UA',
    group: 'preferred', label: '拉订阅的 User-Agent', level: 'advanced',
  },
  max_probe_limit: {
    type: 'int', default: 32, min: 1, max: 256, env: 'MAX_PROBE_LIMIT',
    group: 'preferred', label: '单轮最多探测', unit: '个',
    hint: '防止池里塞满不可达 IP 时把整次请求拖垮', level: 'advanced',
  },
  probe_concurrency: {
    type: 'int', default: 12, min: 1, max: 64, env: 'PROBE_CONCURRENCY',
    group: 'preferred', label: '探测并发', unit: '路', level: 'advanced',
  },
  probe_timeout_ms: {
    type: 'int', default: 2500, min: 500, max: 20000, env: 'PROBE_TIMEOUT_MS',
    group: 'preferred', label: '单次探测超时', unit: '毫秒', level: 'advanced',
  },
  dns_budget_ms: {
    type: 'int', default: 22000, min: 5000, max: 29000, env: 'DNS_BUDGET_MS',
    group: 'preferred', label: '优选总时间预算', unit: '毫秒',
    hint: '必须小于 Workers 的 30 秒墙钟上限，否则请求会被平台直接杀掉', level: 'advanced',
  },
  dns_settle_ms: {
    type: 'int', default: 2500, min: 0, max: 10000, env: 'DNS_SETTLE_MS',
    group: 'preferred', label: '写完 A 记录后的等待', unit: '毫秒',
    hint: '等记录生效再自检；调太短会把「已写入但还没生效」误判为失败', level: 'advanced',
  },
  max_targets: {
    type: 'int', default: 2, min: 1, max: 10, env: 'MAX_TARGETS',
    group: 'preferred', label: 'A 记录条数', unit: '条',
    hint: '多条 A 记录由浏览器自动负载均衡', level: 'advanced',
  },
  sub_url: {
    type: 'str', default: '', maxLen: 500, env: 'SUB_URL',
    legacyKey: 'SUB_URL', ownTab: true,
    group: 'preferred', label: '订阅链接', wide: true,
    hint: '完整 URL（http(s)://…）或以 / 开头的路径（如 /tsub/xxx）；留空则回退到本机 /sub',
  },

  // ---------- 边缘段与外部数据源 ----------
  cf_ip_ranges: {
    type: 'str', default: '', maxLen: 4000, env: 'CF_IP_RANGES',
    legacyKey: 'CF_IP_RANGES',
    group: 'datasource', label: '手工指定边缘 IP 段', wide: true,
    hint: '每行一个 CIDR，例如 104.16.0.0/13；留空则用下面的数据源自动拉取',
  },
  cf_ip_ranges_url: {
    type: 'str', default: 'https://api.cloudflare.com/client/v4/ips', maxLen: 300, env: 'CF_IP_RANGES_URL',
    group: 'datasource', label: '边缘 IP 段数据源', wide: true,
    hint: '返回 {"result":{"ipv4_cidrs":[...]}}；可换成自建镜像',
  },
  ranges_ttl_ms: {
    type: 'int', default: 43200000, min: 60000, max: 604800000, env: 'RANGES_TTL_MS',
    group: 'datasource', label: '边缘 IP 段缓存时长', unit: '毫秒', level: 'advanced',
  },
  doh_url: {
    type: 'str', default: 'https://cloudflare-dns.com/dns-query', maxLen: 300, env: 'DOH_URL',
    group: 'datasource', label: '解析候选域名的 DoH 服务', wide: true,
    hint: 'Workers 自身没有 DNS 解析能力，只能借道查询接口',
  },
  cf_nets_url: {
    type: 'str', default: 'https://www.cloudflare.com/ips-v4', maxLen: 300, env: 'CF_NETS_URL',
    group: 'datasource', label: '官方 IPv4 段列表', wide: true,
    hint: '用于把查不到归属的 IP 标成「任播」，而不是编一个国名', level: 'advanced',
  },
  node_country_anycast: {
    type: 'bool', default: true, env: 'NODE_COUNTRY_ANYCAST',
    group: 'datasource', label: '任播兜底标注',
    hint: '命中官方段但查不到国家时标成「任播」（这类 IP 本来就没有单一国家归属）', level: 'advanced',
  },
  geoip_batch_url: {
    type: 'str', default: 'https://api.country.is/', maxLen: 300, env: 'GEOIP_BATCH_URL',
    group: 'datasource', label: 'IP 归属查询接口', wide: true,
    hint: '接受 JSON 数组、返回国家代码的批量端点都能替换', level: 'advanced',
  },
  geoip_batch_size: {
    type: 'int', default: 100, min: 1, max: 100, env: 'GEOIP_BATCH_SIZE',
    group: 'datasource', label: '单次批量查询条数', unit: '个', level: 'advanced',
  },

  // ---------- 代理与转发 ----------
  proxy_host: {
    type: 'str', default: '', maxLen: 200, env: 'PROXY_HOST',
    group: 'proxy', label: '优选目标域名', wide: true,
    hint: '自动优选往哪个域名的 A 记录上写；留空则用当前访问的域名（cron 触发时用最后一次访问过的）',
  },
  proxy_hedge_ms: {
    type: 'int', default: 0, min: 0, max: 10000, env: 'PROXY_HEDGE_MS',
    group: 'proxy', label: '转发竞速对冲延迟', unit: '毫秒',
    hint: '首个上游超过这个时间还没响应，就并发请求第二个，取先到的；0 表示关闭', level: 'advanced',
  },

  // ---------- Cloudflare 接口 ----------
  cf_api_token: {
    type: 'str', default: '', maxLen: 200, env: 'CF_API_TOKEN', secret: true,
    group: 'cloudflare', label: 'API Token', wide: true,
    hint: '需要「Zone:Read + Analytics:Read + DNS:Edit」权限；留空表示不修改已配置的值',
  },
  cf_zone_id: {
    type: 'str', default: '', maxLen: 100, env: 'CF_ZONE_ID',
    group: 'cloudflare', label: 'Zone ID',
  },
  cf_account_id: {
    type: 'str', default: '', maxLen: 100, env: 'CF_ACCOUNT_ID',
    group: 'cloudflare', label: 'Account ID',
    hint: '留空则用 token 自动列出账户取第一个', level: 'advanced',
  },
  cf_api_base: {
    type: 'str', default: 'https://api.cloudflare.com/client/v4', maxLen: 300, env: 'CF_API_BASE',
    group: 'cloudflare', label: 'API 端点', wide: true, level: 'advanced',
  },
  worker_script: {
    type: 'str', default: 'any-proxy', maxLen: 100, env: 'WORKER_SCRIPT',
    group: 'cloudflare', label: 'Worker 脚本名',
    hint: '取 wrangler.toml 的 name；同一账户常挂着多个脚本，所以要指明看哪一个',
  },
  analytics_ttl_ms: {
    type: 'int', default: 300000, min: 0, max: 3600000, env: 'ANALYTICS_TTL_MS',
    group: 'cloudflare', label: '用量数据缓存时长', unit: '毫秒',
    hint: 'GraphQL 分析查询按次配额计费，宁可看几分钟前的数也不刷爆配额', level: 'advanced',
  },
  cf_api_timeout_ms: {
    type: 'int', default: 8000, min: 1000, max: 30000, env: 'CF_API_TIMEOUT_MS',
    group: 'cloudflare', label: 'CF 接口超时', unit: '毫秒', level: 'advanced',
  },

  // ---------- 运维与隐私 ----------
  gh_actions_url: {
    type: 'str', default: '', maxLen: 300, env: 'GH_ACTIONS_URL',
    group: 'ops', label: '手动触发健康检查的链接', wide: true,
    hint: '改成你自己仓库的 Actions 地址；留空则面板不显示该按钮',
  },
  stats_salt: {
    type: 'str', default: '', maxLen: 200, env: 'STATS_SALT', secret: true,
    group: 'ops', label: '来访者哈希盐值', wide: true,
    hint: '只用于给来访 IP 做哈希，原始 IP 不出内存；留空则自动生成并长期保持不变',
  },
};

/** 只有这些字段的取值语义是「空 = 有意义的空」，其余空值一律视为「没配，用默认值」 */
const NO_EMPTY_OVERRIDE = ['cf_ip_ranges'];

// ===================== 读取 / 写入 =====================

function kvGet(key) {
  try { return Promise.resolve(runtime.KV.get(key)).catch(() => null); } catch { return Promise.resolve(null); }
}

/**
 * 读全部运行参数（已归一化、已夹紧、已脱敏前）。
 * @returns {Promise<Record<string, any>>}
 */
export async function readSettings(env) {
  const values = await readSection(env, SETTINGS_SECTION, SETTINGS_SPEC);
  const legacy = Object.entries(SETTINGS_SPEC).filter(([, f]) => f.legacyKey);
  if (!legacy.length) return values;

  // 历史遗留键兜底：老版本把值放在独立 KV 键里，且**只**认环境变量。
  // 只有在「面板没存过、环境变量也没给」时才回头看遗留键 —— 少一次存储读，
  // 也避免「用户刚在面板里显式改成默认值，却被遗留键顶回去」。
  const stored = await readStoredSection(env, SETTINGS_SECTION);
  for (const [key, field] of legacy) {
    if (stored[key] !== undefined) continue;
    if (field.env && readEnvValue(env, field.env) !== undefined) continue;
    const raw = await kvGet(field.legacyKey);
    if (raw === null || raw === undefined || String(raw).trim() === '') continue;
    values[key] = coerceLegacy(field, key, raw);
  }
  return values;
}

/** 遗留键存的是裸值（如 '720'、多行 CIDR），按字段声明归一化一次 */
function coerceLegacy(field, key, raw) {
  if (field.type === 'int') {
    const n = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(n)) return field.default;
    return Math.min(Math.max(n, field.min), field.max);
  }
  if (field.type === 'bool') return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
  const s = String(raw).trim();
  return field.maxLen > 0 ? s.slice(0, field.maxLen) : s;
}

/**
 * 取单个参数。模块里最常用的入口。
 * 为什么每次都要 await：配置可能刚被面板改过，缓存写入时已失效，读到的一定是最新值。
 */
export async function readSetting(env, key) {
  const all = await readSettings(env);
  return all[key];
}

/**
 * 保存运行参数（只覆盖传入的键）。
 * 返回 { values, safe } / { error }，与 config.js 的 writeSection 同一形状，
 * 面板侧不需要为这一块写第二套处理。
 */
export async function saveSettings(env, patch) {
  const clean = {};
  for (const [key, field] of Object.entries(SETTINGS_SPEC)) {
    if (!(key in (patch || {}))) continue;
    const raw = patch[key];
    if (raw === undefined || raw === null) continue;
    // 与 config.js 同一套「留空保持不变」语义：空值不覆盖，除非字段声明空是合法取值。
    // 注意 secret 字段留空 = 不修改，面板据此做「已配置则留空」的提示。
    if (String(raw).trim() === '' && !(field.allowEmpty || NO_EMPTY_OVERRIDE.includes(key))) continue;
    clean[key] = raw;
  }
  const r = await writeSection(env, SETTINGS_SECTION, SETTINGS_SPEC, clean);
  if (r && r.error) return r;
  return { values: await readSettings(env), safe: sanitize(SETTINGS_SPEC, r.values), saved: Object.keys(clean) };
}

/** 面板下发给前端的快照：secret 字段只留 has_<key>，值不出服务端 */
export async function safeSettings(env) {
  return sanitize(SETTINGS_SPEC, await readSettings(env));
}

/**
 * 清掉某个字段的「面板配置」，回到环境变量 / 默认值。
 *
 * 为什么需要单独一个入口：`saveSettings` 对空值一律「保持原值」（这是面板的防误删语义），
 * 但「把订阅链接清空以回退到本机 /sub」是合法且必要的操作 —— 两者不能共用一条路径，
 * 否则要么误删要么删不掉。
 */
export async function clearSetting(env, key) {
  if (!SETTINGS_SPEC[key]) return { error: `未知参数：${key}` };
  const doc = await readRawDoc(env);
  if (doc[SETTINGS_SECTION] && typeof doc[SETTINGS_SECTION] === 'object' && key in doc[SETTINGS_SECTION]) {
    delete doc[SETTINGS_SECTION][key];
    await runtime.KV.put(CONFIG_KEY, JSON.stringify(doc));
    invalidateDoc();
    // 与 writeSection 同样的广播：模块的进程内快照要跟着失效，否则「清空了却还在生效」
    notifyConfigChange(SETTINGS_SECTION);
  }
  return { ok: true, values: await readSettings(env) };
}

// ===================== 供目录生成表单 =====================

/**
 * 面板字段清单：由 SETTINGS_SPEC 推导，不在目录里手抄一遍。
 * 这正是「加一个参数只改一处」的落点 —— 呈现信息就写在字段自己身上。
 *
 * 顺序即 SETTINGS_GROUPS 的顺序（分组内按声明顺序），每项带 section（分组名）：
 * 渲染层据此在同一张表单里插入小标题，而不是把 30 个字段平铺成一片。
 */
export function panelParams() {
  const order = new Map(SETTINGS_GROUPS.map((g, i) => [g.id, i]));
  return Object.entries(SETTINGS_SPEC)
    .filter(([, f]) => !f.ownTab) // ownTab：编辑入口在别的选项卡，这里不再重复一份表单
    .map(([key, f]) => ({ key, field: f, group: f.group || '' }))
    .sort((a, b) => (order.get(a.group) ?? 99) - (order.get(b.group) ?? 99))
    .map(({ key, field: f, group }) => {
      const param = { key, label: f.label || key, section: groupLabel(group) };
      if (f.hint) param.hint = f.hint;
      if (f.unit) param.unit = f.unit;
      if (f.level) param.level = f.level;
      if (f.wide) param.wide = true;
      if (f.control) param.type = f.control;
      // 多行列表型（每行一个 CIDR）用文本域
      if (NO_EMPTY_OVERRIDE.includes(key)) param.type = 'textarea';
      if (f.secret) param.type = 'password';
      return param;
    });
}

/** 面板表单要覆盖的字段子集（与 panelParams 同一口径，供目录声明 item.spec） */
export function panelSpec() {
  const out = {};
  for (const [key, field] of Object.entries(SETTINGS_SPEC)) {
    if (!field.ownTab) out[key] = field;
  }
  return out;
}

/** 分组 id -> 显示名。未知分组返回空串（不编一个名字出来） */
export function groupLabel(groupId) {
  const g = SETTINGS_GROUPS.find(x => x.id === groupId);
  return g ? g.name : '';
}

/** 某分组允许写入的字段名集合：接口按它做「不认识的字段一律拒绝」的边界校验 */
export function keysOfGroup(groupId) {
  return Object.entries(SETTINGS_SPEC)
    .filter(([, f]) => (f.group || '') === groupId)
    .map(([key]) => key);
}

/**
 * 参数来源标注：给面板/诊断看的「这个值现在是从哪来的」。
 * 三级取值的解释权在 config.js，这里只做归因展示，不参与取值。
 */
export async function settingsSource(env, key) {
  const field = SETTINGS_SPEC[key];
  if (!field) return 'unknown';
  const stored = await readStoredSection(env, SETTINGS_SECTION);
  if (stored[key] !== undefined) return 'panel';
  if (field.env && readEnvValue(env, field.env) !== undefined) return 'env';
  if (field.legacyKey) {
    const raw = await kvGet(field.legacyKey);
    if (raw !== null && raw !== undefined && String(raw).trim() !== '') return 'legacy';
  }
  return 'default';
}

/** 一次算全部字段的来源。面板一次请求就能把整表的来源标出来，不必逐字段往返。 */
export async function settingsSources(env) {
  const out = {};
  for (const key of Object.keys(SETTINGS_SPEC)) out[key] = await settingsSource(env, key);
  return out;
}

/**
 * 分组清单 + 每组字段数。面板的卡片标题与「共 N 项」提示都由它出，
 * 不需要在界面或目录里再数一遍。
 * count 只数**本页可改**的字段；ownTab 的字段编辑入口在别的选项卡，单独用 ownTab 汇总。
 */
export function describeGroups() {
  return SETTINGS_GROUPS.map(g => {
    const fields = Object.entries(SETTINGS_SPEC).filter(([, f]) => f.group === g.id);
    return {
      id: g.id,
      name: g.name,
      desc: g.desc,
      count: fields.filter(([, f]) => !f.ownTab).length,
      ownTab: fields.filter(([, f]) => !!f.ownTab).length,
    };
  });
}

export { sanitize };
