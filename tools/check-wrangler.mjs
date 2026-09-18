#!/usr/bin/env node
/**
 * 部署形态自检：wrangler.toml 与 .github/scripts/prepare-deploy.py 是否对齐。
 *
 * 这一层防的是「fork 之后部署失败，而且看不出为什么」——
 * wrangler.toml 里写死任何一个账号下的资源 ID，别人 fork 过去 `wrangler deploy`
 * 必然报「找不到那个数据库 / 命名空间」，而报错信息里没有任何线索指向这个文件。
 * 所以这里钉两件事：
 *
 *   1. 版本库里不允许出现任何真实形态的绑定 ID（UUID / 32 位十六进制），只能是占位符；
 *   2. 每个占位符都真的有人管 —— 并且**真跑一遍脚本**，确认渲染产物没有占位符残留、
 *      用不到的后端绑定被整段删掉、TOML 仍然合法。
 *
 * 光做静态比对不够：脚本里少写一行 replace，静态检查照样绿，而部署时 wrangler
 * 会因为读到 `__D1_DATABASE_ID__` 直接失败。所以第 3~5 段是真的把 python 跑起来。
 *
 * 用法：node tools/check-wrangler.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const SCRIPT = join(ROOT, '.github/scripts/prepare-deploy.py');

const wrangler = read('wrangler.toml');
const script = read('.github/scripts/prepare-deploy.py');
const workflow = read('.github/workflows/deploy-cloudflare.yml');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  -> ' + extra : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? '  -> ' + extra : ''}`); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

/** 占位符只算「真正生效的配置值」：注释里的泛指说明不算（与脚本同一口径） */
const stripComments = t => String(t).replace(/#[^\n]*/g, '');
const placeholdersOf = t => [...new Set((stripComments(t).match(/__[A-Z0-9_]+__/g) || []))].map(s => s.slice(2, -2));
const managedList = () => ((/MANAGED_PLACEHOLDERS = \[([\s\S]*?)\]/.exec(script) || [, ''])[1]
  .match(/'([A-Z0-9_]+)'/g) || []).map(s => s.slice(1, -1));

/** 本项目账号下那两个曾被写死在仓库里的资源 ID —— 它们不该再出现在任何地方 */
const OWN_IDS = ['2d033029-8ed0-4d2b-8291-b261d21bb5d6', '2a940bcb0dae4b448e8def3ebf4fe27d'];

// ===================== 1. 没有写死的绑定 ID =====================
section('1. wrangler.toml 不写死任何人的资源 ID');
{
  const body = stripComments(wrangler);
  for (const id of OWN_IDS) {
    ok(`不含本项目账号的 ID（${id.slice(0, 8)}…）`, !wrangler.includes(id));
  }
  const uuids = (body.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) || []);
  ok('绑定 ID 一律是占位符（不出现 UUID 形态的写死值）', uuids.length === 0, uuids.join(',') || '—');
  const hex32 = (body.match(/\b[0-9a-f]{32}\b/gi) || []);
  ok('KV 命名空间 ID 也是占位符（不出现 32 位十六进制）', hex32.length === 0, hex32.join(',') || '—');
  ok('也没写死别人的仓库地址', !/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/actions/.test(body));
}

// ===================== 2. 占位符与脚本一一对应 =====================
section('2. 每个占位符都有人管');
{
  const found = placeholdersOf(wrangler);
  const managed = managedList();
  ok('取得到脚本认领的占位符清单', managed.length > 0, `${managed.length} 个`);
  const unknown = found.filter(k => !managed.includes(k));
  ok('wrangler.toml 里没有没人管的占位符', unknown.length === 0, unknown.join(',') || `${found.length} 个`);
  const unused = managed.filter(k => !found.includes(k));
  ok('脚本认领的占位符都在 wrangler.toml 里（不是管了个不存在的）', unused.length === 0, unused.join(',') || '—');
  ok('占位符数量对得上', found.length >= 4, `${found.length} 个：${found.join(',')}`);
}

// ===================== 3~5. 真跑一遍 =====================
const D1_TEST = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const KV_TEST = '11112222333344445555666677778888';

