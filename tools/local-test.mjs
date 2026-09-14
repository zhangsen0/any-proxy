#!/usr/bin/env node
/**
 * 本地对比验证：把同一组请求分别打给「重构前」和「重构后」两个本地服务。
 *
 * 判定基准是**期望行为**，而不是旧实现。
 * 旧实现本身就是本次要修的 bug 来源，若拿它当基准，会把「改对了」误判成「改错了」。
 * 因此每个用例用同一套 expect() 分别评估旧 / 新，再按结果分类：
 *
 *   旧 FAIL + 新 PASS  → 已修复    （预期：正是要修的问题）
 *   旧 PASS + 新 PASS  → 一致通过  （重构没碰坏）
 *   旧 PASS + 新 FAIL  → 回归!     （必须修）
 *   旧 FAIL + 新 FAIL  → 未修复!   （必须修）
 *
 * 用法（服务需先自行启动，见 tools/local-dev.mjs 与 tools/dev-fixture.mjs）：
 *   node tools/dev-fixture.mjs 8799
 *   node tools/old-server.mjs 8791          # 重构前实现（可选）
 *   SEED_SITES="fix=http://127.0.0.1:8799" node tools/local-dev.mjs 8795
 *   node tools/local-test.mjs http://127.0.0.1:8791 http://127.0.0.1:8795 http://127.0.0.1:8799
 *
 * 只跑新版（无旧服务）时，旧列显示为「—」，仍按期望行为判定新版。
 *
 * 说明：用 node:http 发请求，绕开本机 HTTP_PROXY 对 localhost 的干扰。
 */
import http from 'node:http';

const OLD = process.argv[2] || '';
const NEW = process.argv[3] || 'http://127.0.0.1:8795';
const FIXTURE = process.argv[4] || 'http://127.0.0.1:8799';
const SITE = 'fix';
const P = `/p/${SITE}`;
const X = `${P}/__x`;
// 脚本上下文的 URL 一律输出绝对地址（单参数 new URL 只接受绝对 URL），故期望值带 origin
const O = NEW ? NEW.replace(/\/+$/, '') : '';

function req(base, path, opts = {}) {
  if (!base) return Promise.resolve(null);
  return new Promise((resolve) => {
    let u;
    try { u = new URL(path, base); } catch { resolve(null); return; }
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: opts.method || 'GET', headers: opts.headers || {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: body }));
    });
    r.on('error', () => resolve(null));
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

const NAV = { 'sec-fetch-dest': 'document', accept: 'text/html' };
const bool = (ok, note) => ({ ok: !!ok, note: note || '' });

/**
 * 用例表。expect 描述「正确行为」，与实现无关。
 * 每个 expect 返回 { ok, note }，note 用于失败时说明实际情况。
 */
