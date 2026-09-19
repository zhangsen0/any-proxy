#!/usr/bin/env node
/**
 * 种子上线前的最后一次自检：**这份具体的种子，能不能让站点真的起来**。
 *
 * 跟 check-storage 的分工：
 *   · check-storage 验「降级机制本身」——用的是写死的最小样例，回答「逻辑对不对」；
 *   · check-seed    验「手上这一份数据」——用真实导出的种子，回答「明天部署上去会不会坏」。
 *
 * 为什么要单拿出来：种子最终是要越过三道关的——
 *   JSON.stringify → GitHub Variables → wrangler.toml（TOML 基本字符串）→ Cloudflare 变量 → 再拼接
 * 每一关都有可能安静地改掉一个字节。汉字被替换成 U+FFFD、换行被还原成真的 LF、
 * 少粘一段之类的情况，**部署全部成功**，只是站点起来的样子不对。
 * 这类问题只有在「把这份种子真的灌进去、真的发一次请求」时才会露出来。
 *
 * 用法：
 *   node tools/check-seed.mjs                       # 跑内置样例（自包含，CI 每天盯着它）
 *   node tools/check-seed.mjs --file seed.json      # 验一份真实导出的种子
 *   node tools/check-seed.mjs --file seed.json --no-site-probe   # 不碰网络
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindRuntime } from '../src/runtime.js';
import { handleRequest } from '../src/router.js';
import { getStatus, stateOf, resetState } from '../src/memstore.js';
import { invalidateSite } from '../src/sites.js';
import { invalidateDoc } from '../src/config.js';
import { pickEntries, scrubSecrets, splitSeed, seedVarName } from './export-seed.mjs';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  -> ' + extra : '')); }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
}

// ===================== 参数 =====================
function parseArgs(argv) {
  const a = { file: '', siteProbe: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') a.file = argv[++i];
    else if (argv[i] === '--no-site-probe') a.siteProbe = false;
    else if (argv[i] === '--help' || argv[i] === '-h') { console.log(HELP); process.exit(0); }
    else die('未知参数：' + argv[i]);
  }
  return a;
}
function die(msg) { console.error('  ✗ ' + msg); process.exit(1); }

const HELP = `
用法：
  node tools/check-seed.mjs                          跑内置样例种子（自包含）
  node tools/check-seed.mjs --file seed.json         验一份 export-seed 导出来的种子
  node tools/check-seed.mjs --file seed.json --no-site-probe   不给每个站点发真实请求

先导出再校验，两步分开是为了中间能看一眼数据：
  node tools/export-seed.mjs --from-d1 --token T --account A --db D --out seed.json
  node tools/check-seed.mjs --file seed.json
`;

/**
 * 内置样例种子：没有 --file 时就跑它。
 * 刻意包含麻烦的东西 —— 中文、换行、斜杠、尖括号 —— 因为这些正是过三道关时容易变质的部分。
 */
const SAMPLE = JSON.stringify({
  UUID: 'b1e6cc7c-9f8f-4f2c-9d2a-3b6f3f34d4b1',
  APP_CONFIG: JSON.stringify({
    settings: { proxy_host: 'proxy.example.com', storage_fail_threshold: 3 },
    theme: { default_theme: 'graphite' },
  }),
  PREF_IPS: '104.16.0.1\n104.16.0.2\n104.16.0.3',
  DISGUISE_CONFIG: JSON.stringify({ title: '站点维护中', subtitle: '稍后恢复<script>alert(1)</script>', path: '/site-status' }),
  // 字段要跟真实站点齐（scheme / host / proxyMode）：代理引擎靠它们拼目标地址，
  // 早期这里只有 target，整条代理路径走不下去、直接返回空 204，
  // 而「站点能用」那条断言看的是状态码不是 500/404 —— 一直在验一个空响应还全绿
  'site:demo': JSON.stringify({
    id: 'demo', slug: 'demo', name: '演示站点',
    scheme: 'https', host: 'example.com', port: null,
    target: 'https://example.com', proxyMode: 'proxy',
  }),
});

// ===================== 加载 =====================
const argv = parseArgs(process.argv.slice(2));
const text = argv.file ? readFileSync(argv.file, 'utf8') : SAMPLE;
const label = argv.file ? argv.file : '内置样例';

console.log(`\n种子自检：${label}（${Buffer.byteLength(text, 'utf8')} 字节）`);

