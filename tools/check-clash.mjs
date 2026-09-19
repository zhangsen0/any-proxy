#!/usr/bin/env node
/**
 * 本地原生订阅渲染自检：src/native-sub.js 的解析与渲染。
 *
 * 防的是什么（2026-09-20 真实事故）：clash/sing-box 输出原本依赖外部订阅转换后端，
 * 后端坏掉时 Stash 这类客户端拿到的是伪装页 HTML，报
 * 「yaml: line 2: found character that cannot start any token」。
 * 现在由业务层本地渲染 —— 这一层必须保证：
 *
 *   1. 产出的**是**合法 YAML / 合法 JSON（用真解析器验，不用眼睛）；
 *   2. 项目实际生成的那几种链接形态（vless ws+tls 为主）能被完整解析；
 *   3. 解析不了的行被跳过并计数，而不是塞进产物里写坏整份配置；
 *   4. 中文/emoji 备注不把 YAML 写坏；
 *   5. 重名节点去重 —— proxy-group 按名字引用，重名会让引用指向谁不可预期。
 *
 * YAML 合法性用 python3 + pyyaml 验（CI 的 ubuntu-latest 自带；本机也装了）。
 * 用法：node tools/check-clash.mjs
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { parseShareLink, renderClashYaml, renderSingboxJson } = await import(join(ROOT, 'src/native-sub.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  -> ' + extra : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? '  -> ' + extra : ''}`); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/** 真解析器：YAML 交给 python yaml.safe_load，JSON 交给 JSON.parse。
 *  「渲染器自己觉得对」不算数 —— 客户端拿真解析器吃它。 */
function yamlParse(text) {
  const dir = mkdtempSync(join(tmpdir(), 'ap-clash-'));
  const f = join(dir, 'c.yaml');
  writeFileSync(f, text);
  const r = spawnSync('python3', ['-c', 'import sys,yaml;json=yaml.safe_load(open(sys.argv[1],encoding="utf-8"));print(__import__("json").dumps(json,ensure_ascii=False))', f], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) return { err: ((r.stderr || '') + (r.stdout || '')).trim().split('\n').pop() };
  try { return { v: JSON.parse(r.stdout) }; } catch (e) { return { err: '解析器输出不是 JSON: ' + e.message }; }
}

// 项目实际会生成的形态（vendor/vless.js 第 495 行）：uuid 是占位符（会被引擎替换成真值），
// host/sni 是 example.com 占位，path 带 /video 前缀，备注带 emoji 与中文。
const REAL_VLESS_WS = 'vless://00000000-0000-4000-8000-000000000000@104.26.1.250:443?security=tls&type=ws&host=proxy.example.com&fp=chrome&sni=proxy.example.com&path=%2Fvideo%2Fabc%3Fed%3D2560&encryption=none&alpn=h2%2Chttp%2F1.1#%F0%9F%8C%8F%20%E4%B8%AD%E6%96%87%E8%8A%82%E7%82%B9%201';
// 备注里带「: 」（冒号＋空格）：YAML 裸标量在这种值上会直接把文件写坏，
// 必须靠渲染器的引号策略兜住 —— 牙齿验证靠它抓住「不引号」的退化。
const REAL_VLESS_TCP = 'vless://00000000-0000-4000-8000-000000000000@1.2.3.4:2053?security=tls&type=tcp&fp=chrome&sni=proxy.example.com#TCP%3A%20%E8%8A%82%E7%82%B9';
const VLESS_GRPC = 'vless://00000000-0000-4000-8000-000000000000@1.2.3.4:443?security=tls&type=grpc&serviceName=grpcsvc&sni=proxy.example.com#GRPC';
const VLESS_REALITY = 'vless://00000000-0000-4000-8000-000000000000@5.6.7.8:443?security=reality&type=tcp&fp=chrome&sni=www.apple.com&pbk=PUBKEY123&sid=ab12&flow=xtls-rprx-vision#Reality';
const TROJAN_WS = 'trojan://pass%40word@6.6.6.6:443?security=tls&type=ws&host=t.example.com&sni=t.example.com&path=%2Ft#%E6%9C%A8%E9%A9%AC';
const SS_PLAIN = 'ss://' + Buffer.from('aes-128-gcm:secretpw').toString('base64') + '@7.7.7.7:8388#SS%E8%8A%82%E7%82%B9';
const SS_PLUGIN = 'ss://' + Buffer.from('aes-128-gcm:pw2').toString('base64') + '@8.8.8.8:8388?plugin=v2ray-plugin%3Bmode%3Dwebsocket#%E5%B8%A6%E6%8F%92%E4%BB%B6';
const GARBAGE = 'http://not-a-share-link.com/x';
const GARBAGE2 = 'vless://no-port-here';

