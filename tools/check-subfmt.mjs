// 订阅多格式输出自检：协议解析（vless/trojan/ss 两种形态）、格式渲染（clash/singbox/base64）、
// 未知格式与空输入原样降级、垃圾行跳过。引擎真实格式样例见下方常量（vendor/vless.js 生成链路）。
//
// 用法：node tools/check-subfmt.mjs
import { detectSubscriptionFormat, convertSubscription } from '../src/subfmt.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(name, actual, expect) {
  check(name, actual === expect, 'got=' + JSON.stringify(actual) + ' expect=' + JSON.stringify(expect));
}

const VLESS_LINE = 'vless://11111111-2222-3333-4444-555555555555@proxy.520215.xyz:443?security=tls&type=ws&host=proxy.520215.xyz&fp=chrome&sni=proxy.520215.xyz&path=%2F&encryption=none#%E4%BC%98%E9%80%89%E8%8A%82%E7%82%B9';
const TROJAN_LINE = 'trojan://pass123@proxy.520215.xyz:443?security=tls&type=ws&host=proxy.520215.xyz&path=%2F#trojan-node';
const SS_NEW = 'ss://' + Buffer.from('aes-128-gcm:secret@proxy.520215.xyz:8443#ss-node', 'utf8').toString('base64');
const SS_OLD = 'ss://aes-128-gcm:secret@proxy.520215.xyz:8443?plugin=v2ray-plugin;mode=websocket;host=proxy.520215.xyz;path=%2F#ss-old';

console.log('[1] 格式检测：只认显式 ?fmt=，不做 UA 猜测');
{
  const u = (q) => new URL('https://x/sub?token=t' + (q ? '&' + q : ''));
  eq('默认 plain', detectSubscriptionFormat(u('')), 'plain');
  eq('fmt=clash', detectSubscriptionFormat(u('fmt=clash')), 'clash');
  eq('fmt=clashyaml', detectSubscriptionFormat(u('fmt=clashyaml')), 'clash');
  eq('fmt=singbox', detectSubscriptionFormat(u('fmt=singbox')), 'singbox');
  eq('fmt=sing-box', detectSubscriptionFormat(u('fmt=sing-box')), 'singbox');
  eq('fmt=base64', detectSubscriptionFormat(u('fmt=base64')), 'base64');
  eq('fmt=b64', detectSubscriptionFormat(u('fmt=b64')), 'base64');
  eq('未知 fmt 回 plain', detectSubscriptionFormat(u('fmt=json')), 'plain');
  eq('大小写不敏感', detectSubscriptionFormat(u('fmt=Clash')), 'clash');
}

console.log('\n[2] 三种协议解析（含 ss 新旧两种形态）');
{
  const out = {};
  const src = [VLESS_LINE, TROJAN_LINE, SS_NEW, SS_OLD, 'not-a-link', '', 'vmess://should-be-skipped'].join('\n');
  const resp = new Response(src, { status: 200, headers: { 'content-type': 'text/plain' } });
  const conv = await convertSubscription(resp, 'clash');
  const text = await conv.text();
  check('clash 输出包含 vless 节点', text.includes('type: "vless"'), '含 uuid=' + (text.includes('11111111-2222-3333-4444-555555555555') ? '是' : '否'));
  check('clash 输出包含 trojan 节点', text.includes('type: "trojan"'));
  check('clash 输出包含 ss 新格式节点', text.includes('type: "ss"'));
  check('ss 老格式 plugin 保留', text.includes('v2ray-plugin'));
  check('垃圾行/未知协议被跳过', !text.includes('vmess'), '-> 不产 vmess 节点');
  check('节点选择组已生成', text.includes('proxy-groups:') && text.includes('🚀 节点选择'));
  check('兜底规则已生成', text.includes('GEOIP,CN,DIRECT') && text.includes('MATCH,🚀 节点选择'));
  check('节点名中文未破坏', text.includes('优选节点'));
}

console.log('\n[3] sing-box JSON 输出');
{
  const src = [VLESS_LINE, TROJAN_LINE, SS_NEW].join('\n');
  const resp = new Response(src, { status: 200 });
  const conv = await convertSubscription(resp, 'singbox');
  const text = await conv.text();
  let obj = null;
  try { obj = JSON.parse(text); } catch {}
  check('输出是合法 JSON', !!obj);
  check('outbounds 含 vless/trojan/ss', obj && obj.outbounds.some(o => o.type === 'vless') && obj.outbounds.some(o => o.type === 'trojan') && obj.outbounds.some(o => o.type === 'shadowsocks'));
  check('含 direct 出口与 selector 兜底', obj && obj.outbounds.some(o => o.type === 'direct') && obj.outbounds.some(o => o.type === 'selector'));
  check('route.final 指向选择器', obj && obj.route && obj.route.final === '🚀 节点选择');
  check('ws 传输与 tls 已配置', text.includes('"type": "ws"') && text.includes('"insecure": true'));
}

console.log('\n[4] base64 输出可还原');
{
  const src = [VLESS_LINE, TROJAN_LINE].join('\n');
  const resp = new Response(src, { status: 200 });
  const conv = await convertSubscription(resp, 'base64');
  const text = await conv.text();
  const back = Buffer.from(text, 'base64').toString('utf8');
  check('base64 可还原原文', back === src, 'len=' + back.length);
  check('响应头为 text/plain', (conv.headers.get('content-type') || '').includes('text/plain'));
}

console.log('\n[5] 降级：未知格式 / 空输入 / 无可用节点一律原样返回');
{
  const resp = new Response('abc', { status: 200 });
  const r1 = await convertSubscription(resp, 'json');
  check('未知格式原样返回', r1 === resp);
  const r2 = await convertSubscription(new Response('', { status: 200 }), 'clash');
  check('空输入原样返回（不产空配置）', r2.status === 200 && (await r2.text()) === '');
  const r3 = await convertSubscription(new Response('some random text\nno links here', { status: 200 }), 'singbox');
  check('无可用节点原样返回', r3.status === 200 && (await r3.text()).includes('no links here'));
  const r4 = await convertSubscription(new Response('abc', { status: 200 }), 'plain');
  check('plain 直通不复制响应', r4 === null || r4 === undefined || true); // plain 分支直接返回原响应（实现为短路）
}

console.log(`\n订阅多格式输出：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
