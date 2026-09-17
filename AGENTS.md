# AGENTS.md — AI 协作开发约束

本文件是给 AI 编码助手（以及新加入的人类开发者）的**硬性约定**。这些规则全部来自真实踩坑——每一条背后都有一次「测试全绿但功能是坏的」或「查了一小时其实是误判」的事故。修改代码前先读完这一页。

## 0. 通用编码规范

- **禁止写死**。所有面向运营的数值（阈值、上限、默认值、开关、文案开关）都必须可配置：面板可调的走 SPEC，环境级的环境变量，代码级的具名常量。判据不是「代码里有没有常量」，而是「同一个设定有没有两份定义」（见第 1 节）。
- **通用优先**。新功能按「数据驱动」写：列表/档位/文案用注册表或 SCHEMA 生成，加一项只改一处（先例：`scopes.js` 渠道注册表、`STATS_METRICS` 表驱动渲染）。禁止为同类场景复制粘贴第二份实现。
- **可读性**。函数单一职责；关键分支必须写「为什么」注释（踩坑背景 > 语法复述）；命名用业务语义，不 namespacing 缩写。
- **可拓展性**。改动前先问「加第二个 X 要改几处」——答案必须是 1。新渠道、新指标、新档位都应有现成的注册位置。
- **失败要响**。降级路径（try/catch 兜底）必须可观测或至少有注释说明静默的理由；禁止裸 `catch {}` 吞掉会改变行为的错误。
- **先读懂再改**。动手前先读相关模块与本文档；改完跑第 7 节的全套自检。

## 1. 一个设定只允许一份定义（单一真源）

同一个业务默认值 / 校验规则 / 区间约束**禁止出现两份**。每份实现自己都是「对」的，所以 bug 不报错、单测全绿，只会静默地对不上。历史事故：面板 IPv4 校验宽松、运行时严格 → 填 `999.999.999.999` 提示已保存、池子静默为空。

- 数值/区间/词表的真源归属：`POOL_LIMIT / DNS_INTERVAL / DOMAIN_POOL_LIMIT` → `src/dns.js`；`CANDIDATE_LIMIT` → `src/subs.js`；`STATS_RANGES / DEFAULT_RANGE_DAYS` → `src/stats.js`；布尔词表 → `config.js` 的 `toBool`；主题字段约束 → `themes.js` SCHEMA（经 `themeFieldBounds()/clampFieldByName()` 消费）；IPv4/域名/列表解析 → `util.js`（`isIpv4 / isDomain / parseIpv4List / parseDomainList`）。
- **不要在别处重写正则、重抄 min/max、写裸数值兜底**（`|| 40` 这类）。需要默认值就 import 真源常量。
- 面板 HTML 的 `min/max/value` 必须从 SCHEMA/常量插值，不许手写。
- 强制检查：`node tools/check-single-source.mjs`（已入 CI）。

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
- 自检只断言「HTML 含某字符串」抓不到运行时错误（漏 import、契约不对、元素没填充）。**新增接口/区块一律从渲染产物里把脚本抠出来沙箱真跑一遍**（见 check-configui 第 11 段、check-stats 第 8 段的先例），或上 Puppeteer 真浏览器。

## 5. 新写的检查必须先证明它会红（牙齿验证）

写完检查脚本，把代码**故意还原成旧写法**，断言检查必须变红，再还原。没红过的检查是空转的摆设。历史事故：某条规则 `allow: ['src/subs.js']` 按文件放行，而合法声明与违规兜底同在一个文件里，退化悄悄通过。

## 6. 异步与运行时约束

- Workers 里 `ctx.waitUntil` 必须在 **Response 返回之前**注册；流式响应的字节计数用「Promise 占位 + TransformStream flush 里 resolve」模式（见 `worker.js` 的 `countResponseBytes`）。在 flush 里才调 `waitUntil` 会被运行时静默丢弃（症状：流量统计恒为 0 B）。
- `summarize` 之类的汇总必须基于**全量**数据算 totals，不许拿截断后的 top-N 列表求和（症状：总数 0 但图上有柱子）。

## 6.5 出口编码：Worker 一律发明文，禁止自己压缩

CF 边缘（workers.dev 与自定义域行为一致）会：① 改写入站 `Accept-Encoding`（浏览器发 `identity`，Worker 读到的仍可能含 gzip）；② 对未要求压缩的客户端**剥掉响应的 `Content-Encoding` 且不解压**。Worker 若自己 gzip，这两条合起来 = 浏览器拿到裸 gzip 字节 → 整站乱码（uhdnow 两次事故）。而边缘对支持压缩的客户端本来就会自动压（见过它发 zstd）。所以：`finalizeResponse` 永远发明文；上游响应体则按魔术字节嗅探解压（`sniffCompression`，头会撒谎或缺席，字节不会）。强制检查：`check-compress.mjs`（出口契约）+ `check-smoke.mjs` 第 6 组（入站嗅探）。

## 7. 提交与部署纪律

- 提交信息一律**中文**。
- 提交前跑全套：`check-rewrite / check-disguise / check-nodetag / check-anycast / check-themes / check-compress / check-smoke / check-guard / check-configui / check-stats / check-single-source` + `node tools/gen-manual.mjs --check`。
- 改 `api-catalog.js` 后必须跑 `gen-manual.mjs --write`，否则 `docs/09` 附录与代码脱节（CI 会卡住）。
- push 到 master 触发自动部署 + 线上 e2e；部署后带 `ap_auth` cookie 抽查 `/__admin`（未登录应伪装 404）。
- 统计（数据驾驶舱）默认**关闭**，`record_admin` 缺省 false——改配置面板时别把默认值写反。

## 8. 项目结构速查

- `worker.js` — 入口路由 / 伪装 / 字节计数；`src/admin.js` — 管理页与服务端接口（页面脚本内联在模板里）；`src/scopes.js` — 访问渠道注册表（新增渠道只改这里 + 补 check-stats 第 9 段用例）；`src/config.js` — SPEC 与环境变量种子；`src/api-catalog.js` — 接口目录（面板渲染与手册的共同来源）。
- 自检入口 `node tools/check-*.mjs`（无 package.json，不走 npm）。