// ===================== 1. 单行解析 =====================
section('1. 分享链接行解析');
{
  const a = parseShareLink(REAL_VLESS_WS);
  ok('vless ws+tls：地址端口正确', a && a.server === '104.26.1.250' && a.port === 443, a && `${a.server}:${a.port}`);
  ok('vless ws+tls：uuid 带出', a && a.uuid === '00000000-0000-4000-8000-000000000000');
  ok('vless ws+tls：tls 开、servername 取 sni', a && a.tls === true && a.servername === 'proxy.example.com');
  ok('vless ws+tls：ws 的 path 与 Host 头都带出', a && a['ws-opts'] && a['ws-opts'].path === '/video/abc?ed=2560' && a['ws-opts'].headers.Host === 'proxy.example.com',
    a && a['ws-opts'] ? `path=${a['ws-opts'].path}` : '无 ws-opts');
  ok('vless ws+tls：中文 emoji 备注保留', a && a.name.includes('中文节点 1'));
  ok('vless 备注里的冒号空格被原样解出（不是 YAML 关键字）', parseShareLink(REAL_VLESS_TCP)?.name === 'TCP: 节点',
    parseShareLink(REAL_VLESS_TCP)?.name);

  const b = parseShareLink(VLESS_GRPC);
  ok('vless grpc：network 与 serviceName', b && b.network === 'grpc' && b['grpc-opts']['grpc-service-name'] === 'grpcsvc');

  const c = parseShareLink(VLESS_REALITY);
  ok('vless reality：reality-opts 带出 pbk/sid 与 flow', c && c['reality-opts'] && c['reality-opts']['public-key'] === 'PUBKEY123' && c.flow === 'xtls-rprx-vision');

  const d = parseShareLink(TROJAN_WS);
  ok('trojan ws：password 解出且 host 头正确', d && d.type === 'trojan' && d.password === 'pass@word' && d['ws-opts'].headers.Host === 't.example.com',
    d && `pw=${d.password}`);

  const e = parseShareLink(SS_PLAIN);
  ok('ss（无插件）：cipher/password 解出', e && e.type === 'ss' && e.cipher === 'aes-128-gcm' && e.password === 'secretpw');

  ok('ss（带 plugin）：跳过不渲染', parseShareLink(SS_PLUGIN) === null);
  ok('http 链接：跳过', parseShareLink(GARBAGE) === null);
  ok('缺端口的 vless：跳过', parseShareLink(GARBAGE2) === null);
  ok('空行：跳过', parseShareLink('') === null);
}

