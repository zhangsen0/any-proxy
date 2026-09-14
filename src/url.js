// URL 命名空间映射：目标站 URL <-> 代理路径。
// 这套规则对所有站点一致，不含任何域名白名单 / 站点特判；前端注入脚本与后端共用同一份。

/** 跨域资源通道前缀：/p/<id>/__x/<host>/<path> —— 承载任何非目标站域的资源 */
const CROSS_PREFIX = '/__x/';

function hostOf(h) {
  return String(h || '').toLowerCase();
}

/**
 * host 是否为当前站点域。按 host 精确匹配（含端口）：
 * 任何其它域 —— 包括子域（api.github.com 之类往往是独立服务）—— 一律走跨域通道，
 * 通道按 host 精确回源，因此对任意站点都是正确且一致的行为。
 */
function isSiteHost(host, siteHost) {
  const h = hostOf(host);
  const s = hostOf(siteHost);
  return !!h && h === s;
}

/**
 * 通用 URL 映射（后端与前端注入脚本共用同一套规则）。
 * 把任意 http(s) URL 映射进本代理的命名空间，不依赖任何域名白名单 / 站点配置 / 路径关键字：
 *   - 属于站点自身域（含子域）      -> /p/<id>/<path>
 *   - 属于当前响应所属域（跨域通道） -> /p/<id>/__x/<host>/<path>
 *   - 其它任何域                   -> /p/<id>/__x/<host>/<path>
 * 其中 sitePrefix = /p/<id>，base = { host, prefix } 描述"当前这份内容原本属于哪个域"。
 */
