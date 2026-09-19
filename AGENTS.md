# AGENTS.md — AI 协作开发约束

本文件是给 AI 编码助手（以及新加入的人类开发者）的**硬性约定**。这些规则全部来自真实踩坑——每一条背后都有一次「测试全绿但功能是坏的」或「查了一小时其实是误判」的事故。修改代码前先读完这一页。

## 0. 通用编码规范

- **禁止写死**。所有面向运营的数值（阈值、上限、默认值、开关、文案开关）都必须可配置：面板可调的走 SPEC，环境级的环境变量，代码级的具名常量。判据不是「代码里有没有常量」，而是「同一个设定有没有两份定义」（见第 1 节）。
- **通用优先**。新功能按「数据驱动」写：列表/档位/文案用注册表或 SCHEMA 生成，加一项只改一处（先例：`scopes.js` 渠道注册表、`STATS_METRICS` 表驱动渲染）。禁止为同类场景复制粘贴第二份实现。
- **可读性**。函数单一职责；关键分支必须写「为什么」注释（踩坑背景 > 语法复述）；命名用业务语义，不 namespacing 缩写。
- **可拓展性**。改动前先问「加第二个 X 要改几处」——答案必须是 1。新渠道、新指标、新档位都应有现成的注册位置。
- **失败要响**。降级路径（try/catch 兜底）必须可观测或至少有注释说明静默的理由；禁止裸 `catch {}` 吞掉会改变行为的错误。
- **先读懂再改**。动手前先读相关模块与本文档；改完跑第 7 节的全套自检。

### 0.5 命名规范（《阿里巴巴开发规范》适用条款）

- 【强制】标识符（变量 / 函数 / 类 / 参数 / 导出符号）一律**英文**，禁止中文与拼音命名。注释使用中文是本仓库约定，不受此条约束。
- 【强制】变量与函数用小驼峰（`sitePrefix`）；类型 / 构造器用大驼峰；常量用 `UPPER_SNAKE_CASE`（`CANDIDATE_LIMIT`）。
- 【强制】杜绝望文不知义的缩写（`cnd` / `calc` 之类要写全）；布尔量用 `is / has / can / should` 前缀（`isAuthed`）；函数名动词开头（`rewriteContent`）。
- 【豁免】`vendor/` 是第三方 vendored 代码（edgetunnel 上游原样拷贝，含大量中文标识符），**保持原样跟随上游，不做命名整改**；如需改动，先核对上游对应实现，能不改就不改。

## 1. 一个设定只允许一份定义（单一真源）

同一个业务默认值 / 校验规则 / 区间约束**禁止出现两份**。每份实现自己都是「对」的，所以 bug 不报错、单测全绿，只会静默地对不上。历史事故：面板 IPv4 校验宽松、运行时严格 → 填 `999.999.999.999` 提示已保存、池子静默为空。

