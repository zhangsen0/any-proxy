#!/usr/bin/env node
/**
 * 导出种子（seed）——把线上存储里的内容拉出来，做成可以直接灌回内存的那一袋数据。
 *
 * 什么时候用它：D1 / KV 配额打满或者干脆不可用了，站点却还得继续跑。
 * 这时候把数据导出成一份种子，配合 `STORAGE_BACKEND=memory` 部署，
 * 站点在**一个存储绑定都不要**的情况下也能起来。
 *
 * 三种来源：
 *   --from-d1   通过 Cloudflare 的 D1 REST 接口拉 `kv` 表
 *   --from-kv   通过 Cloudflare 的 KV REST 接口逐个键拉
 *   --from-sql  读 `wrangler d1 export` 出来的 .sql 文件（不需要令牌，也不用联网）
 *
 * 平台限制 —— 这一条决定了本脚本为什么必须支持分片：
 *   **每个环境变量上限 5 KB**（付费计划同样是 5 KB/个），Free 计划一个 Worker
 *   只能带 64 个变量。所以种子按 `--chunk` 切成若干段，分别填进
 *   `SEED_JSON` / `SEED_JSON_01` / `SEED_JSON_02` ……
 *   由 `src/memstore.js` 在启动时按序号拼回来。
 *
 * 用法：
 *   node tools/export-seed.mjs --from-sql dump.sql
 *   node tools/export-seed.mjs --from-d1 --token cfat_xxx --account <id> --db <id>
 *   node tools/export-seed.mjs --from-kv --token cfat_xxx --account <id> --ns <id>
 *   node tools/export-seed.mjs --from-sql dump.sql --chunk 4096 --out seed.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// ===================== 纯函数部分（可离线自检；这里不许出现网络调用） =====================

/** 默认跳过的键：量大、且丢得起的那一类（统计重建一次就有） */
export const DEFAULT_SKIP = ['stats:', 'st:', 'visit:', 'latency:'];

/** Worker 的变量个数也有上限（Free 64 个，给它留几个给别的用途） */
export const MAX_PARTS = 60;

/** 单个变量的大小上限 5 KB；分片默认留一点余量 */
export const VAR_LIMIT = 5120;

/**
 * 挑出要导出的键。
 * @param {Array<[string,string]>} entries [键, 值] 列表
 */
export function pickEntries(entries, opts = {}) {
  const skip = Array.isArray(opts.skip) ? opts.skip : (opts.keepStats ? [] : DEFAULT_SKIP);
  const only = opts.only && opts.only.length ? opts.only : null;
  const picked = [];
  const dropped = [];
  for (const [k, v] of entries) {
    if (k === null || k === undefined) continue;
    if (v === null || v === undefined) continue;
    if (only) {
      if (!only.some((p) => k === p || k.startsWith(p))) { dropped.push(k); continue; }
    }
    if (skip.some((p) => k.startsWith(p))) { dropped.push(k); continue; }
    picked.push([k, String(v)]);
  }
  return { picked, dropped };
}

/**
 * 按 UTF-8 字节切成若干段。
 *
 * 必须守住的边界：**不能把多字节字符劈成两半**。劈开的汉字在内存里拼起来还能复原，
 * 但中途经过 GitHub Variables 与 Cloudflare 的变量存储时，残缺的字节有可能被替换成
 * 问号或 U+FFFD，数据就悄悄坏掉了 —— 而且是部署成功但内容不对的那种坏。
 *
 * 段数超过上限时不截断返回：`overflow` 要给出来，让调用方自己去取舍。
 */
export function splitSeed(text, limit = 4096, maxParts = MAX_PARTS) {
  if (!(limit > 0)) throw new Error('分片大小必须是正数');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= limit) return { parts: [text], overflow: false };

  const parts = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    if (end < bytes.length) {
      // 0x80~0xBF 是 UTF-8 续字节：段的开头不能落在续字节上
      while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
    }
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return { parts, overflow: parts.length > maxParts };
}

/** 第 i 段的变量名：主段不带后缀，其余从 01 起两位数字 */
export function seedVarName(i) {
  return i === 0 ? 'SEED_JSON' : 'SEED_JSON_' + String(i).padStart(2, '0');
}

/**
 * 解析 `wrangler d1 export` 出来的 SQL，取 `INSERT INTO kv` 那几行。
 *
 * 为什么不直接用 `.split("'")`：站点的值本身就是 JSON，里面双引号单引号都有。
 * 按引号直接切开会把值拦腰截断，导出结果长得像是对的（键名还在），实际每个值都缺一半 ——
 * 这种损坏只有在站点跑起来之后才发现。所以这里老老实实处理 `''` 转义。
 */
