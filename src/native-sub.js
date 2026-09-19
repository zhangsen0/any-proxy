// 订阅的本地原生渲染：clash YAML / sing-box JSON 的最后一米，不再依赖外部转换后端。
//
// 为什么要有这个文件（2026-09-20 的事故，详见 docs/07-踩坑记录.md）：
// 引擎（vendor/vless.js）的 clash / sing-box 输出走「外部订阅转换后端」
// （config_JSON.订阅转换配置.SUBAPI）。默认值是个占位假域名，面板没有改它的入口；
// 那台后端坏掉之后，同一个订阅链接对 Stash 这类只吃 YAML 的客户端吐回来的是
// 伪装页 HTML 或 400 —— 客户端把它当 YAML 解析，报
// 「yaml: line 2: found character that cannot start any token」。
// 而引擎的 mixed 输出（vless:// 行列表）是本地生成的，一直可靠。
//
// 所以本文件职责很窄：解析分享链接行（vless:// / trojan:// / ss://），
// 渲染成 clash YAML / sing-box JSON。刻意不碰 vendor（上游升级会冲突）；
// ACL4SSR 那类远程规则模板也不在这里接 —— 转换后端恢复可用时再谈。
//
// 解析不了的行**跳过并计数**，绝不硬塞：宁可少一个节点，也不能产出一份坏 YAML
// 把整个订阅拖垮（这和 check-storage「失败要响」是同一条哲学）。

/** YAML 字符串值统一走 JSON 引号：YAML 的双引号标量与 JSON 转义规则兼容，
 *  节点备注里的冒号、#、emoji、中文都不会把文件写坏。 */
const yq = v => JSON.stringify(String(v));

function yNode(node) {
  const L = [];
  L.push(`  - name: ${yq(node.name)}`);
  L.push(`    type: ${node.type}`);
  L.push(`    server: ${yq(node.server)}`);
  L.push(`    port: ${node.port}`);
  if (node.uuid) L.push(`    uuid: ${yq(node.uuid)}`);
  if (node.password) L.push(`    password: ${yq(node.password)}`);
  if (node.tls) L.push('    tls: true');
  if (node.servername) L.push(`    servername: ${yq(node.servername)}`);
  if (node['client-fingerprint']) L.push(`    client-fingerprint: ${yq(node['client-fingerprint'])}`);
  if (node.flow) L.push(`    flow: ${yq(node.flow)}`);
  if (node.network && node.network !== 'tcp') L.push(`    network: ${node.network}`);
  if (node['skip-cert-verify']) L.push('    skip-cert-verify: true');
  if (node['ws-opts']) {
    L.push('    ws-opts:');
    L.push(`      path: ${yq(node['ws-opts'].path || '/')}`);
    if (node['ws-opts'].headers) {
      L.push('      headers:');
      for (const [k, v] of Object.entries(node['ws-opts'].headers)) L.push(`        ${k}: ${yq(v)}`);
    }
  }
  if (node['grpc-opts']) {
    L.push('    grpc-opts:');
    L.push(`      grpc-service-name: ${yq(node['grpc-opts']['grpc-service-name'] || '')}`);
  }
  if (node['reality-opts']) {
    L.push('    reality-opts:');
    if (node['reality-opts']['public-key']) L.push(`      public-key: ${yq(node['reality-opts']['public-key'])}`);
    if (node['reality-opts']['short-id']) L.push(`      short-id: ${yq(node['reality-opts']['short-id'])}`);
  }
  return L.join('\n');
}