// ===================== 1. 形态 =====================
console.log('\n[1] 种子本身的形态：要能平铺、能吃三道转运');
let obj = null;
let parseErr = '';
try { obj = JSON.parse(text); } catch (e) { obj = null; parseErr = e.message; }
check('是合法 JSON', obj !== null, parseErr);
if (obj === null) { console.log('\n=== 种子不是合法 JSON，后面没法验 ==='); process.exit(1); }

const keys = Object.keys(obj);
check('是平铺的键值对象（不是数组 / 嵌套）', obj && !Array.isArray(obj) && typeof obj === 'object', `顶层类型 ${Array.isArray(obj) ? 'array' : typeof obj}`);
check('至少有一个键', keys.length > 0, `${keys.length} 个`);
check('值一律是字符串（memstore 只接受 string）', keys.every((k) => typeof obj[k] === 'string'),
  keys.filter((k) => typeof obj[k] !== 'string').slice(0, 3).join(',') || '全部是字符串');
check('键名不含空白（拼进 TOML 表名会出问题）', keys.every((k) => !/\s/.test(k)),
  keys.filter((k) => /\s/.test(k)).slice(0, 3).join(',') || '没问题');
// 注意查的是**文本层**而不是解析后的值：PREF_IPS 这种内容本来就该带真换行，
// JSON.parse 之后当然是 LF。真正要保证的是「运输态」里没有裸控制字符 ——
// JSON.stringify 会把它们转成 \n 这类的转义文本，少了这一步就说明种子不是它产出来的
const ctrl = text.match(/[\u0000-\u001f]/g);
check('种子文本里没有裸控制字符（TOML 基本字符串容不下）', !ctrl, ctrl ? ctrl.length + ' 处' : '没问题');
check('没有乱码替换符 U+FFFD（多字节字符被切过的特征）', !/\uFFFD/.test(text),
  (text.match(/\uFFFD/g) || []).length + ' 处');

// ===================== 2. 真正的 TOML 往返 =====================
console.log('\n[2] 过一遍 wrangler.toml：每一段都被原样搬运了吗');
{
  // 照**真实链路**验，不按想象验：
  //   种子切成 N 段 → 每段各自成一个环境变量的值 → prepare-deploy 写进 [vars]
  //   → wrangler 上传 → CF 把它交给 Worker → memstore 再拼回来
  // 容易把劲使错地方：去盯「键名里的冒号和点」是没用的 —— TOML 的键永远只是
  // SEED_JSON / SEED_JSON_01 这种，种子内容整体躺在值里面，不参与 TOML 结构。
  // 真会变质的恰恰是**值**：转义、分段边界、\uXXXX 还原，全发生在值上。
  //
  // 这一组也不自己实现转义规则（自己写就是给自己打分）——真调一次 python3 的 tomllib，
  // 因为部署链路用的就是它。
  const dir = mkdtempSync(join(tmpdir(), 'seed-toml-'));
  const py = join(dir, 'rt.py');
  const toml = join(dir, 'wrangler.toml');
  const partsFile = join(dir, 'parts.json');
  const { parts } = splitSeed(text, 4096);
  writeFileSync(partsFile, JSON.stringify(parts), 'utf8');
  writeFileSync(py, [
    'import json, sys, tomllib',
    "parts = json.load(open(sys.argv[1], encoding='utf-8'))",
    "names = ['SEED_JSON'] + ['SEED_JSON_%02d' % i for i in range(1, len(parts))]",
    "lines = ['[vars]'] + ['%s = %s' % (json.dumps(n), json.dumps(p)) for n, p in zip(names, parts)]",
    "open(sys.argv[2], 'w', encoding='utf-8').write('\\n'.join(lines) + '\\n')",
    "back = tomllib.load(open(sys.argv[2], 'rb'))['vars']",
    'ok = len(back) == len(parts) and all(isinstance(back.get(n), str) for n in names)',
    "ok = ok and ''.join(back[n] for n in names) == ''.join(parts)",
    "print('1' if ok else '0')",
  ].join('\n'));

  let roundtrip = 'skip';
  try {
    roundtrip = execFileSync('python3', [py, partsFile, toml], { encoding: 'utf8' }).trim();
  } catch (err) {
    console.log('     （TOM 往返没跑起来：' + String(err.message).split('\n')[0].slice(0, 120) + '）');
  }
  check('每一段写进 wrangler.toml 再读回来都逐字节相同', roundtrip === '1',
    roundtrip === 'skip' ? '没跑成，不能算通过' : ``);
  check('这份种子确实带了中文（否则上面那条是在验空气）', /[\u4e00-\u9fa5]/.test(text),
    /[\u4e00-\u9fa5]/.test(text) ? '有中文' : '没有中文，这条往返检查等于没验');
}

