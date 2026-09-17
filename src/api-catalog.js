/**
 * API 目录：全站可配置项的一份清单。
 *
 * 为什么要有这个文件：
 *   之前每个接口的参数散落在 admin.js 的各个分支里，改一个字段要满文件找；
 *   面板 UI、自检脚本、文档三处各抄一遍，必然会出现"这里改了那里没改"。
 *   这份目录是唯一事实来源 —— 面板按它渲染表单，自检脚本按它逐个接口校对，
 *   以后加一个配置项只需要在这里加一条。
 *
 * 约定：
 *   - params 里的 key **必须与接口实际接收的 JSON 字段名一致**，
 *     这样 UI 才能用 GET 回来的值自动回填表单，不需要写任何映射代码。
 *   - read 是该配置的读取接口（GET），write 是写入接口（POST/PUT），两者通常同路径。
 *   - auth 表示该接口是否需要登录 —— 由 router.js 统一拦截，这里只用于 UI 提示。
 */

export const API_CATALOG = [
  {
    id: 'sites',
    name: '反代站点',
    desc: '被代理的目标站点与访问链接',
    items: [
      {
        id: 'site-list', name: '站点列表', method: 'GET', path: '/__api/sites',
        desc: '所有站点及其访问前缀', auth: false,
      },
      {
        id: 'site-add', name: '添加站点', method: 'POST', path: '/__api/sites',
        desc: '名称 + 网址即可，访问后缀留空自动生成', auth: true,
        params: [
          { key: 'name', label: '名称', type: 'text', placeholder: '我的博客' },
          { key: 'slug', label: '访问后缀（可选）', type: 'text', placeholder: 'blog' },
          { key: 'target', label: '网址', type: 'text', placeholder: 'example.com' },
          { key: 'port', label: '端口（可选）', type: 'text', placeholder: '8080' },
        ],
      },
      {
        id: 'site-update', name: '修改站点', method: 'PUT', path: '/__api/sites/<id>',
        desc: '改名称 / 后缀 / 目标地址；后缀变化时旧链接会一并迁移', auth: true,
        pathParam: { key: 'id', label: '站点 id', placeholder: 'demo' },
        params: [
          { key: 'name', label: '名称', type: 'text', placeholder: '新名称' },
          { key: 'slug', label: '新访问后缀（可选）', type: 'text', placeholder: 'newslug' },
          { key: 'target', label: '网址', type: 'text', placeholder: 'https://example.com' },
          { key: 'port', label: '端口', type: 'text', placeholder: '443' },
        ],
      },
      {
        id: 'site-delete', name: '删除站点', method: 'DELETE', path: '/__api/sites/<id>',
        desc: '删除后 /p/<id>/ 立即失效', auth: true, danger: true,
        pathParam: { key: 'id', label: '站点 id', placeholder: 'demo' },
      },
    ],
  },
  {
    id: 'subscription',
    name: '代理节点与订阅',
    desc: '节点配置、订阅来源、节点备注',
    items: [
      {
        id: 'sub-config', name: '订阅链接', method: 'GET', path: '/__api/sub-config', writeMethod: 'POST',
        desc: '浏览器优选从这里拉候选 IP；留空则用本机 /sub', auth: true,
        params: [{ key: 'sub_url', label: '订阅链接', type: 'text', placeholder: 'https://… 或 /tsub/xxxx' }],
      },
      {
        id: 'node-tag', name: '节点国家标注', method: 'GET', path: '/__api/node-tag', writeMethod: 'POST',
        desc: '给订阅节点备注补 IP 归属国家', auth: true,
        params: [
          { key: 'enabled', label: '启用标注', type: 'bool' },
          { key: 'style', label: '样式', type: 'text', placeholder: 'flag / name / code' },
        ],
      },
      {
        id: 'preferred-candidates', name: '拉取优选候选', method: 'GET', path: '/__api/preferred-candidates',
        desc: '按 Cloudflare 官方 IP 段过滤后的候选 IP', auth: false,
      },
      {
        id: 'tempsubs', name: '临时订阅列表', method: 'GET', path: '/__api/tempsubs',
        desc: '限时有效的临时订阅记录', auth: true,
      },
      {
        id: 'tempsub-add', name: '新建临时订阅', method: 'POST', path: '/__api/tempsubs',
        desc: '独立 UUID，到期自动失效', auth: true,
        params: [
          { key: 'name', label: '备注名', type: 'text', placeholder: '留空则用创建时间' },
          { key: 'days', label: '有效期（天）', type: 'number', placeholder: '1' },
        ],
      },
    ],
  },
  {
    id: 'preferred',
    name: '优选 IP 与 DNS',
    desc: '优选频率、优选池、健康检查写回',
    items: [
      {
        id: 'dns-config', name: '自动优选频率', method: 'GET', path: '/__api/dns-config', writeMethod: 'POST',
        desc: '定时任务的间隔（5 ~ 1440 分钟）', auth: true,
        params: [{ key: 'interval_minutes', label: '间隔（分钟）', type: 'number', placeholder: '720' }],
      },
      {
        id: 'dns-run', name: '立即执行一次优选', method: 'POST', path: '/__api/dns-run',
        desc: '不等定时任务，马上测通并改写 A 记录', auth: true,
      },
      {
        id: 'preferred-ips', name: '优选 IP 池', method: 'GET', path: '/__api/preferred-ips', writeMethod: 'POST',
        desc: '每行一个 IPv4；apply=true 时顺带写入 DNS', auth: true,
        params: [
          { key: 'ips', label: 'IP 列表（每行一个）', type: 'textarea', placeholder: '104.16.0.1' },
          { key: 'apply', label: '保存后立即应用到 DNS', type: 'bool' },
        ],
      },
      {
        id: 'pool-config', name: '候选域名池 / 健康集', method: 'GET', path: '/__api/pool-config', writeMethod: 'POST',
        desc: '候选域名来源；healthcheck 自愈写回的可用集也在这里', auth: true,
        params: [
          { key: 'pref_domains', label: '候选域名（每行一个）', type: 'textarea', placeholder: 'speed.cloudflare.com' },
          { key: 'good_ips', label: '已验证可用集（每行一个）', type: 'textarea', placeholder: '104.16.0.1' },
        ],
      },
      {
        id: 'speedtest', name: '上游测速', method: 'GET', path: '/__api/speedtest',
        desc: '从 Worker 侧测各站点上游延迟', auth: false,
      },
    ],
  },
  {
    id: 'appearance',
    name: '外观主题',
    desc: '面板配色 / 字体 / 圆角',
    items: [
      {
        id: 'themes', name: '主题列表与默认主题', method: 'GET', path: '/__api/themes', writeMethod: 'POST',
        desc: '内置 10 套 + 自定义；default_theme 是全站默认（访客未自选时生效）', auth: true,
        params: [{ key: 'default_theme', label: '默认主题 id', type: 'text', placeholder: 'aurora' }],
      },
      {
        id: 'theme-custom', name: '自定义主题', method: 'POST', path: '/__api/themes/custom',
        desc: '只写要覆盖的 CSS 变量，其余自动继承', auth: true,
        params: [
          { key: 'id', label: '主题 id（英文小写）', type: 'text', placeholder: 'mytheme' },
          { key: 'name', label: '名称', type: 'text', placeholder: '我的主题' },
          { key: 'vars', label: '变量（JSON）', type: 'textarea', placeholder: '{"--accent":"#ff6600"}' },
        ],
      },
    ],
  },
  {
    id: 'stats',
    name: '访问统计',
    desc: '按天记录各通道请求数、流量与来访数',
    items: [
      {
        id: 'stats-config', name: '开关与保留策略', method: 'GET', path: '/__api/stats-config', writeMethod: 'POST',
        desc: '内存聚合后批量落盘，不逐请求写存储', auth: true,
        params: [
          { key: 'enabled', label: '启用统计', type: 'bool' },
          { key: 'retention_days', label: '保留天数', type: 'number', placeholder: '30' },
          { key: 'flush_ms', label: '落盘间隔（毫秒）', type: 'number', placeholder: '15000' },
          { key: 'top_limit', label: '面板显示前 N 个通道', type: 'number', placeholder: '10' },
          { key: 'uv_limit', label: '单桶最多记录多少来访者', type: 'number', placeholder: '200' },
          { key: 'track_visitors', label: '记录来访者数（IP 哈希）', type: 'bool' },
          { key: 'record_admin', label: '统计管理面板自身的访问', type: 'bool' },
        ],
      },
      {
        id: 'stats', name: '统计数据', method: 'GET', path: '/__api/stats',
        desc: '带 ?days=N 指定天数', auth: true,
      },
    ],
  },
  {
    id: 'ratelimit',
    name: '限流与防滥用',
    desc: '按来访者 + 时间窗计数，超阈值挡下，屡犯可临时封禁',
    items: [
      {
        id: 'ratelimit-config', name: '限流开关与阈值', method: 'GET', path: '/__api/ratelimit', writeMethod: 'POST',
        desc: '计数在 isolate 内存里（单实例级平滑限流），只有封禁落盘', auth: true,
        params: [
          { key: 'enabled', label: '启用限流', type: 'bool' },
          { key: 'window_seconds', label: '时间窗（秒）', type: 'number', placeholder: '60' },
          { key: 'max_requests', label: '窗口内允许请求数', type: 'number', placeholder: '120' },
          { key: 'scope', label: '计数口径（ip / ip_path）', type: 'text', placeholder: 'ip' },
          { key: 'whitelist', label: '放行名单（每行一个 IP 或 CIDR）', type: 'textarea', placeholder: '203.0.113.0/24' },
          { key: 'exempt_paths', label: '豁免路径前缀（每行一个）', type: 'textarea', placeholder: '/__api/login' },
          { key: 'exempt_authed', label: '已登录豁免', type: 'bool' },
          { key: 'ban_enabled', label: '启用屡犯封禁', type: 'bool' },
          { key: 'ban_threshold', label: '触发封禁的被挡次数', type: 'number', placeholder: '5' },
          { key: 'ban_seconds', label: '封禁时长（秒）', type: 'number', placeholder: '600' },
          { key: 'message', label: '被挡时的提示文案', type: 'text', placeholder: '请求过于频繁，请稍后再试' },
        ],
      },
      {
        id: 'ratelimit-bans', name: '当前封禁列表', method: 'GET', path: '/__api/ratelimit/bans',
        desc: '跨实例生效的封禁记录，到期自动解除', auth: true,
      },
      {
        id: 'ratelimit-clear', name: '解除全部封禁', method: 'POST', path: '/__api/ratelimit/clear',
        desc: '一键解封；内存计数随 isolate 回收自然失效，无需清理', auth: true, danger: true,
      },
    ],
  },
  {
    id: 'alert',
    name: '告警通知',
    desc: '把异常推到可配置的 Webhook（企业微信 / 钉钉 / 自建服务）',
    items: [
      {
        id: 'alert-config', name: '通道与节流', method: 'GET', path: '/__api/alert', writeMethod: 'POST',
        desc: 'Webhook 地址属敏感项，只返回 has_webhook_url；留空则不修改', auth: true,
        params: [
          { key: 'enabled', label: '启用告警', type: 'bool' },
          { key: 'webhook_url', label: 'Webhook 地址（留空保持不变）', type: 'password', placeholder: 'https://…' },
          { key: 'webhook_type', label: '格式（generic / wecom / dingtalk）', type: 'text', placeholder: 'generic' },
          { key: 'title_prefix', label: '标题前缀', type: 'text', placeholder: '[Any-Proxy]' },
          { key: 'cooldown_minutes', label: '同一事件冷却（分钟）', type: 'number', placeholder: '30' },
          { key: 'max_per_hour', label: '每小时最多发几条', type: 'number', placeholder: '20' },
          { key: 'timeout_ms', label: '发送超时（毫秒）', type: 'number', placeholder: '4000' },
          { key: 'events', label: '订阅的事件（每行一个，留空=全部）', type: 'textarea', placeholder: 'login_fail' },
        ],
      },
      {
        id: 'alert-test', name: '发一条测试告警', method: 'POST', path: '/__api/alert/test',
        desc: '绕过冷却走完整发送链路，用来确认通道配对了', auth: true,
      },
      {
        id: 'alert-recent', name: '最近发送记录', method: 'GET', path: '/__api/alert/recent',
        desc: '含跳过原因，排查「为什么没收到」就看这里', auth: true,
      },
    ],
  },
  {
    id: 'share',
    name: '站点临时访问链接',
    desc: '给反代站点开一条到期自动作废的短链',
    items: [
      {
        id: 'share-config', name: '开关与默认值', method: 'GET', path: '/__api/share-config', writeMethod: 'POST',
        desc: '链接前缀可改（默认 /s）；不能占用 /p /__ /edt 等保留段', auth: true,
        params: [
          { key: 'enabled', label: '启用临时链接', type: 'bool' },
          { key: 'path_prefix', label: '链接前缀', type: 'text', placeholder: '/s' },
          { key: 'default_days', label: '默认有效期（天）', type: 'number', placeholder: '1' },
          { key: 'max_days', label: '允许的最长天数', type: 'number', placeholder: '30' },
          { key: 'default_max_hits', label: '默认次数上限（0=不限）', type: 'number', placeholder: '0' },
          { key: 'count_hits', label: '记录访问次数', type: 'bool' },
        ],
      },
      {
        id: 'share-list', name: '临时链接列表', method: 'GET', path: '/__api/shares',
        desc: '含剩余时间与访问次数，面板里可直接复制 / 停用 / 删除', auth: true,
      },
    ],
  },
  {
    id: 'disguise',
    name: '首页伪装',
    desc: '访客视角的一切从这里配置',
    items: [
      {
        id: 'disguise-config', name: '伪装配置', method: 'GET', path: '/__api/disguise', writeMethod: 'POST',
        desc: '模板 / 文案 / 隐蔽入口 / 严格模式（口令仅返回 has_token，写回才覆盖）', auth: true,
        normalize: 'disguise',
        params: [
          { key: 'enabled', label: '启用伪装', type: 'bool' },
          { key: 'strict', label: '严格模式（未登录拿不到任何 API 数据）', type: 'bool' },
          { key: 'template', label: '模板', type: 'select', optionsFrom: 'disguiseTemplates' },
          { key: 'title', label: '站点标题', type: 'text', placeholder: '留空则用当前域名' },
          { key: 'subtitle', label: '副标题', type: 'text', placeholder: '留空则不显示' },
          { key: 'contact', label: '页脚联系方式', type: 'text', placeholder: '留空则不显示' },
          { key: 'items', label: '服务 / 特性（每行一条）', type: 'textarea', placeholder: '技术支持 | 7x24 响应' },
          { key: 'posts', label: '文章列表（每行一条）', type: 'textarea', placeholder: '2026-01-01 | 标题 | 摘要' },
          { key: 'path', label: '隐蔽路径', type: 'text', placeholder: '/mypanel' },
          { key: 'token', label: 'URL 口令（留空保持不变）', type: 'text', placeholder: '不修改请留空' },
          { key: 'custom_html', label: '自定义模板 HTML', type: 'textarea', placeholder: '模板选 custom 时整页直出' },
        ],
      },
    ],
  },
  {
    id: 'session',
    name: '登录与会话',
    desc: '口令登录与登出',
    items: [
      {
        id: 'login', name: '登录', method: 'POST', path: '/__api/login',
        desc: '换取 ap_auth Cookie（伪装模式下必须先过隐蔽入口）', auth: false,
        params: [{ key: 'password', label: '访问口令', type: 'password', placeholder: '' }],
      },
      {
        id: 'logout', name: '登出', method: 'POST', path: '/__api/logout',
        desc: '清除登录态与进门标记', auth: false,
      },
    ],
  },
];

/** 需要心跳包/凭据、不在 UI 里直接执行的保留接口（并发 Christians jung: 一样の UI に乗らない） */
export const SENSITIVE_PATHS = ['/__api/login', '/__api/logout'];

/** 展开成一维列表，供自检脚本逐个校对 */
export function flatCatalog(groups = API_CATALOG) {
  return groups.flatMap(g => g.items.map(i => ({ ...i, group: g.id, groupName: g.name })));
}

export { API_CATALOG as default };