- **面向运营的运行参数 → `src/settings.js` 的 `SETTINGS_SPEC`**（唯一真源）：优选频率、优选池上限、候选上限、探测并发/超时、总时间预算、订阅 UA/严格模式、边缘段与外部数据源地址、转发对冲阈值、CF API 凭据与端点、面板运维入口、来访者哈希盐值。面板表单、运行时取值、手册附录全部从这一份生成。
- 数值/区间/词表的真源归属（除运行参数外）：`STATS_RANGES / DEFAULT_RANGE_DAYS` → `src/stats.js`；布尔词表 → `config.js` 的 `toBool`；主题字段约束 → `themes.js` SCHEMA（经 `themeFieldBounds()/clampFieldByName()` 消费）；IPv4/域名/列表解析 → `util.js`（`isIpv4 / isDomain / parseIpv4List / parseDomainList`）。
- **不要在别处重写正则、重抄 min/max、写裸数值兜底**（`|| 40` 这类）。需要默认值就 import 真源常量；运行参数一律走 `readSetting(s) / readSettings(env)`，**禁止在模块里直读 `env.XXX`**（唯一例外是 `settings.js` 自己作为环境变量种子的兜底）。
- 只有**部署形态**项留在 wrangler.toml / 环境变量：`STORAGE_BACKEND / DB / SITES / MEDIA_R2`（改它等于换存储，必须与绑定同改）与 `PASSWORD / KEY`（凭据，不进 KV）。
- **wrangler.toml 里不许写死资源 ID**：D1 的 `database_id`、KV 的 `id`、R2 的 `bucket_name`、`name`、`GH_ACTIONS_URL` 一律写成 `__XXX__` 占位符，由 `.github/scripts/prepare-deploy.py` 在部署前渲染（仓库 Variables 优先，没配就调 CF 接口自动创建；R2 建不出来就删绑定降级）。判据是「版本库里不能出现任何 UUID / 32 位十六进制形态的 ID」，由 `check-wrangler.mjs` 静态 + 真跑双重钉住。
- 面板 HTML 的 `min/max/value` 必须从 SCHEMA/常量插值，不许手写。
- 运行参数改完**必须即时生效**：写库后由 `notifyConfigChange(section)` 广播，各模块在 `onConfigChange` 里清掉自己的进程内快照（见 `cf-analytics.js` 的 `cache.clear()`、`geoip.js` 的 `cfNets = null`）。新增模块级缓存，就要同时挂一个清缓存的钩子。
- **写入侧不许静默忽略**：`saveSettings` 遇到 `SETTINGS_SPEC` 之外的键直接报 400 并点名是哪个字段。静默忽略会让「字段名写错 / 调用方还在用旧别名」表现为「提示保存成功、值却没变」——不报错、日志干净，只能人肉比对。同理，新增接口时别再造一层 `{别名} → 注册表字段名` 的翻译。
- **校验要拦在写入前**：面板值若不能被引擎接受（如 `uuid` 必须是 v4 形态，否则 `vendor/vless.js` 会静默改用派生值），必须在注册表字段的 `validate` 里拦住，而不是等引擎默默丢弃。
- **接口必须进目录**：`admin.js` 里新增 `/__api/*` 就要在 `api-catalog.js` 加条目，否则面板不渲染、手册不收录，而且什么都不报错。刻意不进目录的（内部探活、预览类）要登记进 `check-configui` 第 7 段的 `OFF_CATALOG` 白名单并写明理由。
- **页面脚本里不许写死运行参数的数字**：浏览器优选曾经在脚本里写死 `40 / 15 / 8 / 3500`，于是面板把「订阅候选上限」调到 100、浏览器依旧只测 40 个 —— 开关存在、行为不变，不报错。需要口径就从服务端下发（见 `admin.js` 的 `pickLimits(cfg)`，由 `/__api/preferred-candidates` 与 `/__api/preferred-ips` 回带），**拿不到就停下报错、不要用写死数字兜底**。判据在 `check-preferred.mjs` 第 6 段：真改一次值断言下发跟着变 + 静态扫描源码里没有第二套数字。
- 强制检查：`node tools/check-single-source.mjs` + `node tools/check-settings.mjs`（均已入 CI）。

## 2. 浏览器端 `api()` 返回包装结构

`src/admin.js` 里页面脚本的 `api()` 返回 **`{ ok, status, data }`**，业务字段一律在 `r.data.*` 里：

```js
api('/__api/sites').then(r => { const sites = (r.data && r.data.sites) || []; });
```

**禁止**直接读 `r.sites / r.shares / r.error / r.path`。历史上「生成链接」的站点下拉因此永远为空——不报错、只静默为空。回归检查：`check-configui.mjs` 第 11 段会把渲染产物里的 share IIFE 抠出来沙箱真跑。

## 3. 注入浏览器的脚本必须自包含

凡通过 `fn.toString()` 注入页面的函数（`STATS_JS / CONFIG_JS` 等），**闭包里没有模块导入**——`import` 进来的 `esc` 之类在浏览器里是 `ReferenceError`，且整块 `<script>` 会一起死掉，后面的 IIFE 全部不执行（症状：某个下拉/列表永远是空的）。

- 注入函数内部用的工具函数就地定义；需要的常量用 `JSON.stringify` 序列化后拼进脚本（如 `var STATS_DEFAULT_DAYS=...`）。
- 新增/修改注入脚本后，必须跑 `check-stats.mjs`（第 8 段会在裸沙盒里真跑脚本抓这类泄漏）。