// ===================== 3. 灌进内存模式 =====================
console.log('\n[3] 灌进内存模式：真把一个存储绑定都不给');
const ORIGIN = 'https://proxy.example.com';
const PASSWORD = 'dev';
const COOKIE = 'ap_auth=' + Buffer.from(PASSWORD).toString('base64');
const UUID = 'b1e6cc7c-9f8f-4f2c-9d2a-3b6f3f34d4b1';

function bootWith(partsGetter) {
  resetState(null, null);
  const env = { PASSWORD, UUID, STORAGE_BACKEND: 'memory' };
  const parts = partsGetter();
  parts.forEach((v, i) => { env[seedVarName(i)] = v; });
  bindRuntime(env);
  return { env, parts };
}

async function runOnce(getter, tag) {
  const { env, parts } = bootWith(getter);
  const H = { cookie: COOKIE };
  const home = await handleRequest(new Request(ORIGIN + '/__admin', { headers: H }), env, {});
  const html = await home.text();
  check(`${tag} 管理页打得开`, home.status === 200, String(home.status));
  check(`${tag} 状态条渲染出来了且写明内存模式`, html.includes('membar') && /内存模式/.test(html));

  const api = await handleRequest(new Request(ORIGIN + '/__api/storage', { headers: H }), env, {});
  const body = await api.json();
  const st = body.status || {};
  check(`${tag} 接口的模式与键数都对得上`,
    st.mode === 'memory' && st.memKeys === keys.length,
    JSON.stringify({ mode: st.mode, memKeys: st.memKeys, want: keys.length, scope: st.scope }));
  check(`${tag} 记得种子是灌进来的`, (st.events || []).some((e) => e.kind === 'seed'),
    (st.events || []).map((e) => e.kind).join(','));
  return { parts, st };
}

const whole = await runOnce(() => [text], '整份');

// ===================== 4. 分段之后再灌，必须一样 =====================
console.log('\n[4] 分片之后再灌：结果必须跟整份一致');
{
  const { parts } = splitSeed(text, 4096);
  const split = await runOnce(() => parts, '分片');
  check('拼回来还是同一份 JSON', parts.join('') === text,
    `${parts.join('').length} vs ${text.length}`);
  check('分段数不大于 60（Free 计划变量个数的余量）', parts.length <= 60, `${parts.length} 段`);
  check('每段都不超过 5 KB', parts.every((p) => Buffer.byteLength(p, 'utf8') <= 5120),
    `最大 ${Math.max(...parts.map((p) => Buffer.byteLength(p, 'utf8')))} 字节`);
  check('两种灌法键数一样', whole.st.memKeys === split.st.memKeys,
    `${whole.st.memKeys} vs ${split.st.memKeys}`);
}

