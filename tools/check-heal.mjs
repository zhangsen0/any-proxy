#!/usr/bin/env node
/**
 * 前缀丢失自愈自检（无需网络）。
 *
 * 锁死一个真实故障：客户端把代理地址当 base，与以 / 开头的绝对路径做标准 URL 拼接，
 * 按 URL 规范前导斜杠表示「从域名根开始」，base 里的 /p/<id> 被整个吃掉：
 *   new URL("/play/video/x", "https://proxy/p/uhdnow")  ->  https://proxy/play/video/x
 *
 * 现场（Emby / VidHub）：DirectStreamUrl 是 /play/video/...，客户端据此拼出的播放
 * 地址脱离代理命名空间，请求落到代理根上 404，播放器反复重试、流量打满却播不了。
 *
 * 自愈只在「站点恰好一个」且「路径不像代理自身命名空间」且「带查询串」时生效 ——
 * 条件放得越宽越容易误伤，所以这里两个方向都要钉住：该救的救到，不该碰的一律不碰。
 *
 * 用法：node tools/check-heal.mjs
 */
import { handleRequest } from '../src/router.js';
import { bindRuntime } from '../src/runtime.js';
import { invalidateSite } from '../src/sites.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
}

const TOKEN = 'T'.repeat(32);

/** 建一个内存版站点存储 + 运行期 */
function makeEnv(sites, password = 'dev') {
  const mem = new Map();
  for (const s of sites) {
    mem.set('site:' + s.id, JSON.stringify({
      id: s.id, name: s.id, scheme: 'https', host: s.host, port: null,
      target: 'https://' + s.host, created_at: new Date().toISOString(),
    }));
  }
  const kv = {
    async list(o = {}) {
      const p = o.prefix || '';
      return { keys: [...mem.keys()].filter(k => k.startsWith(p)).map(name => ({ name })), list_complete: true };
    },
    async get(k) { return mem.has(k) ? mem.get(k) : null; },
    async put(k, v) { mem.set(k, v); },
    async delete(k) { mem.delete(k); },
  };
  return { PASSWORD: password, SITES: kv };
}