/** 解析一行分享链接。解析不了返回 null（由调用方跳过计数）。 */
export function parseShareLink(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  const proto = (u.protocol || '').replace(':', '').toLowerCase();
  const host = u.hostname;
  const port = u.port ? Number(u.port) : 0;
  if (!host || !port || !Number.isFinite(port)) return null;
  const name = decodeURIComponent((u.hash || '').replace(/^#/, '')) || `${host}:${port}`;
  const p = u.searchParams;

  if (proto === 'vless') {
    const uuid = decodeURIComponent(u.username || '');
    if (!uuid) return null;
    const security = (p.get('security') || '').toLowerCase();
    const net = (p.get('type') || 'tcp').toLowerCase();
    const isTLS = security === 'tls' || security === 'reality';
    const node = {
      name, type: 'vless', server: host, port,
      uuid,
      tls: isTLS || undefined,
      servername: (p.get('sni') || p.get('host') || (isTLS ? host : '')) || undefined,
      'client-fingerprint': (p.get('fp') || (isTLS ? 'chrome' : '')) || undefined,
      flow: p.get('flow') || undefined,
      network: net,
    };
    if (security === 'reality') {
      node['reality-opts'] = { 'public-key': p.get('pbk') || '', 'short-id': p.get('sid') || '' };
    }
    if (net === 'ws') {
      node['ws-opts'] = { path: p.get('path') || '/', headers: { Host: p.get('host') || host } };
    } else if (net === 'grpc') {
      node['grpc-opts'] = { 'grpc-service-name': p.get('serviceName') || p.get('path') || '' };
    }
    return node;
  }

  if (proto === 'trojan') {
    const password = decodeURIComponent(u.username || '');
    if (!password) return null;
    const net = (p.get('type') || 'tcp').toLowerCase();
    const node = {
      name, type: 'trojan', server: host, port,
      password,
      servername: (p.get('sni') || p.get('peer') || host) || undefined,
      'skip-cert-verify': p.get('allowInsecure') === '1' || undefined,
      network: net,
    };
    if (net === 'ws') node['ws-opts'] = { path: p.get('path') || '/', headers: { Host: p.get('host') || host } };
    else if (net === 'grpc') node['grpc-opts'] = { 'grpc-service-name': p.get('serviceName') || '' };
    return node;
  }

  if (proto === 'ss') {
    // 两种形态：ss://base64(method:pass@host:port)#name 与 ss://base64(method:pass)@host:port#name。
    // 带 plugin= 的一律跳过（v2ray-plugin 参数各端差异大，渲染错会连不上而不是报错）。
    if (p.get('plugin')) return null;
    let method = '', password = '';
    const userinfo = decodeURIComponent(u.username || '');
    if (userinfo.includes(':')) {
      [method, password] = userinfo.split(/:(.*)$/);
    } else {
      try {
        const dec = decodeURIComponent(atobSafe(userinfo) || '');
        // base64 主体有两种形态：'method:pass' 与 'method:pass@host:port'。
        // 后者的 host 部分以 URL 里 @ 之后的为准，这里把它裁掉；前者本来就没有 @。
        const cut = dec.includes('@') ? dec.slice(0, dec.lastIndexOf('@')) : dec;
        if (cut.includes(':')) [method, password] = cut.split(/:(.*)$/);
      } catch { return null; }
    }
    if (!method || !password) return null;
    return { name, type: 'ss', server: host, port, cipher: method, password };
  }

  return null;
}

function atobSafe(s) {
  try { return atob(s.replace(/-/g, '+').replace(/_/g, '/')); } catch { return ''; }
}

/** 名字去重：YAML 的 proxy-group 按名字引用，重名会让引用指向谁变得不可预期 */
function dedupeNames(nodes) {
  const seen = new Map();
  for (const n of nodes) {
    const c = seen.get(n.name) || 0;
    seen.set(n.name, c + 1);
    if (c > 0) n.name = `${n.name} #${c + 1}`;
  }
  return nodes;
}

const CLASH_HEAD = [
  '# 本订阅由服务端本地渲染（不依赖外部转换后端）。改节点请进管理面板，勿手改此文件。',
  'mixed-port: 7890',
  'allow-lan: false',
  'mode: rule',
  'log-level: info',
  'unified-delay: true',
  'tcp-concurrent: true',
].join('\n');

const CLASH_RULES = [
  'rules:',
  '  - DOMAIN-SUFFIX,local,DIRECT',
  '  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
  '  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
  '  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
  '  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
  '  - GEOIP,CN,DIRECT',
  '  - MATCH,PROXY',
].join('\n');

/**
 * 把分享链接行渲染成 clash（mihomo 内核）可用的完整配置。
 * 返回 { yaml, total, used, skipped }：skipped>0 不算错误，但要在响应头里让人看见。
 */
export function renderClashYaml(lines) {
  const all = (Array.isArray(lines) ? lines : String(lines || '').split('\n'))
    .map(l => l.trim()).filter(Boolean);
  const parsed = all.map(parseShareLink);
  const nodes = dedupeNames(parsed.filter(Boolean));
  if (!nodes.length) {
    return { yaml: '', total: all.length, used: 0, skipped: all.length };
  }
  const names = nodes.map(n => yq(n.name));
  const proxyL = [
    'proxies:',
    ...nodes.map(yNode),
  ].join('\n');
  const groups = [
    'proxy-groups:',
    '  - name: PROXY',
    '    type: select',
    '    proxies:',
    `      - 自动选择`,
    ...names.map(n => `      - ${n}`),
    '  - name: 自动选择',
    '    type: url-test',
    '    url: http://www.gstatic.com/generate_204',
    '    interval: 300',
    '    tolerance: 50',
    '    proxies:',
    ...names.map(n => `      - ${n}`),
  ].join('\n');
  const yaml = [CLASH_HEAD, proxyL, groups, CLASH_RULES].join('\n\n') + '\n';
  return { yaml, total: all.length, used: nodes.length, skipped: all.length - nodes.length };
}

/**
 * sing-box JSON：结构与 clash 同一套节点，外壳按 sing-box 的 outbounds + route 最小集。
 * 返回 { json, total, used, skipped }。
 */
export function renderSingboxJson(lines) {
  const all = (Array.isArray(lines) ? lines : String(lines || '').split('\n'))
    .map(l => l.trim()).filter(Boolean);
  const parsed = all.map(parseShareLink);
  const nodes = dedupeNames(parsed.filter(Boolean));
  if (!nodes.length) {
    return { json: '', total: all.length, used: 0, skipped: all.length };
  }
  const outbounds = nodes.map(n => {
    if (n.type === 'vless') {
      const o = { type: 'vless', tag: n.name, server: n.server, server_port: n.port, uuid: n.uuid };
      if (n.tls) {
        o.tls = { enabled: true, server_name: n.servername || n.server };
        if (n['reality-opts']) {
          o.tls.reality = { enabled: true, public_key: n['reality-opts']['public-key'], short_id: n['reality-opts']['short-id'] || '' };
        }
        if (n['client-fingerprint']) o.tls.utls = { enabled: true, fingerprint: n['client-fingerprint'] };
      }
      if (n.flow) o.flow = n.flow;
      if (n.network === 'ws') {
        o.transport = { type: 'ws', path: (n['ws-opts'] && n['ws-opts'].path) || '/', headers: (n['ws-opts'] && n['ws-opts'].headers) || {} };
      } else if (n.network === 'grpc') {
        o.transport = { type: 'grpc', service_name: (n['grpc-opts'] && n['grpc-opts']['grpc-service-name']) || '' };
      }
      return o;
    }
    if (n.type === 'trojan') {
      const o = { type: 'trojan', tag: n.name, server: n.server, server_port: n.port, password: n.password };
      o.tls = { enabled: true, server_name: n.servername || n.server, insecure: !!n['skip-cert-verify'] };
      if (n.network === 'ws') {
        o.transport = { type: 'ws', path: (n['ws-opts'] && n['ws-opts'].path) || '/', headers: (n['ws-opts'] && n['ws-opts'].headers) || {} };
      }
      return o;
    }
    // ss
    return { type: 'ss', tag: n.name, server: n.server, server_port: n.port, method: n.cipher, password: n.password };
  });
  const tags = outbounds.map(o => o.tag);
  const conf = {
    log: { level: 'warn' },
    outbounds: [
      { type: 'selector', tag: 'PROXY', outbounds: [...tags, 'direct'], default: tags[0] || 'direct' },
      ...outbounds,
      { type: 'direct', tag: 'direct' },
    ],
    route: {
      rules: [{ ip_is_private: true, outbound: 'direct' }],
      final: 'PROXY',
    },
  };
  return { json: JSON.stringify(conf, null, 2) + '\n', total: all.length, used: nodes.length, skipped: all.length - nodes.length };
}
