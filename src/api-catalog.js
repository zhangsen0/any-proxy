/**
 * API 目录：全站可配置项与工具接口的一份清单，也是「哪个选项卡管哪块内容」的唯一声明处。
 *
 * 为什么要有这个文件：
 *   早先每个接口的参数散落在 admin.js 的各个分支里，改一个字段要满文件找；
 *   面板 UI、自检脚本、文档三处各抄一遍，必然出现「这里改了那里没改」。
 *   现在这份目录是唯一事实来源 —— 面板按它渲染，自检按它校对，手册按它生成。
 *
 * 目录负责「怎么呈现」，模块的 SPEC 负责「取什么值」（见 src/config.js）：
 *   字段的类型、默认值、取值范围都从各模块导出的 SPEC 里读，不在这里重抄一遍。
 *   check-configui.mjs 会双向核对两者一致 —— SPEC 加字段漏了目录，或者目录写了
 *   SPEC 里不存在的字段，都会让自检红掉，而不是悄悄在界面上多出一个没人认领的输入框。
 *
 * 字段速查（改目录前先看这段）：
 *   group.tab       该分组的内容由哪个选项卡承载。标了就不再在「配置」页渲染表单，
 *                   只留一行跳转 —— 同一份内容只允许在一个地方可改，
 *                   否则两处口径迟早打架（优选池就曾同时长在「优选 IP」和「配置」里）。
 *   group.hidden    true 表示不在配置页出现（页面另有入口，如登录 / 登出）。
 *   item.kind       setting 可读可写的配置 / query 只读查询 / action 执行动作。
 *                   不写则按方法推断：GET 视为 query，其余视为 action。
 *   item.spec       该配置项的字段表（模块导出的 SPEC），字段类型与默认值由它决定。
 *                   运行参数里的字段另有归属表单：`panelSpecOf(id) / panelParamsOf(id)`
 *                   只取声明了「属于这张表单」的字段，因此一个字段不可能同时出现在两处。
 *   item.body       动作类接口的固定请求体（如 {action:"clean"}），界面不用为它写输入框。
 *   item.keep       true 表示即使所在分组归属别的选项卡，这一项仍留在配置页 ——
 *                   给「不属于任何功能页」的诊断类工具用。
 *   item.pathParam  路径里的 <id> 由界面单独收集。
 *   item.normalize  'lines' 表示该接口的文本域按行转成数组提交。
 *   param.type      覆盖 SPEC 推断出的控件类型（一般不用写）。
 *   param.in        'query' 表示该字段拼进查询串，其余进 JSON body。
 *   param.level     'advanced' 收进「进阶选项」折叠区，默认收起。
 *   param.options   下拉选项；不写时下拉项从 optionsFrom 指定的清单取。
 *   param.unit      数值输入框右侧的小字单位（秒 / 天 / 毫秒…）。
 */

import { STATS_SPEC } from './stats.js';
import { RATELIMIT_SPEC } from './ratelimit.js';
import { ALERT_SPEC, ALERT_FORMATS, ALERT_EVENT_IDS } from './alert.js';
import { SHARE_SPEC } from './share.js';
import { R2_CACHE_SPEC } from './media-r2.js';
import { SETTINGS_SPEC, panelSpec, panelParams, panelSpecOf, panelParamsOf } from './settings.js';

/** 选项卡 id -> 显示名。跳转行与手册按它出文案，避免多处各写一遍中文 */
export const TAB_LABELS = {
  sites: '站点',
  stats: '数据驾驶舱',
  edge: 'CF 用量',
  proxy: '代理节点',
  preferred: '优选 IP',
  security: '伪装与安全',
  theme: '外观主题',
  share: '临时链接',
  registry: '配置中心',
};

const SELECT = {
  scope: [
    { value: 'ip', label: '按来访者计数' },
    { value: 'ip_path', label: '按「来访者 + 路径」分别计数' },
  ],
  webhookType: ALERT_FORMATS.map(v => ({
    value: v,
    label: { generic: '通用 JSON', wecom: '企业微信机器人', dingtalk: '钉钉机器人' }[v] || v,
  })),
};

