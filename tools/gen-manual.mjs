#!/usr/bin/env node
/**
 * 系统操作手册的「附录」生成器。
 *
 * 手册正文是人写的（怎么部署、怎么排查），但速查表不行 ——
 * 字段名、默认值、环境变量名这些都是会变的事实，手抄一遍必然过期，
 * 而且过期得很安静：读者照着表格填了个已经改名的环境变量，只会以为功能坏了。
 *
 * 所以附录两节由本脚本从 src/api-catalog.js 与各模块 SPEC 生成，写进手册的
 * 标记区间内；CI 里跑 --check，目录改了没重新生成就直接红掉。
 *
 * 用法：
 *   node tools/gen-manual.mjs          # 检查手册是否与代码同步（CI 用）
 *   node tools/gen-manual.mjs --write  # 重新生成附录并写回手册
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { API_CATALOG, flatCatalog, TAB_LABELS } from '../src/api-catalog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANUAL = join(ROOT, 'docs', '09-系统操作手册.md');
const BEGIN = '<!-- BEGIN:GENERATED -->';
const END = '<!-- END:GENERATED -->';

const TYPE_LABEL = { bool: '开关', int: '整数', str: '文本' };

/** 表格单元格：竖线和换行都会破坏表格结构，先换掉 */
function cell(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim() || '—';
}

function defaultLabel(field) {
  if (field.secret) return '（不回显）';
  if (field.default === '' || field.default === null || field.default === undefined) return '空';
  if (typeof field.default === 'boolean') return field.default ? '开' : '关';
  return String(field.default);
}

/** 附录 A：配置项速查 —— 只列有 SPEC 的设置项，字段含义取目录里的说明 */
function configReference() {
  const lines = [];
  lines.push('### A.1 配置项速查');
  lines.push('');
  lines.push('「面板」一列是管理面板里的位置。三处取值优先级：**面板配置 → 环境变量 → 默认值**，'
    + '面板里存过就以面板为准，所以环境变量只用于首次部署时给个种子。');
  lines.push('');
  for (const group of API_CATALOG) {
    const items = group.items.filter(i => i.spec && i.params);
    if (!items.length) continue;
    const where = group.tab ? `「${TAB_LABELS[group.tab]}」选项卡` : '「配置」选项卡';
    lines.push(`#### ${group.name}（${where}）`);
    lines.push('');
    lines.push('| 字段 | 面板标签 | 类型 | 默认值 | 环境变量 | 说明 |');
    lines.push('|---|---|---|---|---|---|');
    for (const item of items) {
      for (const p of item.params) {
        const field = item.spec[p.key] || {};
        const notes = [p.hint, p.unit ? `单位：${p.unit}` : ''].filter(Boolean).join('；');
        lines.push(`| \`${cell(p.key)}\` | ${cell(p.label || p.key)} | ${cell(TYPE_LABEL[field.type] || field.type)} `
          + `| ${cell(defaultLabel(field))} | ${cell(field.env ? '`' + field.env + '`' : '—')} | ${cell(notes)} |`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** 附录 B：接口清单 —— 目录里每个接口都在这里，方便对着日志排查 */
function endpointReference() {
  const lines = [];
  lines.push('### A.2 接口速查');
  lines.push('');
  lines.push('登录后的管理接口。未登录访问一律拿不到数据 —— 首页伪装开启时更会直接返回伪装 404，这是设计如此，不是故障。');
  lines.push('');
  lines.push('| 方法 | 路径 | 登录 | 说明 | 面板位置 |');
  lines.push('|---|---|---|---|---|');
  for (const item of flatCatalog()) {
    const group = API_CATALOG.find(g => g.id === item.group);
    if (group.hidden) continue;
    const method = item.method || 'GET';
    const place = group.tab ? `「${TAB_LABELS[group.tab]}」` : (item.keep ? '「配置」→ 诊断工具' : '「配置」');
    lines.push(`| ${cell(method)} | \`${cell(item.path)}\` | ${item.auth === false ? '否' : '是'} | ${cell(item.desc)} | ${cell(place)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function generatedBody() {
  return [configReference(), endpointReference()].join('\n');
}

// ===================== 主流程 =====================

const write = process.argv.includes('--write');

if (!existsSync(MANUAL)) {
  console.error('找不到手册：' + MANUAL);
  process.exit(1);
}

const text = readFileSync(MANUAL, 'utf8');
const beginIdx = text.indexOf(BEGIN);
const endIdx = text.indexOf(END);
if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
  console.error(`手册里缺少生成区间标记（${BEGIN} … ${END}）`);
  process.exit(1);
}

const current = text.slice(beginIdx + BEGIN.length, endIdx).trim();
const expected = generatedBody().trim();

if (write) {
  if (current === expected) {
    console.log('附录已是最新，无需修改');
    process.exit(0);
  }
  const next = text.slice(0, beginIdx + BEGIN.length) + '\n\n' + expected + '\n\n' + text.slice(endIdx);
  writeFileSync(MANUAL, next);
  const stats = (expected.match(/^\| /gm) || []).length;
  console.log(`已更新手册附录：${stats} 行表格`);
  process.exit(0);
}

if (current === expected) {
  console.log('✅ 手册附录与代码一致');
  process.exit(0);
}

console.log('❌ 手册附录与代码不一致 —— 目录或 SPEC 改过之后忘了重新生成。');
console.log('   处理：node tools/gen-manual.mjs --write');
const curLines = current.split('\n');
const expLines = expected.split('\n');
for (let i = 0; i < Math.max(curLines.length, expLines.length); i++) {
  if (curLines[i] !== expLines[i]) {
    console.log(`   首个差异在第 ${i + 1} 行：`);
    console.log('     手册：' + (curLines[i] || '(缺行)'));
    console.log('     应为：' + (expLines[i] || '(多行)'));
    break;
  }
}
process.exit(1);