// ===================== 2. 真渲染 + 真解析器 =====================
section('2. clash YAML 用真解析器验');
{
  const lines = [REAL_VLESS_WS, REAL_VLESS_TCP, VLESS_GRPC, VLESS_REALITY, TROJAN_WS, SS_PLAIN, SS_PLUGIN, GARBAGE, GARBAGE2, ''];
  const r = renderClashYaml(lines);
  ok('产出非空', !!r.yaml);
  // 空行在计数前就被滤掉（不算行）；9 行有效输入里 6 行可解析、3 行跳过
  ok('计数：6 行可解析、3 行跳过', r.total === 9 && r.used === 6 && r.skipped === 3, `total=${r.total} used=${r.used} skipped=${r.skipped}`);

  const p = yamlParse(r.yaml);
  ok('python yaml.safe_load 能吃（不是渲染器自说自话）', !p.err, p.err || '');
  if (p.v) {
    const proxies = p.v.proxies || [];
    ok('proxies 数量 = 6', proxies.length === 6, String(proxies.length));
    const ws = proxies.find(x => x.name && x.name.includes('中文节点 1'));
    ok('中文 emoji 名原样保留', !!ws);
    ok('ws 节点：path/Host/servername 三件套', ws && ws['ws-opts'] && ws['ws-opts'].path === '/video/abc?ed=2560'
      && ws['ws-opts'].headers.Host === 'proxy.example.com' && ws.servername === 'proxy.example.com');
    ok('规则段存在且以 MATCH 结尾', Array.isArray(p.v.rules) && p.v.rules[p.v.rules.length - 1] === 'MATCH,PROXY');
    ok('proxy-groups 引用的名字都真实存在（含去重后缀）', (() => {
      const names = new Set(proxies.map(x => x.name));
      for (const g of (p.v['proxy-groups'] || [])) {
        for (const ref of (g.proxies || [])) if (!names.has(ref) && !['自动选择'].includes(ref)) return false;
      }
      return true;
    })());
  }

  // 重名：两条同名链接 → 第二条加后缀，组里引用必须跟得上
  const dup = renderClashYaml([REAL_VLESS_TCP, REAL_VLESS_TCP]);
  const pd = yamlParse(dup.yaml);
  if (pd.v) {
    const names = (pd.v.proxies || []).map(x => x.name);
    ok('重名节点自动加后缀且组引用一致', names.length === 2 && names[0] !== names[1] && JSON.stringify(names) === JSON.stringify([...new Set(names)]), names.join(' / '));
  } else ok('重名节点自动加后缀且组引用一致', false, pd.err);

  // 垃圾输入：一行都解析不出来 → 产出空，由 router 层回 503（绝不能回一份坏 YAML）
  const empty = renderClashYaml([GARBAGE, GARBAGE2]);
  ok('一行都解析不出：产出为空（上层据此回 503）', empty.yaml === '' && empty.skipped === 2);
}

// ===================== 3. sing-box =====================
section('3. sing-box JSON');
{
  const r = renderSingboxJson([REAL_VLESS_WS, TROJAN_WS, SS_PLUGIN, GARBAGE]);
  ok('产出非空', !!r.json);
  let j = null;
  try { j = JSON.parse(r.json); } catch (e) { }
  ok('JSON.parse 能吃', !!j);
  if (j) {
    const vs = j.outbounds.filter(o => o.type === 'vless');
    ok('vless outbound：server/uuid/tls 三件套', vs.length === 1 && vs[0].server === '104.26.1.250' && vs[0].tls.server_name === 'proxy.example.com');
    const tr = j.outbounds.find(o => o.type === 'vless');
    ok('ws transport：path 与 Host 头', tr && tr.transport && tr.transport.type === 'ws' && tr.transport.path === '/video/abc?ed=2560');
    ok('ss 带 plugin 的被跳过', !j.outbounds.some(o => o.tag && o.tag.includes('带插件')));
    ok('selector 在第一位且引用真实存在', j.outbounds[0].type === 'selector'
      && j.outbounds[0].outbounds.every(t => t === 'direct' || j.outbounds.some(o => o.tag === t)));
    ok('route.final 指向 selector', j.route && j.route.final === 'PROXY');
  }
}