const cases = [
  // ---------- JS：本次 bug 的核心 ----------
  {
    name: 'JS：//# sourceMappingURL 标记保持原样',
    path: `${P}/app.js`,
    expect: r => bool(
      r.text.includes('//# sourceMappingURL=app.js.map'),
      r.text.includes('https://#') ? '被改写成 https://# …（脚本语法损坏）' : '缺少 sourceMappingURL',
    ),
  },
  {
    name: 'JS：行注释不被当成协议相对 URL',
    path: `${P}/app.js`,
    expect: r => bool(
      r.text.includes('// TODO: 这行注释不能被当成协议相对 URL'),
      '注释被改写，脚本语法损坏',
    ),
  },
  {
    name: 'JS：全文不出现 https://# 片段',
    path: `${P}/app.js`,
    expect: r => bool(!r.text.includes('https://#'), '存在被污染的 https://# 片段'),
  },
  {
    name: 'JS：同源绝对 URL → 主通道（绝对地址）',
    path: `${P}/app.js`,
    expect: r => bool(r.text.includes(`"${O}${P}/api/ping"`), '未映射到主通道：' + (r.text.match(/ENDPOINT = "[^"]*"/) || [''])[0]),
  },
  {
    name: 'JS：同源协议相对 URL → 主通道（绝对地址）',
    path: `${P}/app.js`,
    expect: r => bool(r.text.includes(`"${O}${P}/api/mirror"`), '未映射到主通道：' + (r.text.match(/MIRROR = "[^"]*"/) || [''])[0]),
  },
  {
    name: 'JS：跨域协议相对 URL → __x 通道（绝对地址）',
    path: `${P}/app.js`,
    expect: r => bool(r.text.includes(`${O}${X}/cdn.example.org/lib.js`), '未映射到跨域通道'),
  },
  {
    name: 'JS：跨域绝对 URL → __x 通道（绝对地址）',
    path: `${P}/app.js`,
    expect: r => bool(r.text.includes(`${O}${X}/cdn.example.org/abs.js`), '未映射到跨域通道'),
  },

  // ---------- HTML ----------
  {
    name: 'HTML：站内链接/脚本/样式走主通道',
    path: `${P}/`, headers: NAV,
    expect: r => {
      const a = r.text.includes(`href="${P}/next/page?q=1"`);
      const s = r.text.includes(`src="${P}/app.js"`);
      const c = r.text.includes(`href="${P}/style.css"`);
      return bool(a && s && c, `link=${a} script=${s} css=${c}`);
    },
  },
  {
    name: 'HTML：移除 <base> 与 integrity',
    path: `${P}/`, headers: NAV,
    expect: r => bool(
      !/<base\b/i.test(r.text) && !/\sintegrity=/i.test(r.text),
      `base=${/<base\b/i.test(r.text)} integrity=${/\sintegrity=/i.test(r.text)}`,
    ),
  },
  {
    name: 'HTML：srcset 逐项重写',
    path: `${P}/`, headers: NAV,
    expect: r => bool(
      r.text.includes(`${P}/img/s.png 1x`) && r.text.includes(`${P}/img/l.png 2x`),
      'srcset 未逐项重写',
    ),
  },
  {
    name: 'HTML：协议相对资源走跨域通道',
    path: `${P}/`, headers: NAV,
    expect: r => bool(r.text.includes(`${X}/cdn.example.org/a.png`), '未映射到跨域通道'),
  },
  {
    name: 'HTML：站外绝对链接走跨域通道',
    path: `${P}/`, headers: NAV,
    expect: r => bool(r.text.includes(`${X}/cdn.example.org/abs`), '未映射到跨域通道'),
  },
  {
    name: 'HTML：导航文档注入运行时脚本',
    path: `${P}/`, headers: NAV,
    expect: r => bool(r.text.includes('MutationObserver'), '未注入运行时脚本'),
  },

  // ---------- CSS ----------
  {
    name: 'CSS：url(/...) 走主通道',
    path: `${P}/style.css`,
    expect: r => bool(r.text.includes(`url(${P}/img/bg.png)`), '未走主通道'),
  },
  {
    name: 'CSS：url(https://外域) 走跨域通道',
    path: `${P}/style.css`,
    expect: r => bool(r.text.includes(`${X}/cdn.example.org/img/x.png`), '未走跨域通道'),
  },
  {
    name: 'CSS：url(//外域) 走跨域通道',
    path: `${P}/style.css`,
    expect: r => bool(r.text.includes(`${X}/cdn.example.org/img/y.png`), '未走跨域通道'),
  },
  {
    name: 'CSS：注释里的斜杠不被改写',
    path: `${P}/style.css`,
    expect: r => bool(r.text.includes('/* // 这是注释里的斜杠，不能被改写 */'), '注释被改写'),
  },

  // ---------- 缓存与接口 ----------
  {
    name: '缓存：指纹资源 immutable 长缓存',
    path: `${P}/app.8f2c1b3d.js`,
    expect: r => {
      const cc = r.headers['cache-control'] || '';
      return bool(cc.includes('31536000') && cc.includes('immutable'), 'cache-control=' + cc);
    },
  },
  {
    name: '缓存：HTML 不缓存',
    path: `${P}/`, headers: NAV,
    expect: r => bool((r.headers['cache-control'] || '').includes('no-store'), 'cache-control=' + (r.headers['cache-control'] || '')),
  },
  {
    name: '管理：站点列表返回已登记的站点',
    path: '/__api/sites',
    expect: r => {
      try {
        const j = JSON.parse(r.text);
        const list = j.sites || j;
        return bool(Array.isArray(list) && list.some(s => s.id === SITE), 'ids=' + JSON.stringify((list || []).map(s => s.id)));
      } catch { return bool(false, '非 JSON：' + r.text.slice(0, 60)); }
    },
  },
  {
    name: '鉴权：未登录写接口返回 401',
    path: '/__api/sites', method: 'POST', headers: { 'content-type': 'application/json' },
    expect: r => bool(r.status === 401, 'status=' + r.status),
  },
];

/** 对一次响应求判定结果；服务不可用时返回 null */
function judge(r, expect) {
  if (!r) return { state: 'DOWN', note: '服务不可用' };
  if (r.status === 0) return { state: 'FAIL', note: '请求错误' };
  let out;
  try { out = expect(r); } catch (e) { return { state: 'FAIL', note: '判定异常 ' + e.message }; }
  return { state: out.ok ? 'PASS' : 'FAIL', note: out.note || '' };
}

function classify(o, n) {
  if (!o) return { label: '—', bad: n.state === 'FAIL' };
  if (o.state === 'PASS' && n.state === 'PASS') return { label: '一致通过', bad: false };
  if (o.state === 'FAIL' && n.state === 'PASS') return { label: '已修复', bad: false };
  if (o.state === 'PASS' && n.state === 'FAIL') return { label: '回归!', bad: true };
  return { label: '未修复!', bad: true };
}

const pad = (s, n) => {
  const w = [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

console.log('\n对比验证（fixture = ' + FIXTURE + '）');
console.log('  old = ' + (OLD || '(未提供)') + '   重构前实现');
console.log('  new = ' + NEW + '   当前实现');
console.log('  基准 = 期望行为（不以旧实现为准）\n');
console.log(pad('用例', 34) + pad('old', 7) + pad('new', 7) + pad('结论', 10) + '备注');
console.log('-'.repeat(100));

let bad = 0, fixed = 0, down = 0;
for (const c of cases) {
  const ro = OLD ? await req(OLD, c.path, { method: c.method, headers: c.headers }) : null;
  const rn = await req(NEW, c.path, { method: c.method, headers: c.headers });
  const o = judge(ro, c.expect);
  const n = judge(rn, c.expect);
  const cls = classify(o, n);
  if (cls.bad) bad++;
  if (cls.label === '已修复') fixed++;
  if (n.state === 'DOWN') down++;
  const note = n.state === 'FAIL' ? n.note : (o.state === 'FAIL' && n.state === 'PASS' ? '(旧: ' + o.note + ')' : '');
  console.log(pad(c.name, 34) + pad(OLD ? o.state : '—', 7) + pad(n.state, 7) + pad(cls.label, 10) + note);
}

console.log('-'.repeat(100));
console.log(`合计 ${cases.length} 项　已修复 ${fixed}　需处理 ${bad}${down ? `　(new 服务不可用 ${down})` : ''}`);
if (down) { console.log('\nnew 服务未启动，结果无效。'); process.exit(2); }
console.log(bad ? '\n存在回归或未修复项，见上表。' : '\nnew 全部符合期望行为。');
process.exit(bad ? 1 : 0);
