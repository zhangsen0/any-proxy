/**
 * 「CF 用量」选项卡的渲染层：把 /__api/cf-analytics 的聚合结果画成人看的东西。
 * 数据直接来自 Cloudflare 边缘统计（GraphQL），与管理面板的「数据驾驶舱」
 * （本机 D1 统计）互为补充：那边回答「我的站点被谁访问」，这边回答
 * 「当前 Worker 绑定的 CF 账户基础用量」——不用登录 CF 控制台。
 *
 * 与 stats-ui.js 共用同一套纪律：
 *   1. 服务端渲染阶段不发任何请求，数据一律等页面跑起来再异步取；
 *   2. 图表不引第三方库：按天柱状图用等宽柱子按百分比高度画；
 *   3. 注入出去的脚本必须自给自足（esc / fmt 就地定义，闭包不引用模块 import），
 *      且渲染产物会进 check 的裸沙盒真跑。
 */

import { renderToolItem } from './config-ui.js';
import { flatCatalog } from './api-catalog.js';
import { KEEP_NAMES_SHIM } from './config-ui.js';

/** 每日趋势可切换的指标：下拉选项与格式化方式都只在这里定义（与 stats-ui 同套路） */
const CF_TREND_METRICS = [
  { key: 'requests', label: '请求数', fmt: 'int' },
  { key: 'bytes', label: '带宽', fmt: 'bytes' },
  { key: 'cachedBytes', label: '缓存字节', fmt: 'bytes' },
  { key: 'uniques', label: '唯一访客', fmt: 'int' },
];
const CF_TREND_METRICS_JSON = JSON.stringify(CF_TREND_METRICS);

/** 状态码分组着色：badge 颜色按码段分，播放链路常见码单独标 */
const CF_STATUS_KLASS = {
  200: 'ok', 206: 'ok', 301: 'nav', 302: 'nav', 304: 'nav',
  400: 'warn', 401: 'warn', 403: 'warn', 404: 'warn', 418: 'warn', 429: 'warn',
  499: 'abort', 500: 'bad', 502: 'bad', 503: 'bad', 504: 'bad',
};
const CF_STATUS_KLASS_JSON = JSON.stringify(CF_STATUS_KLASS);

/** 目录项渲染（原始 JSON）——路径与文案只在目录里写一次 */
function toolById(id) {
  const item = flatCatalog().find(i => i.id === id);
  return item ? renderToolItem(item) : '';
}

/** 趋势指标下拉：选项来自 CF_TREND_METRICS，默认取第一项 */
function cfMetricOptions() {
  return CF_TREND_METRICS.map((m, i) =>
    `<option value="${m.key}"${i === 0 ? ' selected' : ''}>${m.label}</option>`
  ).join('');
}

/** 驾驶舱主体：KPI + 每日趋势 + 状态码分布 + Top 路径。全部空壳，数值由 CF_JS 填 */
function cfPaneCard() {
  return `<div class="card" id="cfCard" data-pane="edge">
    <h2>Cloudflare 用量驾驶舱</h2>
    <div class="hint" style="margin:-8px 0 var(--sp-3);">直接查 Cloudflare 边缘统计（GraphQL），与本机「数据驾驶舱」互补：不用登录 CF 控制台就能看到当前 Worker 绑定的账户基础用量。数据 5 分钟缓存，只看个大概，别当实时监控。</div>

    <div class="st-bar">
      <div class="st-bar-right">
        <span class="st-stamp" id="cfUpdated"></span>
        <button type="button" class="mini" id="cfRefresh">刷新</button>
      </div>
    </div>

    <div class="st-alert" id="cfAlert" hidden></div>

    <div class="st-kpis" id="cfKpis"></div>

    <div class="st-block">
      <div class="st-block-head">
        <b>每日趋势（近 30 天）</b>
        <select id="cfMetric" class="st-metric">${cfMetricOptions()}</select>
      </div>
      <div class="st-chart" id="cfChart"></div>
      <div class="st-axis" id="cfAxis"></div>
      <div class="st-axis-note" id="cfAxisNote"></div>
    </div>

    <div class="st-block">
      <div class="st-block-head">
        <b>状态码分布（近 24h）</b>
        <span class="st-sub" id="cfStatusNote"></span>
      </div>
      <div class="cf-status" id="cfStatus"></div>
    </div>

    <div class="st-block">
      <div class="st-block-head">
        <b>Top 路径（近 24h）</b>
        <span class="st-sub">按带宽排序，回答「流量打在哪条路由上」</span>
      </div>
      <div class="st-rank" id="cfPaths"></div>
    </div>

    <div class="st-block">
      <div class="st-block-head">
        <b>数据源状态</b>
        <span class="st-sub" id="cfSrcNote"></span>
      </div>
      <div class="cf-src" id="cfSrc"></div>
    </div>

    <details class="cfg-tools"><summary>工具（原始 JSON）</summary>
      ${toolById('cf-analytics')}
    </details>
  </div>`;
}

