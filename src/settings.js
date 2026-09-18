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
  sanitize, invalidateDoc, CONFIG_KEY, coerceBySpec,
} from './config.js';
import { runtime, notifyConfigChange } from './runtime.js';
import { isUuid, parseIpv4List, parseDomainList } from './util.js';

/** 配置文档里的分区名。整表存 APP_CONFIG[section]，与其它模块的分区同一份文档、同一份缓存。 */
export const SETTINGS_SECTION = 'settings';

// ===================== 分组 =====================
//
// 分组只决定「在配置中心的哪张卡片里」，字段自己声明属于哪一组（field.group）。
// 加一组 = 这里加一条；加一个字段 = SETTINGS_SPEC 加一条。两边都不需要改界面代码。

export const SETTINGS_GROUPS = [
  { id: 'preferred', name: '优选与候选', desc: '订阅候选怎么拉、优选池留多少、探测多快多重。改完下一个请求就按新值跑。' },
  { id: 'node', name: '代理节点身份', desc: '订阅里出现的节点 ID、地址与路径。改完重新拉一次订阅即可看到；改 UUID 会让旧订阅链接失效。' },
  { id: 'nodetag', name: '节点备注国家标注', desc: '给订阅节点的备注补上 IP 归属国家，主订阅与临时订阅同一套规则。' },
  { id: 'pool', name: '优选池与候选域名', desc: '自动优选优先用哪些 IP、候选域名从哪里解析。条数上限沿用「优选与候选」里的设置。' },
  { id: 'datasource', name: '边缘段与外部数据源', desc: '判定「节点是否归属边缘网络」以及国家标注所用的外部接口地址。' },
  { id: 'proxy', name: '代理与转发', desc: '优选目标域名与转发侧的可用性取舍。' },
  { id: 'cloudflare', name: 'Cloudflare 接口', desc: '「CF 用量」驾驶舱与 DNS 优选调用 CF API 所需的凭据与端点。凭据只回显「是否已配置」。' },
  { id: 'ops', name: '运维与隐私', desc: '面板上的运维入口与来访者哈希盐值。' },
];

// ===================== 字段表 =====================
//
// type        bool / int / str / list —— 与控制方式、归一化方式同一份定义（config.js 的 COERCERS）
// default     默认值。必须是与具体部署无关的中性值（不含域名 / IP / 口令）
// min / max   整数区间。面板的 min/max 与运行时的夹紧都由它插值，不手写
// env         对应的环境变量名，作为首次部署的种子
// legacyKey   历史独立 KV 键：升级后首次读取时兜底，避免「面板显示默认值、实际沿用旧值」
// secret      敏感项：面板只回显「是否已配置」，值不出现在任何返回体里
// label/hint/unit/level/wide/options  呈现信息，目录按它渲染表单
//
// store       存在哪儿。默认 'section'（APP_CONFIG[settings]）；'engine' 是代理引擎自己的
//             config.json（与引擎共用一份，落点见 engineKey）；'kv' 是历史独立 KV 键（见 kvKey）。
//             加一个字段只声明它存在哪，读写的归一化与三级取值仍然只有这一套实现。
// panel       归属哪一个设置表单（目录项 id）。标了就不再出现在「配置中心」的运行参数卡里 ——
//             这是「同一份配置只有一处可改」的落点：字段在哪张表单上，由字段自己说了算。
// itemKind    list 型元素的合法性（ipv4 / domain）；非法项直接报错，不静默过滤 ——
//             静默过滤会造成「提示保存成功、池子其实被筛空」。
// limitBy     list 型最多保留多少项，取自另一个字段（面板写入与运行时读取共用同一上限）。