export function parseSqlDump(sql) {
  const rows = [];
  const skipped = [];
  const re = /INSERT\s+INTO\s+`?kv`?\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\);/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const cols = m[1].split(',').map((s) => s.trim().replace(/`/g, '').toLowerCase());
    const tuple = m[2] + ',';
    const cells = readTuple(tuple);
    if (!cells) { skipped.push(m[0].slice(0, 60)); continue; }
    const ki = cols.indexOf('key');
    const vi = cols.indexOf('value');
    if (ki < 0 || vi < 0) { skipped.push(m[0].slice(0, 60)); continue; }
    rows.push([cells[ki], cells[vi]]);
  }
  return { rows, skipped };
}

/** 读一行 VALUES 里的各个字段，返回数组；解析不动返回 null */
function readTuple(tuple) {
  const cells = [];
  let i = 0;
  while (i < tuple.length) {
    const ch = tuple[i];
    if (ch === ',') { i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "'") {
      let out = '';
      i++;
      while (i < tuple.length) {
        if (tuple[i] === "'") {
          if (tuple[i + 1] === "'") { out += "'"; i += 2; continue; }
          i++;
          break;
        }
        out += tuple[i];
        i++;
      }
      cells.push(out);
      continue;
    }
    // 数字、NULL 这类不带引号的写法
    let out = '';
    while (i < tuple.length && tuple[i] !== ',') { out += tuple[i]; i++; }
    cells.push(out.trim());
  }
  return cells.length ? cells : null;
}

// ===================== 网络部分 =====================

function request(url, opts = {}) {
  const { token, method = 'GET', body = null, proxy = null } = opts;
  if (proxy) {
    // 走代理时交给 curl：本机往往只有它配好了出网的路子，
    // 没必要在脚本里再手写一个 CONNECT 隧道
    const args = ['-sS', '-m', '60', '-w', '\n%{http_code}', '-x', proxy, '-X', method, url];
    if (token) args.push('-H', 'Authorization: Bearer ' + token);
    if (body) args.push('-H', 'Content-Type: application/json', '--data-binary', body);
    const raw = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const at = raw.lastIndexOf('\n');
    return { status: Number(raw.slice(at + 1).trim()), text: raw.slice(0, at) };
  }
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(url, { method, headers, body: body || undefined })
    .then(async (r) => ({ status: r.status, text: await r.text() }));
}

function die(msg) { console.error('  ✗ ' + msg); process.exit(1); }

/**
 * 统一的处理：这里刻意**不替 CF 翻译错误信息**。
 * 「配额超限」「令牌权限不够」「数据库 ID 写错」三种情况在接口层常常都表现为同一个 400/403，
 * 自己猜着翻译，猜错了反而更花时间 —— 把原始错误原样打出来，让用户对症处理。
 */
function parseCf(r, label) {
  let json = null;
  try { json = JSON.parse(r.text); } catch { /* 落到下面统一处理 */ }
  if (!json) die(`${label} 返回的不是 JSON（HTTP ${r.status}）：${String(r.text).slice(0, 300)}`);
  if (r.status >= 400 || json.success === false) {
    const errs = (json.errors || []).map((e) => `${e.code || ''} ${e.message || ''}`.trim()).join('；');
    die(`${label} 接口失败（HTTP ${r.status}）：${errs || String(r.text).slice(0, 300)}`);
  }
  return (json.result && json.result[0]) || json.result || json;
}

async function fromD1({ token, account, db, proxy }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${db}/raw`;
  const r = await request(url, {
    token, method: 'POST', proxy,
    body: JSON.stringify({ sql: 'SELECT key, value FROM kv' }),
  });
  const body = parseCf(r, 'D1');
  return (body.results || []).map((row) => [row.key, row.value]);
}

async function fromKV({ token, account, ns, proxy }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}`;
  const names = [];
  let cursor = '';
  for (;;) {
    const u = base + '/keys?limit=1000' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const body = parseCf(await request(u, { token, proxy }), 'KV');
    for (const k of body || []) names.push(k.name);
    cursor = body.result_info && body.result_info.cursor;
    if (!cursor) break;
  }
  const out = [];
  for (const k of names) {
    const r = await request(base + '/values/' + encodeURIComponent(k), { token, proxy });
    if (r.status !== 200) { console.error(`  ! ${k} 取值失败（HTTP ${r.status}），跳过`); continue; }
    out.push([k, r.text]);
  }
  return out;
}

function fromSql(file) {
  const { rows, skipped } = parseSqlDump(readFileSync(file, 'utf8'));
  if (skipped.length) console.log(`  ! 有 ${skipped.length} 行没解析出来（格式不认识），已跳过`);
  return rows.map(([k, v]) => [k, v === 'NULL' ? null : v]);
}

// ===================== 命令行 =====================

function parseArgs(argv) {
  const a = { chunk: 0, out: '', proxy: process.env.HTTPS_PROXY || '', keepStats: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--from-d1') a.src = 'd1';
    else if (k === '--from-kv') a.src = 'kv';
    else if (k === '--from-sql') { a.src = 'sql'; a.file = argv[++i]; }
    else if (k === '--token') a.token = argv[++i];
    else if (k === '--account') a.account = argv[++i];
    else if (k === '--db') a.db = argv[++i];
    else if (k === '--ns') a.ns = argv[++i];
    else if (k === '--proxy') a.proxy = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--chunk') a.chunk = Number(argv[++i]);
    else if (k === '--keep-stats') a.keepStats = true;
    else if (k === '--only') a.only = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--help' || k === '-h') a.help = true;
    else die('未知参数：' + k);
  }
  return a;
}

const HELP = `
用法：
  node tools/export-seed.mjs --from-sql dump.sql                      # wrangler d1 export 出来的文件
  node tools/export-seed.mjs --from-d1 --token T --account A --db D   # 直接从 D1 拉
  node tools/export-seed.mjs --from-kv --token T --account A --ns N   # 直接从 KV 拉

选项：
  --out seed.json   同时写一份完整 JSON（给本地备份用；通常超过单变量 5 KB 上限）
  --chunk 4096      按字节分片打印，并标明每段该填进哪个变量
  --keep-stats      连统计类键一起导出（默认跳过：量大且丢得起）
  --only a,b        只导出这些前缀 / 键
  --proxy HOST:PORT 本机能出网的那条路（默认读 HTTPS_PROXY）
  -h / --help       看这个
`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.src) { console.log(HELP); process.exit(a.help ? 0 : 1); }

  let entries = [];
  if (a.src === 'sql') {
    entries = fromSql(a.file);
  } else if (a.src === 'd1') {
    if (!a.token || !a.account || !a.db) die('--from-d1 需要 --token / --account / --db');
    entries = await fromD1(a);
  } else if (a.src === 'kv') {
    if (!a.token || !a.account || !a.ns) die('--from-kv 需要 --token / --account / --ns');
    entries = await fromKV(a);
  }

  const { picked, dropped } = pickEntries(entries, { keepStats: a.keepStats, only: a.only });
  if (!picked.length) die('一个键都没取到 —— 看看过滤条件是不是太严，或者数据本来就不在这份来源里');

  const obj = {};
  for (const [k, v] of picked) obj[k] = v;
  const json = JSON.stringify(obj);
  const bytes = Buffer.byteLength(json, 'utf8');

  const tail = dropped.length
    ? `（跳过 ${dropped.length} 个：${dropped.slice(0, 5).join('、')}${dropped.length > 5 ? '…' : ''}）`
    : '';
  console.log(`\n取到 ${Object.keys(obj).length} 个键，共 ${bytes} 字节${tail}`);

  if (a.out) { writeFileSync(a.out, json); console.log(`已写 ${a.out}`); }

  if (a.chunk) {
    const { parts, overflow } = splitSeed(json, a.chunk);
    console.log(`\n按 ${a.chunk} 字节切成 ${parts.length} 段 —— 依次填到 GitHub 仓库的 Variables：`);
    for (let i = 0; i < parts.length; i++) {
      console.log(`\n--- ${seedVarName(i)}（${Buffer.byteLength(parts[i], 'utf8')} 字节）---`);
      console.log(parts[i]);
    }
    if (overflow) {
      console.log(`\n  ! 超过 ${MAX_PARTS} 段 —— Worker 的变量个数有上限（Free 64 个）。`
        + `建议用 --only 只导必要的键，或把 chunk 调大到接近 ${VAR_LIMIT}。`);
    }
  } else if (bytes > VAR_LIMIT) {
    console.log(`\n  ! 整份 ${bytes} 字节，**超过单个变量 5 KB 的上限**，用 --var 传不进去。`
      + `请用 --chunk 4096 分片，或用 --only 只导必要的键。`);
  } else {
    console.log(`\n整份 ${bytes} 字节，可以直接填进 SEED_JSON（单个变量上限 5 KB）。`);
  }
  console.log('');
}

// 只在被当作命令直接运行时才动 exports / 联网；被别的脚本 import 纯函数时不许有任何副作用
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((e) => die(String((e && e.message) || e)));
}
