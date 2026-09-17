/**
 * 「数据驾驶舱」选项卡的渲染层：把 /__api/stats 的聚合结果画成人看的东西。
 *
 * 为什么单独一层：admin.js 已经 2000 行，而这一屏的组成（KPI / 趋势图 / 通道排行）
 * 与其它选项卡没有交集。目录（api-catalog.js）负责「有哪些接口」，
 * 这里只负责「怎么把统计结果讲清楚」——文案、颜色、空状态都在这一层。
 *
 * 两条纪律：
 *   1. **服务端渲染阶段不发任何请求**（check-configui 会把渲染期的网络调用直接判红），
 *      数据一律等页面跑起来再异步取。
 *   2. 图表不引第三方库：接口返回的是「每天一个点」，用一排等宽柱子按百分比高度画
 *      就够用，且窄屏（手机上）不会像 SVG 缩放那样把字缩成蚂蚁。
 *
 * 前端脚本与 config-ui.js 同一个套路：写成真实函数再 toString() 注入，
 * 因此同样需要 prefix __name 兜底（--keep-names 会把内部箭头函数改写成 __name(...)）。
 */

import { esc } from './util.js';
import { settingFormById, renderToolItem, KEEP_NAMES_SHIM } from './config-ui.js';
import { flatCatalog } from './api-catalog.js';

/** 目录项渲染（原始 JSON 与清空数据）——路径与文案只在目录里写一次 */
function toolById(id) {
  const item = flatCatalog().find(i => i.id === id);
  return item ? renderToolItem(item) : '';
}

/**
 * 驾驶舱主体：KPI + 趋势图 + 通道排行。
 * 全部为空壳，数值由 STATS_JS 填；这样首屏不会因为统计接口慢而白屏。
 */
function dashboardCard() {
  return `<div class="card" id="statsCard" data-pane="stats">
    <h2>数据驾驶舱</h2>
    <div class="hint" style="margin:-8px 0 var(--sp-3);">按天汇总全站访问：请求数、流量、来访者与错误。数据只存在你自己的存储里，来访者以「IP + 安装级盐值」的哈希记录，原始 IP 不落盘。</div>

    <div class="st-bar">
      <div class="st-seg" id="stDays">
        <button type="button" data-days="7" class="active">近 7 天</button>
        <button type="button" data-days="14">近 14 天</button>
        <button type="button" data-days="30">近 30 天</button>
      </div>
      <div class="st-bar-right">
        <span class="st-stamp" id="stUpdated"></span>
        <button type="button" class="mini" id="stRefresh">刷新</button>
      </div>
    </div>

    <div class="st-alert" id="stAlert" hidden></div>

    <div class="st-kpis" id="stKpis"></div>

    <div class="st-block">
      <div class="st-block-head">
        <b>每日趋势</b>
        <select id="stMetric" class="st-metric">
          <option value="hits">请求数</option>
          <option value="bytes">流量</option>
          <option value="errors">错误数</option>
        </select>
      </div>
      <div class="st-chart" id="stChart"></div>
      <div class="st-axis" id="stAxis"></div>
      <div class="st-axis-note" id="stAxisNote"></div>
    </div>

    <div class="st-block">
      <div class="st-block-head">
        <b>通道排行</b>
        <span class="st-sub" id="stScopeNote"></span>
      </div>
      <div class="st-rank" id="stRank"></div>
    </div>
  </div>`;
}

/**
 * 整个选项卡：驾驶舱 + 统计设置（同一份配置只在这里能改，
 * 配置页通过目录的 tab 归属只留跳转，不再重复一份表单）。
 */
export function renderStatsPane() {
  return dashboardCard() + `<div class="card" data-pane="stats">
    <h2>统计设置</h2>
    <div class="hint" style="margin:-8px 0 var(--sp-3);">关闭后不再记录新数据，已有的保留；保留天数决定驾驶舱最多能回看多久。</div>
    ${settingFormById('stats-config')}
    <details class="cfg-tools"><summary>工具（原始数据 / 清空）</summary>
      ${toolById('stats')}
      ${toolById('stats-clear')}
    </details>
  </div>`;
}

// ===================== 前端脚本 =====================