## 4. 调试判据：先怀疑代码，再怀疑边缘

- **伪装（cloaking）把一切未捕获异常渲染成 404**。「某接口 404」≠「被拦截」，先怀疑 handler 抛异常。判别法：同秒同 colo 同 cookie，对比只差一个字符的兄弟路径——兄弟正常而它 404 ⇒ handler 内部问题。
- **看路径的行为，不看名字**：路径跟着代码改名一起变，就一定是代码问题。
- `git status` 的 `ahead N` 不可信（本机 `refs/remotes` 不落盘），核对远端一律用 `api.github.com/repos/zhangsen0/any-proxy/commits/master`。
- 自检只断言「HTML 含某字符串」抓不到运行时错误（漏 import、契约不对、元素没填充）。**新增接口/区块一律从渲染产物里把脚本抠出来沙箱真跑一遍**（见 check-configui 第 11 段、check-stats 第 8 段的先例），或上 Puppeteer 真浏览器。真实案例：router.js 的 OPTIONS 预检分支用了 `cors()` 却漏 import，所有预检静默变成伪装 404，上线多月才被全类型实测发现（回归：check-smoke 第 8 组）。

## 5. 新写的检查必须先证明它会红（牙齿验证）

写完检查脚本，把代码**故意还原成旧写法**，断言检查必须变红，再还原。没红过的检查是空转的摆设。历史事故：某条规则 `allow: ['src/subs.js']` 按文件放行，而合法声明与违规兜底同在一个文件里，退化悄悄通过。

## 6. 异步与运行时约束

- Workers 里 `ctx.waitUntil` 必须在 **Response 返回之前**注册；流式响应的字节计数用「Promise 占位 + TransformStream flush 里 resolve」模式（见 `worker.js` 的 `countResponseBytes`）。在 flush 里才调 `waitUntil` 会被运行时静默丢弃（症状：流量统计恒为 0 B）。
- `summarize` 之类的汇总必须基于**全量**数据算 totals，不许拿截断后的 top-N 列表求和（症状：总数 0 但图上有柱子）。
- WebSocket 透传：客户端在 101 返回后立即可 `send`，出站握手此刻常还在 CONNECTING——这段时间到达的消息必须缓冲、open 后按序冲刷，按 `readyState===1` 直接放行会静默丢首条消息（症状：握手成功但回显永远不来，check-smoke 第 7 组回归）。

## 6.5 出口编码：Worker 一律发明文，禁止自己压缩

CF 边缘（workers.dev 与自定义域行为一致）会：① 改写入站 `Accept-Encoding`（浏览器发 `identity`，Worker 读到的仍可能含 gzip）；② 对未要求压缩的客户端**剥掉响应的 `Content-Encoding` 且不解压**。Worker 若自己 gzip，这两条合起来 = 浏览器拿到裸 gzip 字节 → 整站乱码（uhdnow 两次事故）。而边缘对支持压缩的客户端本来就会自动压（见过它发 zstd）。所以：`finalizeResponse` 永远发明文；上游响应体则按魔术字节嗅探解压（`sniffCompression`，头会撒谎或缺席，字节不会）。强制检查：`check-compress.mjs`（出口契约）+ `check-smoke.mjs` 第 6 组（入站嗅探）。

## 7. 提交与部署纪律

- 提交信息一律**中文**。
- 提交前跑全套：仓库里的 `tools/check-*.mjs` **一套都不能漏**（当前 21 套纯离线：
  `check-rewrite / check-disguise / check-nodetag / check-anycast / check-themes / check-compress /
  check-hls / check-media / check-path / check-heal / check-smoke / check-guard / check-stats /
  check-configui / check-single-source / check-settings / check-preferred / check-cf-panel /
  check-site-modes / check-latency / check-wrangler`）+ `node tools/gen-manual.mjs --check`。
  一行搞定：`for f in tools/check-*.mjs; do node "$f" || echo "FAIL $f"; done`（`check-live` 需要参数会自动退出，忽略它的 usage 提示即可）。