export const API_CATALOG = [
  // ===================== 配置页自己的设置（没有专门选项卡的功能） =====================
  // ===================== 归属「数据驾驶舱」：图表在那边看，设置也在那边改 =====================
  {
    id: 'stats',
    name: '访问统计',
    desc: '按天记录各通道的请求数与流量，用来回答「最近谁在用什么」。',
    tab: 'stats',
    items: [
      {
        id: 'stats-config', name: '统计设置', kind: 'setting',
        method: 'GET', path: '/__api/stats-config', writeMethod: 'POST',
        desc: '内存里聚合、按间隔批量落盘，不逐请求写存储，所以开着也不拖慢代理。',
        spec: STATS_SPEC,
        params: [
          { key: 'enabled', label: '启用统计', hint: '关闭后不再记录新数据，已有的保留' },
          { key: 'retention_days', label: '数据保留', type: 'number', unit: '天' },
          { key: 'track_visitors', label: '记录来访者数', hint: '只记来访 IP 的哈希，不存原始 IP' },
          { key: 'top_limit', label: '面板显示通道数', type: 'number', unit: '个', level: 'advanced' },
          { key: 'uv_limit', label: '单桶最多记录来访者', type: 'number', unit: '个', level: 'advanced' },
          { key: 'flush_ms', label: '落盘间隔', type: 'number', unit: '毫秒', level: 'advanced' },
          { key: 'record_admin', label: '把管理面板自身的访问也计入', level: 'advanced' },
        ],
      },
      {
        id: 'stats', name: '查看统计数据', kind: 'query', path: '/__api/stats',
        desc: '按天聚合的通道排行、流量（实际传输字节）、媒体流量、传输中断与来访数（驾驶舱用的就是这份数据）',
        params: [{ key: 'days', label: '统计天数', type: 'number', in: 'query', placeholder: '7' }],
      },
      {
        id: 'stats-clear', name: '清空统计数据', kind: 'action', method: 'POST', path: '/__api/stats/clear',
        desc: '删掉已落盘的全部访问记录，保留统计设置本身',
        danger: true,
      },
    ],
  },
  // ===================== 归属「CF 用量」：Cloudflare 边缘统计，不用登录 CF 控制台 =====================
  {
    id: 'cf-analytics',
    name: 'CF 用量',
    desc: 'Cloudflare 用量驾驶舱的数据源：直接查 CF 边缘统计（GraphQL），展示当前 Worker 绑定的账户基础用量，无需登录 CF 控制台。',
    tab: 'edge',
    items: [
      {
        id: 'cf-analytics', name: '查看 CF 用量', kind: 'query', path: '/__api/cf-analytics',
        desc: '按天请求数/带宽/缓存命中 + 近 24h 状态码分布与 Top 路径 + 当前 Worker 脚本近 30 天调用（5 分钟缓存，单源失败自动降级并注明）',
        params: [],
      },
    ],
  },
  {
    id: 'ratelimit',
    name: '限流与防滥用',
    desc: '按来访者加时间窗计数，超阈值挡下，屡犯临时封禁。',
    items: [
      {
        id: 'ratelimit-config', name: '限流设置', kind: 'setting',
        method: 'GET', path: '/__api/ratelimit', writeMethod: 'POST',
        desc: '计数在实例内存里做（单实例级平滑限流），只有封禁记录落盘，跨实例生效。',
        spec: RATELIMIT_SPEC,
        params: [
          { key: 'enabled', label: '启用限流' },
          { key: 'max_requests', label: '窗口内允许请求数', type: 'number', unit: '次' },
          { key: 'window_seconds', label: '时间窗', type: 'number', unit: '秒' },
          { key: 'scope', label: '计数口径', options: SELECT.scope },
          { key: 'exempt_authed', label: '已登录的请求不限流', hint: '自己用面板时不会被自己的阈值挡住' },
          { key: 'message', label: '被挡时的提示文案', wide: true },
          {
            key: 'whitelist', label: '放行名单', type: 'textarea', wide: true, level: 'advanced',
            hint: '每行一个 IP 或 CIDR，例如 203.0.113.0/24',
          },
          {
            key: 'exempt_paths', label: '豁免路径', type: 'textarea', wide: true, level: 'advanced',
            hint: '每行一个路径前缀；建议把登录接口放进来，否则登录页自己会被限流',
          },
          { key: 'ban_enabled', label: '启用屡犯封禁', level: 'advanced', hint: '被挡够次数就把来源封一段时间' },
          { key: 'ban_threshold', label: '触发封禁的被挡次数', type: 'number', unit: '次', level: 'advanced' },
          { key: 'ban_seconds', label: '封禁时长', type: 'number', unit: '秒', level: 'advanced' },
        ],
      },
      {
        id: 'ratelimit-bans', name: '查看当前封禁', kind: 'query', path: '/__api/ratelimit/bans',
        desc: '跨实例生效的封禁记录，到期自动解除',
      },
      {
        id: 'ratelimit-clear', name: '解除全部封禁', kind: 'action', method: 'POST', path: '/__api/ratelimit/clear',
        desc: '一键解封，用于确认是自己误封之后立刻恢复',
        danger: true,
      },
    ],
  },
  {
    id: 'alert',
    name: '告警通知',
    desc: '把登录失败、限流拦截、上游故障这类事件推到企业微信 / 钉钉 / 自建服务。',
    items: [
      {
        id: 'alert-config', name: '告警设置', kind: 'setting',
        method: 'GET', path: '/__api/alert', writeMethod: 'POST',
        desc: 'Webhook 地址本身是一条凭据，面板只回显「是否已配置」，留空表示不修改。',
        spec: ALERT_SPEC,
        params: [
          { key: 'enabled', label: '启用告警' },
          { key: 'webhook_url', label: 'Webhook 地址', type: 'password', wide: true },
          { key: 'webhook_type', label: '推送格式', options: SELECT.webhookType },
          { key: 'cooldown_minutes', label: '同一事件冷却', type: 'number', unit: '分钟' },
          { key: 'events', label: '订阅的事件', type: 'textarea', wide: true, level: 'advanced',
            hint: '每行一个，留空 = 全部订阅。可选：' + ALERT_EVENT_IDS.join(' / ') },
          { key: 'title_prefix', label: '标题前缀', level: 'advanced' },
          { key: 'max_per_hour', label: '每小时最多发送', type: 'number', unit: '条', level: 'advanced' },
          { key: 'timeout_ms', label: '发送超时', type: 'number', unit: '毫秒', level: 'advanced' },
        ],
      },
      {
        id: 'alert-test', name: '发一条测试告警', kind: 'action', method: 'POST', path: '/__api/alert/test',
        desc: '绕过冷却走完整发送链路，用来确认通道真的配对了',
      },
      {
        id: 'alert-recent', name: '查看最近发送记录', kind: 'query', path: '/__api/alert/recent',
        desc: '含跳过原因，排查「为什么没收到」先看这里',
      },
    ],
  },
  {
    id: 'diagnostics',
    name: '诊断工具',
    desc: '只在排查问题时用，不影响正常运行。',
    items: [
      {
        id: 'preferred-candidates', name: '拉取优选候选', kind: 'query', path: '/__api/preferred-candidates',
        desc: '按 Cloudflare 官方 IP 段过滤后，从订阅里抽出的候选 IP',
        auth: false,
      },
      {
        id: 'speedtest', name: '上游测速', kind: 'query', path: '/__api/speedtest',
        desc: '从 Worker 侧测各站点上游的响应延迟，用于判断慢在链路还是源站',
        auth: false,
      },
    ],
  },

  // ===================== 已有专门选项卡的功能：只留跳转，不再重复表单 =====================
  {
    id: 'sites',
    name: '反代站点',
    desc: '被代理的目标站点与访问前缀，在「站点」选项卡里增删改。',
    tab: 'sites',
    items: [
      { id: 'site-list', name: '站点列表', kind: 'query', path: '/__api/sites', desc: '所有站点及其访问前缀', auth: false },
      {
        id: 'site-add', name: '添加站点', kind: 'action', method: 'POST', path: '/__api/sites',
        desc: '名称 + 网址即可，访问后缀留空自动生成', auth: true,
      },
      {
        id: 'site-update', name: '修改站点', kind: 'action', method: 'PUT', path: '/__api/sites/<id>',
        desc: '改名称 / 后缀 / 目标地址，以及站点模式字段（proxyMode 取注册表键、mediaCacheAuthBind 盗链保护、mediaSkipDetailLog 媒体日志开关、aiKey/aiKeys AI 中转配置）；后缀变化时旧链接会一并迁移', auth: true,
        pathParam: { key: 'id', label: '站点 id', placeholder: 'demo' },
      },
      {
        id: 'site-delete', name: '删除站点', kind: 'action', method: 'DELETE', path: '/__api/sites/<id>',
        desc: '删除后 /p/<id>/ 立即失效', auth: true, danger: true,
        pathParam: { key: 'id', label: '站点 id', placeholder: 'demo' },
      },
    ],
  },
  {
    id: 'registry',
    name: '配置中心',
    desc: '系统注册表与配置字典的集中查看与编辑：站点模式注册表可编辑（新增 / 查看 / 编辑 / 删除），其余代码级字典（访问渠道 / 统计档位 / 告警事件 / 伪装模板 / 引擎词表 / 徽标色板）在面板内只读展示真源位置。',
    tab: 'registry',
    items: [
      {
        id: 'settings-runtime',
        name: '运行参数',
        kind: 'setting',
        method: 'GET', path: '/__api/settings', writeMethod: 'POST',
        desc: '全部「非部署形态」的可运营参数：字段表在 src/settings.js 一处声明，界面与文档都由它生成。'
          + '三处取值优先级为「面板配置 → 环境变量种子 → 规范默认值」，保存后立即生效、无需重新部署。'
          + '不在这里的只有部署形态项（存储后端与绑定、进站口令、代理引擎密钥）——它们必须与 wrangler.toml 一起改。',
        spec: panelSpec(),
        params: panelParams(),
      },
      {
        id: 'site-modes', name: '站点模式注册表', kind: 'setting', method: 'GET', path: '/__api/site-modes', writeMethod: 'POST',
        desc: '站点类型标签 / 徽标 / 说明 / 执行引擎（KV 可编辑，未配置用默认；内置 normal/media/ai 不可删、引擎不可改，自定义模式可增删改）', auth: true,
      },
      {
        id: 'r2-cache', name: 'R2 媒体缓存策略', kind: 'setting', method: 'GET', path: '/__api/r2-cache', writeMethod: 'POST',
        desc: '流媒体分片持久缓存的策略：总开关 / 保留天数 / 单分片上限 MB / 缓存总量上限 MB，KV 可编辑、保存即生效',
        auth: true,
        spec: R2_CACHE_SPEC,
        params: [
          { key: 'enabled', label: '启用持久缓存', hint: '关闭后不再往 R2 写入分片，已缓存的不受影响' },
          { key: 'ttlDays', label: '分片保留天数', type: 'number', unit: '天' },
          { key: 'maxObjectMB', label: '单分片缓存上限', type: 'number', unit: 'MB' },
          { key: 'maxTotalMB', label: '缓存总量上限', type: 'number', unit: 'MB', hint: '0 表示不限；超出后按到期时间淘汰最早的对象', level: 'advanced' },
        ],
      },
      {
        id: 'r2-clean', name: '立即清理过期分片', kind: 'action', method: 'POST', path: '/__api/r2-cache',
        desc: '不等定时周期，马上删除当前已过期的媒体分片', auth: true,
        body: { action: 'clean' },
      },
    ],
  },
  {
    id: 'subscription',
    name: '代理节点与订阅',
    desc: '订阅里出现的节点身份、订阅链接、节点国家标注与临时订阅，在「代理节点」选项卡里管理。'
      + '这一页的每一个字段都来自同一张运行参数表，且只有这一处可改。',
    tab: 'proxy',
    items: [
      {
        id: 'node-config', name: '订阅生成配置', kind: 'setting', method: 'GET', path: '/__api/node-config', writeMethod: 'POST',
        desc: '订阅里出现的节点 ID / 地址 / 路径 / 协议 / 传输 / 指纹与订阅名称、更新间隔。'
          + '取值与代理引擎共用同一份配置文档，保存后下一个订阅请求立即按新值输出；'
          + '改节点 ID 会让已发出的订阅链接失效，需要重新复制节点链接。'
          + '（订阅 TOKEN 由「节点地址 + 节点 ID」派生，不是独立配置，所以这里不提供填写处。）',
        auth: true,
        spec: panelSpecOf('node-config'),
        params: panelParamsOf('node-config'),
      },
      {
        id: 'sub-config', name: '订阅链接', kind: 'setting', method: 'GET', path: '/__api/sub-config', writeMethod: 'POST',
        desc: '浏览器优选从这里拉候选 IP；留空则用本机 /sub。（值与校验来自统一运行参数表，编辑入口就在本页，只此一处）',
        auth: true,
        spec: panelSpecOf('sub-config'),
        params: panelParamsOf('sub-config'),
      },
      {
        id: 'node-tag', name: '节点备注国家标注', kind: 'setting', method: 'GET', path: '/__api/node-tag', writeMethod: 'POST',
        desc: '给订阅节点的备注补上 IP 归属国家，例如 CF 电信优选 | 美国【US】。'
          + '主订阅 /sub 与临时订阅 /tsub/<id> 同一套规则；关闭后订阅原样输出，不产生任何外部查询。'
          + '国家查询结果长期缓存，同一个 IP 只真正查询一次。',
        auth: true,
        spec: panelSpecOf('node-tag'),
        params: panelParamsOf('node-tag'),
      },
      {
        id: 'tempsubs', name: '临时订阅列表', kind: 'query', path: '/__api/tempsubs',
        desc: '限时有效的临时订阅记录', auth: true,
      },
      {
        id: 'tempsub-add', name: '新建临时订阅', kind: 'action', method: 'POST', path: '/__api/tempsubs',
        desc: '独立 UUID，到期自动失效', auth: true,
      },
    ],
  },
  {
    id: 'preferred',
    name: '优选 IP 与 DNS',
    desc: '优选频率、优选池、候选域名池与健康检查，全部在「优选 IP」选项卡里配置。',
    tab: 'preferred',
    items: [
      {
        id: 'dns-config', name: '自动优选频率', kind: 'setting', method: 'GET', path: '/__api/dns-config', writeMethod: 'POST',
        desc: '定时任务按这个间隔执行一次优选；保存后立即生效，不等下一个周期',
        auth: true,
        spec: panelSpecOf('dns-config'),
        params: panelParamsOf('dns-config'),
      },
      {
        id: 'dns-run', name: '立即更新优选 IP', kind: 'action', method: 'POST', path: '/__api/dns-run',
        desc: '不等定时任务，马上测通并改写 A 记录（不可用会自动回滚）', auth: true,
      },
      {
        id: 'preferred-ips', name: '优选 IP 池', kind: 'setting', method: 'GET', path: '/__api/preferred-ips', writeMethod: 'POST',
        desc: '自动优选优先从这里取候选；条数上限沿用「配置中心 → 优选与候选」里的「优选池上限」',
        auth: true,
        spec: panelSpecOf('preferred-ips'),
        params: panelParamsOf('preferred-ips'),
      },
      {
        id: 'preferred-apply', name: '把当前池子写入 DNS', kind: 'action', method: 'POST', path: '/__api/preferred-ips',
        desc: '并发测通当前优选池里的 IP，把可用的写入 A 记录并自检（不修改池子内容）', auth: true,
        body: { apply: true },
      },
      {
        id: 'pool-config', name: '可用集与候选域名池', kind: 'setting', method: 'GET', path: '/__api/pool-config', writeMethod: 'POST',
        desc: '「已验证可用集」是自动优选与健康检查写回的、确实通的 IP（优先级高于优选池）；'
          + '「候选域名池」是解析 A 记录来补充候选 IP 的域名清单，留空则不启用这一路',
        auth: true,
        spec: panelSpecOf('pool-config'),
        params: panelParamsOf('pool-config'),
      },
    ],
  },
  {
    id: 'appearance',
    name: '外观主题',
    desc: '10 套内置主题、自定义主题与自动轮换，在「外观主题」选项卡里调整。',
    tab: 'theme',
    items: [
      {
        id: 'themes', name: '主题列表与默认主题', kind: 'setting', method: 'GET', path: '/__api/themes', writeMethod: 'POST',
        desc: '内置 10 套 + 自定义；default_theme 是全站默认（访客未自选时生效）', auth: true,
      },
      {
        id: 'theme-custom', name: '自定义主题', kind: 'action', method: 'POST', path: '/__api/themes/custom',
        desc: '只写要覆盖的 CSS 变量，其余自动继承', auth: true,
      },
    ],
  },
  {
    id: 'share',
    name: '站点临时访问链接',
    desc: '给反代站点开一条到期自动作废的短链，开关与默认值在「临时链接」选项卡里。',
    tab: 'share',
    items: [
      {
        id: 'share-config', name: '链接开关与默认值', kind: 'setting',
        method: 'GET', path: '/__api/share-config', writeMethod: 'POST',
        desc: '链接前缀可改（默认 /s）；不能占用 /p /__ /edt 等保留段。',
        auth: true, spec: SHARE_SPEC,
        params: [
          { key: 'enabled', label: '启用临时链接', hint: '关闭后已发出的链接也立即失效' },
          { key: 'path_prefix', label: '链接前缀', hint: '生成的链接形如 <前缀>/<token>' },
          { key: 'default_days', label: '默认有效期', type: 'number', unit: '天' },
          { key: 'max_days', label: '允许的最长天数', type: 'number', unit: '天' },
          { key: 'default_max_hits', label: '默认次数上限', type: 'number', unit: '次', hint: '0 表示不限次数，只看到期时间' },
          { key: 'count_hits', label: '记录访问次数', level: 'advanced' },
        ],
      },
      {
        id: 'share-list', name: '临时链接列表', kind: 'query', path: '/__api/shares',
        desc: '含剩余时间与访问次数，面板里可直接复制 / 停用 / 删除', auth: true,
      },
    ],
  },
  {
    id: 'disguise',
    name: '首页伪装',
    desc: '访客视角的模板、文案、隐蔽入口与严格模式，在「伪装与安全」选项卡里配置。',
    tab: 'security',
    items: [
      {
        id: 'disguise-config', name: '伪装配置', kind: 'setting', method: 'GET', path: '/__api/disguise', writeMethod: 'POST',
        desc: '模板 / 文案 / 隐蔽入口 / 严格模式（口令仅返回 has_token，写回才覆盖）', auth: true,
        normalize: 'lines',
      },
    ],
  },

  // ===================== 页面另有入口，不在配置页出现 =====================
  {
    id: 'session',
    name: '登录与会话',
    desc: '口令登录与登出。页面右上角已有入口，不在这里重复。',
    hidden: true,
    items: [
      {
        id: 'login', name: '登录', kind: 'action', method: 'POST', path: '/__api/login',
        desc: '换取 ap_auth Cookie（伪装模式下必须先过隐蔽入口）', auth: false,
        params: [{ key: 'password', label: '访问口令', type: 'password' }],
      },
      {
        id: 'logout', name: '登出', kind: 'action', method: 'POST', path: '/__api/logout',
        desc: '清除登录态与进门标记', auth: false,
      },
    ],
  },
];

