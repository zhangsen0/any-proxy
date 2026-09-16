#!/usr/bin/env node
/**
 * CDN 任播 IP 兜底的自检。
 *
 * 要守住的核心判断：GeoIP 查不到国家的 IP，不能顺手编一个国名糊上去。
 * CDN 任播地址在全球边缘通告同一个 IP，本来就没有单一地理归属
 * —— 实测同一个 Cloudflare IP，三个数据源分别给出「查不到 / 加拿大 / 美国」。
 * 所以这里验证的是：命中官方 IP 段就如实标成任播，标出来的东西必须经得起推敲。
 *
 * 只用 Node 内置模块，不发真实网络请求。
 *
 * 用法：
 *   node tools/check-anycast.mjs
 */
import { bindRuntime } from '../src/runtime.js';
import {
  lookupCountries, ipToInt, parseCidr, isCfIp, loadCfNets, resetCfNets,
  ANYCAST, ANYCAST_LABEL, ANYCAST_CODE, CF_NETS_KEY, KEY_PREFIX, NEGATIVE,
} from '../src/geoip.js';
import { tagText, lineRemark, decorateSubscription } from '../src/nodetag.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  -> ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  -> ' + extra : ''}`); }
}

// ---- 内存版 KV（与其它自检脚本同一约定）----
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

// Cloudflare 官方 IPv4 段（真实存在的段，这里只取两条做样本）
const CF_RANGES = '104.16.0.0/12\n172.64.0.0/13\n';
// 104.18.x / 172.66.x 落在上面两段里；188.164.248.3 不在
const CF_IP_1 = '104.18.33.145';
const CF_IP_2 = '172.66.0.7';
const OTHER_IP = '188.164.248.3';

let geoipAnswers = [];   // 主数据源愿意给出国家的 IP
let cfCalls = 0;         // 拉过几次官方段
let cfFails = false;     // 让官方段源挂掉

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('cloudflare.com/ips-v4')) {
    cfCalls++;
    if (cfFails) throw new Error('官方段源不可用');
    return new Response(CF_RANGES, { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  if (u.includes('country.is')) {
    const body = await new Response(globalThis.__LAST_BODY__).json();
    return new Response(JSON.stringify(
      body.filter(ip => geoipAnswers.includes(ip)).map(ip => ({ ip, country: 'US' })),
    ), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error('unexpected url: ' + u);
};

async function lookup(ips) {
  return lookupCountries(ips, { env });
}

console.log('\n[1] CIDR 与整数转换');
ok('ipToInt 基本正确', ipToInt('1.2.3.4') === 0x01020304, ipToInt('1.2.3.4').toString(16));
ok('ipToInt 高位不溢出符号', ipToInt('255.255.255.255') === 0xffffffff);
ok('parseCidr 解析 /12', String(parseCidr('104.16.0.0/12')) === String([0x68100000, 0x681fffff]));
ok('parseCidr 拒绝非法输入', parseCidr('not-an-ip/24') === null);
ok('parseCidr 拒绝越界掩码', parseCidr('104.16.0.0/33') === null);
ok('CF IP 命中官方段', isCfIp(CF_IP_1, parseCidr('104.16.0.0/12') ? [parseCidr('104.16.0.0/12')] : []) === true);
ok('非 CF IP 不命中', isCfIp(OTHER_IP, [parseCidr('104.16.0.0/12')]) === false);
ok('空段列表返回 false', isCfIp(CF_IP_1, []) === false);

console.log('\n[2] 官方段的加载与缓存');
{
  mem.clear(); resetCfNets(); cfCalls = 0; cfFails = false;
  const nets = await loadCfNets(env, null);
  ok('首次从网络拉取', cfCalls === 1 && nets.length === 2, `${cfCalls} 次调用, ${nets.length} 段`);
  ok('结果写入 KV', String(mem.get(CF_NETS_KEY) || '').includes('104.16.0.0/12'));
  const again = await loadCfNets(env, null);
  ok('进程内缓存：第二次不再请求', cfCalls === 1, `累计 ${cfCalls} 次`);
  ok('两次结果一致', again.length === nets.length);
}

console.log('\n[3] 官方段拉不到时静默降级（不影响订阅）');
{
  // 必须 resetCfNets：上一节已经把官方段缓存进了进程内变量
  mem.clear(); resetCfNets(); cfFails = true;
  geoipAnswers = [];
  globalThis.__LAST_BODY__ = JSON.stringify([CF_IP_1]);
  const r = await lookup([CF_IP_1]);
  ok('官方段不可用时不标注，也不抛错', r.size === 0, `size=${r.size}`);
  const line = `vless://uuid-1111@${CF_IP_1}:443?type=ws#CF优选`;
  const out = await decorateSubscription(line, { env, geoip: false });
  ok('节点原样输出', out.text.includes('CF优选') && !out.text.includes('ANYCAST'));
}

