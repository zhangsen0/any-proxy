// ===================== 订阅多格式输出（vless/trojan/ss → clash / sing-box / base64） =====================
// 引擎（vendor/vless.js）输出的是标准分享链接文本（vless://、trojan://、ss:// 混合多行）。
// 本模块在文本层做「格式转换」，不触碰引擎的节点生成逻辑：
//   - 协议解析注册表 PROTOCOL_PARSERS：每种协议一个「分享链接 → 节点对象」解析器；
//   - 格式渲染注册表 FORMAT_RENDERERS：每种输出格式一个「节点对象列表 → 配置文本」渲染器。
// 加一个新协议 = 注册表加一个解析器；加一种输出格式 = 注册表加一个渲染器，互不侵入。
// 不识别的协议行与无法解析的行一律跳过（保留其余节点），不破坏整体输出。

// ---------- 通用小工具 ----------

/** UTF-8 安全 base64（Worker 里 btoa 不能直接吃中文节点名） */
function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 最小 YAML 序列化（节点配置用；字符串统一双引号，避免锚点/冒号/井号等字符破坏结构） */
function toYaml(obj, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      out.push(`${pad}${k}:`);
      for (const item of v) {
        if (item && typeof item === 'object') {
          const lines = toYaml(item, indent + 2).split('\n');
          out.push(`${pad}  - ${lines[0].trim()}`);
          out.push(lines.slice(1).join('\n'));
        } else {
          out.push(`${pad}  - ${typeof item === 'string' ? JSON.stringify(item) : item}`);
        }
      }
    } else if (v && typeof v === 'object') {
      out.push(`${pad}${k}:`);
      out.push(toYaml(v, indent + 2));
    } else {
      out.push(`${pad}${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
    }
  }
  return out.join('\n');
}

/** 解析标准分享链接的 host:port?params#name 部分 */
function parseEndpoint(rest) {
  const hashIdx = rest.indexOf('#');
  const name = hashIdx >= 0 ? decodeURIComponent(rest.slice(hashIdx + 1)) : '';
  const queryIdx = rest.indexOf('?');
  const qs = queryIdx >= 0 ? rest.slice(queryIdx + 1, hashIdx >= 0 ? hashIdx : undefined) : '';
  const hostPort = rest.slice(0, queryIdx >= 0 ? queryIdx : hashIdx >= 0 ? hashIdx : rest.length);
  const m = hostPort.match(/^([^:]+):(\d+)$/);
  if (!m) return null;
  const params = new URLSearchParams(qs);
  return { server: m[1], port: Number(m[2]), name, params };
}

// ---------- 协议解析注册表：分享链接 → 节点对象 ----------

/** vless://uuid@host:port?security=tls&type=ws&host=&sni=&fp=&path=&#name */
function parseVless(line) {
  const m = line.match(/^vless:\/\/([^@]+)@(.*)$/);
  if (!m) return null;
  const ep = parseEndpoint(m[2]);
  if (!ep) return null;
  const p = ep.params;
  const security = p.get('security') || '';
  return {
    type: 'vless',
    name: ep.name,
    server: ep.server,
    port: ep.port,
    uuid: m[1],
    security,
    tls: security === 'tls' || security === 'reality',
    reality: security === 'reality',
    flow: p.get('flow') || '',
    sni: p.get('sni') || ep.server,
    fp: p.get('fp') || 'chrome',
    pbk: p.get('pbk') || '',
    sid: p.get('sid') || '',
    transport: p.get('type') || 'tcp',
    wsPath: p.get('path') || '/',
    wsHost: p.get('host') || '',
  };
}

/** trojan://password@host:port?security=tls&type=ws&host=&path=&#name */
function parseTrojan(line) {
  const m = line.match(/^trojan:\/\/([^@]+)@(.*)$/);
  if (!m) return null;
  const ep = parseEndpoint(m[2]);
  if (!ep) return null;
  const p = ep.params;
  return {
    type: 'trojan',
    name: ep.name,
    server: ep.server,
    port: ep.port,
    password: m[1],
    security: p.get('security') || '',
    tls: p.get('security') === 'tls' || p.get('security') === 'reality',
    sni: p.get('sni') || ep.server,
    fp: p.get('fp') || 'chrome',
    transport: p.get('type') || 'tcp',
    wsPath: p.get('path') || '/',
    wsHost: p.get('host') || '',
  };
}

/**
 * ss:// 两种标准形态都支持：
 *   新格式 ss://base64url(method:password@host:port#name)
 *   老格式 ss://method:password@host:port?plugin=v2ray-plugin;...#name
 */
function parseShadowsocks(line) {
  const body = line.slice('ss://'.length);
  let core;
  if (body.includes('@')) {
    core = body; // 老格式：method:pass@host:port[?...]
  } else {
    const eq = body.indexOf('?');
    try { core = b64decode(eq >= 0 ? body.slice(0, eq) : body); } catch { return null; }
  }
  const atIdx = core.indexOf('@');
  if (atIdx < 0) return null;
  const methodPass = core.slice(0, atIdx);
  const ep = parseEndpoint(core.slice(atIdx + 1));
  if (!ep) return null;
  const mIdx = methodPass.lastIndexOf(':');
  if (mIdx < 0) return null;
  const pluginRaw = ep.params.get('plugin') || '';
  const plugin = pluginRaw.startsWith('v2ray-plugin') ? 'v2ray-plugin' : '';
  return {
    type: 'ss',
    name: ep.name,
    server: ep.server,
    port: ep.port,
    method: methodPass.slice(0, mIdx),
    password: methodPass.slice(mIdx + 1),
    plugin,
    pluginOpts: pluginRaw.slice('v2ray-plugin'.length).replace(/^;/, ''),
  };
}

const PROTOCOL_PARSERS = {
  vless: parseVless,
  trojan: parseTrojan,
  ss: parseShadowsocks,
};

/** 分享链接文本 → 节点对象列表（不识别的协议行跳过，不抛错） */
function parseNodes(text) {
  const nodes = [];
  for (const line of String(text).split('\n').map(s => s.trim()).filter(Boolean)) {
    const proto = line.split('://')[0].toLowerCase();
    const parser = PROTOCOL_PARSERS[proto];
    if (!parser) continue;
    const node = parser(line);
    if (node) nodes.push(node);
  }
  return nodes;
}

// ---------- 格式渲染注册表：节点列表 → 可直接导入的配置文本 ----------

/** Clash YAML：proxies + 节点选择组 + 兜底规则，导入即用 */
function renderClash(nodes) {
  const proxies = [];
  for (const n of nodes) proxies.push(clashProxy(n));
  if (!proxies.length) return null;
  const group = [
    { name: '🚀 节点选择', type: 'select', proxies: proxies.map(p => p.name) },
    { name: '♻️ 自动选择', type: 'url-test', url: 'http://www.gstatic.com/generate_204', interval: 300, tolerance: 50, proxies: proxies.map(p => p.name) },
  ];
  const yaml = [
    'proxies:',
    proxies.map(p => toYaml(p, 2)).join('\n'),
    '',
    'proxy-groups:',
    group.map(g => toYaml(g, 2)).join('\n'),
    '',
    'rules:',
    '  - GEOIP,CN,DIRECT',
    '  - MATCH,🚀 节点选择',
  ].join('\n');
  return { body: yaml, type: 'application/yaml; charset=utf-8' };
}

function clashProxy(n) {
  const base = { name: n.name, type: n.type, server: n.server, port: n.port };
  if (n.type === 'vless') {
    base.uuid = n.uuid;
    base.tls = n.tls;
    base.servername = n.sni;
    if (n.reality) base['client-fingerprint'] = n.fp;
  }
  if (n.type === 'trojan') {
    base.password = n.password;
    base.sni = n.sni;
  }
  if (n.type === 'ss') {
    base.cipher = n.method;
    base.password = n.password;
    if (n.plugin) {
      base.plugin = 'v2ray-plugin';
      base['plugin-opts'] = { mode: 'websocket', host: n.wsHost || n.server, path: n.wsPath };
    }
  }
  const transport = n.transport || 'tcp';
  if (transport === 'ws') {
    base.network = 'ws';
    base['ws-opts'] = { path: n.wsPath, headers: n.wsHost ? { Host: n.wsHost } : {} };
  } else if (transport === 'grpc') {
    base.network = 'grpc';
    base['grpc-opts'] = {};
  }
  return base;
}

/** Sing-box JSON：vless/trojan/ss outbounds + selector 出口 + 路由兜底 */
function renderSingbox(nodes) {
  const outbounds = [];
  const tags = [];
  for (const n of nodes) {
    const ob = singboxOutbound(n);
    if (ob) { outbounds.push(ob); tags.push(n.name); }
  }
  if (!outbounds.length) return null;
  outbounds.push({ type: 'direct', tag: 'direct' });
  const selector = { type: 'selector', tag: '🚀 节点选择', outbounds: tags.concat('direct') };
  const config = {
    log: { level: 'info' },
    outbounds: outbounds.concat(selector),
    route: {
      rules: [{ ip_cidr: ['8.8.8.8/32', '8.8.4.4/32'], outbound: 'direct' }],
      final: '🚀 节点选择',
    },
  };
  return { body: JSON.stringify(config, null, 2), type: 'application/json; charset=utf-8' };
}

function singboxOutbound(n) {
  const tls = n.tls ? { enabled: true, server_name: n.sni, insecure: true } : undefined;
  const transport =
    (n.transport || 'tcp') === 'ws'
      ? { type: 'ws', path: n.wsPath, headers: n.wsHost ? { Host: n.wsHost } : undefined }
      : (n.transport || 'tcp') === 'grpc'
        ? { type: 'grpc' }
        : undefined;
  // sing-box 对 shadowsocks 的类型名是 shadowsocks（Clash 里才是 ss）
  const ob = { type: n.type === 'ss' ? 'shadowsocks' : n.type, tag: n.name, server: n.server, server_port: n.port };
  if (n.type === 'vless') {
    ob.uuid = n.uuid;
    if (n.reality) { ob.flow = n.flow || 'xtls-rprx-vision'; ob.tls = { enabled: true, server_name: n.sni, insecure: true, reality: { public_key: n.pbk, short_id: n.sid } }; ob.transport = transport; }
    else { ob.tls = tls; ob.transport = transport; }
  } else if (n.type === 'trojan') {
    ob.password = n.password;
    ob.tls = tls;
    ob.transport = transport;
  } else if (n.type === 'ss') {
    ob.method = n.method;
    ob.password = n.password;
    // sing-box 原生不支持 v2ray-plugin：带 plugin 的 ss 按纯 shadowsocks 输出（多数客户端可协商直连），
    // 无法协商时用户可换 clash 格式（插件参数完整保留）。
    ob.transport = transport;
  }
  return ob;
}

/** Base64：整份分享链接文本做 UTF-8 安全 base64（标准订阅格式） */
function renderBase64(nodes, rawLines) {
  return { body: b64encode(rawLines.join('\n')), type: 'text/plain; charset=utf-8' };
}

const FORMAT_RENDERERS = {
  clash: renderClash,
  singbox: renderSingbox,
  base64: renderBase64,
};

// ---------- 出口：格式检测 + 转换 ----------

/** 格式检测：只认显式 ?fmt= 参数，不做 UA 猜测（避免误伤现有 v2rayN 等客户端） */
export function detectSubscriptionFormat(url) {
  const fmt = (url.searchParams.get('fmt') || '').toLowerCase();
  if (fmt === 'clash' || fmt === 'clashyaml') return 'clash';
  if (fmt === 'singbox' || fmt === 'sing-box' || fmt === 'sing') return 'singbox';
  if (fmt === 'base64' || fmt === 'b64') return 'base64';
  return 'plain';
}

/** 转换引擎响应为指定格式；无法解析（无可用节点）或格式未知时原样返回 */
export async function convertSubscription(resp, fmt) {
  if (fmt === 'plain') return resp;
  const render = FORMAT_RENDERERS[fmt];
  if (!render) return resp;
  const text = await resp.text();
  const rawLines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const nodes = parseNodes(text);
  const out = render(nodes, rawLines);
  // 无法渲染（无可用节点）时：body 已被读走，用原文重建等价响应，避免二次消费报错
  if (!out) return new Response(text, { status: resp.status, headers: resp.headers });
  return new Response(out.body, {
    status: 200,
    headers: {
      'content-type': out.type,
      'cache-control': 'no-store',
      'content-disposition': resp.headers.get('content-disposition') || '',
    },
  });
}