function statsInit() {
  var card = document.getElementById('statsCard');
  if (!card) return;

  var $ = function (sel) { return document.querySelector(sel); };
  var days = 7;
  var metric = 'hits';
  var loaded = false;
  var loading = false;
  var sites = {};

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
  function fmtMetric(v, m) { return m === 'bytes' ? fmtBytes(v) : fmtInt(v); }
  function scopeName(scope) {
    if (scope.indexOf('p:') === 0) {
      var id = scope.slice(2);
      return '站点 · ' + (sites[id] || id);
    }
    var map = {
      edt: '代理节点（VLESS）',
      'edt-admin': '代理面板',
      sub: '主订阅',
      tsub: '临时订阅',
      admin: '管理面板',
      login: '登录页',
      share: '站点临时链接',
    };
    return map[scope] || scope;
  }
  function setAlert(text, cls) {
    var el = $('#stAlert');
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
    var t = (d && d.totals) || {};
    var daily = (d && d.daily) || [];
    var activeDays = daily.filter(function (x) { return x.hits > 0; }).length;
    var peak = daily.reduce(function (a, x) { return (!a || x.hits > a.hits) ? x : a; }, null);
    var errRate = t.hits ? (t.errors / t.hits * 100) : 0;
    var items = [
      { label: '总请求数', value: fmtInt(t.hits), sub: '日均 ' + fmtInt(daily.length ? t.hits / daily.length : 0) + ' 次' },
      { label: '总流量', value: fmtBytes(t.bytes), sub: '响应体大小合计' },
      { label: '独立访客', value: fmtInt(t.uv), sub: '各通道之和（去重上限）' },
      { label: '错误数', value: fmtInt(t.errors), sub: '占比 ' + errRate.toFixed(errRate < 10 ? 1 : 0) + '%', err: t.errors > 0 },
      { label: '有数据的天数', value: activeDays + ' / ' + daily.length, sub: '统计保留 ' + (d.retention_days || '-') + ' 天' },
      { label: '峰值日', value: peak && peak.hits ? fmtInt(peak.hits) : '—', sub: peak && peak.hits ? peak.date : '暂无访问' },
    ];
    $('#stKpis').innerHTML = items.map(function (x) {
      return '<div class="st-kpi"><span class="st-kpi-label">' + x.label + '</span>'
        + '<span class="st-kpi-value' + (x.err ? ' err' : '') + '">' + x.value + '</span>'
        + '<span class="st-kpi-sub">' + x.sub + '</span></div>';
    }).join('');
  }

  function renderChart(d) {
    var daily = (d && d.daily) || [];
    var chart = $('#stChart');
    var axis = $('#stAxis');
    if (!daily.length) {
      chart.innerHTML = '<div class="st-empty">最近 ' + (d.days || days) + ' 天还没有记录</div>';
      axis.innerHTML = '';
      note('stAxisNote', '');
      return;
    }
    var values = daily.map(function (x) { return Number(x[metric]) || 0; });
    var max = Math.max.apply(null, values.concat([1]));
    chart.innerHTML = daily.map(function (x, i) {
      var v = values[i];
      var pct = Math.max(v > 0 ? 4 : 1.5, Math.round(v / max * 100));
      var tip = x.date + '：请求 ' + fmtInt(x.hits) + ' 次 · 流量 ' + fmtBytes(x.bytes) + ' · 错误 ' + fmtInt(x.errors) + ' 次';
      return '<i class="st-col' + (v > 0 ? '' : ' zero') + '" style="height:' + pct + '%" title="' + tip + '"></i>';
    }).join('');
    // 日期标签按需稀疏：柱数多于 8 根时隔几根标一个，避免手机上糊成一片
    var step = Math.max(1, Math.ceil(daily.length / 8));
    axis.innerHTML = daily.map(function (x, i) {
      var show = i % step === 0 || i === daily.length - 1;
      return '<span>' + (show ? x.date.slice(5) : '') + '</span>';
    }).join('');
    note('stAxisNote', '峰值 ' + fmtMetric(max, metric) + '（把鼠标停在柱子上看当天明细）');
  }

  function renderRank(d) {
    var series = (d && d.series) || [];
    var box = $('#stRank');
    if (!series.length) {
      box.innerHTML = '<div class="st-empty">还没有可统计的访问</div>';
      note('stScopeNote', '');
      return;
    }
    var top = Math.max.apply(null, series.map(function (s) { return s.hits || 0 }).concat([1]));
    box.innerHTML = series.map(function (s) {
      var pct = Math.max(2, Math.round((s.hits || 0) / top * 100));
      return '<div class="st-row">'
        + '<div class="st-row-head">'
        + '<span class="st-row-name">' + esc(scopeName(s.scope)) + '</span>'
        + '<span class="st-row-nums">' + fmtInt(s.hits) + ' 次 · ' + fmtBytes(s.bytes) + ' · ' + fmtInt(s.uv) + ' 访客'
        + (s.errors ? ' · <em class="st-err">' + fmtInt(s.errors) + ' 错误</em>' : '') + '</span>'
        + '</div>'
        + '<div class="st-track"><i style="width:' + pct + '%"></i></div>'
        + '<div class="st-row-days">' + (s.days || []).map(function (x) {
          return x.date.slice(5) + ' ' + fmtInt(x.hits);
        }).join('　') + '</div>'
        + '</div>';
    }).join('');
    note('stScopeNote', '按请求数排序，最多显示 ' + (d.top_limit || series.length) + ' 个通道');
  }

  function render(d) {
    if (!d || !d.ok) {
      setAlert('统计数据读取失败，请点「刷新」重试。', 'bad');
      return;
    }
    if (!d.enabled) {
      setAlert('访问统计当前未启用，面板不会记录任何数据。在下方「统计设置」里打开「启用统计」即可开始记录（已产生访问后第一分钟就能看到数据）。', 'warn');
    } else if (!(d.daily || []).length) {
      setAlert('统计已启用，但最近 ' + d.days + ' 天还没有记录。计数在内存里聚合、每 15 秒落盘一次，稍等片刻后刷新即可。', '');
    } else if (d.days < days) {
      setAlert('保留天数只有 ' + d.retention_days + ' 天，本次实际回看 ' + d.days + ' 天。需要更长的历史请在下方「统计设置」里调大保留天数。', '');
    } else {
      setAlert('');
    }
    renderKpis(d);
    renderChart(d);
    renderRank(d);
    var stamp = document.getElementById('stUpdated');
    if (stamp) {
      var now = new Date();
      stamp.textContent = '更新于 ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
    }
  }

  function load() {
    if (loading) return;
    loading = true;
    loaded = true;
    var btn = document.getElementById('stRefresh');
    if (btn) btn.disabled = true;
    api('/__api/stats?days=' + days).then(function (r) {
      render(r && r.data);
    }).catch(function (e) {
      setAlert('统计数据读取失败：' + ((e && e.message) || e), 'bad');
    }).then(function () {
      loading = false;
      if (btn) btn.disabled = false;
    });
  }

  // ---- 天数切换 ----
  var seg = document.getElementById('stDays');
  if (seg) {
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-days]');
      if (!b) return;
      days = Number(b.getAttribute('data-days')) || 7;
      [].forEach.call(seg.querySelectorAll('button'), function (x) {
        x.classList.toggle('active', x === b);
      });
      load();
    });
  }
  var metricSel = document.getElementById('stMetric');
  if (metricSel) {
    metricSel.addEventListener('change', function () {
      metric = metricSel.value;
      load();
    });
  }
  var refresh = document.getElementById('stRefresh');
  if (refresh) refresh.onclick = load;

  // 清空数据是目录里的工具项（由 config-ui 的脚本执行），这里只负责清完自动刷新视图
  var clearBtn = document.querySelector('[data-uid="stats-clear"] [data-act="run"]');
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      setTimeout(function () { if (!document.body.contains(card)) return; load(); }, 800);
    });
  }

  // 懒加载：驾驶舱不是默认选项卡时，等真正切到它再取数
  window.__statsEnsure = function (force) {
    if (force || !loaded) load();
  };
  if (card.style.display !== 'none') load();

  // 站点 id -> 名称，仅用于把「p:xxx」显示成人话；失败就退回显示 id
  api('/__api/sites').then(function (r) {
    var list = (r && r.data && r.data.sites) || [];
    list.forEach(function (s) { sites[s.id] = s.name || s.id; });
    if (loaded) load();
  }).catch(function () {});
}