/** 整个选项卡：驾驶舱卡片本身（无独立设置项，设置 = env 里的 CF secret） */
export function renderCfPane() {
  return cfPaneCard();
}

// ===================== 前端脚本 =====================

function cfInit(CF_TREND_METRICS, CF_STATUS_KLASS) {
  var card = document.getElementById('cfCard');
  if (!card) return;

  var $ = function (sel) { return document.querySelector(sel); };
  var metric = CF_TREND_METRICS[0].key;
  var metricFmts = {};
  CF_TREND_METRICS.forEach(function (m) { metricFmts[m.key] = m.fmt; });
  var loading = false;
  var loaded = false;
  var last = null;   // 最近一次聚合结果：刷新数据源状态时就地重画，不必再打接口

  function fmtInt(n) {
    n = Number(n) || 0;
    return n.toLocaleString('zh-CN');
  }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    var u = ['KB', 'MB', 'GB', 'TB'];
    var i = -1;
    do { n = n / 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
  }
  function fmtMetric(v, m) { return metricFmts[m] === 'bytes' ? fmtBytes(v) : fmtInt(v); }
  function pct(a, b) { return b ? (a / b * 100) : 0; }
  // ⚠️ esc / statusKlass 必须定义在 cfInit **内部**：函数被 toString() 注入浏览器，
  // 闭包里只有它自己声明的变量；从模块 import 的任何东西在浏览器里都是 ReferenceError。
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function statusKlass(code) {
    return CF_STATUS_KLASS[String(code)] || (code >= 500 ? 'bad' : (code >= 400 ? 'warn' : 'nav'));
  }
  function setAlert(text, cls) {
    var el = $('#cfAlert');
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.className = 'st-alert' + (cls ? ' ' + cls : '');
    el.textContent = text;
  }
  function note(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text || '';
  }

  function renderKpis(d) {
    var daily = (d && d.daily) || [];
    var today = daily.length ? daily[daily.length - 1] : null;
    var status = (d && d.status) || [];
    var dayReq = status.reduce(function (a, x) { return a + x.requests; }, 0);
    var worker = (d && d.worker) || null;
    var cacheRate = today && today.requests ? pct(today.cachedRequests, today.requests) : 0;
    var items = [
      { label: '今日请求（UTC）', value: today ? fmtInt(today.requests) : '—',
        sub: today ? '唯一访客 ' + fmtInt(today.uniques) : '暂无' },
      { label: '今日带宽', value: today ? fmtBytes(today.bytes) : '—',
        sub: today ? '缓存 ' + fmtBytes(today.cachedBytes) : '暂无' },
      { label: '今日缓存命中率', value: today ? cacheRate.toFixed(1) + '%' : '—',
        sub: today ? '命中 ' + fmtInt(today.cachedRequests) + ' 次' : '暂无' },
      { label: '近 24h 请求', value: fmtInt(dayReq), sub: '边缘统计口径' },
      { label: 'Worker 请求（30天）', value: worker ? fmtInt(worker.totals.requests) : '—',
        sub: worker ? '脚本 ' + esc(worker.script) : '未配置账户' },
      { label: 'Worker 错误（30天）', value: worker ? fmtInt(worker.totals.errors) : '—',
        sub: worker ? (worker.accountHasOthers ? '账户还有其它脚本' : '仅本脚本') : '—', err: worker && worker.totals.errors > 0 },
    ];
    $('#cfKpis').innerHTML = items.map(function (x) {
      return '<div class="st-kpi"><span class="st-kpi-label">' + x.label + '</span>'
        + '<span class="st-kpi-value' + (x.err ? ' err' : '') + '">' + x.value + '</span>'
        + '<span class="st-kpi-sub">' + x.sub + '</span></div>';
    }).join('');
  }

  function renderChart(d) {
    var daily = (d && d.daily) || [];
    var chart = $('#cfChart');
    var axis = $('#cfAxis');
    if (!daily.length) {
      chart.innerHTML = '<div class="st-empty">近 30 天还没有数据（检查 CF_ZONE_ID 与 token 权限）</div>';
      axis.innerHTML = '';
      note('cfAxisNote', '');
      return;
    }
    var values = daily.map(function (x) { return Number(x[metric]) || 0; });
    var max = Math.max.apply(null, values.concat([1]));
    chart.innerHTML = daily.map(function (x, i) {
      var v = values[i];
      var pctH = Math.max(v > 0 ? 4 : 1.5, Math.round(v / max * 100));
      var tip = x.date + '：请求 ' + fmtInt(x.requests) + ' · 带宽 ' + fmtBytes(x.bytes)
        + ' · 缓存 ' + fmtInt(x.cachedRequests) + ' 次 · 访客 ' + fmtInt(x.uniques);
      return '<i class="st-col' + (v > 0 ? '' : ' zero') + '" style="height:' + pctH + '%" title="' + tip + '"></i>';
    }).join('');
    var step = Math.max(1, Math.ceil(daily.length / 8));
    axis.innerHTML = daily.map(function (x, i) {
      var show = i % step === 0 || i === daily.length - 1;
      return '<span>' + (show ? x.date.slice(5) : '') + '</span>';
    }).join('');
    note('cfAxisNote', '峰值 ' + fmtMetric(max, metric) + '（把鼠标停在柱子上看当天明细）');
  }

  function renderStatus(d) {
    var status = (d && d.status) || [];
    var box = $('#cfStatus');
    if (!status.length) {
      box.innerHTML = '<div class="st-empty">近 24h 没有状态码数据</div>';
      note('cfStatusNote', '');
      return;
    }
    var top = Math.max.apply(null, status.map(function (x) { return x.requests || 0; }).concat([1]));
    box.innerHTML = status.map(function (x) {
      var w = Math.max(2, Math.round((x.requests || 0) / top * 100));
      var k = statusKlass(x.code);
      return '<div class="st-row">'
        + '<div class="st-row-head">'
        + '<span class="st-row-name"><em class="cf-code ' + k + '">' + esc(x.code) + '</em>'
        + (String(x.code) === '499' ? ' 客户端放弃' : '') + '</span>'
        + '<span class="st-row-nums">' + fmtInt(x.requests) + ' 次 · ' + fmtBytes(x.bytes) + '</span>'
        + '</div>'
        + '<div class="st-track"><i class="cf-bar ' + k + '" style="width:' + w + '%"></i></div>'
        + '</div>';
    }).join('');
    var total = status.reduce(function (a, x) { return a + x.requests; }, 0);
    note('cfStatusNote', total + ' 次请求 · 499 是播放器中途放弃（流量大但播不了的信号）');
  }

  function renderPaths(d) {
    var paths = (d && d.paths) || [];
    var box = $('#cfPaths');
    if (!paths.length) {
      box.innerHTML = '<div class="st-empty">近 24h 没有路径数据</div>';
      return;
    }
    var top = Math.max.apply(null, paths.map(function (x) { return x.bytes || 0; }).concat([1]));
    box.innerHTML = paths.map(function (x) {
      var w = Math.max(2, Math.round((x.bytes || 0) / top * 100));
      return '<div class="st-row">'
        + '<div class="st-row-head">'
        + '<span class="st-row-name cf-path">' + esc(x.path) + '</span>'
        + '<span class="st-row-nums">' + fmtInt(x.requests) + ' 次 · ' + fmtBytes(x.bytes) + '</span>'
        + '</div>'
        + '<div class="st-track"><i style="width:' + w + '%"></i></div>'
        + '</div>';
    }).join('');
  }

  function renderSrc(d) {
    var box = $('#cfSrc');
    var zone = (d && d.zone) || null;
    var account = (d && d.account) || null;
    var lines = [];
    if (d && d.enabled === false) {
      lines.push('<div class="cf-src-line bad">未配置 CF 凭据：在 Worker 环境变量里设置 <span class="tag">CF_API_TOKEN</span> 与 <span class="tag">CF_ZONE_ID</span>（secret），部署后本页即可显示用量。</div>');
    } else {
      lines.push('<div class="cf-src-line">Zone：' + (zone && zone.name ? esc(zone.name) : '（未知）')
        + (zone ? ' <span class="tag">' + esc(zone.id) + '</span>' : '') + '</div>');
      lines.push('<div class="cf-src-line">账户：' + (account && account.name ? esc(account.name) : '（未知）')
        + (account ? ' <span class="tag">' + esc(account.id) + '</span>' : '') + '</div>');
      var errs = (d && d.errors) || [];
      if (errs.length) {
        lines.push('<div class="cf-src-line warn">部分数据源失败（其余照常显示）：</div>');
        errs.forEach(function (e) {
          lines.push('<div class="cf-src-line warn">· ' + esc(e.source) + '：' + esc(e.message) + '</div>');
        });
      } else {
        lines.push('<div class="cf-src-line ok">全部数据源正常 · 更新于 ' + esc((d && d.updated_at || '').replace('T', ' ').slice(0, 19)) + ' UTC</div>');
      }
    }
    box.innerHTML = lines.join('');
  }

  function render(d) {
    if (!d || !d.ok) {
      setAlert('用量数据读取失败，请点「刷新」重试。', 'bad');
      return;
    }
    if (d.enabled === false) {
      setAlert('未配置 CF_API_TOKEN / CF_ZONE_ID，本页只显示引导。配置方法见下方「数据源状态」。', 'warn');
    } else if ((d.errors || []).length) {
      setAlert('有 ' + d.errors.length + ' 个数据源失败，其余正常显示（详见「数据源状态」）。', 'warn');
    } else if (!((d.daily || []).length)) {
      setAlert('数据源正常，但近 30 天没有记录。', '');
    } else {
      setAlert('');
    }
    last = d;
    renderKpis(d);
    renderChart(d);
    renderStatus(d);
    renderPaths(d);
    renderSrc(d);
    var stamp = document.getElementById('cfUpdated');
    if (stamp) {
      var now = new Date();
      stamp.textContent = '更新于 ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
    }
  }

  function load() {
    if (loading) return;
    loading = true;
    loaded = true;
    var btn = document.getElementById('cfRefresh');
    if (btn) btn.disabled = true;
    api('/__api/cf-analytics').then(function (r) {
      render(r && r.data);
    }).catch(function (e) {
      setAlert('用量数据读取失败：' + ((e && e.message) || e), 'bad');
    }).then(function () {
      loading = false;
      if (btn) btn.disabled = false;
    });
  }

  var metricSel = document.getElementById('cfMetric');
  if (metricSel) {
    metricSel.addEventListener('change', function () {
      metric = metricSel.value;
      renderChart(last || {});
    });
  }
  var refresh = document.getElementById('cfRefresh');
  if (refresh) refresh.onclick = load;

  // 懒加载：不是默认选项卡时，等真正切到它再取数
  window.__cfEnsure = function (force) {
    if (force || !loaded) load();
  };
  if (card.style.display !== 'none') load();
}