/** 需要凭据、不在 UI 里直接执行的保留接口 */
export const SENSITIVE_PATHS = ['/__api/login', '/__api/logout'];

/** 展开成一维列表，供自检脚本逐个校对 */
export function flatCatalog(groups = API_CATALOG) {
  return groups.flatMap(g => g.items.map(i => ({ ...i, group: g.id, groupName: g.name })));
}

/** 目录项的处置方式：off（不在配置页）/ keep（留在配置页）/ jump（只因归属选项卡而留跳转） */
export function placementOf(group, item) {
  if (group.hidden || item.hidden) return 'off';
  if (item.keep) return 'keep';
  return group.tab ? 'jump' : 'stay';
}

/** 配置页要渲染的三块内容：设置卡 / 诊断工具 / 跳转行 */
export function splitCatalog(groups = API_CATALOG) {
  const cards = [];
  const tools = [];
  for (const g of groups) {
    const staying = g.items.filter(i => placementOf(g, i) === 'stay');
    const kept = g.items.filter(i => placementOf(g, i) === 'keep');
    if (staying.length) cards.push({ group: g, items: staying });
    for (const i of kept) tools.push({ ...i, groupName: g.name });
  }
  return { cards, tools };
}

export { STATS_SPEC, RATELIMIT_SPEC, ALERT_SPEC, SHARE_SPEC };
export default API_CATALOG;