const STATS_JS = `${KEEP_NAMES_SHIM}(${statsInit.toString()})();`;

// ===================== 样式 =====================

const STATS_CSS = `
  .st-bar { display:flex; align-items:center; justify-content:space-between; gap:var(--sp-2); flex-wrap:wrap; margin-bottom:var(--sp-3); }
  .st-seg { display:inline-flex; gap:4px; padding:3px; background:var(--input); border:1px solid var(--line); border-radius:var(--radius-sm); }
  .st-seg button { padding:6px 12px; font-size:13px; font-weight:500; background:transparent; color:var(--muted); border:none; border-radius:var(--radius-xs); }
  .st-seg button:hover { background:transparent; color:var(--txt); }
  .st-seg button.active { background:var(--card); color:var(--txt); box-shadow:var(--shadow); }
  .st-bar-right { display:flex; align-items:center; gap:var(--sp-2); }
  .st-stamp { font-size:12px; color:var(--muted); }
  .st-alert { font-size:12px; line-height:1.7; color:var(--muted); background:var(--input); border:1px solid var(--line); border-left:3px solid var(--muted); border-radius:var(--radius-xs); padding:10px 12px; margin:0 0 var(--sp-3); }
  .st-alert.warn { border-left-color:var(--accent); color:var(--txt); }
  .st-alert.bad { border-left-color:var(--err); color:var(--err); }
  .st-kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(140px, 100%), 1fr)); gap:var(--sp-2); }
  .st-kpi { display:flex; flex-direction:column; gap:2px; padding:12px 14px; background:var(--input); border:1px solid var(--line); border-radius:var(--radius-sm); min-width:0; }
  .st-kpi-label { font-size:12px; color:var(--muted); }
  .st-kpi-value { font-size:20px; font-weight:600; letter-spacing:-.01em; font-variant-numeric:tabular-nums; }
  .st-kpi-value.err { color:var(--err); }
  .st-kpi-sub { font-size:11px; color:var(--muted); }
  .st-block { margin-top:var(--sp-4); }
  .st-block-head { display:flex; align-items:center; justify-content:space-between; gap:var(--sp-2); flex-wrap:wrap; margin-bottom:var(--sp-2); }
  .st-block-head b { font-size:14px; font-weight:600; }
  .st-sub { font-size:12px; color:var(--muted); }
  .st-metric { width:auto; min-width:120px; padding:6px 10px; font-size:13px; }
  .st-chart { display:flex; align-items:flex-end; gap:3px; height:170px; padding:0 0 0 2px; border-bottom:1px solid var(--line); }
  .st-col { flex:1 1 0; min-width:2px; background:var(--accent); border-radius:3px 3px 0 0; opacity:.85; transition:opacity .15s; }
  .st-col:hover { opacity:1; }
  .st-col.zero { background:var(--line); }
  .st-axis { display:flex; gap:3px; margin-top:6px; padding-left:2px; }
  .st-axis span { flex:1 1 0; min-width:0; text-align:center; font-size:10px; color:var(--muted); white-space:nowrap; overflow:hidden; }
  .st-axis-note { font-size:11px; color:var(--muted); margin-top:6px; }
  .st-empty { width:100%; text-align:center; color:var(--muted); font-size:13px; padding:28px 0; }
  .st-rank { display:flex; flex-direction:column; gap:var(--sp-3); }
  .st-row-head { display:flex; align-items:baseline; justify-content:space-between; gap:var(--sp-2); flex-wrap:wrap; }
  .st-row-name { font-size:13px; font-weight:600; }
  .st-row-nums { font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums; }
  .st-err { font-style:normal; color:var(--err); }
  .st-track { height:6px; border-radius:999px; background:var(--input); border:1px solid var(--line); overflow:hidden; margin:6px 0 4px; }
  .st-track i { display:block; height:100%; background:var(--accent); }
  .st-row-days { font-size:11px; color:var(--muted); line-height:1.8; word-break:break-all; }
  @media (max-width:640px) {
    .st-chart { height:130px; gap:2px; }
    .st-kpi-value { font-size:18px; }
  }
`;

export { STATS_JS, STATS_CSS };