// ===================== 5. 站点路由 =====================
console.log('\n[5] 站点路由：种子里的站点是不是真的能用');
{
  const H = { cookie: COOKIE };
  const siteKeys = keys.filter((k) => k.startsWith('site:'));
  check('种子里带了至少一个站点（否则站点部分是空的）', siteKeys.length > 0, `${siteKeys.length} 个`);

  // 判据经历过一次返工，值得把来龙去脉写下来。
  // 第一版只看状态码不 != 500/404 —— 结果目标站（v1.uhdnow.com）自己就返回 nginx 的 404，
  // 「种子正常、代理也通」被判成失败。
  // 第二版想用「本站渲染的『站点不存在』友好错误页」当标记 —— 结果发现项目有
  // 「前缀丢失自愈」，任何未知路径都会拼到第一个站点上再代理一遍，
  // 于是那张错误页几乎不会出现，判据等于空验。
  // 现在的做法最直接：**同一条请求，灌种子前后打两次，两边必须不一样**。
  // 它不依赖目标站返回什么，也不依赖项目自己的自愈规则 —— 只要种子没生效，
  // 两次就会一模一样，断言立刻变红。
  const probe = async (seedGetter, path) => {
    const e = bootWith(seedGetter);
    // 站点与配置都有进程内缓存；不清的话第二次会读到上一次的结果，对照就成了摆设
    invalidateSite();
    invalidateDoc();
    const r = await handleRequest(new Request(ORIGIN + path, { headers: H }), e.env, {});
    return { status: r.status, body: (await r.text()).slice(0, 4000) };
  };

  if (!argv.siteProbe) {
    console.log('     （--no-site-probe：跳过真实请求）');
  }

  for (const k of siteKeys) {
    let meta = null;
    try { meta = JSON.parse(obj[k]); } catch { meta = null; }
    const slug = (meta && (meta.slug || meta.id)) || String(k).slice('site:'.length);
    check(`${k} 能解析出站点信息`, meta !== null && !!(meta.id || meta.host),
      meta === null ? '不是 JSON' : String(meta.target || meta.host));
    if (!argv.siteProbe) continue;

    const hit = await probe(() => [text], `/p/${encodeURIComponent(slug)}/`);
    const miss = await probe(() => [], `/p/${encodeURIComponent(slug)}/`);   // 空种子 = 什么都没灌
    check(`站点 ${slug} 的确用了种子里的那份配置（不灌种子时表现明显不同）`,
      hit.status !== miss.status || hit.body !== miss.body,
      `有种子 HTTP ${hit.status}，没种子 HTTP ${miss.status}`);
  }
}

// ===================== 6. 凭据 =====================
console.log('\n[6] 凭据：明文的部分被剔掉了吗');
{
  // 注意 scrubbing 只是导出工具给的默认动作，**不是门禁** —— 用户可以 --keep-secrets。
  // 所以这里不断言「必须没有凭据」，那样会逼人绕过工具；这里做的是另一件事：
  // 把事实摆出来，并验证「真要脱敏时，脱完的种子还是能用的」——
  // 后者才是会悄悄坏掉的部分（清空字段可能把上层解析弄崩）。
  const { entries, hits } = scrubSecrets(keys.map((k) => [k, obj[k]]));
  console.log(`     ${hits.length ? '发现 ' + hits.length + ' 处凭据明文' : '没有发现凭据明文'}`);
  for (const h of hits.slice(0, 12)) console.log(`       · ${h.key} → ${h.path}（${h.len} 位）`);

  const scrubbedObj = Object.fromEntries(entries);
  const scrubbedText = JSON.stringify(scrubbedObj);
  if (hits.length) {
    // 不看「原文里那串还在不在」（那要把凭据本身拼进断言里），
    // 只看「脱敏前后确实不一样了」——换了东西是能验的，换了什么不必验
    check('脱敏之后种子内容确实变了（凭据被换掉了）', scrubbedText !== text,
      `${scrubbedText.length} vs ${text.length}`);
    check('脱敏没把键数弄少（清字段，不清键）', Object.keys(scrubbedObj).length === keys.length,
      `${Object.keys(scrubbedObj).length} vs ${keys.length}`);
    // 清空的字段会让上层拿到空串；此时站点还能起来，才算真的「补一遍就行」
    resetState(null, null);
    const env = { PASSWORD, UUID, STORAGE_BACKEND: 'memory' };
    const sp = splitSeed(scrubbedText, 4096).parts;
    sp.forEach((v, i) => { env[seedVarName(i)] = v; });
    bindRuntime(env);
    const r = await handleRequest(new Request(ORIGIN + '/__api/storage', { headers: { cookie: COOKIE } }), env, {});
    const st = ((await r.json()).status) || {};
    check('脱敏之后照样起得来（说明缺的那几个是能事后补的）',
      r.status === 200 && st.mode === 'memory' && st.memKeys === keys.length,
      JSON.stringify({ status: r.status, mode: st.mode, memKeys: st.memKeys }));
  } else {
    check('没有凭据可脱（这一组是空跑，但不算失败）', true);
  }
}

// ===================== 7. 过滤口径 =====================
console.log('\n[7] 导出口径：该丢的丢了没');
{
  const before = keys.length;
  const { picked } = pickEntries(keys.map((k) => [k, obj[k]]));
  const dropped = before - picked.length;
  check('这份种子里的键都不属于该默认跳过的那几类', dropped === 0,
    `还有 ${dropped} 个会被 export-seed 默认跳过`);
}

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
console.log(`种子自检：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