/** 用可控 fetch 接住上游请求，返回它实际打到的源站 URL */
function stubFetch() {
  const seen = [];
  globalThis.fetch = async (u) => {
    seen.push(String(u));
    return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  return seen;
}

/** 单个 Site 的 env（自愈必须生效的前提） */
const oneSite = makeEnv([{ id: 'uhdnow', host: 'v1.uhdnow.com' }]);
/** 多站点的 env（无法判断回填谁，自愈必须放弃） */
const manySites = makeEnv([
  { id: 'uhdnow', host: 'v1.uhdnow.com' },
  { id: 'other', host: 'other.example' },
]);

async function call(env, path) {
  bindRuntime(env);
  // sites.js 的站点缓存是进程内全局的、不按绑定区分 —— 生产环境永远只有一组绑定，
  // 所以这不是缺陷；但本脚本要在 oneSite / manySites / env 之间来回切同一个进程，
  // 不清的话「多站点必须放弃」会读到上一个 env 的站点列表而误判成单站点。
  invalidateSite();
  const seen = stubFetch();
  const out = await handleRequest(new Request('https://proxy.example' + path, { method: 'GET' }), env, {});
  return { status: out.status, seen };
}

console.log('\n[1] 该救的必须救到：前缀丢失的 Emby API 请求');
{
  bindRuntime(oneSite);
  const r = await call(oneSite, '/play/video/abc?api_key=' + TOKEN);
  check('播放地址被挂回前缀',
    r.seen[0] === 'https://v1.uhdnow.com/play/video/abc?api_key=' + TOKEN, r.seen[0]);
}
{
  bindRuntime(oneSite);
  const r = await call(oneSite, '/Items/Counts?api_key=' + TOKEN);
  check('Items 接口被挂回前缀',
    r.seen[0] === 'https://v1.uhdnow.com/Items/Counts?api_key=' + TOKEN, r.seen[0]);
}
{
  bindRuntime(oneSite);
  const r = await call(oneSite, '/Users/01M0N4DGWTT8TXQ4Y392JD88VD/Items/Resume?Limit=12&api_key=' + TOKEN);
  check('Users 深层接口被挂回前缀',
    r.seen[0] === 'https://v1.uhdnow.com/Users/01M0N4DGWTT8TXQ4Y392JD88VD/Items/Resume?Limit=12&api_key=' + TOKEN,
    r.seen[0]);
}
{
  bindRuntime(oneSite);
  const r = await call(oneSite, '/System/Info/Public?api_key=' + TOKEN);
  check('System 接口被挂回前缀',
    r.seen[0] === 'https://v1.uhdnow.com/System/Info/Public?api_key=' + TOKEN, r.seen[0]);
}
{
  bindRuntime(oneSite);
  const r = await call(oneSite, '/emby/play/video/abc?api_key=' + TOKEN);
  check('带 /emby 前缀的形态同样被救回',
    r.seen[0] === 'https://v1.uhdnow.com/emby/play/video/abc?api_key=' + TOKEN, r.seen[0]);
}

console.log('\n[2] 不该碰的一律不碰：代理自身命名空间');
{
  bindRuntime(oneSite);
  const r = await call(oneSite, '/p/uhdnow/System/Info/Public');
  check('正常的 /p/<id> 路径不重复套前缀（无查询串也不受影响）',
    r.seen[0] === 'https://v1.uhdnow.com/System/Info/Public', r.seen[0]);
}
// 这些路径归代理自己（vless 引擎 / 面板 / 临时订阅 / 管理接口）管。
// 目的只是确认「自愈没有把它们当站点 API 抢走」，所以只看有没有回源到目标站；
// /edt 会进 vless 引擎、Node 的 crypto 不支持其 MD5 摘要，故这里容忍它抛错。
for (const p of ['/edt', '/tsub/abc', '/admin', '/login', '/sub', '/__api/sites', '/favicon.ico', '/robots.txt']) {
  const seen = stubFetch();
  try {
    await handleRequest(new Request('https://proxy.example' + p + '?x=1', { method: 'GET' }), oneSite, {});
  } catch { /* vless 引擎在 Node 下抛错属预期 */ }
  check('代理自身路径不被自愈抢走：' + p,
    !seen.some(u => u.includes('v1.uhdnow.com')) || seen.length === 0,
    seen[0] || '未回源到目标站');
}

console.log('\n[3] 条件收窄：不该救的场景必须放弃');
{
  bindRuntime(oneSite);
  const r = await call(oneSite, '/play/video/abc');       // 无查询串
  check('无查询串不接管（避免误吞正常导航）', r.seen.length === 0, r.seen[0] || '未回源');
}
{
  bindRuntime(manySites);
  const r = await call(manySites, '/play/video/abc?api_key=' + TOKEN);  // 多站点
  check('配置了多个站点时放弃（无法判断回填谁）', r.seen.length === 0, r.seen[0] || '未回源');
}
{
  bindRuntime(oneSite);
  const r = await call(oneSite, '/?x=1');                 // 根路径
  check('根路径不接管', r.seen.length === 0, r.seen[0] || '未回源');
}

console.log('\n[4] 伪装开启时同样生效');
{
  const env = makeEnv([{ id: 'uhdnow', host: 'v1.uhdnow.com' }]);
  bindRuntime(env);
  // 走 saveConfig 而不是直接写 KV：readConfig 有模块级缓存，只有 saveConfig 会失效它
  const dg = await import('../src/disguise.js');
  const saved = await dg.saveConfig(env, { enabled: true, path: '/secret-entry', template: 'maintenance', title: 't', strict: true });
  check('伪装配置写入成功（前置条件）', !saved.error, saved.error || 'ok');
  bindRuntime(env);
  check('伪装已激活（前置条件）', dg.isActive(await dg.readConfig(env)), 'isActive');
  const r = await call(env, '/play/video/abc?api_key=' + TOKEN);
  check('伪装开启下前缀丢失的播放地址仍被救回',
    r.seen[0] === 'https://v1.uhdnow.com/play/video/abc?api_key=' + TOKEN, r.seen[0] || '未回源');
  // 陌生人访问根路径应当拿到伪装页，且绝不回源到目标站（伪装首页本就是 200）
  const seen2 = stubFetch();
  const out2 = await handleRequest(new Request('https://proxy.example/', { method: 'GET' }), env, {});
  check('根路径仍走伪装页且不回源', out2.status === 200 && seen2.length === 0,
    'status=' + out2.status + ' 回源=' + seen2.length);
  // 陌生人的未知路径同样只拿到伪装 404，不应被自愈带出站
  const seen3 = stubFetch();
  const out3 = await handleRequest(new Request('https://proxy.example/whatever', { method: 'GET' }), env, {});
  check('陌生人未知路径仍伪装 404 且不回源', out3.status === 404 && seen3.length === 0,
    'status=' + out3.status + ' 回源=' + seen3.length);
}

console.log(`\n前缀自愈自检：通过 ${pass}，失败 ${fail}\n`);
if (fail) process.exit(1);
