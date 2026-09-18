# Any-Proxy

基于 **Cloudflare Workers** 的统一反向代理与优选 IP 代理工具。一个域名同时提供两类能力：

1. **动态多站反向代理** —— 管理页在线增删改任意站点，每个站点一个专属前缀，配置实时写入存储并生效，无需改代码、无需重新部署。
2. **优选 IP 代理节点**（内嵌 edgetunnel）—— VLESS / Trojan / SS 节点 + 管理面板，客户端只需填写域名即可使用。

登录保护、亮/暗主题、GitHub Actions 自动部署与健康检查自愈，站点管理与代理面板共用同一套登录。

- 部署域名：你自己的域名（如 `https://proxy.example.com`）

> 🚀 **第一次部署？看这一篇就够了**：[docs/11-新手部署手把手.md](docs/11-新手部署手把手.md)
> 全程在浏览器里点，不用装 Git / Node / wrangler，照着做完就能用。

> 代码中**不含任何写死的域名 / IP / IP 段**：目标域名由 `PROXY_HOST` 或请求 hostname 推导，
> 边缘 IP 段运行时拉取官方数据源并缓存，候选池一律来自订阅链接或面板配置。
> fork 后自部署不需要到处改常量，也不会出现「配了却仍在改别人 DNS」的情况。

---

## 功能特性

- **动态多站管理**：在线添加 / 删除 / 编辑站点，配置实时生效；同域名重复添加自动复用。
- **访问链接免登录**：任何人拿到 `/p/<id>/` 链接即可直接打开，管理功能受口令保护。
- **两条访问通道**：
  - 主通道 `/p/<id>/<path>`：回源到站点自身域。
  - 跨域通道 `/p/<id>/__x/<host>/<path>`：自动承接页面用到的任意第三方域（CDN / API / 图片域），无需任何配置。
  - 上游 `Set-Cookie` 按通道收敛，不同站点 / 不同域互不覆盖。
- **幂等 URL 映射**：源站回传的 `return_to` / `next` / `redirect` 等参数不再二次套前缀；历史链接中的重复前缀逐层剥离。
- **按 Content-Type 分层的安全重写**：
  - `html` / `xml`：属性级重写 + 移除 `<base>` 与 `integrity`。
  - `css`：只处理 `url(...)` 与 `@import` 字面量。
  - JS / JSON / 纯文本：只处理被引号包裹的 URL 字面量，不误伤注释与 `//# sourceMappingURL`。
