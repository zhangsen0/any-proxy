#!/usr/bin/env node
// 统计全部离线自检的断言总数 —— docs/04 里那张表里的数字，全部由这里产出。
//
// 为什么要有这个：总数曾经靠人手工累加各套的「xx 项」，于是出现
// 「实际 1082 却登记 1074」「三套自检从来没挂 CI 而文档里照样写着全覆盖」——
// 数字由人抄一遍，就一定会抄错，而且错得毫无声响。
// 从这一版起，docs/04 的「断言总数」只认这个脚本的输出。
//
// 用法：node tools/count-asserts.mjs
// 退出码：0 = 统计完成；1 = 存在失败项

import { readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SKIP = ['check-live.mjs', 'check-e2e.mjs'];   // 这两个要真实凭据，不算离线自检
const files = readdirSync('tools')
  .filter((f) => f.startsWith('check-') && f.endsWith('.mjs') && !SKIP.includes(f))
  .sort();

let total = 0;
let bad = 0;
const rows = [];

for (const f of files) {
  const out = execSync(`node tools/${f} 2>&1`, { encoding: 'utf8' });
  // 各套自己打印的计数口径不一致，这里按顺序认三种：
  //   「N 项，失败 M 项」/「结果：N 通过 / M 失败」/「通过 N，失败 M」
  //   都没有才退回数断言行（并剔掉「✅ 全部通过」这类汇总）
  let pass = null;
  let fail = null;
  let m = out.match(/(\d+)\s*项，失败\s*(\d+)\s*项/);
  if (m) [pass, fail] = [+m[1], +m[2]];
  if (pass === null) { m = out.match(/结果：(\d+)\s*通过\s*\/\s*(\d+)\s*失败/); if (m) [pass, fail] = [+m[1], +m[2]]; }
  if (pass === null) { m = out.match(/通过\s*(\d+)，失败\s*(\d+)/); if (m) [pass, fail] = [+m[1], +m[2]]; }
  if (pass === null) {
    const lines = out.split('\n').filter((l) => /^\s*[✅❌]/.test(l) && !/全部通过|一致/.test(l));
    pass = lines.filter((l) => l.includes('✅')).length;
    fail = lines.filter((l) => l.includes('❌')).length;
  }
  rows.push([f.replace('check-', '').replace('.mjs', ''), pass, fail]);
  total += pass + fail;
  bad += fail;
}

rows.sort((a, b) => b[1] - a[1]);
for (const [name, pass, fail] of rows) {
  console.log(name.padEnd(16) + String(pass).padStart(5) + (fail ? `   ❌ ${fail}` : ''));
}
console.log('—'.repeat(30));
console.log('套数'.padEnd(14) + String(rows.length).padStart(5));
console.log('断言总数'.padEnd(12) + String(total).padStart(5));

process.exit(bad ? 1 : 0);
