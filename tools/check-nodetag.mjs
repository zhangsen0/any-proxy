#!/usr/bin/env node
/**
 * 节点备注国家标注自检。
 *
 * 重点守住三条：
 *   1. 订阅的编码形态不能被改坏（base64 进出仍是 base64），否则部分客户端直接不认。
 *   2. GeoIP 数据源挂掉时必须原样返回原文 —— 订阅是整个服务的入口，
 *      为了加个后缀把订阅搞挂，代价完全不可接受。
 *   3. 幂等：重复处理同一份订阅不能把备注越堆越长。
 *
 * 只用 Node 内置模块，不发真实网络请求。
 *
 * 用法：
 *   node tools/check-nodetag.mjs
 */
import { bindRuntime, runtime } from '../src/runtime.js';
import {
  flagEmoji, regionName, toggle, lookupCountries, KEY_PREFIX, NEGATIVE,
} from '../src/geoip.js';
import {
  decorateLine, decorateSubscription, tagSubscriptionResponse,
  lineHost, lineRemark, decodeWhole, styleFrom, tagText, DEFAULT_STYLE,
} from '../src/nodetag.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  -> ' + extra : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? '  -> ' + extra : ''}`); }
}

// ---- 内存版 KV（与 check-disguise.mjs 同一约定）----
const mem = new Map();
const kv = {
  async get(k) { return mem.has(k) ? mem.get(k) : null; },
  async put(k, v) { mem.set(k, v); },
  async delete(k) { mem.delete(k); },
  async list(o = {}) {
    const p = (o && o.prefix) || '';
    return { keys: [...mem.keys()].filter(k => k.startsWith(p)).map(name => ({ name })), list_complete: true };
  },
};
const env = { PASSWORD: 'dev', SITES: kv };
bindRuntime(env);

// ---- 假 GeoIP 数据源：接管 globalThis.fetch ----
let geoipMode = 'ok';        // ok | throw | empty | html
let batchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  batchCalls++;
  if (geoipMode === 'throw') throw new Error('network down');
  if (geoipMode === 'html') return new Response('<html>nope</html>', { status: 200 });
  const body = JSON.parse(opts.body);
  if (geoipMode === 'empty') return Response.json([]);
  // 用一个稳定的假映射，便于断言
  const table = { '1.1.1.1': 'US', '8.8.8.8': 'JP', '9.9.9.9': 'DE' };
  return Response.json(body.map(ip => ({ ip, country: table[ip] || null })));
};

const SUB = [
  'vless://11111111-2222-4333-8444-555555555555@1.1.1.1:443?security=tls&type=ws&host=h.example&path=%2F#%E8%8A%82%E7%82%B9A',
  'vless://11111111-2222-4333-8444-555555555555@8.8.8.8:443?security=tls&type=ws#%E8%8A%82%E7%82%B9B',
  'trojan://pwd@9.9.9.9:443?sni=h.example',
  'vless://11111111-2222-4333-8444-555555555555@node.example.com:443?security=tls',
].join('\n');

function reset() {
  mem.clear();
  batchCalls = 0;
  geoipMode = 'ok';
}

console.log('\n=== 1. 零数据表的国家名与国旗 ===');
ok('ISO 码算出国旗', flagEmoji('US') === '\u{1F1FA}\u{1F1F8}', JSON.stringify(flagEmoji('US')));
ok('中国国旗', flagEmoji('CN') === '\u{1F1E8}\u{1F1F3}');
ok('非法码返回空', flagEmoji('') === '' && flagEmoji('USA') === '');
ok('中文国家名可用', regionName('US') === '美国', regionName('US'));
ok('未知码不崩溃且有回包', regionName('ZZ').length > 0, regionName('ZZ'));
ok('开关默认开启', toggle(undefined, true) === true);
ok('显式关闭生效', toggle('off', true) === false && toggle('0', true) === false);
ok('未识别值走默认', toggle('maybe', true) === true);

console.log('\n=== 2. 单行标注（默认样式：中文名【代码】）===');
{
  const info = { cc: 'US', cn: '美国', flag: flagEmoji('US') };
  const line = 'vless://uuid@1.1.1.1:443?type=ws#%E8%8A%82%E7%82%B9A';
  const once = decorateLine(line, info);
  ok('备注已追加「中文名【代码】」', once.includes(encodeURIComponent('美国【US】')), decodeURIComponent(once.split('#')[1]));
  ok('完整格式为「原备注 | 美国【US】」', decodeURIComponent(once.split('#')[1]) === '节点A | 美国【US】');
  ok('幂等：二次处理不叠加', decorateLine(once, info) === once);
  ok('无备注时也能补', decodeURIComponent(decorateLine('vless://uuid@1.1.1.1:443', info).split('#')[1]) === '美国【US】');
  ok('英国例：GB', tagText({ cc: 'GB', cn: '英国' }) === '英国【GB】', tagText({ cc: 'GB', cn: '英国' }));
  ok('style=flag-name 给国旗+名字', tagText(info, 'flag-name') === '🇺🇸美国', tagText(info, 'flag-name'));
  ok('style=name 只给名字', tagText(info, 'name') === '美国');
  ok('style=code 只给代号', tagText(info, 'code') === 'US');
  ok('style=flag 只给国旗', tagText(info, 'flag') === '🇺🇸');
}

console.log('\n=== 3. 地址/备注抽取 ===');
ok('抽 IP 地址', lineHost('vless://u@1.1.1.1:443?x=1') === '1.1.1.1', lineHost('vless://u@1.1.1.1:443?x=1'));
ok('抽域名地址', lineHost('trojan://p@node.example.com:443') === 'node.example.com');
ok('抽 URI fragment 备注', lineRemark('vless://u@1.1.1.1:443#a-b') === 'a-b');
{
  const v = { v: 2, add: '1.1.1.1', port: 443, ps: 'vmess节点' };
  const b64 = Buffer.from(JSON.stringify(v)).toString('base64');
  ok('vmess 抽地址', lineHost('vmess://' + b64) === '1.1.1.1');
  ok('vmess 抽备注', lineRemark('vmess://' + b64) === 'vmess节点');
  const tagged = decorateLine('vmess://' + b64, { cc: 'JP', cn: '日本', flag: flagEmoji('JP') });
  const decoded = JSON.parse(Buffer.from(tagged.slice('vmess://'.length), 'base64').toString());
  ok('vmess 备注写回 ps', String(decoded.ps) === 'vmess节点 | 日本【JP】', decoded.ps);
}

console.log('\n=== 4. 整份订阅：编码形态保持 ===');
reset();
{
  const r = await decorateSubscription(SUB, { env });
  const lines = r.text.split('\n');
  ok('三行 IP 节点都被标注', r.tagged === 3, `tagged=${r.tagged}/${r.nodes}`);
  ok('域名节点未被标注', lines[3] === 'vless://11111111-2222-4333-8444-555555555555@node.example.com:443?security=tls');
  ok('只发一次批量请求', batchCalls === 1, 'batchCalls=' + batchCalls);
  ok('结果写入缓存', await kv.get(KEY_PREFIX + '1.1.1.1') === 'US');
  // 第二次：应完全走缓存
  const before = batchCalls;
  const r2 = await decorateSubscription(SUB, { env });
  ok('第二次零外部请求', batchCalls === before, 'batchCalls=' + batchCalls);
  ok('第二次结果一致', r2.tagged === 3 && r2.text === r.text);
}
reset();
{
  // 整份 base64 订阅：进出都应是 base64
  const encoded = Buffer.from(SUB).toString('base64');
  const r = await decorateSubscription(encoded, { env });
  ok('识别出整份 base64', decodeWhole(encoded).encoded === true);
  ok('输出仍是 base64', !r.text.includes('://'), r.text.slice(0, 24) + '…');
  const back = Buffer.from(r.text, 'base64').toString();
  ok('解码后保有节点数', back.split('\n').length === 4);
  ok('解码后备注已标注', decodeURIComponent(back.split('\n')[0].split('#')[1]).includes('美国【US】'));
}

console.log('\n=== 5. 数据源异常必须原样透传 ===');
reset();
{
  geoipMode = 'throw';
  const r = await decorateSubscription(SUB, { env });
  ok('抛错时返回原文', r.text === SUB && r.tagged === 0, 'tagged=' + r.tagged);
}
reset();
{
  geoipMode = 'html';
  const r = await decorateSubscription(SUB, { env });
  ok('返回非 JSON 时返回原文', r.text === SUB);
}
reset();
{
  geoipMode = 'empty';
  const r = await decorateSubscription(SUB, { env });
  ok('数据源空结果时返回原文', r.text === SUB);
  ok('空结果也写负缓存', await kv.get(KEY_PREFIX + '1.1.1.1') === NEGATIVE);
  const r2 = await decorateSubscription(SUB, { env });
  ok('二次幂等', r2.text === SUB);
}
reset();
{
  const r = await decorateSubscription('no protocol here', { env });
  ok('非订阅内容直接跳过', r.text === 'no protocol here' && r.skipped === 'no-node');
  const r2 = await decorateSubscription('', { env });
  ok('空文本安全返回', r2.text === '');
}

console.log('\n=== 6. 响应包装层 ===');
reset();
{
  const mkResp = (body, extra = {}) => new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...extra },
  });
  const plain = await tagSubscriptionResponse(mkResp(SUB), { env });
  const text = await plain.text();
  ok('200 文本响应被增强', text.split('\n')[0].includes(encodeURIComponent('美国【US】')));
  ok('保留了状态码', plain.status === 200);

  const notFound = await tagSubscriptionResponse(new Response('nope', { status: 404 }), { env });
  ok('非 200 不处理', notFound.status === 404 && await notFound.text() === 'nope');

  const binary = await tagSubscriptionResponse(
    new Response(SUB, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }), { env });
  ok('非文本类型不处理', await binary.text() === SUB);

  const gz = await tagSubscriptionResponse(mkResp(SUB, { 'content-encoding': 'gzip', 'content-length': '999' }), { env });
  ok('清掉压缩头与旧长度', !gz.headers.get('content-encoding') && !gz.headers.get('content-length'));

  // 关掉数据源，并清掉缓存 —— 不清缓存的话会直接命中上一轮的查询结果，
  // 测到的就变成「缓存命中」而不是「拿不到国家」，等于没测到降级这条路径。
  geoipMode = 'throw';
  mem.clear();
  const degraded = await tagSubscriptionResponse(mkResp(SUB), { env });
  const dt = await degraded.text();
  ok('增强失败仍返回可读取的原文', dt === SUB, 'len=' + dt.length);
}
{
  ok('style 默认 cn-code', styleFrom({}) === 'cn-code' && DEFAULT_STYLE === 'cn-code');
  ok('style 可读取环境变量', styleFrom({ NODE_COUNTRY_STYLE: 'name' }) === 'name');
}

console.log('\n=== 7. 管理页渲染：配置卡片与绑定逻辑必须在同一页 ===');
{
  // 真人踩过的坑：把 JS 注入到模板时，锚点命中了「临时订阅页」的 script，
  // 结果主页只有 HTML 元素、没有任何点击处理，开关点了完全没反应。
  // 这里连同绑定的 JS 一起校验，而不是只查元素是否存在。
  const { adminPage } = await import('../src/admin.js');
  const resp = await adminPage(true, 'https://proxy.example.com', env);
  const html = await resp.text();
  ok('管理页渲染正常', html.length > 10000, 'bytes=' + html.length);
  for (const el of ['paneTabs', 'ntEnabled', 'ntStyle', 'ntSaveBtn', 'paneTabs']) {
    ok('含配置元素 ' + el, html.includes(el));
  }
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const js = blocks.join('\n');
  ok('主页脚本含分区切换逻辑', js.includes('switchPane') && js.includes('paneTabs'));
  ok('主页脚本含标注保存逻辑', js.includes('/__api/node-tag'));
  const panes = [...html.matchAll(/data-pane="([a-z]+)"/g)].map(m => m[1]);
  const tally = panes.reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {});
  ok('四个分区都有归属卡片', Object.keys(tally).length === 4, JSON.stringify(tally));
  ok('每屏都有卡片（无空标签）', Object.values(tally).every(n => n >= 1));
}

globalThis.fetch = realFetch;

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
console.log(`节点国家标注：${pass + fail} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：' + failures.join('、')); process.exit(1); }
