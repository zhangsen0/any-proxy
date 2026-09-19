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
const TARGET = join(ROOT, 'src/memstore.js');
const CHECK = join(ROOT, 'tools/check-storage.mjs');

// ===================== 变异清单 =====================
//
// 每一行是一条「不许退化」的约定：把实现改回旧写法，检查必须逮住。
// 加新约束时，请同时在这张表里加一行 —— 没有牙齿的约定等于没写。
const MUTANTS = [
  {
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
    name: '手动切内存不预加载（面板一片空白）',
    from: 'async function preload(s) {\n  const raw = s.raw;',
    to: 'async function preload(s) {\n  return { ok: true, loaded: 0, failed: 0, truncated: false };\n  const raw = s.raw;',
  },
];

// ===================== 执行 =====================

const original = readFileSync(TARGET, 'utf8');
let restored = false;
function restore() {
  if (restored) return;
  writeFileSync(TARGET, original);
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
  if (!original.includes(m.from)) {
    fail++;
    failures.push(m.name + '（锚点失效，改了吗？）');
    console.log(`  ❌ ${m.name}\n      锚点已不在 memstore.js 里，这条变异没法做了`);
    continue;
  }
  writeFileSync(TARGET, original.replace(m.from, m.to));
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', [CHECK], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