function mapAbsoluteUrl(raw, site, sitePrefix, base) {
  let u;
  try {
    u = new URL(raw, 'https://' + (base && base.host ? base.host : site.host));
  } catch {
    return raw;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;

  // 幂等核心：源站给回的 URL 里可能已经带着代理路径（典型如 return_to / next / redirect 类参数
  // 把 /p/<id>/... 原样回传给了源站，源站再拼进自己的绝对 URL 或重定向 Location）。
  // 若不识别就会二次套前缀 -> /p/<id>/p/<id>/... -> 源站 404。
  // 因此只要路径已经在代理命名空间内，就原样保留（仅补上协议相对/绝对 URL 的其余部分）。
  const p = u.pathname;
  if (p === sitePrefix || p.startsWith(sitePrefix + '/')) {
    return p + u.search + u.hash;
  }
  if (base && (p === base.prefix || p.startsWith(base.prefix + '/'))) {
    return p + u.search + u.hash;
  }
  // 其它站点的代理路径（.../__x/host/p/<id>/... 之类）同样不重复处理
  if (/\/(?:__x\/[^/]+\/)?p\/[^/]+(?:\/|$)/.test(p) && p.includes(sitePrefix)) {
    return p + u.search + u.hash;
  }

  const rest = u.pathname + u.search + u.hash;
  if (isSiteHost(u.host, site.host)) return sitePrefix + rest;
  if (base && isSiteHost(u.host, base.host)) return base.prefix + rest;
  return sitePrefix + CROSS_PREFIX + u.host + rest;
}

/**
 * 「主机名」词法（对所有站点一致，不含任何域名白名单 / 站点特判）。
 *
 * 为什么必须单独判定主机名的合法性：
 * 网页里的资源普遍存在以 // 开头、但**根本不是 URL** 的文本：
 *   - JS 行注释        // some comment
 *   - source map 标记  //# sourceMappingURL=xxx.js.map   （几乎每个 bundle 末尾都有）
 *   - 注释里提到的示例域名、正则与除法表达式等
 * 如果把它们当成「协议相对 URL」去改写，改写结果会插进注释/表达式里，
 * 轻则破坏语法 —— 浏览器整段丢弃该脚本 —— 页面所有按钮、菜单、链接全部点不动。
 * 因此只有 // 之后紧跟合法主机名时，才认定为协议相对 URL 参与重写。
 *
 * 主机名规则与浏览器对 host 的解析一致：至少两级的域名标签，或 localhost / IPv4 / IPv6 字面量。
 */
const HOST_SRC = '(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+[A-Za-z]{2,}'
  + '|localhost'
  + '|\\d{1,3}(?:\\.\\d{1,3}){3}'
  + '|\\[[0-9A-Fa-f:.]+\\]';
/** // 之后紧跟合法主机名（可带端口）才是真正的协议相对 URL */
const SCHEME_RELATIVE_RE = new RegExp('^//(' + HOST_SRC + ')(?::\\d{1,5})?(?=[/?#]|$)');

/** 是否为协议相对 URL（//host/path 且 host 合法）。供后端与前端注入脚本共用同一套判定 */
function isSchemeRelative(s) {
  return typeof s === 'string' && SCHEME_RELATIVE_RE.test(s);
}

/**
 * 按 Content-Type 选择重写策略（对所有站点通用）。
 *   html    —— 文档：可安全地按 HTML 语法做属性级重写
 *   css     —— 样式：只处理 url(...) / @import 的字面量
 *   literal —— 脚本与数据（JS / JSON / 纯文本）：只处理被引号包裹的 URL 字面量
 *
 * 原因：脚本与样式里做裸全文正则替换必然命中注释、正则、除法表达式等非 URL 片段，
 * 一旦被改写就产生语法错误 → 整个 bundle 被丢弃 → 页面交互失效。
 * 限定在字符串字面量 / url() 语境内替换，既能覆盖所有真实 URL，也不会破坏语法。
 */
function contentKind(ct) {
  const t = String(ct || '').toLowerCase();
  if (t.includes('html') || t.includes('xml')) return 'html';
  if (t.includes('css')) return 'css';
  return 'literal';
}

/**
 * 重写用到的正则：集中到模块级常量。
 * 内联正则字面量每执行一次都要新建 RegExp 对象，反代是每请求的热路径，
 * 提升到模块级可以省掉这层重复开销（同时规则集中一处，便于维护）。
 */
// ---- 文档级重写（合并为少量轮次，避免大 HTML 上多轮全文扫描打爆 Worker CPU 预算）----
// 剥离类：<base> 会成为相对 URL 的解析基准；integrity 在内容被改写后必然校验失败。
// 两类都是「直接删除」，合并进一个正则一次扫描完成。
const RE_STRIP = /<base\b[^>]*>(?:\s*<\/base>)?|\s+integrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
/** RE_STRIP 的快速预筛：先 O(n) 检查是否含 base / integrity，避免无谓的全文正则扫描 */
const RE_STRIP_TEST = /<base\b|integrity\s*=/i;
/**
 * 全部 URL 形态的单轮替换（命名分组，回调按形态分发）：
 *   abs     https://host/... / http://host/...        —— 绝对 URL
 *   rel      //host/...（前置字符 relpre 原样保留）    —— 协议相对 URL
 *   attr     src/href/action/poster/data-src/content="/path" —— 属性根相对
 *   srcset   srcset/data-srcset="..."                  —— 逗号分隔的多资源列表
 *   cssroot  url(/path)（前引号 cssq 原样保留）        —— CSS 根相对
 * 分支互斥与顺序约束：
 *   - attr / cssroot 用 (?!\/) 排除 // 开头，避免把协议相对 URL 误判为根相对路径
 *   - 属性值里的绝对 / 协议相对 URL 由 abs / rel 分支处理，attr 分支只认「/」开头
 */
const RE_ALL_URL = new RegExp([
  '(?<abs>https?:\\/\\/[^\\s"\'<>\\\\\\)\\]]+)',
  '|(?<relpre>^|[\\s"\'=(])(?<rel>\\/\\/[^\\s"\'<>\\\\\\)\\]]+)',
  '|(?<attr>(?:src|href|action|poster|data-src|content)=["\'])\\/(?!\\/)(?<attrpath>[^"\']*)',
  '|(?<srcset>(?:srcset|data-srcset)=["\'])(?<ssval>[^"\']*)(?<ssq>["\'])',
  '|url\\(\\s*(?<cssq>["\']?)\\/(?!\\/)(?<csspath>[^)"\']*)',
].join(''), 'g');
// JS/JSON 字符串可能来自 HTML 属性或序列化配置，边界引号会写成 \\\"；保留转义形式，避免漏改 URL。
const RE_LITERAL_URL = /(\\?["'])(https?:\/\/|\/\/)([^'"\s\\]+)\\?\1/g;
const RE_CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const RE_CSS_IMPORT = /@import\s+(['"])([^'"]+)\1/g;
/** 快速判定：内容里是否**可能**存在需要重写的片段（一次扫描替换掉后续多轮正则） */
const RE_ANY_URLISH = /(?:https?:)?\/\/|url\(|=["']\/|<base|integrity/i;
/** 文档里的内联 <script> 块：URL 的消费方式未知，需按脚本规则单独处理 */
const RE_SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
/** 占位符：把内联脚本内容临时摘出，避免被文档级正则误改 */
const HOLDER = /\u0000(\d+)\u0000/g;

/**
 * 把映射结果补成绝对地址（仅作用于代理命名空间内的路径）。
 *
 * 为什么脚本上下文必须用绝对地址：
 *   new URL("...") 只有一个参数时只接受绝对 URL，传根相对路径会直接抛
 *   "Failed to construct 'URL': Invalid URL"，整段脚本在这里中断；
 *   URL.canParse() / fetch 的某些用法同理。而脚本里我们无法预知这个值会被怎么用。
 *   标记语言里的 src/href 由浏览器按文档基准解析，相对路径没有这个问题，保持相对即可。
 */
function absOnOrigin(v, origin) {
  if (!origin) return v;
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('//')) return origin.slice(0, origin.indexOf(':')) + ':' + v;
  if (v.startsWith('/')) return origin + v;
  return v;
}

/**
 * 重写内容中的 URL，规则与前端注入脚本完全一致：
 *   - 绝对 URL      https://host/...  ->  /p/<id>/... 或 /p/<id>/__x/host/...
 *   - 协议相对      //host/...        ->  同上
 *   - 根相对路径    /path             ->  当前响应所属域的代理前缀 + /path
 * 已在代理命名空间内的路径不会被二次套前缀。
 */
function rewriteContent(content, site, sitePrefix, base, kind = 'html') {
  // 一次廉价扫描：完全没有 URL / url() / 根相对属性 / <base> / integrity 的内容直接返回，
  // 省掉下面所有正则轮 REPLACE 的成本（大 bundle、纯数据 JSON 常命中）
  if (!RE_ANY_URLISH.test(content)) return content;
  const prefix = base.prefix;
  const origin = base.origin;
  // 根相对链接按「当前响应所属域」映射；若该域就是站点域（跨域通道回源站点自身，
  // 如 www.github.com 301 到 github.com 后落在 /p/<id>/__x/github.com/），
  // 统一归主通道 /p/<id>/，保证 URL 形态一致、不出现无谓的 __x 嵌套。
  const rootPrefix = base && isSiteHost(base.host, site.host) ? sitePrefix : prefix;
  const mapAbs = (raw) => mapAbsoluteUrl(raw, site, sitePrefix, base);
  // 协议相对：只有 // 之后紧跟合法主机名才认定为 URL，否则原样保留（注释 / 表达式等一律不动）
  const mapRel = (raw) => (isSchemeRelative(raw) ? mapAbs('https:' + raw) : raw);
  let out = content;

  // 判断路径是否已在代理命名空间内（避免二次套前缀）
  const siteRel = sitePrefix.slice(1);            // 如 "p/github"
  const baseRel = prefix.slice(1);                // 如 "p/github" 或 "p/github/__x/host"
  const mapped = (p) => p === siteRel || p.startsWith(siteRel + '/') || p === baseRel || p.startsWith(baseRel + '/');

  /**
   * 脚本 / 数据上下文的重写：只动被引号包裹的 URL 字面量，并输出绝对地址。
   * 外链脚本与文档里的内联 <script> 块共用这一套。
   */
  const rewriteLiteral = (s) => s.replace(RE_LITERAL_URL, (m, q, scheme, body) => {
    const raw = scheme + body;
    const next = scheme === '//' ? mapRel(raw) : mapAbs(raw);
    if (next === raw) return m;                   // 没被映射（不是 URL / 已原样保留），不动
    return q + absOnOrigin(next, origin) + q;
  });

  // ---- 脚本 / 数据 / 其它文本：只重写字符串字面量里的 URL ----
  if (kind === 'literal') return rewriteLiteral(content);

  // ---- 样式：url(...) 与 @import 的字面量 ----
  if (kind === 'css') {
    out = out.replace(RE_CSS_URL, (m, q, u) => {
      const v = u.trim();
      if (!v) return m;
      let nv;
      if (/^https?:/i.test(v)) nv = mapAbs(v);
      else if (v.startsWith('//')) nv = mapRel(v);
      else if (v.startsWith('/') && !mapped(v.slice(1))) nv = rootPrefix + v;
      else return m;
      return 'url(' + q + nv + q + ')';
    });
    return out.replace(RE_CSS_IMPORT, (m, q, u) => {
      const v = u.trim();
      if (/^https?:/i.test(v)) return m.replace(v, mapAbs(v));
      return m;
    });
  }

  // ---- 文档 HTML ----
  // 先把内联 <script> 内容摘出去：文档级正则（绝对 URL 全文替换等）会把它当普通文本改，
  // 而脚本里 URL 的消费方式未知，必须走脚本规则并输出绝对地址
  const blocks = [];
  out = out.replace(RE_SCRIPT_BLOCK, (m, attrs, inner) => {
    const i = blocks.push(inner) - 1;
    return '<script' + attrs + '>\u0000' + i + '\u0000</script>';
  });

  // 剥离 <base> 与 integrity（一次扫描，避免多轮全文正则）。
  // 先做 O(n) 快速预筛：绝大多数文档没有这两种结构，直接跳过全文正则。
  if (RE_STRIP_TEST.test(content)) out = out.replace(RE_STRIP, '');

  // 单轮替换全部 URL 形态：绝对 / 协议相对 / 属性根相对 / srcset / CSS url(/...)
  out = out.replace(RE_ALL_URL, (m, ...args) => {
    const g = args[args.length - 1];
    if (g.abs !== undefined) return mapAbs(g.abs);
    if (g.rel !== undefined) return g.relpre + mapRel(g.rel);
    if (g.attr !== undefined) {
      if (mapped(g.attrpath)) return m;
      return g.attr + rootPrefix + '/' + g.attrpath;
    }
    if (g.srcset !== undefined) {
      const rewritten = g.ssval.split(',').map(s => s.trim()).filter(Boolean).map(it => {
        const parts = it.split(/\s+/);
        const u = parts[0] || '';
        if (!u) return it;
        if (u.startsWith('//')) parts[0] = mapRel(u);
        else if (/^https?:/i.test(u)) parts[0] = mapAbs(u);
        else if (u.startsWith('/') && !mapped(u.slice(1))) parts[0] = rootPrefix + u;
        return parts.join(' ');
      });
      return g.srcset + rewritten.join(', ') + g.ssq;
    }
    if (g.csspath !== undefined) {
      if (mapped(g.csspath)) return m;
      return 'url(' + g.cssq + rootPrefix + '/' + g.csspath;
    }
    return m;
  });
  // 内联脚本内容按脚本规则回填（输出绝对地址，保证 new URL("...") 之类单参数用法可用）
  if (blocks.length) out = out.replace(HOLDER, (m, d) => rewriteLiteral(blocks[Number(d)]));
  return out;
}

// ===================== 管理页面 =====================

export {
  CROSS_PREFIX, hostOf, isSiteHost, mapAbsoluteUrl,
  isSchemeRelative, contentKind, rewriteContent,
  // 导出给前端注入脚本复用：运行时脚本里的协议相对判定必须与后端完全一致，
  // 两边各写一份正则迟早会漂移，导致后端改写过的内容在前端被二次（错误）处理
  SCHEME_RELATIVE_RE,
};
