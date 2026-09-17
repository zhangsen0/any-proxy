/**
 * 部署后线上冒烟：针对任意已部署的 Any-Proxy 实例跑一遍主题与配置接口。
 *
 * 用法：
 *   node tools/check-live.mjs <base-url> <password>
 *   BASE_URL=https://xxx.workers.dev LIVE_PASSWORD=xxx node tools/check-live.mjs
 *
 * 设计约定（与项目其余 check-*.mjs 一致）：
 *   - 只用 Node 内置模块，零依赖；
 *   - 不内置任何域名 / 口令，全部由命令行或环境变量传入；
 *   - 只做「读 + 可回滚的写」，测试结束会把主题配置恢复为 aurora 默认。
 */
const BASE = (process.argv[2] || process.env.BASE_URL || '').replace(/\/+$/, '');
const PASSWORD = process.argv[3] || process.env.LIVE_PASSWORD || '';

if (!BASE || !PASSWORD) {
  console.error('用法: node tools/check-live.mjs <base-url> <password>');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, extra) {
  pass++;
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
}
function bad(name, detail) {
  fail++;
  failures.push(`${name}：${detail}`);
  console.log(`  ✗ ${name} — ${detail}`);
}
function assert(name, cond, detail) {
  cond ? ok(name) : bad(name, detail || '断言失败');
}
function section(t) {
  console.log(`\n[${t}]`);
}

let COOKIE = '';

async function req(path, init) {
  const headers = Object.assign({ 'User-Agent': 'any-proxy-live-check/1.0' }, init && init.headers);
  if (COOKIE) headers.Cookie = COOKIE;
  const res = await fetch(BASE + path, Object.assign({}, init, { headers }));
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    COOKIE = setCookie
      .split(/,(?=\s*[^;]+=)/)
      .map((c) => c.split(';')[0].trim())
      .join('; ');
  }
  return res;
}

async function getJson(path) {
  const res = await req(path);
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text), text };
  } catch {
    return { status: res.status, data: null, text };
  }
}