- **前端运行时修复脚本**：`MutationObserver` 修复动态 DOM；hook `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `history.pushState` / `window.open`；捕获阶段拦截点击，绕开不认识 `/p/` 前缀的 SPA 路由。
- **协议自动判断**：域名 → https；IP / 带端口 → http；显式 `http(s)://` 优先。
- **WebSocket / SSE / HTTP Range 透传**：`Upgrade: websocket` 双向中继；事件流不缓冲；`206 Partial Content` 透传，流媒体可播放拖拽。
- **统一存储后端**：站点配置、DNS 配置、优选池、面板数据全部经统一抽象读写，后端可在 **D1（默认）/ KV** 之间切换。
- **DNS 自动优选**：候选来自订阅链接 / 优选池 / 域名解析（全部可配），并发探测后有预算地写入 A 记录，频率前端可调（5~1440 分钟，默认 12 小时），客户端零配置。
- **无写死配置**：目标域名由变量或请求 hostname 推导，边缘 IP 段运行时拉取并缓存，CI 也要求显式配置，不存在会悄悄生效的内置常量。
- **健康检查自愈**：GitHub Actions 每 12 小时从外部网络真实验证 A 记录，发现 1034 / 不可达时自动扫描可用 IP，经 Worker API 写回可用集并重写 A 记录。
- **登录保护**：设置 `PASSWORD` 后，管理 / 编辑 / 代理面板需登录；未登录可只读查看站点列表、复制链接。
- **首页伪装**：根路径可渲染成一个普通站点页面（维护页 / 企业官网 / 博客 / 下载页 / 自定义 HTML），管理面板移到隐蔽入口；未进门者看不到任何面板痕迹，也拿不到任何 API 数据。详见 [首页伪装](#首页伪装)。
- **主题**：10 套内置外观（配色 / 字体 / 圆角 / 阴影整体替换）+ 自定义主题 + 自动轮换；访客选择记在本地，全站默认由面板设置。
- **访问统计**：内存聚合 + 后台批量落盘，不逐请求写存储；访客以加盐哈希标识，可选不记录；面板按天看 PV / UV / 站点排行。
- **限流与防滥用**：面板口 / 代理口分开限速（每 IP 每分钟令牌桶 + 突发容量），超限自动临时封禁并可一键解封，登录用户与白名单可豁免。默认关闭。
- **告警通知**：限流触发 / 上游异常 / 证书或优选异常等事件推送到自定义 Webhook（含通用 JSON、企业微信、钉钉、飞书模板），带冷却去重与最近发送记录。默认关闭。
- **站点临时访问链接**：给某个站点签发限时链接，可设有效期与最大访问次数，到期或超额自动失效；不计入授权，随时可吊销。默认关闭。

---

## 支持的转发类型

以下全部经线上环境真打实测验证（2026-09-17，32 项全通过）。主通道与跨域通道（`__x`）行为一致。

**请求方法与内容类型**

| 类型 | 说明 |
| --- | --- |
| GET / HEAD / POST / PUT / DELETE / PATCH / OPTIONS | 全方法转发；OPTIONS 统一应答 204 CORS 预检 |
| JSON | 请求与响应，UTF-8 中文完整保真 |
| 表单（x-www-form-urlencoded） | 含中文字段回传无误 |
| multipart/form-data | 文件上传透传 |
| 二进制 | 图片 / 图标 / 任意字节流原样透传（不做文本改写） |
| XML / 纯文本 / JS / CSS | 按 Content-Type 分层重写或透传 |

**状态码与重定向**

- 2xx / 3xx / 4xx / 5xx 全部透传（实测 200/204/206/304/401/404/418/500）。
- 3xx 重定向：Location 绝对地址、相对路径、连续多跳链全部映射回代理命名空间；跨域目标自动进 `__x` 通道。

**Cookie 与会话**

- 上游 `Set-Cookie` 的 `Path` 收敛到代理通道、`Domain` 剥离（`__Host-` 前缀按规范保留 `/`），浏览器能存住，回传时原样带给上游，登录态可保持。
- `Authorization`（Basic Auth 等）请求头透传。

**压缩**

- 上游响应按**魔术字节嗅探**识别 gzip / zstd / deflate 并解压（不轻信 `Content-Encoding` 头，头会撒谎或缺席）；出口一律发明文，压缩协商交给 CF 边缘。

**流式与实时**

- **WebSocket** 双向透传，跨域通道同样可用；上游握手窗口期到达的客户端消息会缓冲后冲刷，不丢首条消息。
- **SSE**（`text/event-stream`）流式不缓冲，事件逐条到达。
- chunked 流式响应逐块到达；**HTTP Range / 206 Partial Content** 透传，流媒体可拖拽。
- 大响应（百 KB 级以上二进制）完整透传。

---

## 代码规范

开发遵循仓库根目录 [AGENTS.md](AGENTS.md) 的硬性约束，其中命名部分提炼自《阿里巴巴开发规范》适用条款：

- 标识符（变量 / 函数 / 类 / 参数）一律**英文**，禁止中文与拼音命名；注释使用中文是本仓库约定，不受此限。
- 变量与函数小驼峰（`sitePrefix`）、类型 / 构造器大驼峰、常量 `UPPER_SNAKE_CASE`（`CANDIDATE_LIMIT`）。
- 杜绝望文不知义的缩写；布尔量用 `is / has / can / should` 前缀；函数名动词开头。
- `vendor/` 为第三方 vendored 代码（跟随上游），命名不整改、保持原样，改动前先核对上游。

---

## 快速开始

> 想要**一步一步照着点**的版本 → [docs/11-新手部署手把手.md](docs/11-新手部署手把手.md)。下面是精简清单。

### 1. 需要准备的 Cloudflare 资源

| 资源 | 说明 |
|---|---|
| **Account ID** | Cloudflare Dashboard 右下角。 |
| **API Token** | 权限：`Workers Scripts: Edit`、`Workers KV Storage: Edit`（kv 后端）、`D1`（d1 后端，默认），并包含 **DNS 编辑** 权限（DNS 优选需要），账号级别。 |
| **D1 数据库**（默认后端） | 创建 `any-proxy-db`，把 `database_id` 填入 `wrangler.toml`；表结构由 `migrations/0001_init.sql` 定义，部署时自动应用。 |
| **KV Namespace**（kv 后端可选） | 创建后把 Namespace ID 填入 `wrangler.toml`（绑定名 `SITES`，勿改）。 |
| 自定义域名（可选） | 接入 Cloudflare，并把 DNS CNAME 到 Worker。 |

### 2. 配置 GitHub Secrets / Variables

在仓库 **Settings → Secrets and variables → Actions** 中配置（详见下文「配置说明」）。

### 3. 部署

```bash
git push origin master
```

GitHub Actions 自动执行：按 `STORAGE_BACKEND` 裁剪 `wrangler.toml`（**只绑定实际使用的后端**，d1 保留 D1 并应用迁移、kv 保留 KV）→ `wrangler deploy` → 写入 Secrets。之后每次 push 自动重新部署，也可在 Actions 页手动触发。

---

## 配置说明

### GitHub Secrets

| Secret | 说明 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API Token（含 Worker + KV/D1 + **DNS 编辑**权限，DNS 优选需要） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID |
| `CF_ZONE_ID` | 自定义域名所在 Zone 的 ID（DNS 自动优选需要） |
| `PASSWORD` | 管理口令（也作为代理面板管理员密码；healthcheck 自愈写回 GOOD_IPS 也需要） |
| `UUID` | 代理节点 UUID（可选，不设置则由 PASSWORD 派生） |
| `DISGUISE_PATH` | **首页伪装**的隐蔽入口路径，如 `/mypanel`。走 Secret 而非变量是刻意的：入口信息不该出现在 Actions 日志里（与 `DISGUISE_TOKEN` 至少配一个） |
| `DISGUISE_TOKEN` | **首页伪装**的 URL 口令；配置后访问 `任意路径?k=<口令>` 即可进门（与 `DISGUISE_PATH` 至少配一个） |

> `KV_NAMESPACE_ID` 不再需要：KV 绑定已写入 `wrangler.toml`，健康检查经 Worker API 读写存储，与后端无关。

### GitHub Variables

| 变量 | 说明 |
|---|---|
| `STORAGE_BACKEND` | 持久化后端：`d1`（默认）或 `kv`。Worker 内全部存储（站点配置、DNS 配置、优选池、面板数据）统一走该后端；切换后端后历史数据不会自动迁移，建议固定后不再切换 |
| `PREF_DOMAINS` | 改 DNS 时解析用的候选域名池（空格分隔）。优先级：GitHub 变量 → Worker 侧 `PREF_DOMAINS`（面板可配）。**没有内置兜底**，两项都空时域名解析这一路候选不参与 |
| `PROXY_HOST` | **优选 / 自愈 / 健康检查的目标域名**（例如 `proxy.example.com`）。留空则 Worker 按**当前请求的 hostname** 推导；定时任务（cron）场景拿不到请求，**必须显式配置**，否则优选会明确报错而不会猜到一个别的域名。**漏配的代价容易被忽视**：健康自愈会在第一个守卫处直接失败，线上端到端校验也因拿不到目标域名而失败；而后者在 push 触发时被跳过去，于是出现「每次 push 都绿，但自愈链路从没真正跑过」的假象 |
| `SUB_URL` | 浏览器优选拉取候选节点的订阅链接。留空则回退本机 `/sub`（token 按 edgetunnel 同一口径推导）。面板「订阅链接」里填写的值优先级最高 |
| `DISGUISE_TEMPLATE` | **首页伪装**模板，作为首次部署的种子（`maintenance` / `corp` / `blog` / `download` / `custom`）。写入过面板配置后以面板为准 |
| `DISGUISE_TITLE` / `DISGUISE_SUBTITLE` / `DISGUISE_CONTACT` | 伪装页的站点标题 / 副标题 / 页脚联系方式。标题留空则用当前域名推导，不会回落到任何内置名字 |

Worker 侧还有一组可选变量（`wrangler.toml` 的 `[vars]`，非敏感）：

| 变量 | 说明 |
|---|---|
| `CF_IP_RANGES` | 自定义边缘 IP 段（每行/空格分隔的 CIDR）。用于把订阅里混进的第三方节点挡在优选池外 |
| `CF_IP_RANGES_URL` | 边缘 IP 段数据源，默认 `https://api.cloudflare.com/client/v4/ips`，结果缓存 12 小时；可换成自建镜像 |
| `SUB_STRICT` | 设为 `0` / `false` 时关闭候选的地址归属过滤 |
| `SUB_CANDIDATE_LIMIT` | 单次返回候选数上限，默认 `40` |
| `DOH_URL` | 解析候选域名用的 DoH 服务，默认 `https://cloudflare-dns.com/dns-query` |
| `DNS_BUDGET_MS` | 单次「立即更新优选 IP」的总时间预算，默认 `22000`。必须小于 Workers 的 30s 墙钟限制 |
| `CF_API_BASE` | Cloudflare API 地址，默认 `https://api.cloudflare.com/client/v4` |

---

## 使用说明

### 访问结构

| 路径 | 说明 |
|---|---|
| `/` 、`/__admin` | 主页（未登录 = 只读列表；登录 = 完整管理 + 代理面板入口）。**开启首页伪装后**：没通过隐蔽入口的访客只看到伪装页 |
| `/__login` | 登录页（伪装开启时不显示任何项目品牌信息） |
| `/p/<id>/...` | 反代访问某站点（免登录） |
| `/p/<id>/__x/<host>/...` | 跨域通道：任意第三方域资源 / 接口 |
| `/edt` | 代理端点（客户端 VLESS 配置用） |
| `/sub` | 节点订阅（edgetunnel） |
| `/login` 、`/admin` | 代理面板登录 / 面板（edgetunnel） |
| `/logout` | 统一登出 |
| `/__api/...` | 管理 REST API（见下） |

### 客户端节点配置（edgetunnel）

- 地址：优选 IP 或你自己的域名（如 `proxy.example.com`）
- 端口：`443`，TLS 开启，SNI / Host = 本域名
- 路径：`/edt`
- UUID：见仓库 Secrets 配置

---

## REST API

所有接口返回 JSON。鉴权为 Cookie（`ap_auth`，HttpOnly）。读接口免登录；写接口需登录。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/__api/sites` | 免登录 | 站点列表 |
| POST | `/__api/sites` | 需登录 | 添加站点 `{name, slug?, target, port?}` |
| PUT | `/__api/sites/<id>` | 需登录 | 更新站点；`slug` 变化迁移路径 |
| DELETE | `/__api/sites/<id>` | 需登录 | 删除站点 |
| POST | `/__api/login` | 免登录 | 登录 `{password}` |
| POST | `/__api/logout` | 免登录 | 登出 |
| GET | `/__api/config` | 免登录 | 配置探测（是否已设口令） |
| GET | `/__api/speedtest` | 免登录 | 服务端测各站点上游延迟 |
| GET | `/__api/dns-config` | 免登录 | 读优选频率（分钟） |
| POST | `/__api/dns-config` | 需登录 | 改频率 `{interval_minutes}`（5~1440） |
| POST | `/__api/dns-run` | 需登录 | 立即执行 DNS 优选 |
| GET | `/__api/preferred-candidates` | 免登录 | 从**订阅链接**拉节点 IP 作为浏览器优选候选（已按边缘 IP 段过滤，返回 `source`/`stats`/`note` 便于排障） |
| GET | `/__api/sub-config` | 需登录 | 读当前订阅链接配置（面板配置值 / 环境变量值 / 实际生效值） |
| POST | `/__api/sub-config` | 需登录 | 保存订阅链接 `{sub_url}`（支持完整 URL 或 `/tsub/xxx` 这类路径；留空则清空并回退） |
| GET | `/__api/preferred-ips` | 免登录 | 读优选池 `PREF_IPS` |
| POST | `/__api/preferred-ips` | 需登录 | 保存优选池 `{ips}` |
| GET | `/__api/pool-config` | 需登录 | 读 `GOOD_IPS` / 候选域名池 / 上次检查时间 |
| POST | `/__api/pool-config` | 需登录 | 保存候选域名池 `{pref_domains}` 或写回可用集 `{good_ips}`（healthcheck 自愈用） |
| GET | `/__api/disguise` | 需登录 | 读首页伪装配置。返回的 `templates` 为可用模板清单；入口口令只给出 `has_token` 布尔，**不返回明文** |
| POST | `/__api/disguise` | 需登录 | 保存首页伪装配置（见 [首页伪装](#首页伪装)）。口令字段留空表示保持原值 |
| GET | `/__api/disguise-preview` | 需登录 | 预览伪装页。带进门 cookie 的浏览器平时看到的是真面板，用这个端点自查访客视角 |
| GET | `/__api/themes` | 免登录 | 主题清单（`themes` + 当前配置字段平铺） |
| POST | `/__api/themes` | 需登录 | 保存主题配置（默认主题 / 是否允许切换 / 轮换模式与间隔与池子 / 是否忽略个人选择） |
| POST | `/__api/themes/custom` | 需登录 | 新增或更新自定义主题（变量值经 `sanitizeVars` 过滤，写不穿 CSS） |
| DELETE | `/__api/themes/custom/<id>` | 需登录 | 删除自定义主题（预设不可删） |
| GET | `/__api/stats-config` | 需登录 | 读访问统计配置 |
| POST | `/__api/stats-config` | 需登录 | 保存访问统计配置 |
| GET | `/__api/stats` | 需登录 | 访问汇总，`?days=N`（默认 7，上限为保留天数） |
| GET | `/__api/ratelimit` | 需登录 | 读限流配置 + 当前封禁数 |
| POST | `/__api/ratelimit` | 需登录 | 保存限流配置 |
| GET | `/__api/ratelimit/bans` | 需登录 | 列出当前被封禁的 IP 与到期时间 |
| POST | `/__api/ratelimit/clear` | 需登录 | 一键解封，返回清除条数 |
| GET | `/__api/alert` | 需登录 | 读告警配置（Webhook 地址**不返明文**，只给 `has_webhook`） |
| POST | `/__api/alert` | 需登录 | 保存告警配置（Webhook 留空表示保持原值） |
| POST | `/__api/alert/test` | 需登录 | 立即发送一条测试告警 |
| GET | `/__api/alert/recent` | 需登录 | 最近告警发送记录（含成功/失败与响应码，已脱敏） |
| GET | `/__api/share-config` | 需登录 | 读临时链接配置 |
| POST | `/__api/share-config` | 需登录 | 保存临时链接配置（前缀、默认/最大有效期、是否计数） |
| GET | `/__api/shares` | 需登录 | 已签发临时链接列表（站点/创建/到期/已用次数/状态） |
| POST | `/__api/shares` | 需登录 | 签发临时链接 `{site, days?, max_hits?, note?}` |
| DELETE | `/__api/shares/<id>` | 需登录 | 吊销临时链接 |

> **伪装 + 严格模式下**，上表标注「免登录」的 GET 接口全部改为**需登录**；此时未进门者访问这些接口会拿到伪装页外形的 404。
> `/__api/login`、`/__api/logout`、`/p/<id>/...`、`/tsub/<id>` 以及所有 WebSocket 请求始终保持匿名可达 —— 前两者是登录与登出本身的通道，后两者是客户端行为（分享出去的反代链接、订阅拉取），一旦被收敛就会把用户锁在外面。

---

## 项目结构

```
worker.js              统一入口：绑定运行时 + 请求路由；scheduled 处理 DNS 定时任务
wrangler.toml          Worker 配置：D1 绑定 DB（默认后端，migrations_dir=migrations）、KV 绑定 SITES、cron */5 * * * *、vars.GH_ACTIONS_URL
AGENTS.md              AI 协作开发约束：单一真源、api 包装契约、注入脚本自包含等硬性约定（改代码前必读）
src/
  runtime.js           平台注入绑定（KV / PASSWORD）的共享容器；按 STORAGE_BACKEND 选择 KV 或 D1
  storage.js           D1-backed KV 兼容适配层（createD1KV），业务模块无感切换后端
  config.js            统一配置层：面板配置 → 环境变量 → 规范默认值，三级降级；下发前自动脱敏
  api-catalog.js       接口 / 配置项清单（数据）：字段来源、呈现方式、归属哪个选项卡，三件事都在这里声明
  config-ui.js         按清单渲染设置表单 / 工具区 / 跳转索引；各功能页的设置块也复用它
  router.js            HTTP 路由与全部访问路径
  proxy.js             反代核心：请求转发、响应重写、WebSocket 透传、Set-Cookie 收敛、上游重试、幂等还原
  url.js               URL 命名空间映射与内容重写（通用规则，无站点特判）
  inject.js            注入到被代理页面的前端运行时脚本（injectLinkFix）
  sites.js             站点配置持久化（增删查、slug 生成、target 解析）
  admin.js             管理 REST API + 服务端渲染的管理页
  auth.js              登录 / 登出 / 登录页（伪装开启时自动脱敏，外观接入主题系统）
  disguise.js          首页伪装：模板注册表、配置读写、进门标记判定、伪装首页与伪装 404 渲染
  themes.js            外观主题：预设注册表（主题即数据）、自定义主题、自动轮换
  stats.js             访问统计：内存聚合 + 后台落盘、访客哈希、按天汇总
  stats-ui.js          「数据驾驶舱」渲染层：KPI / 每日趋势 / 通道排行
  scopes.js            访问通道登记表：路径 → 通道、中文名、是否管理通道（统计用的唯一真源）
  ratelimit.js         限流与防滥用：令牌桶 + 临时封禁 + 一键解封 + 白名单 / 登录豁免
  alert.js             告警通知：事件总线 + Webhook 模板（通用 / 企业微信 / 钉钉 / 飞书）+ 冷却去重
  share.js             站点临时访问链接：限时 / 限次签发、到期自动失效、可随时吊销
  compress.js          出口响应定稿：一律明文，压缩协商交给 CF 边缘（原因见模块内说明）
  nodetag.js           订阅节点备注的国家标注
  geoip.js             IP 归属判定与任播兜底（拿不到官方段时不编造国名）
  tempsubs.js          临时订阅（`/tsub/<id>`）
  dns.js               优选 IP 与 DNS 自动更新（候选池 → 并发探测 → 写 A 记录 → 自校验回滚），带时间预算
  subs.js              订阅与候选：订阅地址解析、节点抽取、边缘 IP 段判定、候选域名解析（无写死数据）
  util.js              无依赖小工具
migrations/
  0001_init.sql        D1 kv 表结构（键值存储），部署时自动应用
vendor/
  vless.js             第三方 edgetunnel 代理引擎（VLESS / Trojan / SS + 面板），经 /edt 挂载
tools/                 本地开发与验证脚本（不参与部署）
  local-dev.mjs        本机跑真实 worker 入口，无需 Cloudflare 运行时
  dev-fixture.mjs      本地「目标站」fixture
  check-rewrite.mjs    重写规则单测
  local-test.mjs       新旧实现行为对比
  check-e2e.mjs        线上端到端校验（需 PROXY_HOST）
  check-live.mjs       部署后线上冒烟：主题 / 防护三件套 / 配置接口（结束自动恢复默认配置）
  check-preferred.mjs  优选链路自检：订阅候选拉取 + 探测是否会在 Workers 墙钟内完成
  check-disguise.mjs   首页伪装自检：访客分档、两种进门方式、拥堵是否收敛、是否被自己锁死
  check-nodetag.mjs    节点国家标注自检：编码形态不被改坏、中文不乱码、数据源挂了不拖垮订阅
  check-nodes.py       实测订阅里每个节点的可用性（TCP→TLS→WebSocket→真实转发出网）
  check-anycast.mjs    CDN 任播兜底自检：CIDR 判定、数据源降级、绝不编造国名
  check-compress.mjs   出口编码契约自检：任何 Accept-Encoding 下都不许输出压缩字节；上游重试/对冲策略
  check-hls.mjs        HLS 清单自检：分片 / 密钥 URI 必须改写进代理命名空间，标签属性一个字不许动
  check-media.mjs      媒体与大文件自检：大文件不进 Cache API、Range 分片不重试不对冲（防流量放大）
  check-path.mjs       路径归一化自检：双斜杠 /p/<id>//xxx 必须折叠（Emby 客户端拼接会产出它，否则视频 404）
  check-heal.mjs       前缀丢失自愈自检：绝对路径拼接会吃掉 /p/<id>，须挂回且不误伤代理自身路径
  check-themes.mjs     主题系统自检：10 套预设齐全、自定义可增删、CSS 注入写不穿、轮换结果收敛
  check-guard.mjs      防护三件套自检：默认关闭不误伤、封禁与解封、告警脱敏、临时链接双重到期
  check-configui.mjs   配置页与目录自检：字段与 SPEC 双向对齐、每项恰好渲染一次、全页无重复配置、转义完备、各选项卡内容同宽
  check-single-source.mjs  配置单一真源自检：一个设定只允许一份定义（面板与运行期同口径）
  gen-manual.mjs       操作手册附录生成器：速查表从目录与 SPEC 生成，--check 模式进 CI
  check-smoke.mjs      路由级冒烟：从请求入口走到页面出口，专治「单测全绿但组合起来就炸」
docs/                  软件生命周期文档（09 是面向使用者的操作手册）
.github/workflows/
  deploy-cloudflare.yml   push master 自动部署（含 D1 迁移应用 + Secret 注入）
  healthcheck.yml         每 12 小时健康检查 + 自愈（workflow_dispatch 可手动触发）
  verify.yml              push 跑单测；部署完成后跑线上 e2e；6 小时定时自检
  diag.yml                手动线上诊断（workflow_dispatch）
```

---

## 本地开发与测试

无需 Cloudflare 账号，全部脚本只用 Node 内置模块：

```bash
# 1. 重写规则单测（改 url.js 后必跑）
node tools/check-rewrite.mjs

# 2. 起本地目标站 + 代理，浏览器直接点
node tools/dev-fixture.mjs 8799
SEED_SITES="demo=http://127.0.0.1:8799" node tools/local-dev.mjs 8787
#   → http://127.0.0.1:8787/p/demo/

# 3. 线上校验
PROXY_HOST=proxy.example.com node tools/check-e2e.mjs

# 4. 优选链路自检（订阅候选能否拉到、优选探测会不会超时）
SUB_URL=https://proxy.example.com/tsub/xxxx node tools/check-preferred.mjs
CIDR_FILE=./cidrs.txt SKIP_NETWORK=1 node tools/check-preferred.mjs   # 离线模式

# 5. 首页伪装自检（改 disguise.js / router.js 后必跑）
node tools/check-disguise.mjs

# 6. 节点备注国家标注自检（改 geoip.js / nodetag.js 后必跑）
node tools/check-nodetag.mjs

# 7. CDN 任播兜底自检（改 geoip.js 的任播逻辑后必跑）
node tools/check-anycast.mjs

# 8. 出口编码契约与请求策略自检（改 compress.js / proxy.js 后必跑）
node tools/check-compress.mjs

# 9. HLS 播放清单自检（改 url.js / proxy.js 的文本改写分支后必跑）
#    守的是「清单被当非文本直传」：分片与 AES 密钥 URI 不改写，视频就完全播不了
node tools/check-hls.mjs

# 10. 媒体与大文件自检（改 proxy.js 的缓存 / 重试策略后必跑）
#     守的是流量放大：视频不能进 Cache API，Range 分片不能重试或对冲
node tools/check-media.mjs

# 11. 路径归一化自检（改 proxy.js 的路径处理 / url.js 的 URL 映射后必跑）
#     守的是双斜杠：客户端把带尾斜杠的 base 地址与绝对路径拼接会产出 /p/<id>//xxx，
#     源站与代理都回 404，症状是「能登录、能刷首页、就是播不了」
node tools/check-path.mjs

# 12. 前缀丢失自愈（改 router.js 的路由分发后必跑）
#     守的是客户端用绝对路径拼代理地址时 /p/<id> 被 URL 规范吃掉 -> 请求落到代理根 404
node tools/check-heal.mjs

# 13. 代理链路冒烟（改任何一处请求处理链路后必跑）
node tools/check-smoke.mjs

# 14. 主题系统自检（改 themes.js / admin.js 主题部分后必跑）
node tools/check-themes.mjs

# 15. 防护三件套自检（改 ratelimit.js / alert.js / share.js 后必跑）
node tools/check-guard.mjs

# 16. 配置页与接口目录自检（改配置项 / api-catalog.js 后必跑）
node tools/check-configui.mjs

# 17. 配置单一真源自检（新增默认值 / 加一个常量前先跑；同一个设定不允许写两份）
node tools/check-single-source.mjs

# 18. 操作手册的速查表与代码是否同步（改配置项后跑 --write 重新生成）
node tools/gen-manual.mjs

# 19. 部署后线上冒烟：传目标地址与口令，跑主题、防护与配置接口（结束会自动恢复默认配置）
node tools/check-live.mjs https://<你的-worker>.workers.dev <PASSWORD>

# 20. 实测订阅里每个节点是否真的可用（需 Python 3）
SUB_URL=https://proxy.example.com/tsub/xxxx python3 - <<'EOF'
import urllib.request
open('/tmp/sub.txt','wb').write(urllib.request.urlopen('$SUB_URL').read())
EOF
python3 tools/check-nodes.py /tmp/sub.txt
```

> `check-nodes.py` 分四级递进，越往下越能证明「真能用」：
> `L1` TCP 端口可达 → `L2` 带 SNI 完成 TLS → `L3` WebSocket 拿到 101 →
> **`L4` 真发一条 VLESS 请求把数据代理出网**。只有到 L4 才算端到端验证过，
> 停在 L3 只能说明「握手通了」，不代表能转发。
>
> 两个坑在实测里都被踩过，脚本里已经处理掉了：探测目标要避开 Cloudflare 托管的站点
> （CF 对自己边缘 IP 发来的明文 HTTP 请求直接回 400，会把健康节点误判成坏的），
> 以及每个目标必须新开一条连接（同一条 WS 连接上重试第二个目标，服务端已经把它
> 当作上一个流在收，第一个失败会连累后面全部失败）。

### 一个设定只允许一份定义

这是本项目最容易出隐蔽 bug 的地方，而且**单测抓不到**——因为每份实现自己都是「对」的：

| 曾经的真实故障 | 后果 |
| --- | --- |
| 面板用宽松正则校验 IPv4，运行时用严格版 | 面板提示「已保存」，池子却被静默过滤成空 |
| 优选频率在面板接口与调度器各写一份 | 面板显示 12 小时，实际按另一个间隔跑 |
| 布尔词表两套词汇（`config.js` 认 `on/off`，`geoip.js` 还认 `enable/none`） | `none` 在环境变量里能关掉，在面板里却被当成没配 |
| 候选条数常量旁又写了一个裸 `40` | 改常量时漏改裸值，「面板配的上限」与运行时不一致 |

所以约定如下，并由 `check-single-source.mjs` 卡住（70 项，含「把写死点塞回去必须变红」的牙齿验证）：

- **默认值与区间**：写在字段声明里（`config.js` / `themes.js` 等的 `SPEC`），面板表单的
  `min` `max` `value` 与运行期兜底都从它取，不在 HTML 或注入脚本里再抄一遍。
- **列表解析**（IP / 域名 / 布尔词表）：只有 `util.js` / `config.js` 里那一份实现。
- **数据表**（访问通道 `scopes.js`、驾驶舱档位 `stats.js` 的 `STATS_RANGES`、指标表）：
  加一项只改表，前后端都不动分支。
- **注入浏览器的脚本**（`toString()` 过去的那类）必须自给自足：只能引用自己的局部变量
  与浏览器全局，引用模块级 import 在浏览器里是 `ReferenceError`，且渲染期才炸。
  需要的数据一律以 `JSON.stringify` 的形式注入。

---

## 优选是怎么跑的

1. **候选来源**（全部可配，无写死）：已验证可用集 `GOOD_IPS` → 优选池 `PREF_IPS` → **订阅链接里的节点**（按边缘 IP 段过滤）→ 候选域名池 `PREF_DOMAINS` 动态解析。
2. **服务端探测**：并发 `HTTP(80)` 过滤不可达 IP，受总预算 `DNS_BUDGET_MS` 约束。
3. **写 DNS**：取前 2 个写入 A 记录，随后用「访问自己域名」自检，不通过立即回滚。

> 为什么要有时间预算：Workers 单次 HTTP 请求有约 30 秒墙钟上限，超时会被平台直接杀掉，
> 前端只会看到「请求失败」。过去逐 IP 串行探测（每个最多等 3s），候选里只要有几个不可达地址就会累计超限，
> 这正是「立即更新优选 IP」一直报错的原因。现在串行 12s 的场景并发后约 2.5s，且预算耗尽会直接返回已探到的结果。

---

## 首页伪装

开启后，**没通过隐蔽入口的访客**访问根路径看到的是一个普通站点页面，而不是管理面板。管理页 →「首页伪装」卡片即可配置，无需改代码、无需重新部署。

### 访客分档

| 访客 | 判定 | 根路径 `/` | `/__api/*` |
|---|---|---|---|
| 陌生人 | 无进门标记、未登录 | 伪装页 | 伪装页外形的 404 |
| 已进门未登录 | 有进门 cookie | 真面板 | 401（面板 JS 据此引导登录） |
| 已登录 | `ap_auth` 有效 | 真面板 | 正常放行 |

**进门标记（cookie）为什么不需要保密**：伪造它最多只能拿到 401，拿不到任何数据 —— 敏感接口一律要求真登录。它只用来区分「有没有找对门」，真正的门始终是 `PASSWORD`。即使有人猜到了入口路径，看到的也只是一个不带任何品牌信息的登录页。

### 两种进门方式（存在后才生效）

- **隐蔽路径**：配置如 `/mypanel`，访问即进门。首段不能占用 `admin` / `edt` / `p` / `sub` / `__api` 等保留段，也不能是 `/` —— 面板会直接拒绝这类配置，避免把自己锁死。
- **URL 口令**：配置后访问 `任意路径?k=<口令>` 即进门。口令校验收窄等长侧信道，且读取接口只返回 `has_token` 布尔，不返回明文。

两者可同时配置，任一命中即进门。**启用伪装必须至少配一种**，否则保存时会被拒绝 —— 这是最容易把自己关在门外的配置错误。

### 内置模板

| 模板 | 内容 | 需要填的字段 |
|---|---|---|
| `maintenance` | 极简维护页：标题 + 说明 + 联系方式 | `title` / `subtitle` / `contact` |
| `corp` | 企业官网：导航 + 主视觉 + 服务三栏 + 页脚 | 另加 `items` |
| `blog` | 文章列表：日期 + 标题 + 摘要 | 另加 `posts` |
| `download` | 项目 / 下载页：主视觉 + 特性列表 | 另加 `items` |
| `custom` | 直接输出你贴的整段 HTML | `custom_html` |

`items` 每行一条，格式 `标题 | 说明`；`posts` 每行一条，格式 `日期 | 标题 | 摘要`。标题留空时用**当前域名**推导 —— 代码里没有任何内置站点名。

### 严格模式做了什么

开启后（默认开启），未进门者：

- 全部 `/__api/*` 拿不到数据 —— 包括原先免登录的 `/__api/sites`（它原本会把站点名、目标域名、`/p/<id>/` 链接整份交给陌生人）
- 所有未匹配路径返回伪装 404，**不再 302 到 `/__admin`**（跳转的 `Location` 头会把面板命名空间直接送给扫描器）
- `/robots.txt` 返回 `Disallow: /`，`/favicon.ico` 返回静默 204
- 登录页、错误页脱掉项目名称；全局异常兜底不再把内部错误原文吐给陌生人
- **始终保持匿名可达**：`/__api/login`、`/__api/logout`（登录通道本身）、`/p/...`（分享出去的反代链接）、`/tsub/...`（订阅拉取）、所有 WebSocket（代理节点可能把 path 配成 `/`）

### 连带改造：探活改用根路径

这一条不那么显眼但很关键。原先**四处**依赖匿名访问 `/__api/config` 来判活：服务端优选探测、DNS 自检、浏览器跨站测速、Actions 健康检查。严格模式一开，它们会全部失效、误判 IP 不可达，进而触发自愈把好端端的 A 记录删掉。

改法是分两路：**内部请求**自带登录态（口令进程内可得），**外部 / 跨站请求**改用根路径 `/` —— 伪装状态下根路径永远返回 200，而根路径是所有网站都有的，不引入任何新指纹。健康检查的判据同步放宽为「2xx/3xx 即视为可达」。

> 改完请手动触发一次 `Health Check & Auto Repair` 确认自愈链路正常，再放开长期自动运行。

---

## 防护与分享（限流 / 告警 / 临时链接）

三个模块共用同一套配置层（`src/config.js`）与同一份接口清单（`src/api-catalog.js`），
**关键项全部默认关闭** —— 升级不会改变任何既有部署的行为。

### 限流与防滥用

- **两个口子分开**：面板口（管理 API）与代理口（`/p/...`）各自一套参数，避免某人刷面板把代理业务一起限死。
- **令牌桶**：按 `每 IP 每分钟请求数` 匀速放行，另有 `突发容量` 允许短时超过。桶状态放内存，跨 isolate 不强求精确 —— 限流是「防滥用」不是「计费」，宁可少挡几个也不该误伤。
- **临时封禁**：连续超限达阈值后进入封禁，时长可配；面板 `一键解封` 清理全部封禁记录。
- **豁免**：白名单 CIDR / IP，以及 `已登录用户豁免`（默认开）—— 管理员自己不该被自己挡住。
- 触发封禁会同时发出告警事件（见下）。

### 告警通知

- **事件可选**：限流触发 / 上游异常 / 临时链接到期等，逐个开关。
- **Webhook 模板**：`通用 JSON`、`企业微信`、`钉钉`、`飞书` 四种载荷形态，换平台不用改代码。
- **冷却去重**：同一事件在冷却窗口内只发一次，避免上游抖动时把通知刷爆。
- **最近发送记录**：面板可回溯最近若干条（含成功 / 失败与响应码），便于排查 Webhook 打不通。
- `测试发送` 按钮直接打一条样例，不用等真实事件。
- Webhook 地址属敏感项，**接口不下发明文**（`sanitize()` 统一脱敏），只回显「是否已配置」。

### 站点临时访问链接

- 给某个站点签发一条限时链接（`/<前缀>/<token>`），可设 `有效期天数` 与 `最大访问次数`，**两者任一先到即失效**。
- 计数与到期判定在服务端，链接本身不携带任何可伪造的凭据。
- 面板列出全部已签发链接（站点 / 创建时间 / 到期时间 / 已用次数 / 状态），可随时吊销。
- 与 `/p/<id>/` 的主通道互不影响，临时链接只是额外开的一扇临时门。

---

## 节点备注国家标注

订阅里拉到的节点会自动在备注后面补上 IP 归属国家，主订阅 `/sub` 与临时订阅 `/tsub/<id>` 都生效：

```
CF 电信优选 | 美国【US】
地区随机 | 美国 US | LAX | 104.202.107.55:8443 | 美国【US】
```

默认开启，面板「节点备注国家标注」里可以随时关掉或换样式；也可以用环境变量 `NODE_COUNTRY_TAG` / `NODE_COUNTRY_STYLE` 控制。

| 样式取值 | 效果 | | 环境变量 `NODE_COUNTRY_STYLE` |
|---|---|---|---|
| `cn-code` | 美国【US】 | | 默认，中文名 + ISO 代号 |
| `flag-name` | 🇺🇸美国 | | 国旗 + 中文名 |
| `name` | 美国 | | 只要中文名 |
| `code` | US | | 只要 ISO 代号 |
| `flag` | 🇺🇸 | | 只要国旗 |

> 代号用的是 **ISO 3166-1 alpha-2** 标准码，所以英国是 `GB` 而不是常见的非正式写法 `UK`。

**怎么做到「效率最高」**：

1. **批量**：一次 HTTP 请求最多问 100 个 IP。80 个节点 = 1 次外部请求，而不是 80 次。
2. **永久缓存**：结果写进存储长期保存，同一个 IP 第二次起**零外部请求**。IP 归属几乎不变，没必要设短 TTL，这是最大的一笔节省。
3. **负缓存**：查不到归属的 IP 也记下来，避免每次订阅都白去重问。
4. **零数据表**：中文国家名由平台 ICU 提供（`Intl.DisplayNames`），国旗 emoji 由 ISO 代号直接算出（两个 regional indicator 字符），两者都不需要内置几百行的映射表。
5. **写入不阻塞**：第一查询完就把结果用 `ctx.waitUntil` 甩到响应之后写，不让存储往返拖慢订阅返回。

**失败时的行为**：数据源不可用、返回非 JSON、超时，统统原样透传节点（备注只是少个后缀）。订阅是整个服务的入口，为了加个后缀把订阅搞挂是不可接受的。这一层还有 8 秒墙钟上限兜底。

### CDN 任播 IP：不编国名

有个绕不开的事实：**CDN 任播 IP 没有单一地理归属**。同一个 IP 在全球边缘通告，从不同位置探测会落到不同地域。实测同一个 Cloudflare 优选 IP：

| 数据源 | 给出的结论 |
|---|---|
| `api.country.is`（本项目主源） | 查不到，返回空 |
| `ip-api.com` | 加拿大 CA |
| `ipwho.is` | 美国 US |

谁都不是「标准答案」。而这类 IP 恰恰是订阅的主力——实测 67 个去重 IP 里有 42 个（63%）落在 Cloudflare 官方段内，主源对其中 32 个查不出国家。

所以这里的处理是 **GeoIP 优先 + 官方 IP 段兜底**：

1. 主源查得到国家 → 照常显示真实国家（哪怕这个 IP 在 CDN 段内）
2. 查不到、但 IP 落在 CDN 官方段内 → 标成 `Cloudflare 任播【ANYCAST】`
3. 查不到、也不在任何已知 CDN 段 → 老实留空，绝不顺手编一个国名

```
CF 电信优选 | Cloudflare 任播【ANYCAST】
普通节点     | 荷兰【NL】
```

覆盖率从 49% 提到约 97%，而且**标出来的每一条都经得起推敲**——这比凑满覆盖率重要，备注是用来做判断的，一个错的国家名比没有更糟。

官方 IP 段取自 Cloudflare 自己公开维护的清单（`https://www.cloudflare.com/ips-v4`），拉取一次长期缓存，之后每个 IP 的判定是**纯内存的整数区间比较、零外部请求**。所以这层兜底几乎没有运行时成本。

| 环境变量 | 说明 |
|---|---|
| `NODE_COUNTRY_TAG` | `false` / `0` / `off` 关闭标注，其余（含未配置）为开启 |
| `NODE_COUNTRY_STYLE` | 后缀样式，取值见上表，默认 `cn-code` |
| `NODE_COUNTRY_ANYCAST` | 任播兜底开关，默认开启；显式写否关闭（关闭后退化为「查不到就不标注」） |
| `CF_NETS_URL` | CDN 官方 IPv4 段清单，默认 `https://www.cloudflare.com/ips-v4` |
| `GEOIP_BATCH_URL` | 批量查询端点，默认 `https://api.country.is/`（HTTPS、免密钥、单次 100 个 IP、数据源 MaxMind GeoLite2）。任何接受 JSON 数组、返回国家代码的批量端点都能替换 |
| `GEOIP_BATCH_SIZE` | 单次批量上限，默认 `100` |

**注意**：这一步刻意放在 `/sub` 出口做增强，**没有改动 vendor/vless.js** —— 节点生成逻辑仍在上游，关掉开关就是原样透传，以后升级也不会冲突。

### 实测节点是否真的可用

`tools/check-nodes.py` 会对订阅里每个节点做分级握手，越往下越能证明「真能用」：

| 级别 | 含义 |
|---|---|
| L1 | TCP 端口可达 |
| L2 | 带正确 SNI 能完成 TLS 握手（1034 / 证书不匹配会在这里暴露） |
| L3 | WebSocket upgrade 拿到 101 —— edgetunnel 的入口就是 ws |
| L4 | 真正发一条 VLESS 请求把数据代理出网，并收到目标站响应 |

```bash
curl -s https://proxy.example.com/tsub/<id> -o /tmp/sub.txt
python3 tools/check-nodes.py /tmp/sub.txt 16
```

> L4 的探测目标刻意选**没有托管在 Cloudflare 上**的站点。CF 对自己边缘 IP 发来的明文 HTTP 请求会直接回 400，用 `example.com` 这类 CF 托管域名当判据，会把健康节点误判成坏的。

---

## 访问速度

反代的正文链路是「源站 → Worker 读 body 解压 → 改写 → 发给浏览器」。每一步都有成本，这里做了三件事。

### 1. 出口 gzip 压缩（收益最大）

改写必须先把压缩过的 body 解压成明文，解完之后如果不重新压缩，浏览器拿到的就是原始体量——几百 KB 的 JS bundle、上百 KB 的 HTML 全部裸奔。

现在会在返回前用 `CompressionStream` 压一遍：

```
10841 B  →  139 B  （工具自检里的样例）
```

典型网页通常压到原来的 **20~30%**，也就是首屏在浏览器这一侧的下载时间能省掉一大半。这不是理论值，是 upstream 链路发生变化后最直接的杠杆。

三条安全边界，任何一条不满足就发明文：

| 条件 | 原因 |
|---|---|
| 浏览器 `Accept-Encoding` 明确支持 gzip 且 `q>0` | 发了对方解不开的编码，整站 JS/CSS 一起挂 |
| 响应不是 SSE / 二进制 / 已压缩 | SSE 一旦被缓冲实时性就没了；重复压缩纯属浪费 |
| 正文大于 512 B | 太小的内容压了反而变大 |

响应会带上 `Vary: Accept-Encoding`，避免缓存把压缩版和明文版混在一起。

> 之所以能放心这么做，是因为**任何异常都会退回未压缩版本**——慢一点和发坏 body 之间，永远选慢一点。

### 2. 对冲请求（治长尾）

先发一个请求，超过阈值还没回来就并行再发一个，谁先回来用谁。这是 *Tail at Scale* 里的经典做法，治的是 P99 尾延迟，不是错误。

限定条件很严格，**只对幂等请求生效**（GET/HEAD 且无 body）。重复提交一次带 body 的 POST 可能造成重复下单，那种风险换来的延迟收益不值。

默认关闭，靠环境变量打开：

| 环境变量 | 说明 |
|---|---|
| `PROXY_HEDGE_MS` | 对冲阈值（毫秒）。建议 `1200`；不配置或 `0` 即关闭，行为与原先一致 |

### 3. 重试不再空等

原先失败重试前会先在 Worker 里 `sleep(300)`。这段等待既救不了过载的源站（真正的退避应该是秒级指数级），又实打实让每个失败请求多卡 300ms，而且 Worker 计费时长照算。现在改成**立即重试**。

保留的三层保障从前往后是：对冲 → 错误/5xx/429 立即重试一次 → HTTPS 不可用时降级 HTTP。

---

## 外观主题

管理页 → **外观主题**：内置 **10 套**预设，切换后配色、字体、圆角、阴影强度会整体替换，
部分主题连标签栏与按钮的形状都会变（极简派改直角、樱粉把按钮做成药丸、终端全等宽描边……），
目标是「换主题像换了个系统」，而不是只换个主色。

**自定义主题**：只填要覆盖的 CSS 变量即可，其余自动继承。常用：

| 变量 | 作用 |
|---|---|
| `--bg` / `--card` / `--line` | 背景 / 卡片 / 边框 |
| `--accent` / `--accent-hover` | 主色与悬停色 |
| `--font` / `--font-mono` | 正文字体 / 等宽字体 |
| `--radius` / `--shadow` | 圆角 / 阴影 |

**主题存在哪里**：访客自己选的只存在本机 `localStorage`；管理员点「设为全站默认」才写入服务端。

**自动轮换**（防审美疲劳）：三种方式通过环境变量或面板配置——

| 方式 | 行为 |
|---|---|
| `off` | 不轮换，固定用默认主题 |
| `visit` | 每次加载随机一套（默认只在访客没手动挑过时生效） |
| `interval` | 每隔 N 分钟整体换一套，同一时刻所有人一致 |

相关变量：`THEME_DEFAULT` / `THEME_ROTATE_MODE` / `THEME_ROTATE_MINUTES` / `THEME_ROTATE_POOL` / `THEME_ALLOW_CUSTOM`。

---

## 常见问题

- **「立即更新优选 IP」执行失败**：错误信息现在会带具体环节。常见三种：① 缺 `CF_API_TOKEN` / `CF_ZONE_ID` Secret；② 没配 `PROXY_HOST` 且拿不到请求 hostname（cron 场景必配）；③ 候选为空——先在面板粘贴订阅链接或保存优选池。若提示 HTTP 5xx 且无详情，说明请求在平台侧超时，多为池里混了过多不可达 IP。
- **浏览器优选拉不到候选**：先看管理页「订阅链接」是否填写并保存；再看 `/__api/preferred-candidates` 返回的 `note` 字段，它会说明是拉取失败、无 IPv4 节点，还是无法获取边缘 IP 段导致未做过滤。
- **反代 Google 等人机验证页**：Cloudflare 出站是数据中心 IP，reCAPTCHA 绑定站点域名，反代环境无法完成验证。建议反代无反爬机制的站点（博客、文档、论坛等）。
- **页面一直加载 / 按钮点不动**：多为第三方域 JS/CSS 直连失败。本项目已把任意第三方域自动走跨域通道并按同一规则重写；仍异常请强刷（Ctrl/Cmd+Shift+R）重试。
- **图片 / 图标不出**：第三方独立域资源走跨域通道经代理；若用户网络本身无法访问该 CDN 则仍加载不出。
- **A 记录会不会写入不可用 IP（1034）**：不会。定时任务与「立即更新」都先经服务端 HTTP(80) 探测过滤不可达 / 非 CF IP，写入前还会以域名访问自检，新 IP 若 1034 立即回滚旧记录。
- **开启伪装后进不去面板了**：先确认当时配了至少一种进门方式（隐蔽路径或 URL 口令）。清掉站点 Cookie 后重新访问该路径（或 `任意路径?k=口令`）即可恢复 —— 进门标记本身不涉及权限，丢失不会有副作用。若配置丢失，可在 Cloudflare 控制台把 Worker 存储里的 `DISGUISE_CONFIG` 键删掉，伪装即停用。
- **开启伪装后自愈不工作了**：健康检查现在需要先用 `PASSWORD` 登录再读优选池，且已改为「按每条 A 记录逐个尝试」以应对 DNS 已指向故障 IP 的情况。手动触发一次 `Health Check & Auto Repair`，确认日志里没有「无法登录 Worker」的警告。
- **为什么浏览器测速用 no-cors 计时**：直连 `https://IP` 时 SNI=IP，CF 无 IP 证书，TLS 必然失败，cors 模式永远测不通；改 no-cors 计时（握手耗时段≈延迟）做排序，可用性交给服务端 HTTP 探测。
- **访问链接公开**：`/p/<id>/` 链接对任何知道的人都开放（管理功能仍受口令保护）。

---

## 项目文档

按软件生命周期组织的产出文档放在 [`docs/`](./docs/)：

| 文档 | 阶段 |
|---|---|
| [系统操作手册](./docs/09-系统操作手册.md) | **怎么用**：每一步在哪一屏、怎么点，附症状对照表与配置速查表 |
| [需求与迭代](./docs/01-需求与迭代.md) | 每轮需求的来源、取舍与验收 |
| [架构设计](./docs/02-架构设计.md) | 模块地图、三档访客模型、降级策略 |
| [开发规范](./docs/03-开发规范.md) | 这个项目特有的硬约束（含反例） |
| [测试体系](./docs/04-测试体系.md) | 10 个自检脚本各守哪一段 |
| [部署上线](./docs/05-部署上线.md) | 流水线三步、Secrets 清单、验收清单 |
| [运维与自愈](./docs/06-运维与自愈.md) | 健康检查、假健康事故的教训 |
| [踩坑记录](./docs/07-踩坑记录.md) | 13 个能复现的坑，按代价排序 |
| [归档说明](./docs/08-归档说明.md) | 归档后能做什么、不能做什么 |

> 只想用起来：读**系统操作手册**。要接手维护：按 **踩坑记录 → 架构设计 → 部署上线** 的顺序读。

---

## 面板结构

一块功能只归属一个选项卡。这条规矩是踩过坑才立起来的：优选池曾经同时长在
「优选 IP」和「配置」两页里，改完一边忘了另一边就会「面板显示 A、实际生效 B」。

| 选项卡 | 管什么 |
|---|---|
| 站点 | 反代站点的增删改、复制链接 |
| 代理节点 | 订阅链接、节点国家标注、代理面板与临时订阅入口 |
| 优选 IP | 自动优选频率、立即优选、优选 IP 池、**候选域名池与健康检查** |
| 伪装与安全 | 首页伪装的模板、文案、隐蔽路径、口令、严格模式 |
| 外观主题 | 10 套内置主题、自定义主题、自动轮换 |
| 临时链接 | 临时链接的开关与默认值、生成、停用、删除 |
| 配置 | 只放**没有独立选项卡**的设置（访问统计 / 限流防滥用 / 告警通知）+ 诊断工具 + 各页入口 |

「配置」页由 [`src/api-catalog.js`](./src/api-catalog.js) 驱动：加一条配置项只需在目录里加一条，
界面自动出现。`group.tab` 声明这块内容归哪个选项卡，标了就不再在配置页重复渲染表单。

---

## 注意事项

- 遵守相关法律法规，勿用于侵权、违法内容。