export const SETTINGS_SPEC = {
  // ---------- 优选与候选 ----------
  dns_interval_minutes: {
    type: 'int', default: 720, min: 5, max: 1440, env: 'DNS_INTERVAL',
    legacyKey: 'DNS_CONFIG', panel: 'dns-config',
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
  latency_enabled: {
    type: 'bool', default: false, env: 'LATENCY_ENABLED',
    group: 'preferred', label: '按实测延迟排序',
    hint: '关着的时候优选只挑「能通的」，顺序是谁先探到谁在前；开着会逐个实测延迟再按快慢排。多花几秒，通常换来明显更快的节点',
  },
  latency_samples: {
    type: 'int', default: 2, min: 1, max: 5, env: 'LATENCY_SAMPLES',
    group: 'preferred', label: '每个目标取样次数', unit: '次', level: 'advanced',
    hint: '取中位数，抵消单次抖动。次数越多越准、也越耗时（会挤占总预算）',
  },
  latency_budget_ms: {
    type: 'int', default: 8000, min: 1000, max: 25000, env: 'LATENCY_BUDGET_MS',
    group: 'preferred', label: '延迟实测总预算', unit: '毫秒', level: 'advanced',
    hint: '预算耗尽就按已测到的结果排序，绝不把整个请求拖过 Workers 的墙钟',
  },
  sub_latency_sort: {
    type: 'bool', default: true, env: 'SUB_LATENCY_SORT',
    group: 'preferred', label: '订阅按实测延迟排序',
    hint: '客户端通常拿订阅里第一个节点用，所以顺序就是速度。开着会把实测最快的排到最前；关着则原样透传上游订阅的顺序（近似随机）。测量结果有缓存，只有缓存过期后那一次拉取会多花几秒',
  },
  sub_latency_ttl_ms: {
    type: 'int', default: 1800000, min: 60000, max: 21600000, env: 'SUB_LATENCY_TTL_MS',
    group: 'preferred', label: '延迟缓存有效期', unit: '毫秒', level: 'advanced',
    hint: '缓存期内复用上次实测结果，不重复探测。调大省时间但跟不上网络变化，调小更准但每次拉订阅都要实测一遍',
  },
  pick_speed_enabled: {
    type: 'bool', default: true, env: 'PICK_SPEED_ENABLED',
    group: 'preferred', label: '自动优先用浏览器测速的顺序',
    hint: '服务端只能从 Cloudflare 自己的网络探测，那个「最快」跟你的网络基本无关（实测两个视角的排序近似零相关）。开着就用你在面板「浏览器自动优选」测出来的快慢来排；关着则回到服务端探测的顺序。服务端始终只负责把不通的 IP 剔掉',
  },
  pick_speed_ttl_ms: {
    type: 'int', default: 43200000, min: 600000, max: 172800000, env: 'PICK_SPEED_TTL_MS',
    group: 'preferred', label: '浏览器测速结果有效期', unit: '毫秒', level: 'advanced',
    hint: '超过这个时间没重新测过就当作没测过，回到服务端顺序。换了网络（回家、出国）旧数字就是错的，所以宁可不用也不能一直信',
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
    legacyKey: 'SUB_URL', panel: 'sub-config',
    group: 'node', label: '订阅链接', wide: true,
    hint: '完整 URL（http(s)://…）或以 / 开头的路径（如 /tsub/xxx）；留空则回退到本机 /sub',
  },

  // ---------- 代理节点身份 ----------
  //
  // 这几个字段落在**代理引擎自己的配置文档** KV config.json 里（store: 'engine'）。
  // 为什么不搬到 APP_CONFIG：引擎直接读这份文档，搬走就等于同一个设定有两份存储。
  // 这里只做两件事 —— 按同一套三级取值把它读出来，以及在交给引擎前把有效值回灌成
  // 环境变量（engineEnvFor），否则引擎会用环境变量/请求上下文把面板值覆盖掉：
  // 面板上「节点 ID / 节点地址 / 路径 / 订阅 TOKEN」曾因此改了完全不生效。
  node_uuid: {
    store: 'engine', engineKey: 'UUID', panel: 'node-config',
    type: 'str', default: '', maxLen: 64, env: 'UUID',
    // 引擎只认 v4 形态的 UUID，其余一律静默改用它自己派生的那个。
    // 所以这里必须写入前拦住：否则「面板保存成功、节点 ID 其实没变」。
    validate: v => (isUuid(v) ? '' : '节点 ID 必须是 UUID v4 形态（8-4-4-4-12 位十六进制，第 3 段以 4 开头、第 4 段以 8/9/a/b 开头）'),
    group: 'node', label: '节点 ID（UUID）', wide: true,
    hint: '订阅链接里的用户 ID。改它会让已发出的链接全部失效，需要重新复制节点链接',
  },
  node_host: {
    store: 'engine', engineKey: 'HOSTS', panel: 'node-config',
    type: 'list', itemKind: 'domain', default: [], maxItems: 5, env: 'HOST',
    group: 'node', label: '节点地址', wide: true,
    hint: '每行一个域名，第一个进入订阅链接；留空则用客户端实际访问的域名',
  },
  node_path: {
    store: 'engine', engineKey: 'PATH', panel: 'node-config',
    type: 'str', default: '/', maxLen: 200, env: 'PATH',
    validate: v => (String(v).trim().startsWith('/') ? '' : '节点路径必须以 / 开头'),
    group: 'node', label: '节点路径', wide: true,
    hint: '客户端连接的路径，必须以 / 开头；反向代理参数会自动追加在它后面',
  },
  node_protocol: {
    store: 'engine', engineKey: '协议类型', panel: 'node-config',
    type: 'str', default: 'vless', options: ['vless', 'trojan', 'ss'],
    group: 'node', label: '协议类型',
  },
  node_transport: {
    store: 'engine', engineKey: '传输协议', panel: 'node-config',
    type: 'str', default: 'ws', options: ['ws', 'grpc'],
    group: 'node', label: '传输协议',
  },
  node_fingerprint: {
    store: 'engine', engineKey: 'Fingerprint', panel: 'node-config',
    type: 'str', default: 'chrome', maxLen: 40, level: 'advanced',
    group: 'node', label: 'TLS 指纹（fp）',
  },
  node_sub_name: {
    store: 'engine', engineKey: ['优选订阅生成', 'SUBNAME'], panel: 'node-config',
    type: 'str', default: 'edgetunnel', maxLen: 100,
    group: 'node', label: '订阅名称', hint: '客户端里显示的订阅名，也是节点备注的默认值',
  },
  node_sub_update_hours: {
    store: 'engine', engineKey: ['优选订阅生成', 'SUBUpdateTime'], panel: 'node-config',
    type: 'int', default: 3, min: 1, max: 168, unit: '小时', level: 'advanced',
    group: 'node', label: '客户端订阅更新间隔',
    hint: '写进订阅响应的 Profile-Update-Interval。引擎按「小时」解释这个值，所以面板也用小时',
  },

  // ---------- 节点备注国家标注 ----------
  //
  // 曾经只有一张手写表单 + 一处「只认环境变量」的样式解析：面板上改了样式，
  // 订阅输出仍然是旧样式。现在样式与开关都进注册表，解析只有一处。
  node_tag_enabled: {
    store: 'kv', kvKey: 'NODE_COUNTRY_TAG', panel: 'node-tag',
    type: 'bool', default: true, env: 'NODE_COUNTRY_TAG',
    group: 'nodetag', label: '给节点备注补国家',
    hint: '关闭后订阅原样输出，不产生任何外部查询',
  },
  node_tag_style: {
    store: 'kv', kvKey: 'NODE_COUNTRY_STYLE', panel: 'node-tag',
    type: 'str', default: 'cn-code', options: ['cn-code', 'flag-name', 'name', 'code', 'flag'],
    env: 'NODE_COUNTRY_STYLE',
    group: 'nodetag', label: '标注样式',
    hint: 'cn-code 美国【US】／flag-name 🇺🇸美国／name 美国／code US／flag 🇺🇸',
  },

  // ---------- 优选池与候选域名 ----------
  //
  // 列表型数据也走注册表：上限、解析口径、面板与运行时的截断长度因此只有一份定义。
  // 面板提交的非法项一律**报错退回**（不静默过滤），否则会出现「提示保存成功、池子是空的」。
  preferred_ips: {
    store: 'kv', kvKey: 'PREF_IPS', panel: 'preferred-ips',
    type: 'list', itemKind: 'ipv4', default: [], limitBy: 'pool_limit', env: 'PREF_IPS',
    group: 'pool', label: '优选 IP 池', wide: true,
    hint: '每行一个 IPv4；「浏览器自动优选」测速后也存这里，自动优选优先从它取候选',
  },
  pool_good_ips: {
    store: 'kv', kvKey: 'GOOD_IPS', panel: 'pool-config',
    type: 'list', itemKind: 'ipv4', default: [], limitBy: 'pool_limit',
    group: 'pool', label: '已验证可用集', wide: true,
    hint: '健康检查与自动优选写回的「确实通」的 IP，优先级高于上面的优选池',
  },
  pref_domains: {
    store: 'kv', kvKey: 'PREF_DOMAINS', panel: 'pool-config',
    type: 'list', itemKind: 'domain', default: [], limitBy: 'domain_pool_limit', env: 'PREF_DOMAINS',
    group: 'pool', label: '候选域名池', wide: true,
    hint: '每行一个域名；解析它们的 A 记录来补充候选 IP，留空则不启用这一路候选',
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

// ===================== 存储适配器 =====================
//
// 注册表里的一张字段表要管三种落点，但**取值与归一化只有这一套实现**：
//
//   section（默认）—— APP_CONFIG[settings]，与其它模块同一份文档、同一份缓存
//   engine        —— 代理引擎自己的 KV config.json，配置键是引擎的格式（含中文键）
//   kv            —— 历史独立 KV 键（PREF_IPS / GOOD_IPS / PREF_DOMAINS / NODE_COUNTRY_*）
//
// 为什么不让各模块自己去读这些键：那样「面板读到的」和「运行时用的」迟早会分叉。
// 这里多出来的只是「去哪儿取、写回哪儿」，规则仍然只有一条。

/** 引擎配置文档的存储键（与 vendor/vless.js 共用，别改名） */
const ENGINE_KEY = 'config.json';

/** 按 store 把字段表分堆 */
function groupByStore(spec) {
  const out = { section: {}, engine: {}, kv: {} };
  for (const [key, field] of Object.entries(spec)) {
    const store = field.store || 'section';
    if (!out[store]) out[store] = {};
    out[store][key] = field;
  }
  return out;
}

/** 存储里的值算不算「配过」。注意 'false' / '0' 都是有意义的取值，只有空/null 才算没配。 */
function hasStored(raw) {
  if (raw === null || raw === undefined) return false;
  if (Array.isArray(raw)) return raw.length > 0;
  return String(raw).trim() !== '';
}

function hasEnv(field, env) {
  if (!field.env) return false;
  const v = readEnvValue(env, field.env);
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/** 三级取值：存储 → 环境变量种子 → 规范默认值。三处存储共用这一处判断。 */
function pickValue(field, raw, env) {
  if (hasStored(raw)) return raw;
  if (hasEnv(field, env)) return readEnvValue(env, field.env);
  return field.default;
}

/** 列表项的清洗：去掉行内注释、去空白、域名小写。校验与落盘都用它，口径只有一处。 */
function tidyItem(item) {
  return String(item == null ? '' : item).split('#')[0].trim().toLowerCase();
}

/** 列表型：整份字符串按行/逗号拆开，去空去重，不在这里做合法性裁剪（那由 validate 报错） */
function splitList(raw) {
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
  return String(raw === null || raw === undefined ? '' : raw)
    .split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
}

/**
 * 列表型的归一化（没有专用解析器时的兜底）：清洗 → 去重（保序）。
 *
 * IPv4 / 域名的合法性判断一律交给 util.js 的规范解析器（见 readList），
 * 这里不另立一套校验 —— 同一份规则写两遍，迟早会分叉成「面板拒了、运行时认了」。
 */
function coerceList(field, raw) {
  const items = splitList(raw).map(tidyItem).filter(Boolean).filter((s, i, arr) => arr.indexOf(s) === i);
  const capped = typeof field.maxItems === 'number' ? items.slice(0, field.maxItems) : items;
  return capped;
}

/**
 * 列表型的规范化：**读写共用这一处**。
 *
 * 用 util.js 的规范解析器（拆行 / 清洗 / 去重 / 丢弃非法项），而不是再写一套逐项校验：
 *   1. 面板写入的与运行时读出的必然是同一批值 —— 这是「改了这里那里不生效」的结构性防线；
 *   2. 一个错别字只会丢掉那一行，不会让整池候选作废（解析器本来就是「能用多少用多少」）。
 * 调用方若需要「输入非空却一条都没留下就说清楚」的提示，自行比较结果长度（见 admin.js）。
 */
function readList(field, raw) {
  if (field.itemKind === 'ipv4') return parseIpv4List(raw);
  if (field.itemKind === 'domain') return parseDomainList(raw);
  return coerceList(field, raw);
}

function coerceStored(field, raw, env) {
  const picked = pickValue(field, raw, env);
  if (field.type === 'list') return readList(field, picked);
  return coerceBySpec(field, picked);
}

/** 列表型的条数上限取自另一个字段（如 pool_limit）：面板写入与运行时读取必须是同一上限 */
function limitFor(field, values) {
  if (!field.limitBy || !values) return 0;
  const n = Number(values[field.limitBy]);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** 读取后统一按上限截断：面板显示的就是运行时用到的那些 */
function applyListLimits(values) {
  for (const [key, field] of Object.entries(SETTINGS_SPEC)) {
    if (field.type !== 'list' || !field.limitBy) continue;
    const limit = limitFor(field, values);
    if (limit && Array.isArray(values[key])) values[key] = values[key].slice(0, limit);
  }
}

async function readEngineDoc() {
  try {
    const raw = await runtime.KV.get(ENGINE_KEY);
    if (!raw) return {};
    const doc = JSON.parse(raw);
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  } catch { return {}; }
}

/** engineKey 可以是 'UUID'，也可以是 ['优选订阅生成','SUBNAME'] 这样的嵌套路径 */
function getPath(doc, engineKey) {
  const keys = Array.isArray(engineKey) ? engineKey : [engineKey];
  let cur = doc;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function setPath(doc, engineKey, value) {
  const keys = Array.isArray(engineKey) ? engineKey : [engineKey];
  let cur = doc;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

/** 删掉文档里的一条路径（用于「清空 = 回到引擎自己的默认」） */
function deletePath(doc, engineKey) {
  const keys = Array.isArray(engineKey) ? engineKey : [engineKey];
  let cur = doc;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur || typeof cur !== 'object') return;
    cur = cur[keys[i]];
  }
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) delete cur[keys[keys.length - 1]];
}

/**
 * 把一个引擎字段写进配置文档。空列表刻意**删除该键**而不是写 `[]`。
 *
 * 理由：引擎的判断是 `if (!config_JSON.HOSTS) config_JSON.HOSTS = [hostname]`，
 * 而 `[]` 是 truthy —— 写空数组会让引擎保留一个空的主机列表，生成出来的订阅
 * 一条主机都没有。「清空节点地址」的正确语义是回到引擎默认（用客户端实际访问的域名），
 * 只有删键才能让它发生。这与列表型「空 = 有意义的空」的语义一致，只是引擎的写法需要删键。
 */
function writeEngineField(doc, engineKey, value) {
  if (Array.isArray(value) && !value.length) { deletePath(doc, engineKey); return; }
  setPath(doc, engineKey, value);
}

/**
 * 读全部运行参数（已归一化、已夹紧、已脱敏前）。
 * @returns {Promise<Record<string, any>>}
 */
export async function readSettings(env) {
  const { section, engine, kv } = groupByStore(SETTINGS_SPEC);
  const values = await readSection(env, SETTINGS_SECTION, section);

  if (Object.keys(engine).length) {
    const doc = await readEngineDoc();
    for (const [key, field] of Object.entries(engine)) {
      values[key] = coerceStored(field, getPath(doc, field.engineKey), env);
    }
  }

  const kvKeys = Object.keys(kv);
  if (kvKeys.length) {
    // 一次并发读完，别逐字段往返存储
    const raws = await Promise.all(kvKeys.map(k => kvGet(kv[k].kvKey)));
    kvKeys.forEach((key, i) => { values[key] = coerceStored(kv[key], raws[i], env); });
  }

  // 历史遗留键兜底（只针对分区存储的字段）：老版本把值放在独立 KV 键里，且**只**认环境变量。
  // 只有在「面板没存过、环境变量也没给」时才回头看遗留键 —— 少一次存储读，
  // 也避免「用户刚在面板里显式改成默认值，却被遗留键顶回去」。
  const legacy = Object.entries(section).filter(([, f]) => f.legacyKey);
  if (legacy.length) {
    const stored = await readStoredSection(env, SETTINGS_SECTION);
    for (const [key, field] of legacy) {
      if (stored[key] !== undefined) continue;
      if (hasEnv(field, env)) continue;
      const raw = await kvGet(field.legacyKey);
      if (!hasStored(raw)) continue;
      values[key] = coerceLegacy(field, key, raw);
    }
  }

  applyListLimits(values);
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
 *
 * 三种存储分别落位，但**归一化与校验都走同一条路径**：先按字段声明收敛成最终值，
 * 再决定写到哪里。这样「面板存进去的」与「运行时读出来的」不可能出现两套口径。
 */
export async function saveSettings(env, patch) {
  // 不认识的字段**报错**，不是静默忽略。
  //
  // 静默忽略的代价很大：字段名写错一个字母、或某个调用方还在用旧别名时，
  // 接口照样返回 200「已保存」，而实际一个字节都没写进去。
  // 面板上的表现就是「点了保存、提示成功、但值没变」——不报错、不抛异常、
  // 日志也干净，只能靠人肉逐字段对比才发现。所以这里一次性堵死：
  // 字段名只有 SETTINGS_SPEC 这一套，写不进去就当场说清楚是哪个名字。
  const unknown = Object.keys(patch || {}).filter(k => !(k in SETTINGS_SPEC));
  if (unknown.length) {
    return { error: `未知配置项：${unknown.join('、')}（字段名以 settings.js 的 SETTINGS_SPEC 为唯一真源）` };
  }

  const { section, engine, kv } = groupByStore(SETTINGS_SPEC);
  const sectionPatch = {};
  const enginePatch = {};
  const kvPatch = {};

  // 列表型的条数上限来自另一个字段（limitBy），先取一次当前值 ——
  // 面板写入的截断长度必须与运行时读取的一致，否则「填多了被静默丢掉」
  const needsLimit = Object.entries(SETTINGS_SPEC).some(([k, f]) => f.limitBy && k in (patch || {}));
  const current = needsLimit ? await readSettings(env) : null;

  for (const [key, field] of Object.entries(SETTINGS_SPEC)) {
    if (!(key in (patch || {}))) continue;
    const raw = patch[key];
    if (raw === undefined || raw === null) continue;

    let value;
    if (field.type === 'list') {
      // 写入与读取走**同一个解析器**（见 readList）：同样是「拆行 → 清洗 → 去重 → 丢弃非法项 → 截断」。
      // 曾经写入路径另有一套「逐项报错退回」，于是同一个值在面板里被拒、在运行时却被认 ——
      // 正是这一类「两套口径」制造了「改了这里、那里不生效」。现在只有 util.js 一份判断。
      value = readList(field, raw);
      const cap = typeof field.maxItems === 'number' ? field.maxItems : limitFor(field, current);
      if (cap) value = value.slice(0, cap);
    } else {
      value = raw;
      // 与 config.js 同一套「留空保持不变」语义：空值不覆盖，除非字段声明空是合法取值。
      // 列表型天然可以清空（清空池子是个明确意图），字符串型仍然按「留空 = 不改」。
      if (String(raw).trim() === '' && !(field.allowEmpty || NO_EMPTY_OVERRIDE.includes(key))) continue;
    }

    if (field.validate) {
      const err = field.validate(value);
      if (err) return { error: err };
    }

    // 声明了 options 的字段只接受表里的取值，并**存规范写法**。
    // 少这一条就会出现第三种值：面板的下拉选不到它、消费方只认表里的字面量 ——
    // 于是「保存成功」但那个值对谁都不生效。大小写也在这里收口（协议/传输写进节点链接时是字面量）。
    if (field.options && field.options.length) {
      const canonical = field.options.find(o => String(o).toLowerCase() === String(value).trim().toLowerCase());
      if (canonical === undefined) return { error: `${field.label || key} 只能取：${field.options.join(' / ')}` };
      value = canonical;
    }

    if (field.store === 'engine') enginePatch[key] = value;
    else if (field.store === 'kv') kvPatch[key] = value;
    else sectionPatch[key] = value;
  }

  // 分区存储：沿用 config.js 的 writeSection（校验、脱敏、广播都在那边）
  let saved = [];
  if (Object.keys(sectionPatch).length) {
    const r = await writeSection(env, SETTINGS_SECTION, section, sectionPatch);
    if (r && r.error) return r;
    saved = saved.concat(Object.keys(sectionPatch));
  }

  // 引擎配置文档：整份读出来改完再写回，保留引擎自己的其它键（订阅转换、反代、TG…）
  if (Object.keys(enginePatch).length) {
    const doc = await readEngineDoc();
    for (const [key, value] of Object.entries(enginePatch)) {
      writeEngineField(doc, engine[key].engineKey, value);
    }
    await runtime.KV.put(ENGINE_KEY, JSON.stringify(doc));
    // 引擎侧同样要「保存即生效」：引擎每次请求都会读这份文档，没有再缓存一层，
    // 但本进程里读过的副本要作废，否则面板自己刷新时还可能看到旧值
    invalidateDoc();
    notifyConfigChange('engine');
    saved = saved.concat(Object.keys(enginePatch));
  }

  //独立 KV 键：列表按行存，与运行时自己的写入格式一致（见 dns.js 的 GOOD_IPS）
  const kvKeys = Object.keys(kvPatch);
  if (kvKeys.length) {
    await Promise.all(kvKeys.map(key => {
      const field = kv[key];
      const value = kvPatch[key];
      const raw = field.type === 'list' ? value.join('\n') : String(value);
      return Promise.resolve(runtime.KV.put(field.kvKey, raw)).catch(() => null);
    }));
    notifyConfigChange('kv');
    saved = saved.concat(kvKeys);
  }

  return { values: await readSettings(env), safe: sanitize(SETTINGS_SPEC, await readSettings(env)), saved };
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
  const field = SETTINGS_SPEC[key];
  if (!field) return { error: `未知参数：${key}` };

  if (field.store === 'engine') {
    // 引擎文档里没有「删除字段」这种语义：清空 = 写回空值（引擎随后按请求上下文兜底）。
    // 列表型见 writeEngineField —— 直接删键，让引擎的 `if (!HOSTS)` 兜底生效。
    const doc = await readEngineDoc();
    writeEngineField(doc, field.engineKey, field.type === 'list' ? [] : '');
    await runtime.KV.put(ENGINE_KEY, JSON.stringify(doc));
    notifyConfigChange('engine');
    return { ok: true, values: await readSettings(env) };
  }

  if (field.store === 'kv') {
    await Promise.resolve(runtime.KV.delete(field.kvKey)).catch(() => null);
    notifyConfigChange('kv');
    return { ok: true, values: await readSettings(env) };
  }

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

/** 字段 -> 目录参数：呈现信息只写在字段自己身上，目录不手抄第二份 */
function paramOf(key, field, group) {
  const param = { key, label: field.label || key, section: groupLabel(group) };
  if (field.hint) param.hint = field.hint;
  if (field.unit) param.unit = field.unit;
  if (field.level) param.level = field.level;
  if (field.wide) param.wide = true;
  if (field.options) {
    param.options = field.options.map(v => ({ value: v, label: field.optionLabels && field.optionLabels[v] || v }));
    param.type = 'select';
  }
  if (field.control) param.type = field.control;
  // 列表型与多行 CIDR 用文本域
  if (field.type === 'list' || NO_EMPTY_OVERRIDE.includes(key)) param.type = 'textarea';
  if (field.secret) param.type = 'password';
  return param;
}

/**
 * 面板字段清单：由 SETTINGS_SPEC 推导，不在目录里手抄一遍。
 * 这正是「加一个参数只改一处」的落点 —— 呈现信息就写在字段自己身上。
 *
 * 顺序即 SETTINGS_GROUPS 的顺序（分组内按声明顺序），每项带 section（分组名）：
 * 渲染层据此在同一张表单里插入小标题，而不是把 30 个字段平铺成一片。
 *
 * 绑定了专属表单（field.panel）的字段不在这里 —— 它有唯一的编辑入口，见 panelOf()。
 */
export function panelParams() {
  const order = new Map(SETTINGS_GROUPS.map((g, i) => [g.id, i]));
  return Object.entries(SETTINGS_SPEC)
    .filter(([, f]) => !f.panel)
    .map(([key, f]) => ({ key, field: f, group: f.group || '' }))
    .sort((a, b) => (order.get(a.group) ?? 99) - (order.get(b.group) ?? 99))
    .map(({ key, field: f, group }) => paramOf(key, f, group));
}

/**
 * 某个专属表单（目录项 id）要呈现的字段。
 *
 * 一张表单 = 目录里一个设置项，字段用 field.panel 声明自己属于哪张。
 * 这样「同一份配置只有一处可改」不是靠人工核对，而是**结构上不可能重复**：
 * 一个字段只能声明一个 panel，声明了就不会再出现在配置中心的运行参数卡里。
 */
export function panelParamsOf(panelId) {
  return Object.entries(SETTINGS_SPEC)
    .filter(([, f]) => f.panel === panelId)
    .map(([key, f]) => paramOf(key, f, f.group || ''));
}

/** 某个专属表单要覆盖的字段子集（与 panelParamsOf 同一口径，供目录声明 item.spec） */
export function panelSpecOf(panelId) {
  const out = {};
  for (const [key, field] of Object.entries(SETTINGS_SPEC)) {
    if (field.panel === panelId) out[key] = field;
  }
  return out;
}

/** 面板表单要覆盖的字段子集（与 panelParams 同一口径，供目录声明 item.spec） */
export function panelSpec() {
  const out = {};
  for (const [key, field] of Object.entries(SETTINGS_SPEC)) {
    if (!field.panel) out[key] = field;
  }
  return out;
}

/** 分组 id -> 显示名。未知分组返回空串（不编一个名字出来） */
export function groupLabel(groupId) {
  const g = SETTINGS_GROUPS.find(x => x.id === groupId);
  return g ? g.name : '';
}

/**
 * 参数来源标注：给面板/诊断看的「这个值现在是从哪来的」。
 * 三级取值的解释权在 config.js，这里只做归因展示，不参与取值。
 */
export async function settingsSource(env, key) {
  const field = SETTINGS_SPEC[key];
  if (!field) return 'unknown';

  // 引擎 / 独立 KV 两种存储：存储里有值就是 panel（都是面板写的），没有就看环境变量种子
  if (field.store === 'engine') {
    const doc = await readEngineDoc();
    if (hasStored(getPath(doc, field.engineKey))) return 'panel';
    return hasEnv(field, env) ? 'env' : 'default';
  }
  if (field.store === 'kv') {
    if (hasStored(await kvGet(field.kvKey))) return 'panel';
    return hasEnv(field, env) ? 'env' : 'default';
  }

  const stored = await readStoredSection(env, SETTINGS_SECTION);
  if (stored[key] !== undefined) return 'panel';
  if (hasEnv(field, env)) return 'env';
  if (field.legacyKey) {
    const raw = await kvGet(field.legacyKey);
    if (hasStored(raw)) return 'legacy';
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
 * count 只数**配置中心这张卡**上可改的字段；绑定了专属表单（field.panel）的字段
 * 编辑入口在功能页里，单独用 ownTab 汇总 —— 否则卡片标题会虚报字段数。
 */
export function describeGroups() {
  return SETTINGS_GROUPS.map(g => {
    const fields = Object.entries(SETTINGS_SPEC).filter(([, f]) => f.group === g.id);
    return {
      id: g.id,
      name: g.name,
      desc: g.desc,
      count: fields.filter(([, f]) => !f.panel).length,
      ownTab: fields.filter(([, f]) => !!f.panel).length,
    };
  });
}

// ===================== 交给代理引擎的身份 =====================

/**
 * 引擎身份：把注册表解析出的有效值回灌成引擎认的环境变量。
 *
 * ## 它修的是什么
 *
 * `vendor/vless.js` 每次请求都会用环境变量与请求上下文**无条件覆盖**它自己那份
 * config.json 里的 `UUID / HOSTS / PATH`（`config_JSON.UUID = userID`、
 * `config_JSON.HOST = host`、以及末尾重算的订阅 TOKEN）。于是面板上改「节点 ID /
 * 节点地址 / 路径 / 订阅 TOKEN」全都保存成功但**一点效果都没有** ——
 * 这正是「这里改了那里不生效」的典型。
 *
 * 修法不去动 vendor（上游升级会冲突，也不该由业务侧改引擎）：把面板值作为
 * 环境变量交给引擎，让「面板 → 存储 → 引擎」成为一条链，环境变量退化为首次部署的种子。
 * 默认值与环境变量种子相同，所以**没有在面板上改过的部署，行为与改动前逐字一致**。
 */
export async function engineEnvFor(env, extra = {}) {
  const values = await readSettings(env);
  const out = { ...env };

  const uuid = String(values.node_uuid || '').trim();
  if (uuid) out.UUID = uuid;

  // HOSTS 是数组：引擎自己会按 [,\s]+ 拆 `env.HOST`，这里用逗号回灌等价于原值
  const hosts = Array.isArray(values.node_host) ? values.node_host.filter(Boolean) : [];
  if (hosts.length) out.HOST = hosts.join(',');

  const path = String(values.node_path || '').trim();
  if (path) out.PATH = path;

  // extra 是调用方的显式覆盖（如临时订阅要换成自己的 UUID），优先级最高：
  // 它代表「这一次请求就用这个身份」，不能被面板的默认身份顶掉。
  return { ...out, ...extra };
}

/**
 * 节点身份（订阅 token 的推导口径）：MD5MD5(host + uuid)。
 *
 * 调用方（subs.js 的兜底订阅、router.js 的临时订阅）必须与引擎算出同一个 token，
 * 否则「临时订阅链接」会 404。这里的 host/uuid 就是引擎实际会用的那一份
 * （面板值优先，其次环境变量，最后本次请求的 hostname），确保两边同源。
 */
export async function nodeIdentity(env, hostname = '') {
  const values = await readSettings(env);
  const uuid = String(values.node_uuid || readEnvValue(env, 'UUID') || '').trim().toLowerCase();
  const hosts = Array.isArray(values.node_host) ? values.node_host.filter(Boolean) : [];
  const host = (hosts[0] || String(hostname || '')).trim().toLowerCase();
  return { uuid, host, path: String(values.node_path || '').trim() };
}

export { sanitize };
