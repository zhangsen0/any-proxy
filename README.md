# Any-Proxy

基于 **Cloudflare Workers** 的统一反向代理与优选 IP 代理工具。一个域名同时提供两类能力：

1. **动态多站反向代理** —— 管理页在线增删改任意站点，每个站点一个专属前缀，配置实时写入存储并生效，无需改代码、无需重新部署。
2. **优选 IP 代理节点**（内嵌 edgetunnel）—— VLESS / Trojan / SS 节点 + 管理面板，客户端只需填写域名即可使用。

登录保护、亮/暗主题、GitHub Actions 自动部署与健康检查自愈，站点管理与代理面板共用同一套登录。

- 部署域名：你自己的域名（如 `https://proxy.example.com`）
- 示例反代链接：`https://proxy.example.com/p/github/zhangsen0/any-proxy`

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
- **主题**：亮 / 暗 / 跟随系统三档，本地保存。

---

## 快速开始

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

> `KV_NAMESPACE_ID` 不再需要：KV 绑定已写入 `wrangler.toml`，健康检查经 Worker API 读写存储，与后端无关。

### GitHub Variables

| 变量 | 说明 |
|---|---|
| `STORAGE_BACKEND` | 持久化后端：`d1`（默认）或 `kv`。Worker 内全部存储（站点配置、DNS 配置、优选池、面板数据）统一走该后端；切换后端后历史数据不会自动迁移，建议固定后不再切换 |
| `PREF_DOMAINS` | 改 DNS 时解析用的候选域名池（空格分隔）。优先级：GitHub 变量 → Worker 侧 `PREF_DOMAINS`（面板可配）。**没有内置兜底**，两项都空时域名解析这一路候选不参与 |
| `PROXY_HOST` | **优选 / 自愈 / 健康检查的目标域名**（例如 `proxy.example.com`）。留空则 Worker 按**当前请求的 hostname** 推导；定时任务（cron）场景拿不到请求，**必须显式配置**，否则优选会明确报错而不会猜到一个别的域名 |
| `SUB_URL` | 浏览器优选拉取候选节点的订阅链接。留空则回退本机 `/sub`（token 按 edgetunnel 同一口径推导）。面板「订阅链接」里填写的值优先级最高 |

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
| `/` 、`/__admin` | 主页（未登录 = 只读列表；登录 = 完整管理 + 代理面板入口） |
| `/__login` | 登录页 |
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

---

## 项目结构

```
worker.js              统一入口：绑定运行时 + 请求路由；scheduled 处理 DNS 定时任务
wrangler.toml          Worker 配置：D1 绑定 DB（默认后端，migrations_dir=migrations）、KV 绑定 SITES、cron */5 * * * *、vars.GH_ACTIONS_URL
src/
  runtime.js           平台注入绑定（KV / PASSWORD）的共享容器；按 STORAGE_BACKEND 选择 KV 或 D1
  storage.js           D1-backed KV 兼容适配层（createD1KV），业务模块无感切换后端
  router.js            HTTP 路由与全部访问路径
  proxy.js             反代核心：请求转发、响应重写、WebSocket 透传、Set-Cookie 收敛、上游重试、幂等还原
  url.js               URL 命名空间映射与内容重写（通用规则，无站点特判）
  inject.js            注入到被代理页面的前端运行时脚本（injectLinkFix）
  sites.js             站点配置持久化（增删查、slug 生成、target 解析）
  admin.js             管理 REST API + 服务端渲染的管理页
  auth.js              登录 / 登出 / 登录页
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
  check-preferred.mjs  优选链路自检：订阅候选拉取 + 探测是否会在 Workers 墙钟内完成
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
```

---

## 优选是怎么跑的

1. **候选来源**（全部可配，无写死）：已验证可用集 `GOOD_IPS` → 优选池 `PREF_IPS` → **订阅链接里的节点**（按边缘 IP 段过滤）→ 候选域名池 `PREF_DOMAINS` 动态解析。
2. **服务端探测**：并发 `HTTP(80)` 过滤不可达 IP，受总预算 `DNS_BUDGET_MS` 约束。
3. **写 DNS**：取前 2 个写入 A 记录，随后用「访问自己域名」自检，不通过立即回滚。

> 为什么要有时间预算：Workers 单次 HTTP 请求有约 30 秒墙钟上限，超时会被平台直接杀掉，
> 前端只会看到「请求失败」。过去逐 IP 串行探测（每个最多等 3s），候选里只要有几个不可达地址就会累计超限，
> 这正是「立即更新优选 IP」一直报错的原因。现在串行 12s 的场景并发后约 2.5s，且预算耗尽会直接返回已探到的结果。

---

## 常见问题

- **「立即更新优选 IP」执行失败**：错误信息现在会带具体环节。常见三种：① 缺 `CF_API_TOKEN` / `CF_ZONE_ID` Secret；② 没配 `PROXY_HOST` 且拿不到请求 hostname（cron 场景必配）；③ 候选为空——先在面板粘贴订阅链接或保存优选池。若提示 HTTP 5xx 且无详情，说明请求在平台侧超时，多为池里混了过多不可达 IP。
- **浏览器优选拉不到候选**：先看管理页「订阅链接」是否填写并保存；再看 `/__api/preferred-candidates` 返回的 `note` 字段，它会说明是拉取失败、无 IPv4 节点，还是无法获取边缘 IP 段导致未做过滤。
- **反代 Google 等人机验证页**：Cloudflare 出站是数据中心 IP，reCAPTCHA 绑定站点域名，反代环境无法完成验证。建议反代无反爬机制的站点（博客、文档、论坛等）。
- **页面一直加载 / 按钮点不动**：多为第三方域 JS/CSS 直连失败。本项目已把任意第三方域自动走跨域通道并按同一规则重写；仍异常请强刷（Ctrl/Cmd+Shift+R）重试。
- **图片 / 图标不出**：第三方独立域资源走跨域通道经代理；若用户网络本身无法访问该 CDN 则仍加载不出。
- **A 记录会不会写入不可用 IP（1034）**：不会。定时任务与「立即更新」都先经服务端 HTTP(80) 探测过滤不可达 / 非 CF IP，写入前还会以域名访问自检，新 IP 若 1034 立即回滚旧记录。
- **为什么浏览器测速用 no-cors 计时**：直连 `https://IP` 时 SNI=IP，CF 无 IP 证书，TLS 必然失败，cors 模式永远测不通；改 no-cors 计时（握手耗时段≈延迟）做排序，可用性交给服务端 HTTP 探测。
- **访问链接公开**：`/p/<id>/` 链接对任何知道的人都开放（管理功能仍受口令保护）。

---

## 注意事项

- 遵守相关法律法规，勿用于侵权、违法内容。