console.log('\n[4] GeoIP 优先 + CF 段兜底');
{
  mem.clear(); resetCfNets(); cfFails = false;
  // 主源只能给出 OTHER_IP，CF 的两个查不到
  geoipAnswers = [OTHER_IP];
  for (const ip of [CF_IP_1, CF_IP_2, OTHER_IP]) globalThis.__LAST_BODY__ = JSON.stringify([ip]);
  const merged = new Map();
  globalThis.__LAST_BODY__ = JSON.stringify([CF_IP_1, CF_IP_2, OTHER_IP]);
  const r = await lookup([CF_IP_1, CF_IP_2, OTHER_IP]);
  ok('主源查到的照用真实国家', r.get(OTHER_IP) && r.get(OTHER_IP).cc === 'US', JSON.stringify(r.get(OTHER_IP)));
  ok('CF 段内查不到的标为任播', r.get(CF_IP_1) && r.get(CF_IP_1).cc === ANYCAST, JSON.stringify(r.get(CF_IP_1)));
  ok('第二个 CF IP 同样处理', r.get(CF_IP_2) && r.get(CF_IP_2).anycast === true);
  ok('任播不带国旗（没有对应国旗）', (r.get(CF_IP_1).flag || '') === '');
  ok('任播结果落缓存', mem.get(KEY_PREFIX + CF_IP_1) === ANYCAST);
  merged.clear();
}

console.log('\n[5] 非 CF 段且查不到：老实留空，不编国名');
{
  mem.clear(); resetCfNets();
  geoipAnswers = [];                       // 主源什么都不知道
  globalThis.__LAST_BODY__ = JSON.stringify([OTHER_IP]);
  const r = await lookup([OTHER_IP]);
  ok('既不标注也不报任播', !r.get(OTHER_IP), JSON.stringify(r.get(OTHER_IP)));
  ok('写入负缓存避免反复白问', mem.get(KEY_PREFIX + OTHER_IP) === NEGATIVE);
}

console.log('\n[6] 二次查询零外部请求');
{
  mem.clear(); resetCfNets(); cfCalls = 0;
  geoipAnswers = [];
  globalThis.__LAST_BODY__ = JSON.stringify([CF_IP_1]);
  await lookup([CF_IP_1]);
  const after = cfCalls;
  const r = await lookup([CF_IP_1]);
  ok('第二次走缓存拿到任播结论', r.get(CF_IP_1) && r.get(CF_IP_1).cc === ANYCAST);
  ok('缓存命中不再触发新的段拉取', cfCalls === after, `${after} -> ${cfCalls}`);
}

console.log('\n[7] 备注文案');
{
  const any = { cc: ANYCAST, cn: ANYCAST_LABEL, flag: '', anycast: true };
  ok('默认样式为 中文名【代号】', tagText(any, 'cn-code') === `${ANYCAST_LABEL}【${ANYCAST_CODE}】`, tagText(any, 'cn-code'));
  ok('name 样式只给名字', tagText(any, 'name') === ANYCAST_LABEL);
  ok('code 样式给代号', tagText(any, 'code') === ANYCAST_CODE);
  ok('flag 样式没有国旗，退回代号', tagText(any, 'flag') === ANYCAST_CODE);
  ok('真实国家不受影响', tagText({ cc: 'GB', cn: '英国', flag: '🇬🇧' }, 'cn-code') === '英国【GB】');
}

console.log('\n[8] 端到端：整条订阅');
{
  mem.clear(); resetCfNets();
  geoipAnswers = [OTHER_IP];
  const line1 = `vless://uuid-1111@${CF_IP_1}:443?type=ws#CF电信优选`;
  const line2 = `vless://uuid-2222@${OTHER_IP}:443?type=ws#普通节点`;
  globalThis.__LAST_BODY__ = JSON.stringify([CF_IP_1, OTHER_IP]);
  const out = await decorateSubscription([line1, line2].join('\n'), { env });
  ok('成功处理两个节点', out.nodes === 2, `nodes=${out.nodes}`);
  ok('CF 节点标主任播', out.text.includes(encodeURIComponent(`CF电信优选 | ${ANYCAST_LABEL}【${ANYCAST_CODE}】`)));
  ok('普通节点标国家', out.text.includes(encodeURIComponent('普通节点 | 美国【US】')));
  const again = await decorateSubscription(out.text, { env });
  ok('重复处理幂等（不会越堆越长）', again.text === out.text);
  ok('幂等后任播标记仍只有一处', (again.text.match(/ANYCAST/g) || []).length === 1);
}

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
console.log(`CDN 任播兜底：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
