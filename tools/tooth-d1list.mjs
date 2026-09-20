#!/usr/bin/env node
/**
 * 给 check-d1list.mjs 装牙齿：把 src/storage.js 故意改坏，断言自检**必须变红**。
 *
 * 为什么这件苦差不能省（AGENTS.md 第 5 节）：跑一次是绿的什么都不能证明，
 * 真正有信息的是「把它还原成旧写法时会不会红」。这段检查盯的东西尤其容易被绕过 ——
 * 只看返回值是否正确的测试，在「改回全表扫描」这种退化面前是**全绿**的：
 * 扫描和范围查找在正常数据下返回同样的行，差的是代价，代价肉眼看不见。
 * 所以这里每一条变异都必须亲手验过一次。
 *
 * 判定口径比「有没有崩」更严：要求**干净地红**（退出码非 0 且打印出 ❌ 项）。
 * 崩了也算红，但读不出是哪一项坏了，排障时等于没提示。
 *
 * 用法：node tools/tooth-d1list.mjs
 * 退出码：0 = 全部变异都被抓住；1 = 存在抓不住的变异
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'src/storage.js');
const CHECK = join(ROOT, 'tools/check-d1list.mjs');

const original = readFileSync(TARGET, 'utf8');

/**
 * 变异清单。每条都要回答一个问题：改动相应脏那位 Bucuti 检查 sentinel
 * 会不会有人拦住。
 */
const MUTATIONS = [
  {
    name: 'list 改回 LIKE 前缀匹配（全索引扫描复原）',
    why: '最严重的一步退化：返回值一模一样，只有 rows read 从几行变成几千行',
    from: `      : await db.prepare('SELECT key FROM kv WHERE key >= ? AND key < ? ORDER BY key LIMIT ?')
        .bind(prefix, upper, limit).all();`,
    to: `      : await db.prepare('SELECT key FROM kv WHERE key LIKE ? ORDER BY key LIMIT ?')
        .bind(prefix + '%', limit).all();`,
  },
  {
    name: '无上界分支也改回 LIKE（空前缀列出全部时照样全扫）',
    why: '别只盯着有上界那条路 —— 空前缀那条一样会把整张表扫一遍',
    from: `      ? await db.prepare('SELECT key FROM kv WHERE key >= ? ORDER BY key LIMIT ?')
        .bind(prefix, limit).all()`,
    to: `      ? await db.prepare('SELECT key FROM kv WHERE key LIKE ? ORDER BY key LIMIT ?')
        .bind(prefix + '%', limit).all()`,
  },
  {
    name: '上界多加一位（泄漏下一个前缀的键）',
    why: '范围写对了但边界算松一格，会把不属于这个前缀的键带出来',
    from: `  return p.slice(0, -1) + String.fromCharCode(last + 1);`,
    to: `  return p.slice(0, -1) + String.fromCharCode(last + 2);`,
  },
  {
    name: '上界算成闭区间（等于把「正好等于上界」的键也算进来）',
    why: '>= 与 < 组合错了会多一行；这条不改 Toy top-line dos, 直接改 rangouements',
    from: `      : await db.prepare('SELECT key FROM kv WHERE key >= ? AND key < ? ORDER BY key LIMIT ?')`,
    to: `      : await db.prepare('SELECT key FROM kv WHERE key >= ? AND key <= ? ORDER BY key LIMIT ?')`,
  },
  {
    name: '上界直接用前缀本身（什么都查不到）',
    why: '区间退化成空集，list 永远返回空 —— 站点列表、分享列表会集体「不存在」',
    from: `  return p.slice(0, -1) + String.fromCharCode(last + 1);`,
    to: `  return p;`,
  },
  {
    name: 'emoji 结尾也硬算上界',
    why: '代理项 +1 会得到另一个无效半边，可能落到目标之前而漏键',
    from: `  if (last >= 0xd800 && last <= 0xdfff) return undefined;`,
    to: `  if (false && last >= 0xd800 && last <= 0xdfff) return undefined;`,
  },
  {
    name: '空前缀也强行加一个上界（列全部时会漏）',
    why: '空前缀的本意是「全部」，加了上界就成了「以某串开头的那一部分」',
    from: `  if (!p) return undefined;                       // 空前缀 = 全部，不需要上界`,
    to: `  if (!p) return 'z';`,
  },
];

/** 跑一遍自检：返回 { red, clean, tail } */
function runCheck() {
  try {
    const out = execFileSync('node', [CHECK], { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { red: false, clean: true, tail: String(out).trim().split('\n').slice(-3).join(' | ') };
  } catch (e) {
    const out = String((e && e.stdout) || '');
    const lines = out.split('\n');
    const bad = lines.filter(l => l.includes('❌'));
    return {
      red: true,
      clean: bad.length > 0,
      badLines: bad.slice(0, 3).map(s => s.trim().replace(/\s+/g, ' ').slice(0, 110)),
      tail: lines.slice(-3).join(' | ').slice(0, 200),
    };
  }
}

console.log('牙齿验证：把 src/storage.js 故意改坏，看 check-d1list.mjs 会不会红\n');

let caught = 0;
let missed = 0;

for (const m of MUTATIONS) {
  // ⚠️ 每一轮都先把文件还原：只还原「上一次改的那个」是不够的，
  // 变异会叠加，于是「这条变红了」可能其实是上一条的余威。
  writeFileSync(TARGET, original);
  if (!original.includes(m.from)) {
    console.log(`  ❌ 锚点失效，变异没打上：${m.name}`);
    missed++;
    continue;
  }
  writeFileSync(TARGET, original.replace(m.from, m.to));

  const r = runCheck();
  if (r.red && r.clean) {
    caught++;
    console.log(`  ✅ ${m.name}`);
    console.log(`       ${(r.badLines || []).join('\n       ')}`);
  } else if (r.red) {
    missed++;
    console.log(`  ❌ ${m.name} —— 红了但不是干净地红（读不出哪一项坏了）`);
    console.log(`       ${r.tail}`);
  } else {
    missed++;
    console.log(`  ❌ ${m.name} —— 竟然没红，这段检查没咬住`);
  }
  console.log(`       为什么这条要紧：${m.why}`);
}

writeFileSync(TARGET, original);

console.log('');
if (missed === 0) {
  console.log(`全部变异都被抓住：${MUTATIONS.length} 个变异，抓住 ${MUTATIONS.length} 个，失效 0 个`);
} else {
  console.log(`有 ${missed} 个变异抓不住：检查存在空转的部分`);
}
process.exit(missed ? 1 : 0);