// ===================== 4. /tsub 与 /sub 走同一条渲染 =====================
//
// 2026-09-20 的第二次故障：主订阅（/sub）改成本机渲染之后，临时订阅（/tsub/<id>）
// 仍然把 clash / sing-box 交给外部订阅转换后端 —— 同一处单点故障，换了条路进来。
// 判据不看源码里有没有那行调用，看运行时行为：引擎在本机（Node）必然因为 MD5 不可用
// 抛错，只有 nativeSubResponse 会把异常兜成一条说人话的 503；
// 走老路径的话异常会一路抛到调用方。所以「没抛 + 拿到 503」就是走了本机渲染的证据。
{
  const { bindRuntime, runtime } = await import(join(ROOT, 'src/runtime.js'));
  const { handleRequest } = await import(join(ROOT, 'src/router.js'));
  const { resetState } = await import(join(ROOT, 'src/memstore.js'));
  const { invalidateDoc } = await import(join(ROOT, 'src/config.js'));
  const { invalidateSite } = await import(join(ROOT, 'src/sites.js'));
  const { invalidateSettings } = await import(join(ROOT, 'src/settings.js'));
  const ORIGIN = 'https://proxy.example.com';
  const PASSWORD = 'dev';
  const UUID = 'b1e6cc7c-9f8f-4f2c-9d2a-3b6f3f34d4b1';

  const boot = () => {
    resetState(null, null);
    invalidateDoc(); invalidateSite(); invalidateSettings();
    const env = { PASSWORD, UUID };
    bindRuntime(env);
    return env;
  };

  // 4.1 临时订阅：带 Stash UA 的 clash 输出必须落在本机渲染上
  {
    const env = boot();
    await runtime.KV.put('tempsub:t000000001', JSON.stringify({
      id: 't000000001', name: '测试', uuid: 'c0ffee00-0000-4000-8000-000000000001',
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(),
      disabled: false,
    }));
    let res = null, thrown = null;
    try {
      res = await handleRequest(new Request(ORIGIN + '/tsub/t000000001', {
        headers: { 'User-Agent': 'Stash/2.0 (iPhone; iOS 17.0)' },
      }), env, {});
    } catch (e) { thrown = e; }
    ok('临时订阅不把异常往外抛（证明进了本机渲染那条路）', !thrown, thrown && thrown.message);
    const body = res ? await res.text() : '';
    ok('临时订阅的 clash 输出由本机渲染接管（不是外部转换后端的产物）',
      !!res && res.status === 503 && /订阅本机渲染出错|节点身份/.test(body),
      `HTTP ${res && res.status} ${body.slice(0, 60)}`);
    ok('给客户端的是纯文本，不是伪装页 HTML',
      !!res && (res.headers.get('content-type') || '').includes('text/plain')
      && !body.trim().startsWith('<'), (res && res.headers.get('content-type')) || '');
  }

  // 4.2 主订阅同一条路：两边判据一致，以后改一头漏一头会被这里逮住
  {
    const env = boot();
    const res = await handleRequest(new Request(ORIGIN + '/sub?token=x', {
      headers: { 'User-Agent': 'Stash/2.0 (iPhone; iOS 17.0)' },
    }), env, {});
    const body = await res.text();
    ok('主订阅同样由本机渲染接管', res.status === 503 && /订阅本机渲染出错|节点身份/.test(body),
      `HTTP ${res.status} ${body.slice(0, 60)}`);
  }

  // 4.3 记录读不到时要响：响应仍是光秃秃的 404，但日志里说清是哪一种
  {
    const env = boot();
    const errs = [];
    const realErr = console.error;
    console.error = (...a) => { errs.push(a.join(' ')); };
    let res = null;
    try {
      res = await handleRequest(new Request(ORIGIN + '/tsub/t999999999', {
        headers: { 'User-Agent': 'Stash/2.0 (iPhone; iOS 17.0)' },
      }), env, {});
    } finally { console.error = realErr; }
    ok('记录不存在时响应是不解释原因的 404', res && res.status === 404 && (await res.text()) === 'Not Found');
    ok('但病因进了日志（内存模式下「读不到记录」和「链接写错」长得一模一样）',
      errs.some(l => l.includes('[tsub]') && l.includes('读不到该记录')),
      errs.filter(l => l.includes('[tsub]')).join(' | ').slice(0, 90));
  }
}

// ===================== 5. 汇总 =====================
console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
console.log(`本地订阅渲染：${pass + fail} 项，失败 ${fail} 项（含 /tsub 与 /sub 同路的运行时判据）`);
process.exit(fail ? 1 : 0);