- **新增 check 脚本必须同时挂进 `.github/workflows/verify.yml` 的 unit job**，
  否则它只在写它的那个人本机跑过 —— 本地跑过 ≠ 明天也被拦住。历史上一次性漏了三套
  共 98 项（`check-preferred` / `check-cf-panel` / `check-site-modes`），其中 `check-preferred`
  盯的正是「面板能改、行为却不变」，而它自己从没被 CI 盯着。详见 [07-踩坑记录](./docs/07-踩坑记录.md) 第 23 条。
- **静态判据里的「看哪一段」必须是语义边界，且边界本身要有断言**：
  用字符数（`slice(i, i+300)`）会越过 `);` 读到下一句；用「猜一个关键词当终点」更隐蔽 ——
  猜错时机不报错，只会静默切出空串，于是好几条判据一起变红却不说明原因。
  凡是 `.slice(a, b)` 都要配一条 `check('边界找对了', b > a)`，并把 `block.length` 打进失败详情。
  详见 [07-踩坑记录](./docs/07-踩坑记录.md) 第 21、22 条。
- **凡是「写完立刻要看到新值」的检查，都必须先把旧状态装进缓存**：
  缓存是 cold 的时候，写完之后就算不失效，下一次读也会因为 miss 拿到真值 ——
  断言怎么都是绿的，验的其实是「缓存里原本没东西」，跟有没有做失效毫无关系。
  写操作前先做一次对应的读（把「不存在 / 旧值」塞进缓存），并把这次前置结果本身也做成断言 ——
  不这么做，它没生效时后面几条会跟着一起假通过。详见 [07-踩坑记录](./docs/07-踩坑记录.md) 第 24 条。
- **同一件事不要在多个地方各做一遍**：为了保险在三条路径上重复清理 / 重复校验，
  结果是彼此互相掩护 —— 砍掉任何一份检查都照样全绿，谁都没有资格自称是那条保证。
  要就收拢到一处，并只对那一处做牙齿验证。详见 [07-踩坑记录](./docs/07-踩坑记录.md) 第 25 条。
- **文档里的累加数字（断言总数、清单条目数）不要手抄**：`node tools/count-asserts.mjs`
  是唯一真源。手工累加的偏差已经出过两轮 —— 一轮是三套检查从来没挂 CI 却照样登记为「全覆盖」，
  一轮是对着脚本数出来差 8 项。详见 [04-测试体系](./docs/04-测试体系.md)。
- 改 `api-catalog.js` 后必须跑 `gen-manual.mjs --write`，否则 `docs/09` 附录与代码脱节（CI 会卡住）。
- push 到 master 触发自动部署 + 线上 e2e；部署后带 `ap_auth` cookie 抽查 `/__admin`（未登录应伪装 404）。
- 统计（数据驾驶舱）默认**关闭**，`record_admin` 缺省 false——改配置面板时别把默认值写反。

## 8. 项目结构速查

- `worker.js` — 入口路由 / 伪装 / 字节计数；`src/admin.js` — 管理页与服务端接口（页面脚本内联在模板里）；`src/scopes.js` — 访问渠道注册表（新增渠道只改这里 + 补 check-stats 第 9 段用例）；`src/config.js` — SPEC 与环境变量种子；`src/settings.js` — 运行参数注册表（面向运营的参数唯一真源，面板表单与运行时共同消费）；`src/api-catalog.js` — 接口目录（面板渲染与手册的共同来源）。
- 管理页的配置表单**不手写**：`api-catalog.js` 的目录项带 `spec/params`，`admin.js` 的页面模板只写 `settingFormById('<目录项 id>')`，`config-ui.js` 的 `renderSettingForm` 按注册表渲染（`gridHtml` 支持按 `section` 分段）。加一个可配置项 = 注册表加一条，界面自动多一个输入框。
- 功能选项卡自己的**动作 / 查询**同样不手写：`toolItemsForTab('<tab id>')` 从目录渲染（归属该选项卡的非设置项）。目录项声明的固定请求体写在 `item.body`，由 `renderToolItem` 挂到元素的 `data-body`，浏览器侧与用户填写的字段合并 —— 别在页面脚本里另写一份参数。
- 自检入口 `node tools/check-*.mjs`（无 package.json，不走 npm）。