/** 在临时目录里真跑一次脚本，返回渲染后的 wrangler.toml（外加「是否仍是合法 TOML」） */
function runPrepare(env, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ap-wrangler-'));
  const file = join(dir, 'wrangler.toml');
  copyFileSync(join(ROOT, 'wrangler.toml'), file);
  // 只给脚本它需要的环境：不含 CF 凭据，因此不涉及任何云端资源
  const r = spawnSync('python3', [SCRIPT, ...args], {
    cwd: dir,
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      ANYPROXY_SKIP_MIGRATIONS: '1',
      ...env,
    },
    encoding: 'utf8',
  });
  const text = readFileSync(file, 'utf8');
  const parsed = spawnSync('python3', ['-c', 'import sys,tomllib;tomllib.load(open(sys.argv[1],"rb"))', file], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return { code: r.status, log: ((r.stdout || '') + (r.stderr || '')).trim(), text, valid: parsed.status === 0 };
}

section('3. 真跑：d1 模式');
{
  const r = runPrepare({
    STORAGE_BACKEND: 'd1',
    D1_DATABASE_ID: D1_TEST,
    WORKER_NAME: 'my-proxy',
    GITHUB_REPOSITORY: 'alice/any-proxy',
  });
  ok('脚本正常退出', r.code === 0, r.log);
  ok('渲染产物仍是合法 TOML', r.valid);
  ok('D1 的 ID 被换成指定值', r.text.includes(D1_TEST));
  ok('KV 段被整段移除', !r.text.includes('[[kv_namespaces]]'));
  ok('没有占位符残留', placeholdersOf(r.text).length === 0, placeholdersOf(r.text).join(',') || '—');
  ok('Worker 名生效', /^name = "my-proxy"$/m.test(r.text));
  ok('健康检查链接按仓库地址生成', r.text.includes('https://github.com/alice/any-proxy/actions/workflows/healthcheck.yml'));
  // R2 是可选的：账号没开通时不能让部署失败，只能降级
  ok('R2 建不出来就删掉绑定（不卡部署）', !r.text.includes('[[r2_buckets]]') && r.log.includes('R2'));
}

section('4. 真跑：kv 模式');
{
  const r = runPrepare({ STORAGE_BACKEND: 'kv', KV_NAMESPACE_ID: KV_TEST });
  ok('脚本正常退出（kv 模式不需要 D1 的 ID）', r.code === 0, r.log);
  ok('渲染产物仍是合法 TOML', r.valid);
  ok('KV 的 ID 被换成指定值', r.text.includes(KV_TEST));
  ok('D1 段被整段移除', !r.text.includes('[[d1_databases]]'));
  ok('没有占位符残留', placeholdersOf(r.text).length === 0, placeholdersOf(r.text).join(',') || '—');
  ok('没配仓库地址时链接留空，而不是编一个别人的', /GH_ACTIONS_URL = ""/.test(r.text));
}

section('5. 真跑：迁移时磁盘上已经是渲染好的配置');
{
  // 这一条来自一次真事故：脚本把「应用 D1 迁移」排在写盘之前，于是 wrangler 读到的是
  // 还没渲染的占位符，报 name 不合法；而脚本自己那几行日志全是绿的，看着像 wrangler 坏了。
  // 迁移是另一个进程去读磁盘上的文件，所以这里用一个假的 npx 把「它当时看到的文件」
  // 抄下来，直接验那份内容。
  const dir = mkdtempSync(join(tmpdir(), 'ap-wrangler-mig-'));
  const bin = join(dir, 'bin');
  const dump = join(dir, 'seen.toml');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'npx'), '#!/bin/sh\ncat wrangler.toml > "' + dump + '"\nexit 0\n', { mode: 0o755 });
  const file = join(dir, 'wrangler.toml');
  copyFileSync(join(ROOT, 'wrangler.toml'), file);
  const r = spawnSync('python3', [SCRIPT], {
    cwd: dir,
    env: {
      PATH: bin + ':' + (process.env.PATH || '/usr/bin:/bin'),
      STORAGE_BACKEND: 'd1',
      D1_DATABASE_ID: D1_TEST,
      GITHUB_REPOSITORY: 'alice/any-proxy',
    },
    encoding: 'utf8',
  });
  const seen = (() => { try { return readFileSync(dump, 'utf8'); } catch { return ''; } })();
  rmSync(dir, { recursive: true, force: true });

  ok('脚本正常退出', r.status === 0, ((r.stdout || '') + (r.stderr || '')).trim());
  ok('迁移确实被调用了（假 npx 拿到了文件）', seen.length > 0);
  ok('迁移时读到的 D1 ID 已经是真值', seen.includes(D1_TEST));
  ok('迁移时读到的配置里没有占位符', placeholdersOf(seen).length === 0, placeholdersOf(seen).join(',') || '—');
  // 顺序本身也钉一下：写盘必须排在迁移之前，否则上面三条迟早被改回去
  const atWrite = script.indexOf('fh.write(text)');
  const atMigrate = script.indexOf("'migrations', 'apply'");
  ok('写盘语句排在迁移之前（不是靠巧合）', atWrite > 0 && atMigrate > 0 && atWrite < atMigrate,
    `write@${atWrite} / migrate@${atMigrate}`);
}