// 两张纯数据表以 var 形式注入，排在构造器之前（与 stats-ui 同款顺序纪律）
// 数据走**实参**而不是「先 var 再让函数体去引用那个全局名」：
// 部署开启了 minify 后，模块级标识符会被重命名，而 `var CF_TREND_METRICS=...` 是
// 硬编码的字符串字面量 —— 两者对不上，注入到浏览器的脚本一执行就是 ReferenceError。
// 改成实参后，函数体与调用处在同一个 bundle 里由同一套命名规则产出，必然自洽。
const CF_JS = `${KEEP_NAMES_SHIM}(${cfInit.toString()})(${CF_TREND_METRICS_JSON}, ${CF_STATUS_KLASS_JSON});`;

// ===================== 样式（复用 st-* 布局类，新增 cf-* 专属色） =====================

const CF_CSS = `
  .cf-code { font-style:normal; font-weight:600; padding:1px 8px; border-radius:var(--radius-xs); font-variant-numeric:tabular-nums; }
  .cf-code.ok { background:color-mix(in srgb, #16a34a 14%, transparent); color:#16a34a; }
  .cf-code.nav { background:color-mix(in srgb, #2563eb 12%, transparent); color:#2563eb; }
  .cf-code.warn { background:color-mix(in srgb, #d97706 14%, transparent); color:#d97706; }
  .cf-code.abort { background:color-mix(in srgb, #9333ea 14%, transparent); color:#9333ea; }
  .cf-code.bad { background:color-mix(in srgb, #dc2626 14%, transparent); color:#dc2626; }
  .cf-bar.ok { background:#16a34a; } .cf-bar.nav { background:#2563eb; }
  .cf-bar.warn { background:#d97706; } .cf-bar.abort { background:#9333ea; }
  .cf-bar.bad { background:#dc2626; }
  .cf-path { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; word-break:break-all; }
  .cf-src { display:flex; flex-direction:column; gap:6px; font-size:12px; color:var(--muted); line-height:1.7; }
  .cf-src-line.ok { color:#16a34a; }
  .cf-src-line.warn { color:#d97706; }
  .cf-src-line.bad { color:var(--err); }
`;

export { CF_JS, CF_CSS };
