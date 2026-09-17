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

/** 选项卡 id -> 显示名。跳转行与手册按它出文案，避免多处各写一遍中文 */
export const TAB_LABELS = {
  sites: '站点',
  stats: '数据驾驶舱',
  proxy: '代理节点',
  preferred: '优选 IP',
  security: '伪装与安全',
  theme: '外观主题',
  share: '临时链接',
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
        desc: '改名称 / 后缀 / 目标地址；后缀变化时旧链接会一并迁移', auth: true,
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
    id: 'subscription',
    name: '代理节点与订阅',
    desc: '订阅链接、节点国家标注、临时订阅，在「代理节点」选项卡里管理。',
    tab: 'proxy',
    items: [
      {
        id: 'sub-config', name: '订阅链接', kind: 'setting', method: 'GET', path: '/__api/sub-config', writeMethod: 'POST',
        desc: '浏览器优选从这里拉候选 IP；留空则用本机 /sub', auth: true,
      },
      {
        id: 'node-tag', name: '节点国家标注', kind: 'setting', method: 'GET', path: '/__api/node-tag', writeMethod: 'POST',
        desc: '给订阅节点备注补 IP 归属国家', auth: true,
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
        desc: '定时任务的间隔（分钟，允许区间由接口返回）', auth: true,
      },
      {
        id: 'dns-run', name: '立即执行一次优选', kind: 'action', method: 'POST', path: '/__api/dns-run',
        desc: '不等定时任务，马上测通并改写 A 记录', auth: true,
      },
      {
        id: 'preferred-ips', name: '优选 IP 池', kind: 'setting', method: 'GET', path: '/__api/preferred-ips', writeMethod: 'POST',
        desc: '每行一个 IPv4；apply=true 时顺带写入 DNS', auth: true,
      },
      {
        id: 'pool-config', name: '候选域名池 / 健康集', kind: 'setting', method: 'GET', path: '/__api/pool-config', writeMethod: 'POST',
        desc: '候选域名来源；健康检查自愈写回的可用集也在这里', auth: true,
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