async function main() {
  console.log(`线上校验目标：${BASE}`);

  section('登录');
  const login = await req('/__api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert('登录接口返回 200', login.status === 200, `实际 ${login.status}`);
  assert('登录后拿到会话 Cookie', /\bap_auth=/.test(COOKIE) || /\bauth=/.test(COOKIE), `cookie=${COOKIE.slice(0, 40)}`);

  section('管理页渲染');
  const admin = await req('/__admin');
  const html = await admin.text();
  assert('管理页 200', admin.status === 200, `实际 ${admin.status}`);
  assert('html 上带 data-theme', /<html[^>]*data-theme="/.test(html), '未找到 data-theme');
  assert('注入了主题变量表', /--bg\s*:/.test(html), '未找到 --bg 变量');
  assert('出现「外观主题」分区', html.includes('外观主题'), '缺少外观主题分区');
  assert('出现「配置」分区', html.includes('配置'), '缺少配置分区');

  section('主题清单');
  const list = await getJson('/__api/themes');
  assert('主题接口 200', list.status === 200, `实际 ${list.status}`);
  assert('主题接口返回 JSON', !!list.data, '非 JSON 响应');
  // /__api/themes 的返回结构：{ ok, themes:[{id,name,custom,...}], 其余为平铺的配置字段 }
  const themes = (list.data && list.data.themes) || [];
  const presets = themes.filter((t) => !t.custom);
  assert('预设主题 10 套', presets.length === 10, `实际 ${presets.length} 套`);
  const ids = presets.map((t) => t.id || t);
  console.log(`    预设：${ids.join(', ')}`);

  section('预设主题逐套渲染');
  for (const id of ids) {
    const post = await req('/__api/themes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ default_theme: id }),
    });
    if (post.status !== 200) {
      bad(`切换到 ${id}`, `HTTP ${post.status}`);
      continue;
    }
    const page = await req('/__admin');
    const body = await page.text();
    const hit = new RegExp(`data-theme="${id}"`).test(body);
    const scoped = body.includes(`:root[data-theme="${id}"]`) || body.includes(`[data-theme="${id}"]`);
    hit && scoped ? ok(`${id} 生效且带作用域样式`) : bad(`${id}`, `data-theme=${hit} scoped=${scoped}`);
  }

  section('自定义主题');
  const customId = 'live-check';
  const create = await req('/__api/themes/custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: customId, name: '线上自检', vars: { '--bg': '#101010', '--accent': '#00ffcc' } }),
  });
  assert('新增自定义主题 200', create.status === 200, `实际 ${create.status}`);
  const afterCreate = await getJson('/__api/themes');
  const customs = ((afterCreate.data && afterCreate.data.themes) || []).filter((t) => t.custom);
  assert('自定义主题出现在清单里', customs.some((c) => c.id === customId), `custom=${JSON.stringify(customs.map((c) => c.id))}`);

  const pageWithCustom = await req('/__admin');
  const customHtml = await pageWithCustom.text();
  assert('管理页渲染出自定义主题变量', customHtml.includes('#00ffcc') || customHtml.includes('#101010'), 'CSS 里没有自定义变量');

  const del = await req(`/__api/themes/custom/${encodeURIComponent(customId)}`, { method: 'DELETE' });
  assert('删除自定义主题 200', del.status === 200, `实际 ${del.status}`);
  const afterDel = await getJson('/__api/themes');
  const customs2 = ((afterDel.data && afterDel.data.themes) || []).filter((t) => t.custom);
  assert('删除后不再出现在清单', !customs2.some((c) => c.id === customId), `custom=${JSON.stringify(customs2.map((c) => c.id))}`);

  section('CSS 注入防护');
  const evil = await req('/__api/themes/custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'evil-check',
      name: '注入测试',
      vars: { '--x': 'red;}</style><script>alert(1)</script>' },
    }),
  });
  const evilPage = await req('/__admin');
  const evilHtml = await evilPage.text();
  assert('恶意内容没有被原样注入页面', !evilHtml.includes('<script>alert(1)</script>'), '页面出现可执行脚本');
  await req('/__api/themes/custom/evil-check', { method: 'DELETE' });
  void evil;

  section('自动轮换');
  const rot = await req('/__api/themes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rotate_mode: 'interval', rotate_interval_minutes: 60, rotate_pool: 'aurora,neon,terminal' }),
  });
  assert('保存轮换配置 200', rot.status === 200, `实际 ${rot.status}`);
  const rotList = await getJson('/__api/themes');
  const cfg = rotList.data || {};
  assert('轮换模式已写入', cfg.rotate_mode === 'interval', `实际 ${cfg.rotate_mode}`);
  assert('轮换池已写入', String(cfg.rotate_pool || '').includes('neon'), `实际 ${cfg.rotate_pool}`);
  const r1 = await getJson('/__api/themes');
  const r2 = await getJson('/__api/themes');
  const pick = (d) => d && d.data && d.data.rotating_theme;
  const v1 = pick(r1);
  const v2 = pick(r2);
  assert('同一时间片轮换结果一致', JSON.stringify(v1) === JSON.stringify(v2), `${JSON.stringify(v1)} vs ${JSON.stringify(v2)}`);
  assert('轮换结果落在配置池内', ['aurora', 'neon', 'terminal'].includes(String(v1)), `实际 ${JSON.stringify(v1)}`);
  console.log(`    当前轮换命中：${JSON.stringify(v1)}`);

  section('访问统计接口');
  const statsCfg = await getJson('/__api/stats-config');
  assert('统计配置可读', statsCfg.status === 200, `实际 ${statsCfg.status}`);
  const stats = await getJson('/__api/stats?days=7');
  assert('统计数据可读', stats.status === 200, `实际 ${stats.status}`);

  section('恢复默认');
  const restore = await req('/__api/themes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ default_theme: 'aurora', rotate_mode: 'off', rotate_pool: '', rotate_interval_minutes: 60 }),
  });
  assert('恢复为默认主题', restore.status === 200, `实际 ${restore.status}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('线上校验全部通过');
}

main().catch((e) => {
  console.error('校验脚本异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
