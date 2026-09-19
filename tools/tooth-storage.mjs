#!/usr/bin/env node
/**
 * 给 check-storage.mjs 装牙齿：把 memstore.js 故意改坏，断言那套自检**必须变红**。
 *
 * 为什么这个脚本要存在：
 * 写完一段检查，跑一次是绿的 —— 这什么都不能证明。真正有信息的只有一件事：
 * 「把实现还原成旧写法时，它会不会红」。历史上漏掉这一手的结果是：某条规则
 * `allow: ['src/subs.js']` 按文件放行，合法声明与违规兜底同在一个文件里，
 * 退化悄悄通过，检查空转了很久没人知道（AGENTS.md 第 5 节）。
 *
 * 光靠人手工做一遍也不够：那一遍只在做它的当天有效。所以把「故意改坏」这件事
 * 本身也做成一行命令，谁改了 memstore.js 都能随手验证检查还咬不咬得住。
 *
 * 判定口径比「有没有崩」更严：
 *   - 崩溃也确实会让 CI 变红，但读不出是哪一项坏了，夜里排障等于没提示；
 *     所以这里要求**干净地红**（退出码非 0 且打印出 ❌ 项）。
 *   - 每个变异都必须至少有一条断言变红；一条都没有 = 这段检查是摆设。
 *
 * 用法：node tools/tooth-storage.mjs
 * 退出码：0 = 全部变异都被抓住；1 = 存在抓住不了的变异
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = {
  memstore: join(ROOT, 'src/memstore.js'),
  seedtool: join(ROOT, 'tools/export-seed.mjs'),
  prepare: join(ROOT, '.github/scripts/prepare-deploy.py'),
  admin: join(ROOT, 'src/admin.js'),
  native: join(ROOT, 'src/native-sub.js'),
  router: join(ROOT, 'src/router.js'),
};
// 每个变异跑哪一套自检：改动落在哪个环节，就由盯那个环节的那套来咬。
// 默认 storage —— 内存模式这条链路上大部分约束都由它看
const CHECKS = {
  storage: join(ROOT, 'tools/check-storage.mjs'),
  wrangler: join(ROOT, 'tools/check-wrangler.mjs'),
  clash: join(ROOT, 'tools/check-clash.mjs'),
};

// ===================== 变异清单 =====================
//
// 每一行是一条「不许退化」的约定：把实现改回旧写法，检查必须逮住。
// 加新约束时，请同时在这张表里加一行 —— 没有牙齿的约定等于没写。
const MUTANTS = [
  {
    file: 'memstore',
    name: '一次成功不清零（抖动会被误判成挂了）',
    from: 'const ok = () => { s.fails = 0; };',
    to: 'const ok = () => { };',
  },
  {
    name: '降级后仍然打后端（等于没降级）',
    from: "if (s.mode === 'memory') return memGet(s, key);",
    to: 'if (false) return memGet(s, key);',
  },
  {
    name: '探测成功就自动切回存储',
    from: "return { ok: true, detail: '存储可读写' };",
    to: "s.mode = 'storage'; s.source = 'auto'; return { ok: true, detail: '存储可读写' };",
  },
  {
    name: '写回时不判冲突、无脑覆盖',
    from: 'if (!force && cur !== null && cur !== baseline) {',
    to: 'if (false) {',
  },
  {
    name: '写回失败就把脏键丢掉（用户以为写过了）',
    from: "logEvent(s, 'flush-fail', `${key} 写入失败：${e && e.message}`);",
    to: "s.dirty.delete(key);\n      logEvent(s, 'flush-fail', `${key} 写入失败：${e && e.message}`);",
  },
  {
    name: '写失败时把异常吞掉（调用方不知道要重试）',
    from: "logEvent(s, 'write-degraded', `${key} 写入失败，已暂留内存`);\n        throw e;",
    to: "logEvent(s, 'write-degraded', `${key} 写入失败，已暂留内存`);",
  },
  {
    name: '每次 bind 都新建状态（内存数据逐请求丢失）',
    from: 'let s = states.get(k);',
    to: 'let s = null;',
  },
  {
    name: '种子不灌进内存（内存模式下一片空白）',
    from: 's.mem.set(String(k), v === null || v === undefined ? null : String(v));',
    to: 'void 0;',
  },
  {
    name: '降级时不搬影子副本（配置当场回到默认值）',
    from: 'for (const [k, v] of s.shadow) s.mem.set(k, v);',
    to: 'void s.shadow;',
  },
  {
    name: '面板的阈值同步不进来（只能改代码才能调）',
    from: 'if (Number.isFinite(v) && v >= 1) failThreshold = Math.floor(v);',
    to: 'if (false) failThreshold = Math.floor(v);',
  },
  {
    name: '自动降级谎报 global（其它实例还在往坏存储里写）',
    from: 's.scope = \'isolate\';   // 自动降级默认只在本实例；广播成功才升级为 best-effort',
    to: "s.scope = 'global';",
  },
  {
    name: '墓碑漏进列表（删掉的站点还在列表里）',
    from: 'if (v === null || v === undefined) continue;   // 墓碑不出现在列表里',
    to: 'if (false) continue;',
  },
  {
    name: '不记 dirty（写回时无键可搬）',
    from: '  s.mem.set(k, value === null || value === undefined ? null : String(value));\n  s.dirty.add(k);',
    to: '  s.mem.set(k, value === null || value === undefined ? null : String(value));',
  },
  {
    file: 'memstore',
    name: '预捞清单漏掉 ADD.txt（策展好的节点静默退化成随机 IP）',
    from: "export const SUB_MINIMAL_KEYS = ['APP_CONFIG', 'config.json', 'ADD.txt', 'PREF_IPS', 'GOOD_IPS'];",
    to: "export const SUB_MINIMAL_KEYS = ['APP_CONFIG', 'config.json', 'PREF_IPS', 'GOOD_IPS'];",
  },
  {
    file: 'router',
    name: '订阅不查身份（缺节点 ID 时只说「没节点」，病因被藏起来）',
    from: "      if (!ident.uuid) {",
    to: "      if (false) {",
  },
  {
    file: 'memstore',
    name: '手动切内存不预加载（面板一片空白）',
    from: 'async function preload(s) {\n  const raw = s.raw;',
    to: 'async function preload(s) {\n  return { ok: true, loaded: 0, failed: 0, truncated: false };\n  const raw = s.raw;',
  },
  {
    file: 'memstore',
    name: '只认单个 SEED_JSON（分片全部被忽略，站点起不来却没有报错）',
    from: 'const m = /^SEED_JSON(?:_(\\d+))?$/i.exec(name);',
    to: "const m = /^SEED_JSON$/i.exec(name);",
  },
  {
    file: 'memstore',
    name: '分片不按序号排（灌进内存的内容前后颠倒）',
    from: 'hit.sort((a, b) => a.seq - b.seq);',
    to: 'void hit;',
  },
  {
    file: 'seedtool',
    name: '分片从多字节字符中间切开（汉字过一趟变量存储就坏掉）',
    from: 'while (end > start && (bytes[end] & 0xc0) === 0x80) end--;',
    to: 'while (false) end--;',
  },
  {
    file: 'seedtool',
    name: '不过滤统计类键（几百 KB 的流水被当成种子）',
    from: 'if (skip.some((p) => k.startsWith(p))) { dropped.push(k); continue; }',
    to: 'if (false) { dropped.push(k); continue; }',
  },
  {
    file: 'seedtool',
    name: '词表里没有 stat: 这个单数前缀（线上数据就是它，整类键漏过去）',
    from: "export const DEFAULT_SKIP = ['stats:', 'stat:', 'st:', 'visit:', 'latency:', 'geoip:', 'log.json'];",
    to: "export const DEFAULT_SKIP = ['stats:', 'st:', 'visit:', 'latency:', 'geoip:', 'log.json'];",
  },
  {
    file: 'seedtool',
    name: '脱敏不动对象里的凭据字段（订阅令牌明文进了仓库变量）',
    from: '      if (isSecret(path)) {',
    to: '      if (false) {',
  },
  {
    file: 'seedtool',
    name: '脱敏不管「整个值就是凭据」那种（STATS_SALT 原样带出去）',
    from: "      if (isSecret(k) && raw !== '') {",
    to: '      if (false) {',
  },
  {
    file: 'seedtool',
    name: '把 D1 /raw 的返回当对象数组处理（导出直接崩，或导出来是空的）',
    from: '      const k = Array.isArray(row) ? row[iKey < 0 ? 0 : iKey] : row.key;',
    to: '      const k = row.key;',
  },
  {
    file: 'seedtool',
    name: 'SQL 里的转义引号不还原（每个值都被拦腰截断）',
    from: `if (tuple[i + 1] === "'") { out += "'"; i += 2; continue; }`,
    to: 'if (false) { i += 2; continue; }',
  },
  {
    file: 'seedtool',
    name: '分片数超上限不给信号（部署才发现变量不够用）',
    from: 'return { parts, overflow: parts.length > maxParts };',
    to: 'return { parts, overflow: false };',
  },
  // ---- 部署环节：把种子写进 wrangler.toml 这一步，错一点都不会报错 ----
  {
    file: 'prepare',
    check: 'wrangler',
    name: '漏贴一段也不查（部署出一个读着半份数据的站点）',
    from: '    if used:\n        missing =',
    to: '    if False:\n        missing =',
  },
  {
    file: 'prepare',
    check: 'wrangler',
    name: '把仓库变量一股脑塞进 [vars]（部署时与命令行 --var 打架）',
    from: "    names = ['SEED_JSON'] + ['SEED_JSON_%02d' % i for i in range(1, SEED_MAX_PARTS + 1)]",
    to: '    names = sorted(env.keys())',
  },
  {
    file: 'prepare',
    check: 'wrangler',
    name: '种子追加到 [vars] 之外（TOML 里出现同名表，部署直接失败）',
    from: "    if marker in text:\n        # 必须插进已有的 [vars] 表里面：TOML 不允许同名表出现两次\n        return text.replace(marker, marker + block, 1)",
    to: '    if False:\n        return text.replace(marker, marker + block, 1)',
  },
  {
    file: 'prepare',
    check: 'wrangler',
    name: '种子值不转义（值里的引号把配置文件写坏）',
    from: "lines.append('%s = %s' % (name, json.dumps(value)))",
    to: "lines.append('%s = \"%s\"' % (name, value))",
  },
  {
    file: 'prepare',
    check: 'wrangler',
    name: '根本不把种子写进配置（站点起来却读不到任何数据）',
    from: '    text = appendSeedVars(text, seed)',
    to: '    text = text',
  },
  // ---- 配额打满时还能不能发版（迁移失败不许再退回到「发不了版」）----
  {
    file: 'prepare',
    check: 'wrangler',
    name: '迁移失败就退出（配额打满直接发不了版）',
    from: '        check=False,\n        capture_output=True,',
    to: '        check=True,\n        capture_output=True,',
  },
  {
    file: 'prepare',
    check: 'wrangler',
    name: '迁移失败了却一声不响（放行变成静默失败）',
    from: "        print('::error::[d1 migrations] ' + line)",
    to: '        pass',
  },
  {
    file: 'prepare',
    check: 'wrangler',
    name: '写盘排到迁移之后（wrangler 读到没渲染的占位符）',
    from: "    with open(path, 'w', encoding='utf-8') as fh:\n        fh.write(text)",
    to: "    apply_migrations()\n    with open(path, 'w', encoding='utf-8') as fh:\n        fh.write(text)",
  },
  {
    file: 'prepare',
    check: 'wrangler',
    name: '迁移之后又把配置重写一遍（迁移时读到的不是最终产物）',
    from: "        log('d1 模式：迁移已应用')\n        return",
    to: "        log('d1 模式：迁移已应用')\n        _f = open('wrangler.toml', 'a'); _f.write('\\n# 变异\\n'); _f.close()\n        return",
  },
  {
    file: 'prepare',
    check: 'wrangler',
    name: '摘要写成空操作（运行详情页上看不出这次没建表）',
    from: 'def summarize(lines):\n    """写进 Actions 的运行摘要。日志看不看随缘，摘要是这次部署躲不掉的一页。"""',
    to: 'def summarize(lines):\n    return\n    """写进 Actions 的运行摘要。日志看不看随缘，摘要是这次部署躲不掉的一页。"""',
  },
  // ---- 本地订阅渲染：Stash 这类客户端拿到的 YAML 必须是真的 ----
  {
    file: 'native',
    check: 'clash',
    name: '字符串值不加引号（备注里的「: 」把 YAML 写坏）',
    from: 'const yq = v => JSON.stringify(String(v));',
    to: 'const yq = v => String(v);',
  },
  {
    file: 'native',
    check: 'clash',
    name: 'ws 节点丢掉 ws-opts（客户端连不上而不是报错）',
    from: "  if (node['ws-opts']) {\n    L.push('    ws-opts:');",
    to: '  if (false) {\n    L.push(\'    ws-opts:\');',
  },
  {
    file: 'native',
    check: 'clash',
    name: '重名节点不去重（proxy-group 引用指向谁不可预期）',
    from: '    if (c > 0) n.name = `${n.name} #${c + 1}`;',
    to: '    if (false) n.name = `${n.name} #${c + 1}`;',
  },
  // ---- 面板：用户提出的原话是「在网站显眼的位置显示当前的运行模式」----
  {
    file: 'admin',
    name: '面板不渲染状态条（内存模式跑着，页面上却一点迹象都没有）',
    from: '${authed ? renderModeBar(env) : \'\'}',
    to: "''",
  },
];

// ===================== 执行 =====================

const original = {};
for (const [k, f] of Object.entries(FILES)) original[k] = readFileSync(f, 'utf8');
let restored = false;
function restore() {
  if (restored) return;
  for (const [k, f] of Object.entries(FILES)) writeFileSync(f, original[k]);
  restored = true;
}
// 无论怎么退出的（含 Ctrl-C、断言抛错），都不能把改坏的实现留在磁盘上
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });

let pass = 0;
let fail = 0;
const failures = [];

for (const m of MUTANTS) {
  const key = m.file || 'memstore';
  const file = FILES[key];
  if (!original[key].includes(m.from)) {
    fail++;
    failures.push(m.name + '（锚点失效，这条约束改了吗？）');
    console.log(`  ❌ ${m.name}\n      锚点已不在 ${key} 里，这条变异没法做了`);
    continue;
  }
  // ⚠️ 每一轮开始先把**所有**文件还原：只还原当前这一个是不够的。
  // 跨文件变异会叠加（改了 memstore 又跑 seedtool 的变异，前者仍带着伤），
  // 于是「这一条变红了」可能其实是上一条的余威 —— 看着 40 个全抓住，实则在自欺。
  // 每一次都必须只带着这一个伤口上场，红才是它自己咬出来的。
  for (const [k, f] of Object.entries(FILES)) writeFileSync(f, original[k]);
  writeFileSync(file, original[key].replace(m.from, m.to));
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', [CHECKS[m.check || 'storage']], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = String((e.stdout || '') + (e.stderr || ''));
    code = e.status === undefined ? 1 : e.status;
  }
  const reds = out.split('\n').filter((l) => l.includes('❌')).map((l) => l.trim().replace(/^❌\s*/, '').split('  -> ')[0]);
  if (code !== 0 && reds.length > 0) {
    pass++;
    console.log(`  ✅ ${m.name}\n      ${reds.length} 项变红 -> ${reds[0]}`);
  } else if (code !== 0) {
    fail++;
    failures.push(m.name);
    console.log(`  ❌ ${m.name}\n      脚本崩了，但没打印出失败项 —— 排障时读不出是哪一条坏了`);
  } else {
    fail++;
    failures.push(m.name);
    console.log(`  ❌ ${m.name}\n      改坏了却是绿的 —— 这段检查形同虚设`);
  }
}

restore();

console.log(`\n=== ${fail === 0 ? '全部变异都被抓住' : '有抓不住的变异'} ===`);
if (fail) console.log('失效的检查：\n  - ' + failures.join('\n  - '));
console.log(`牙齿验证：${pass + fail} 个变异，抓住 ${pass} 个，失效 ${fail} 个\n`);
process.exit(fail ? 1 : 0);