section('6. 真跑：本地模式');
{
  const r = runPrepare({ GITHUB_REPOSITORY: '' }, ['--local']);
  ok('本地模式不碰云端也能渲染', r.code === 0, r.log);
  ok('渲染产物仍是合法 TOML', r.valid);
  ok('没有占位符残留', placeholdersOf(r.text).length === 0, placeholdersOf(r.text).join(',') || '—');
  ok('本地模式不跑迁移、不联网建资源', !r.log.includes('migrations') && !r.log.includes('已创建'));
  ok('R2 绑定在本地保留（wrangler dev 用得上）', r.text.includes('[[r2_buckets]]'));
}

// ===================== 7. 部署流程接上了 =====================
section('7. 部署流程把变量接进了脚本');
{
  ok('部署前仍会跑一次渲染脚本', workflow.includes('prepare-deploy.py'));
  for (const v of ['WORKER_NAME', 'D1_DATABASE_ID', 'KV_NAMESPACE_ID', 'R2_BUCKET_NAME', 'GH_ACTIONS_URL']) {
    ok(`${v} 可从仓库 Variables 覆盖`, new RegExp(`${v}: \\$\\{\\{ vars\\.${v} \\}\\}`).test(workflow));
  }
}

// ===================== 8. 脚本自身的健壮性 =====================
section('8. 渲染脚本自己别踩坑');
{
  // CF 的 v4 接口失败时也可能回 200：只看 result 会把「权限不够」读成「一个资源都没有」，
  // 脚本转头去新建，撞上重名错误，而真正的线索被吞掉了
  ok('接口返回 success:false 时当场报错', /get\('success'\) is False/.test(script));
  // R2 列表返回 {"result":{"buckets":[...]}}，D1 / KV 返回 {"result":[...]}。
  // 照搬 cfList 会遍历到一个 dict 的键名 —— 「桶明明在」被判成不存在，然后误降级
  ok('R2 列表按 result.buckets 解包（结构与 D1/KV 不同）',
    /result\.get\('buckets'\)/.test(script) && !/cfList\('r2\/buckets'\)/.test(script));
  ok('拿不到存储 ID 时报错要点名变量与解决办法', /拿不到 %s/.test(script) && script.includes('Variables'));
  ok('ID 解析成空值不会被当成成功渲染出去', /解析结果为空/.test(script));
}

// ===================== 9. 文档不再教人抄 ID =====================
section('9. 文档里不再出现写死的 ID');
{
  for (const doc of ['README.md', 'docs/11-新手部署手把手.md', 'docs/05-部署上线.md']) {
    let text = '';
    try { text = read(doc); } catch { /* 文档改名不算失败，跳过 */ }
    const hit = OWN_IDS.filter(id => text.includes(id));
    ok(`${doc} 不含本项目账号的 ID`, hit.length === 0, hit.join(',') || '—');
  }
}

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);
console.log(`部署形态（wrangler.toml 渲染）：${pass + fail} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：' + failures.join('、')); process.exit(1); }
