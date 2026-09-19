/**
 * 线上面板体检（只在 GitHub Actions 里跑 —— 因为只有 CI 拿得到管理口令）。
 *
 * 只读：遍历 API 目录里的 GET 类接口与面板页本身，把非 200 的连同错误摘要打印出来。
 * 一个写操作都不做：诊断不该顺手改用户的数据。
 *
 * 用法：
 *   PROXY_HOST=xxx PASSWORD=yyy node .github/scripts/diag-panel.mjs
 */
import { API_CATALOG } from '../../src/api-catalog.js';

const HOST = process.env.PROXY_HOST || '';
const PASSWORD = process.env.PASSWORD || '';
if (!HOST || !PASSWORD) { console.error('需要 PROXY_HOST 与 PASSWORD'); process.exit(1); }
const ORIGIN = 'https://' + HOST;

let COOKIE = '';

async function call(method, path, body) {
  const res = await fetch(ORIGIN + path, {
    method,
    headers: { cookie: COOKIE, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function main() {
  const login = await call('POST', '/__api/login', { password: PASSWORD });
  let ok = false;
  try { ok = JSON.parse(login.text).ok === true; } catch { /* 非 JSON 即为失败 */ }
  const sc = login.headers.get('set-cookie') || '';
  const m = sc.match(/(ap_auth=[^;]+)/);
  console.log('登录 → HTTP', login.status, '| ok =', ok, '| 拿到会话 =', !!m);
  console.log('     body:', login.text.slice(0, 160).replace(/\s+/g, ' '));
  if (!ok || !m) { console.error('登录没成功，后面的结果不可信，停'); process.exit(2); }
  COOKIE = m[1];

  // ---- GET 类接口逐个打 ----
  const paths = new Set(['/__admin']);
  for (const g of API_CATALOG) {
    for (const it of (g.items || [])) {
      const kind = it.kind || (it.method === 'GET' ? 'query' : 'action');
      if (kind === 'action') continue;          // 只读体检，动作类一律不碰
      if (it.path.includes('<id>')) continue;   // 缺参数，单列没意义
      paths.add(it.path);
    }
  }

  console.log(`\n=== GET 类目标 ${paths.size} 个：只列不正常的 ===`);
  const bad = [];
  for (const p of paths) {
    try {
      const r = await call('GET', p + (p.includes('?') ? '&' : '?') + 't=' + Date.now());
      const isHtml = r.text.trimStart().startsWith('<');
      if (r.status !== 200) {
        bad.push(`${String(r.status).padEnd(5)} ${p}  ${r.text.slice(0, 150).replace(/\s+/g, ' ')}`);
      } else if (isHtml && p.startsWith('/__api/')) {
        bad.push(`${String(r.status).padEnd(5)} ${p}  返回的是 HTML —— 被伪装页拦了`);
      }
    } catch (e) {
      bad.push(`EXC   ${p}  ${String(e && e.message).slice(0, 120)}`);
    }
  }
  for (const b of bad) console.log('  ' + b);
  console.log('  —— 以上共', bad.length, '条');

  // ---- 面板页本身 ----
  console.log('\n=== 面板页 ===');
  const home = await call('GET', '/__admin?t=' + Date.now());
  console.log('  /__admin →', home.status, home.text.length + 'B');
  for (const needle of ['data-key', 'initModeBar', '写回', '运行模式', 'script']) {
    console.log(`    含「${needle}」: ${home.text.includes(needle)}`);
  }

  // ---- 唯一允许的写：只读探测 ----
  console.log('\n=== 存储探测（只读）===');
  const probe = await call('POST', '/__api/storage', { action: 'probe' });
  console.log('  probe →', probe.status, probe.text.slice(0, 300).replace(/\s+/g, ' '));
}

await main();
