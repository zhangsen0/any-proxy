#!/usr/bin/env node
/**
 * 配置单一真源自检：一个设定只允许有一份定义。
 *
 * 为什么需要这一层：本项目最大的隐患不是「某个常量写死在代码里」，而是
 * **同一个设定被写了两份，两份还不一致**。已经真实发生过三例：
 *
 *   1. IPv4 校验：admin.js 用只验段数的正则（`999.999.999.999` 也放行），
 *      subs.js/dns.js 用带段值校验的实现 —— 面板提示「已保存」，池子其实被过滤成空。
 *   2. DNS 优选频率：默认 720、区间 5~1440 同时写在 admin.js（面板接口）与 dns.js（调度器），
 *      改一处就会出现「面板显示 12 小时、实际按别的间隔跑」。
 *   3. 布尔词表：config.js 认 on/off，geoip.js 还认 enable/none ——
 *      于是 `none` 在环境变量里能关掉、在面板里却被当成没配。
 *
 * 这类 bug 单测抓不到（每份实现自己都是「对」的），代码评审也容易漏，
 * 只有把「面板接口的行为」和「静态残留」一起钉住才防得住。
 *
 * 用法：node tools/check-single-source.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleRequest } from '../src/router.js';
import { bindRuntime } from '../src/runtime.js';
import { kvKey, isIpv4, isDomain, parseIpv4List, parseDomainList } from '../src/util.js';
import { toBool } from '../src/config.js';
import { DNS_INTERVAL, POOL_LIMIT, DOMAIN_POOL_LIMIT } from '../src/dns.js';
import { CANDIDATE_LIMIT } from '../src/subs.js';
import { themeFieldBounds, clampThemeField } from '../src/themes.js';
import { STATS_RANGES, DEFAULT_RANGE_DAYS } from '../src/stats.js';
import { STATS_JS } from '../src/stats-ui.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://proxy.example.com';
const PASSWORD = 'dev';
const COOKIE = 'ap_auth=' + Buffer.from(PASSWORD).toString('base64');

const mem = new Map();
const kv = {
  async list(o = {}) {
    const p = (o && o.prefix) || '';
    return { keys: [...mem.keys()].filter(k => k.startsWith(p)).map(name => ({ name })), list_complete: true };
  },
  async get(k) { return mem.has(k) ? mem.get(k) : null; },
  async put(k, v) { mem.set(k, String(v)); },
  async delete(k) { mem.delete(k); },
};
const env = { PASSWORD, SITES: kv, PROXY_HOST: new URL(ORIGIN).hostname };
bindRuntime(env);

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  -> ' + extra : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? '  -> ' + extra : ''}`); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const h = { Cookie: COOKIE, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await handleRequest(
    new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
    env, {},
  );
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, html: text };
}

// ===================== 1. 列表解析：面板与运行时同一口径 =====================
section('1. IP / 域名解析（唯一实现在 util.js）');
{
  ok('合法 IPv4 被接受', isIpv4('104.17.109.97') === true);
  // 这条是核心：旧版 admin.js 的正则只数字段数，会把它当合法值存进优选池
  ok('段值越界的"IP"被拒绝（旧版面板会放行）', isIpv4('999.999.999.999') === false, '999.999.999.999');
  ok('段数不足被拒绝', isIpv4('1.2.3') === false && isIpv4('1.2.3.4.5') === false);
  ok('空与空白被拒绝', isIpv4('') === false && isIpv4(' ') === false);

  const parsed = parseIpv4List('104.17.109.97\n104.17.109.97, 1.1.1.1; 8.8.8.8 # 备注\n999.1.1.1');
  ok('多分隔符 + 去重 + 忽略注释 + 剔除非法值',
    parsed.join(',') === '104.17.109.97,1.1.1.1,8.8.8.8', parsed.join(','));
  ok('上限参数生效', parseIpv4List(Array.from({ length: 40 }, (_, i) => `10.0.0.${i + 1}`).join('\n'), 5).length === 5);
  ok('不传上限则不截断', parseIpv4List('1.1.1.1\n8.8.8.8').length === 2);

  ok('合法域名被接受', isDomain('www.cloudflare.com') === true);
  ok('非法域名被拒绝', isDomain('不是域名') === false && isDomain('localhost') === false);
  ok('域名列表小写化 + 去重',
    parseDomainList('WWW.Cloudflare.com\nwww.cloudflare.com\ntime.cloudflare.com').join(',')
      === 'www.cloudflare.com,time.cloudflare.com');
}

// ===================== 2. 面板接口必须与运行时同口径 =====================
section('2. 面板接口的校验口径（这一节的用例在修好之前是红的）');
{
  const bad = await call('/__api/preferred-ips', { method: 'POST', body: { ips: '999.999.999.999' } });
  ok('优选池接口拒绝段值越界的 IP', bad.status === 400, `HTTP ${bad.status} ${JSON.stringify(bad.data)}`);

  const mixed = await call('/__api/preferred-ips', {
    method: 'POST',
    body: { ips: '104.17.109.97\n104.17.109.97\n1.2.3\n8.8.8.8 # 主用' },
  });
  ok('优选池接口接收合法 IP 并去重', mixed.status === 200 && mixed.data.count === 2, JSON.stringify(mixed.data));

  const stored = mem.get('PREF_IPS');
  ok('落盘的正是运行时认得的那些', stored === '104.17.109.97\n8.8.8.8', JSON.stringify(stored));

  const readBack = await call('/__api/preferred-ips');
  ok('读回与落盘一致（面板与运行时同一个池子）',
    (readBack.data.ips || []).join(',') === '104.17.109.97,8.8.8.8', JSON.stringify(readBack.data.ips));

  const badGood = await call('/__api/pool-config', { method: 'POST', body: { good_ips: '999.1.1.1' } });
  ok('健康集接口同样拒绝非法 IP', badGood.status === 400, `HTTP ${badGood.status}`);

  const badDomain = await call('/__api/pool-config', { method: 'POST', body: { pref_domains: 'not a domain' } });
  ok('候选域名池拒绝非法域名', badDomain.status === 400, `HTTP ${badDomain.status}`);

  const okDomain = await call('/__api/pool-config', { method: 'POST', body: { pref_domains: 'WWW.Cloudflare.com, speed.cloudflare.com' } });
  ok('候选域名池接收合法域名并归一化', okDomain.status === 200 && okDomain.data.pref_domains.join(',') === 'www.cloudflare.com,speed.cloudflare.com',
    JSON.stringify(okDomain.data.pref_domains));

  // 超限：面板写入的上限必须等于运行时读取的上限，否则人填多了会被静默丢掉
  const many = Array.from({ length: POOL_LIMIT + 20 }, (_, i) => `10.1.${Math.floor(i / 255)}.${i % 255}`).join('\n');
  const capped = await call('/__api/preferred-ips', { method: 'POST', body: { ips: many } });
  ok('超量写入被截到 POOL_LIMIT', capped.status === 200 && capped.data.count === POOL_LIMIT, `count=${capped.data && capped.data.count} POOL_LIMIT=${POOL_LIMIT}`);
  ok('落盘条数也是 POOL_LIMIT', (mem.get('PREF_IPS') || '').split('\n').length === POOL_LIMIT);
  const limits = await call('/__api/pool-config');
  ok('接口如实报出上限（前端/文档不用猜）',
    limits.data.limits && limits.data.limits.ips === POOL_LIMIT && limits.data.limits.domains === DOMAIN_POOL_LIMIT,
    JSON.stringify(limits.data.limits));
}

// ===================== 3. 优选频率：默认值与区间只有一处 =====================
section('3. 自动优选频率（默认值与区间由 DNS_INTERVAL 单点定义）');
{
  const fresh = await call('/__api/dns-config');
  ok('未配置时返回 DNS_INTERVAL.default', fresh.data.interval_minutes === DNS_INTERVAL.default,
    `${fresh.data.interval_minutes} vs ${DNS_INTERVAL.default}`);
  ok('接口同时报出允许区间', fresh.data.min === DNS_INTERVAL.min && fresh.data.max === DNS_INTERVAL.max,
    `${fresh.data.min}~${fresh.data.max}`);

  const low = await call('/__api/dns-config', { method: 'POST', body: { interval_minutes: DNS_INTERVAL.min - 1 } });
  const high = await call('/__api/dns-config', { method: 'POST', body: { interval_minutes: DNS_INTERVAL.max + 1 } });
  const atMin = await call('/__api/dns-config', { method: 'POST', body: { interval_minutes: DNS_INTERVAL.min } });
  const atMax = await call('/__api/dns-config', { method: 'POST', body: { interval_minutes: DNS_INTERVAL.max } });
  ok('低于下限被拒', low.status === 400, `HTTP ${low.status}`);
  ok('高于上限被拒', high.status === 400, `HTTP ${high.status}`);
  ok('边界值恰好可用（区间是闭区间）', atMin.status === 200 && atMax.status === 200, `${atMin.status}/${atMax.status}`);

  const after = await call('/__api/dns-config');
  ok('调度器读到的值就是面板存的值', after.data.interval_minutes === DNS_INTERVAL.max, String(after.data.interval_minutes));
}

// ===================== 4. 布尔词表只有一份 =====================
section('4. 布尔取值（词表只有 config.js 一份）');
{
  const cases = [
    ['none', true, false], ['disable', true, false], ['disabled', true, false],
    ['off', true, false], ['0', true, false], ['no', true, false], ['false', true, false],
    ['enabled', false, true], ['enable', false, true], ['yes', false, true], ['on', false, true],
    ['', true, true], [undefined, false, false], [true, false, true],
    ['看不懂的值', true, true],   // 认不出来就落回默认值，而不是猜
  ];
  for (const [input, dflt, want] of cases) {
    ok(`toBool(${JSON.stringify(input)}, ${dflt}) === ${want}`, toBool(input, dflt) === want, String(toBool(input, dflt)));
  }
  ok('CANDIDATE_LIMIT 是具名常量（不是散落的 40）', Number.isInteger(CANDIDATE_LIMIT) && CANDIDATE_LIMIT > 0, String(CANDIDATE_LIMIT));
}

// ===================== 5. 默认值只定义一次：面板与运行期读同一份 =====================
section('5. 默认值单一真源（主题轮换间隔 / 统计回看档位）');
{
  // ---- 主题轮换间隔：SCHEMA 是唯一真源 ----
  const rt = themeFieldBounds('rotate_interval_minutes');
  ok('轮换间隔的约束来自 SCHEMA', rt.default === 60 && rt.min === 1 && rt.max === 10080, JSON.stringify(rt));
  ok('取不到值时落回默认值', clampThemeField('rotate_interval_minutes', undefined) === rt.default);
  ok('空串与 0 与 undefined 同待遇',
    clampThemeField('rotate_interval_minutes', '') === rt.default && clampThemeField('rotate_interval_minutes', 0) === rt.default);
  ok('低于下限被夹住', clampThemeField('rotate_interval_minutes', -5) === rt.min, String(clampThemeField('rotate_interval_minutes', -5)));
  // 旧写法是 Math.max(1, ...)，只管下限；上限只在面板 HTML 里，运行期不设防
  ok('高于上限被夹住（旧写法只夹下限）', clampThemeField('rotate_interval_minutes', 999999) === rt.max, String(clampThemeField('rotate_interval_minutes', 999999)));
  ok('合法值原样通过', clampThemeField('rotate_interval_minutes', 30) === 30);

  // ---- 统计回看档位：档位表是唯一真源 ----
  ok('默认档位 = 档位表第一项', DEFAULT_RANGE_DAYS === STATS_RANGES[0], `${DEFAULT_RANGE_DAYS} / ${JSON.stringify(STATS_RANGES)}`);
  ok('档位表非空且都是正整数',
    Array.isArray(STATS_RANGES) && STATS_RANGES.length > 0 && STATS_RANGES.every(n => Number.isInteger(n) && n > 0),
    JSON.stringify(STATS_RANGES));
  ok('注入脚本带上了默认档位数据（不是自己写死）',
    new RegExp(`var STATS_DEFAULT_DAYS=${DEFAULT_RANGE_DAYS};`).test(STATS_JS),
    (STATS_JS.match(/STATS_DEFAULT_DAYS=\d+/) || ['无'])[0]);

  // ---- 面板真的把这些约束渲染出来了吗（源码改对了、页面没跟上也算错） ----
  const page = await call('/__admin');
  const inp = /<input type="number" id="rtMinutes"[^>]*>/.exec(page.html || '');
  ok('面板渲染出了轮换间隔输入框', !!inp);
  ok('输入框区间来自 SCHEMA（不是写死的 1 / 10080）',
    !!inp && inp[0].includes(`min="${rt.min}"`) && inp[0].includes(`max="${rt.max}"`),
    inp ? inp[0].replace(/\s+/g, ' ') : '找不到输入框');
  ok('输入框默认值来自 SCHEMA', !!inp && inp[0].includes(`value="${rt.default}"`));
}

// ===================== 6. 静态残留：同类字面量不许再散落 =====================
section('6. 静态扫描（去注释后按文件白名单核对）');
{
  /** 去掉块注释与行注释，只留代码，免得注释里的示例被误判 */
  function codeOnly(rel) {
    const raw = readFileSync(join(ROOT, rel), 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(l => l.split('//')[0])
      .filter(l => !/^\s*\*/.test(l))
      .join('\n');
  }

  const SRC = [
    'worker.js', 'src/admin.js', 'src/alert.js', 'src/api-catalog.js', 'src/auth.js', 'src/compress.js',
    'src/config-ui.js', 'src/config.js', 'src/disguise.js', 'src/dns.js', 'src/geoip.js', 'src/inject.js',
    'src/nodetag.js', 'src/proxy.js', 'src/ratelimit.js', 'src/router.js', 'src/runtime.js', 'src/scopes.js',
    'src/share.js', 'src/sites.js', 'src/stats-ui.js', 'src/stats.js', 'src/storage.js', 'src/subs.js',
    'src/tempsubs.js', 'src/themes.js', 'src/url.js', 'src/util.js',
  ];

  // 每条规则：{ 说明, 特征, 允许出现的文件 }
  //
  // 规则只钉「确有唯一真源」的东西，宁可少一条也不要误报 ——
  // 会误报的检查活不过两周，就会被下一个人关掉。
  // 所以刻意不写「不许出现 1440」（告警冷却的合法上限也是 1440）、
  // 也不写「不许出现 slice(0, 30)」（伪装模板的条数上限与优选池无关）。
  //
  // 兜底字面量类规则（`|| 数字`）的 allow 一律是空数组：**连真源所在的文件也不放行**。
  // 踩过的坑：候选条数那条原本写成 allow: ['src/subs.js']，于是「把 CANDIDATE_LIMIT
  // 换回裸 40」这种退化悄悄通过了 —— 因为合法的声明与违规的散落同在一个文件里，
  // 按文件放行等于没查。真源的存在性由下面「防止检查被删空」那组用例单独保证。
  const RULES = [
    // 主机形态的 IPv4 正则；CIDR（末尾跟 /24）属于另一件事，不在此列
    { name: 'IPv4 正则', re: /\^\\d\{1,3\}\(\\\.\\d\{1,3\}\)\{3\}\$/, allow: ['src/util.js'] },
    { name: '域名正则', re: /\[a-z0-9\.-\]\*/, allow: ['src/util.js'] },
    { name: '优选频率默认值 720', re: /\b720\b/, allow: ['src/dns.js'] },
    { name: '面板里写死频率下限', re: /min="5"|v < 5\b/, allow: [] },
    { name: '候选条数兜底字面量 || 40', re: /\|\|\s*40\b/, allow: [] },
    { name: '轮换间隔兜底字面量 || 60', re: /\|\|\s*60\b/, allow: [] },
    { name: '面板里写死轮换区间', re: /min="1"\s+max="10080"/, allow: [] },
    { name: '统计默认档位兜底字面量 || 7', re: /\|\|\s*7\b/, allow: [] },
    { name: '本地布尔词表', re: /ON_WORDS|OFF_WORDS/, allow: ['src/config.js'] },
  ];

  for (const rule of RULES) {
    const hits = [];
    for (const f of SRC) {
      if (rule.allow.includes(f)) continue;
      if (rule.re.test(codeOnly(f))) hits.push(f);
    }
    ok(`${rule.name} 只出现在 ${rule.allow.length ? rule.allow.join('/') : '（无）'}`, hits.length === 0, hits.join(',') || '无残留');
  }

  // 反过来也要保证：该有的那份还在（删过头会让检查变成永真）
  //
  // 这一组与上面的规则是成对的：规则说「别处不许有」，这里说「真源必须还在」。
  // 少了这一组，把真源一起删掉就能让规则永远通过。
  const MUST_EXIST = [
    ['IPv4 正则', 'src/util.js', /\(\\\.\\d\{1,3\}\)\{3\}/],
    ['优选频率默认值', 'src/dns.js', /\b720\b/],
    ['布尔词表', 'src/config.js', /ON_WORDS|OFF_WORDS/],
    ['候选条数常量', 'src/subs.js', /CANDIDATE_LIMIT\s*=\s*40\b/],
    ['轮换间隔默认值', 'src/themes.js', /rotate_interval_minutes:[\s\S]{0,120}?default:\s*60\b/],
    ['统计档位表', 'src/stats.js', /STATS_RANGES\s*=\s*\[/],
    ['统计默认档位 = 档位表首项', 'src/stats.js', /DEFAULT_RANGE_DAYS\s*=\s*STATS_RANGES\[0\]/],
  ];
  for (const [name, file, re] of MUST_EXIST) {
    ok(`${name} 在 ${file} 里确实存在（防止检查被删空）`, re.test(codeOnly(file)));
  }
}

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
console.log(`配置单一真源：${pass + fail} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：' + failures.join('、')); process.exit(1); }
