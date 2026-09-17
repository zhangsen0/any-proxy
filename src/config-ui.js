/**
 * 管理页「配置」分区与全站「设置表单」的渲染层。
 *
 * 两条纪律：
 *   1. **只认目录** —— 这里没有任何具体接口的路径、字段名或中文文案，
 *      全部来自 src/api-catalog.js。加一个配置项 = 目录加一条，界面自动出现。
 *   2. **同一份配置只在一个地方能改** —— 归属某个功能选项卡的分组，在配置页
 *      只留一行跳转（见 api-catalog.js 的 placementOf）。优选池曾经同时长在
 *      「优选 IP」和「配置」两处，改完一边忘了另一边就会出现「面板显示 A、实际生效 B」。
 *
 * 前端脚本写在 configInit() 里再用 toString() 注入，而不是拼字符串 ——
 * 拼字符串的写法没法跳转定义、没法语法高亮，改错一个引号要到线上才发现。
 */

import { esc } from './util.js';
import { splitCatalog, flatCatalog, TAB_LABELS } from './api-catalog.js';

const ADMIN_PATHS = ['/__api'];
const AUTHED_PATHS = ['/__api/login', '/__api/logout', '/__api/config'];

/** 目录项的默认处置：能写的是动作，只能读的是查询 */
export function kindOf(item) {
  if (item.kind) return item.kind;
  return String(item.method || 'GET').toUpperCase() === 'GET' ? 'query' : 'action';
}

function writeMethodOf(item) {
  return String(item.writeMethod || item.method || 'POST').toUpperCase();
}

// ===================== 控件 =====================

/** 控件类型：目录没写就按 SPEC 推断（int → 数字、bool → 开关、其余 → 文本） */
function controlType(param, spec) {
  if (param.type) return param.type;
  if (param.options) return 'select';
  const field = spec && spec[param.key];
  if (!field) return 'text';
  if (field.type === 'bool') return 'bool';
  if (field.type === 'int') return 'number';
  return 'text';
}

/** 取值范围由 SPEC 决定，界面按它限制，省得填错再被服务端退回来 */
function boundsOf(spec, key) {
  const field = (spec && spec[key]) || {};
  return {
    min: typeof field.min === 'number' ? field.min : null,
    max: typeof field.max === 'number' ? field.max : null,
  };
}

/** 占位提示优先取 SPEC 的默认值 —— 默认值只在模块里写一次，不在这里重抄 */
function placeholderOf(param, spec) {
  if (param.placeholder !== undefined) return param.placeholder;
  const field = (spec && spec[param.key]) || {};
  if (field.secret) return '已配置则留空';
  const d = field.default;
  if (d === '' || d === null || d === undefined) return '留空表示不设置';
  if (typeof d === 'boolean') return '';
  return `默认 ${d}`;
}

function controlHtml(param, spec, uid) {
  const id = `cfg-${uid}-${param.key}`;
  const attrs = `id="${id}" data-key="${esc(param.key)}"${param.in ? ` data-in="${esc(param.in)}"` : ''}${param.secretFlag ? ' data-secret="1"' : ''}`;
  const ph = placeholderOf(param, spec);
  const type = controlType(param, spec);

  if (type === 'bool') {
    return `<label class="cfg-switch" for="${id}"><input type="checkbox" ${attrs}>`
      + '<span class="cfg-track"><i></i></span><span class="cfg-switch-label" data-toggle-label>关闭</span></label>';
  }
  if (type === 'number') {
    const b = boundsOf(spec, param.key);
    const range = (b.min !== null ? ` min="${b.min}"` : '') + (b.max !== null ? ` max="${b.max}"` : '');
    const unit = param.unit ? `<em>${esc(param.unit)}</em>` : '';
    return `<span class="cfg-num"><input type="number" ${attrs}${range} inputmode="numeric" placeholder="${esc(ph)}">${unit}</span>`;
  }
  if (type === 'textarea') {
    return `<textarea ${attrs} rows="${esc(String(param.rows || 3))}" placeholder="${esc(ph)}"></textarea>`;
  }
  if (type === 'select') {
    const options = (param.options || [])
      .map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)
      .join('');
    return `<select ${attrs}>${options}</select>`;
  }
  if (type === 'password') {
    return `<input type="password" ${attrs} placeholder="${esc(ph)}" autocomplete="new-password">`;
  }
  return `<input type="text" ${attrs} placeholder="${esc(ph)}">`;
}

function fieldHtml(param, spec, uid) {
  const field = (spec && spec[param.key]) || {};
  const type = controlType(param, spec);
  const wide = !!param.wide || type === 'textarea';
  const badge = field.secret ? '<span class="cfg-badge" data-secret-badge hidden>已配置</span>' : '';
  const param2 = field.secret ? { ...param, secretFlag: true } : param;
  return `<div class="cfg-field${wide ? ' wide' : ''}" data-field="${esc(param.key)}">
    <label for="cfg-${uid}-${esc(param.key)}">${esc(param.label || param.key)}${badge}</label>
    ${controlHtml(param2, spec, uid)}
    ${param.hint ? `<div class="cfg-hint">${esc(param.hint)}</div>` : ''}
  </div>`;
}

function gridHtml(list, spec, uid) {
  return `<div class="cfg-grid">${list.map(p => fieldHtml(p, spec, uid)).join('')}</div>`;
}

// ===================== 设置块 / 工具项 =====================

/**
 * 单个设置块：一块 = 一个可读可写的接口。
 * 导出去给各功能页复用（如「临时链接」页的设置区），保证全站只有一套设置表单。
 */
export function renderSettingForm(item, opts = {}) {
  const params = item.params || [];
  if (!params.length) return '';
  const uid = opts.uid || item.id;
  const basic = params.filter(p => p.level !== 'advanced');
  const advanced = params.filter(p => p.level === 'advanced');
  return `<div class="cfg-set" data-setting data-uid="${esc(uid)}" data-path="${esc(item.path)}" data-method="${esc(writeMethodOf(item))}"${item.normalize ? ` data-normalize="${esc(item.normalize)}"` : ''}>
    <div class="cfg-set-head">
      <b>${esc(item.name)}</b>
      <span class="cfg-state" data-state></span>
    </div>
    ${item.desc ? `<div class="cfg-desc">${esc(item.desc)}</div>` : ''}
    ${basic.length ? gridHtml(basic, item.spec, uid) : ''}
    ${advanced.length ? `<details class="cfg-more"><summary>进阶选项（${advanced.length} 项，通常不用改）</summary>${gridHtml(advanced, item.spec, uid)}</details>` : ''}
    <div class="row cfg-actions">
      <button type="button" class="mini" data-act="save" disabled>保存</button>
      <button type="button" class="mini" data-act="revert" disabled>还原</button>
      <span class="msg" data-msg></span>
    </div>
  </div>`;
}

/** 单个工具项：查询或动作。有参数就展开字段，没参数就只有一行 */
export function renderToolItem(item, opts = {}) {
  const uid = opts.uid || item.id;
  const method = String(item.method || 'GET').toUpperCase();
  const params = item.params || [];
  const label = method === 'GET' ? '查看' : (item.danger ? '确认执行' : '执行');
  return `<div class="cfg-tool" data-tool data-uid="${esc(uid)}" data-path="${esc(item.path)}" data-method="${esc(method)}" data-name="${esc(item.name)}"${item.danger ? ' data-confirm="1"' : ''}>
    <div class="cfg-tool-main">
      <div class="cfg-tool-text">
        <b>${esc(item.name)}</b>
        <span class="cfg-tool-desc">${esc(item.desc || '')}${item.auth === false ? '（匿名可读）' : ''}</span>
      </div>
      <button type="button" class="mini${item.danger ? ' danger' : ''}" data-act="run">${esc(label)}</button>
    </div>
    ${params.length ? `<div class="cfg-tool-params">${gridHtml(params, item.spec, uid)}</div>` : ''}
    <div class="cfg-result" hidden><pre data-out></pre></div>
    <div class="msg" data-msg></div>
  </div>`;
}

/**
 * 按目录 id 取一个设置块，供各功能页把自己的设置项渲染到本页里。
 * 这样「设置表单」全站只有一套渲染器，不会出现某个页面的表单忘了加校验或忘了脱敏。
 */
export function settingFormById(id, opts = {}) {
  const item = flatCatalog().find(i => i.id === id);
  return item ? renderSettingForm(item, opts) : '';
}

// ===================== 配置页 =====================

/** 配置分区：设置卡 + 诊断工具。内容与顺序全部由目录决定 */
function renderConfigPanels() {
  const { cards, tools } = splitCatalog();
  const parts = [];

  parts.push('<div class="cfg-lead" data-pane="config">这里只放没有独立选项卡的设置项。'
    + '其余功能（站点、数据驾驶舱、优选 IP、伪装、主题、临时链接）各自有专属选项卡，用顶部标签切换即可。</div>');

  for (const { group, items } of cards) {
    const settings = items.filter(i => kindOf(i) === 'setting');
    const others = items.filter(i => kindOf(i) !== 'setting');
    const queries = others.filter(i => String(i.method || 'GET').toUpperCase() === 'GET');
    const actions = others.filter(i => String(i.method || 'GET').toUpperCase() !== 'GET');
    parts.push(`<div class="card cfg-card" data-pane="config" data-group="${esc(group.id)}">
      <h2>${esc(group.name)}</h2>
      ${settings.map(i => renderSettingForm(i)).join('')}
      ${others.length ? `<details class="cfg-tools"><summary>工具（${others.length} 项）</summary>
        ${[...queries, ...actions].map(i => renderToolItem(i)).join('')}
      </details>` : ''}
    </div>`);
  }

  if (tools.length) {
    parts.push(`<div class="card cfg-card" data-pane="config" data-group="diagnostics">
      <h2>诊断工具</h2>
      <div class="hint" style="margin:-8px 0 4px;">排查问题时才用得上，不参与日常配置。</div>
      ${tools.map(i => renderToolItem(i)).join('')}
    </div>`);
  }

  return parts.join('');
}

// ===================== 前端脚本 =====================

/**
 * 设置表单与工具区的浏览器侧逻辑。
 * 写成真实函数（而不是拼字符串）是为了能直接读、直接改、直接语法检查；
 * 注入时用 toString()，函数体里的模板串不会被提前求值。
 */
function configInit() {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [].slice.call((root || document).querySelectorAll(sel));

  function syncSwitch(el) {
    const label = el.parentNode && el.parentNode.querySelector ? el.parentNode.querySelector('[data-toggle-label]') : null;
    if (label) label.textContent = el.checked ? '开启' : '关闭';
  }
  function fieldValue(el) {
    return el.type === 'checkbox' ? el.checked : el.value;
  }
  function fillField(el, value) {
    if (el.type === 'checkbox') { el.checked = !!value; syncSwitch(el); return; }
    if (el.tagName === 'TEXTAREA') {
      el.value = Array.isArray(value) ? value.join('\n') : (value === null || value === undefined ? '' : String(value));
      return;
    }
    el.value = value === null || value === undefined ? '' : String(value);
  }
  function markClean(el) {
    el.setAttribute('data-back', JSON.stringify(fieldValue(el)));
    el.removeAttribute('data-dirty');
  }
  function isDirty(el) {
    const back = el.getAttribute('data-back');
    return back === null ? false : JSON.stringify(fieldValue(el)) !== back;
  }
  function setState(set, text, cls) {
    const el = $('[data-state]', set);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'cfg-state' + (cls ? ' ' + cls : '');
  }
  function setMsg(set, text, isErr) {
    const el = $('[data-msg]', set);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg ' + (isErr ? 'err' : 'ok');
  }
  function refresh(set) {
    const fields = $$('[data-key]', set);
    const dirty = fields.filter(isDirty);
    fields.forEach(el => { if (isDirty(el)) el.setAttribute('data-dirty', '1'); else el.removeAttribute('data-dirty'); });
    const save = $('[data-act="save"]', set);
    const revert = $('[data-act="revert"]', set);
    if (save) save.disabled = !dirty.length;
    if (revert) revert.disabled = !dirty.length;
    setState(set, dirty.length ? '有 ' + dirty.length + ' 处未保存' : '已同步', dirty.length ? 'dirty' : '');
  }
  function bodyOf(set) {
    const out = {};
    $$('[data-key]', set).forEach(el => {
      const key = el.getAttribute('data-key');
      const value = fieldValue(el);
      // 敏感项留空 = 保持原值：面板不会拿到明文，也不该用空值把它抹掉
      if (el.getAttribute('data-secret') === '1' && (value === '' || value === null)) return;
      if (set.getAttribute('data-normalize') === 'lines' && typeof value === 'string') {
        out[key] = value.split('\n').map(s => s.trim()).filter(Boolean);
        return;
      }
      out[key] = value;
    });
    return out;
  }
  /** 读取允许的两种返回形态：{config:{...}} 与新接口的平铺 {...} */
  function payload(data) {
    if (data && data.config && typeof data.config === 'object') return data.config;
    return data || {};
  }
  function applyData(set, data) {
    $$('[data-key]', set).forEach(el => {
      const key = el.getAttribute('data-key');
      if (data[key] !== undefined) {
        fillField(el, data[key]);
      } else if (data['has_' + key] !== undefined) {
        // 敏感项：服务端只回「是否已配置」，不回明文
        const box = el.closest ? el.closest('.cfg-field') : null;
        const badge = box ? box.querySelector('[data-secret-badge]') : null;
        if (badge) badge.hidden = !data['has_' + key];
        if (data['has_' + key]) el.setAttribute('placeholder', '已配置，留空表示不修改');
        fillField(el, '');
      }
      markClean(el);
    });
  }

  function loadSet(set) {
    setState(set, '读取中…', '');
    return api(set.getAttribute('data-path')).then(r => {
      applyData(set, payload(r.data));
      refresh(set);
    }).catch(e => {
      // 读失败也要给字段立一条基线（空值），否则「本来没值 + 用户填了新值」
      // 会被判成没改动，保存按钮永远是灰的
      applyData(set, {});
      setState(set, '读取失败：' + ((e && e.message) || e), 'bad');
      setMsg(set, '未能读到当前值；直接填写后保存也可以', true);
    });
  }

  function saveSet(set) {
    const body = bodyOf(set);
    const save = $('[data-act="save"]', set);
    if (save) save.disabled = true;
    setState(set, '保存中…', '');
    setMsg(set, '');
    api(set.getAttribute('data-path'), {
      method: set.getAttribute('data-method') || 'POST',
      body: JSON.stringify(body),
    }).then(r => {
      if (!r.ok) {
        setState(set, '保存失败', 'bad');
        setMsg(set, (r.data && r.data.error) || ('HTTP ' + r.status), true);
        refresh(set);
        return;
      }
      applyData(set, payload(r.data));
      refresh(set);
      setState(set, '已保存', 'done');
      setMsg(set, '已保存并生效', false);
    }).catch(() => {
      setState(set, '保存失败', 'bad');
      setMsg(set, '请求未送达，请检查网络后重试', true);
      refresh(set);
    });
  }

  function revertSet(set) {
    $$('[data-key]', set).forEach(el => {
      const back = el.getAttribute('data-back');
      if (back === null) return;
      try { fillField(el, JSON.parse(back)); } catch (e) { /* 保持原样 */ }
    });
    setMsg(set, '');
    refresh(set);
  }

  function runTool(tool) {
    const path0 = tool.getAttribute('data-path') || '';
    const method = (tool.getAttribute('data-method') || 'GET').toUpperCase();
    const btn = $('[data-act="run"]', tool);
    const box = $('.cfg-result', tool);
    const out = $('[data-out]', tool);
    const body = {};
    const qs = [];
    $$('[data-key]', tool).forEach(el => {
      const value = fieldValue(el);
      if (value === '' || value === null) return;
      const key = el.getAttribute('data-key');
      if (el.getAttribute('data-in') === 'query') qs.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
      else body[key] = value;
    });
    const path = qs.length ? path0 + (path0.indexOf('?') >= 0 ? '&' : '?') + qs.join('&') : path0;
    if (tool.getAttribute('data-confirm') === '1'
      && !window.confirm('确定要执行「' + (tool.getAttribute('data-name') || '该操作') + '」吗？')) return;

    if (btn) btn.disabled = true;
    setMsg(tool, '执行中…', false);
    const opts = { method };
    if (method !== 'GET') opts.body = JSON.stringify(body);
    api(path, opts).then(r => {
      let text;
      try { text = JSON.stringify(r.data, null, 2); } catch (e) { text = String(r.data); }
      if (text && text.length > 4000) text = text.slice(0, 4000) + '\n…（内容过长已截断）';
      if (out) out.textContent = text || '(无返回内容)';
      if (box) box.hidden = false;
      setMsg(tool, r.ok ? '完成' : ((r.data && r.data.error) || ('HTTP ' + r.status)), !r.ok);
    }).catch(e => {
      setMsg(tool, '请求失败：' + ((e && e.message) || e), true);
    }).then(() => { if (btn) btn.disabled = false; });
  }

  // ---- 绑定 ----
  $$('[data-setting]').forEach(set => {
    $$('[data-key]', set).forEach(el => {
      const ev = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
      el.addEventListener(ev, () => refresh(set));
      if (el.type === 'checkbox') el.addEventListener('change', () => syncSwitch(el));
    });
    const save = $('[data-act="save"]', set);
    const revert = $('[data-act="revert"]', set);
    if (save) save.onclick = () => saveSet(set);
    if (revert) revert.onclick = () => revertSet(set);
    loadSet(set);
  });

  $$('[data-tool]').forEach(tool => {
    const btn = $('[data-act="run"]', tool);
    if (btn) btn.onclick = () => runTool(tool);
  });
}

// 兜底：构建期若被 esbuild --keep-names 改写，序列化进浏览器脚本的 configInit 内部箭头函数
// 会变成 __name((...)=>..., "x") 的形式，但 __name 助手只存在于 Worker 包顶层（服务端），
// 浏览器侧没有它，于是注入脚本一执行就抛 ReferenceError，整段脚本中断 —— 表现为
// 「一直加载中」+ 配置页/临时链接页按钮失灵。这里在注入脚本顶部自备一个 __name，
// 没有 keep-names 时它只是个不会被调用的空函数，完全无害。
//
// 任何「把函数 toString() 注入浏览器」的模块都必须带上它（见 src/stats-ui.js），
// 所以它被导出复用，而不是各文件各抄一份。
const KEEP_NAMES_SHIM = 'var __name=function(t,v){try{Object.defineProperty(t,"name",{value:v,configurable:true});}catch(e){}return t;};';

const CONFIG_JS = `${KEEP_NAMES_SHIM}(${configInit.toString()})();`;

// ===================== 样式 =====================
//
// 全部走主题变量：换主题时配置页跟着一起变，不会留下一块「自成一套」的孤岛。

const CONFIG_CSS = `
  /* 文案行本就在卡片之外，用卡片内边距对齐它，读起来才和卡片里的内容同一条竖线 */
  .cfg-lead { font-size:13px; color:var(--muted); line-height:1.8; margin:2px 0 var(--sp-2); padding:0 var(--card-pad); }
  /* 卡片度量必须跟全站同源：曾经这里写死成 var(--sp-3) var(--sp-4)，
     于是配置页的输入框比其它选项卡左右各窄一截 */
  .cfg-card { padding:var(--card-pad); }
  /* 设置块：一个块 = 一个可读可写的接口。
     这里刻意**不给横向内边距**，字段左右边界直接对齐卡片内容区；
     它以前是一层带边框和底色的内嵌盒子，等于在卡片里又缩进 16px ——
     配置页和临时链接页的输入框因此比前面几个选项卡窄一圈。块与块之间用一条
     分隔线区分，比套盒子更轻。 */
  .cfg-set { padding:0; }
  .cfg-set + .cfg-set { margin-top:var(--sp-3); border-top:1px solid var(--line); padding-top:var(--sp-3); }
  .cfg-set-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .cfg-set-head b { font-size:14px; font-weight:600; }
  .cfg-state { font-size:12px; color:var(--muted); }
  .cfg-state.dirty { color:var(--accent); }
  .cfg-state.done { color:var(--ok); }
  .cfg-state.bad { color:var(--err); }
  .cfg-desc { font-size:12px; color:var(--muted); line-height:1.7; margin:4px 0 var(--sp-3); }
  /* 列宽走 --field-min：容器够宽多排一列、窄屏自然回落一列，
     min(…, 100%) 保证极窄屏下不会撑出横向滚动条 */
  .cfg-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(var(--field-min), 100%), 1fr)); gap:var(--grid-gap); align-items:start; }
  .cfg-field { min-width:0; }
  .cfg-field.wide { grid-column:1 / -1; }
  .cfg-field > label:not(.cfg-switch) { display:flex; align-items:center; gap:6px; margin:0 0 5px; font-size:12px; font-weight:500; color:var(--muted); }
  /* 输入控件的外观**不在这里重写**。全站那条 input/select/textarea 规则已经定义了
     背景、圆角、内边距、字号和聚焦描边，配置页沿用同一套才可能和别的选项卡长得一样
     —— 之前这里又抄了一份紧凑版（灰底换成白底、内边距 8/10、字号 13），
     于是同一页里出现两种输入框。这里只补两件全站没有的事： */
  .cfg-field textarea { font-family:var(--font-mono); font-size:12px; line-height:1.7; resize:vertical; }
  .cfg-field [data-dirty] { border-color:var(--accent); }
  .cfg-hint { font-size:11px; color:var(--muted); line-height:1.7; margin:5px 0 0; }
  .cfg-num { position:relative; display:block; }
  .cfg-num em { position:absolute; right:11px; top:50%; transform:translateY(-50%); font-style:normal; font-size:11px; color:var(--muted); pointer-events:none; }
  /* 右侧要让出「单位」后缀的位置；选择器比全站那条更具体，不必用 !important */
  .cfg-num input { padding-right:46px; }
  .cfg-switch { display:inline-flex; align-items:center; gap:9px; cursor:pointer; user-select:none; padding:6px 0; }
  .cfg-switch input { position:absolute; width:0; height:0; opacity:0; }
  .cfg-switch .cfg-track { flex:none; position:relative; width:38px; height:22px; border-radius:999px; background:var(--line); border:1px solid var(--line); transition:background .18s, border-color .18s; }
  .cfg-switch .cfg-track i { position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:var(--card); box-shadow:var(--shadow); transition:left .18s; }
  .cfg-switch input:checked + .cfg-track { background:var(--accent); border-color:var(--accent); }
  .cfg-switch input:checked + .cfg-track i { left:18px; }
  .cfg-switch input:focus-visible + .cfg-track { box-shadow:var(--ring); }
  .cfg-switch-label { font-size:12px; color:var(--muted); }
  .cfg-badge { font-size:10px; padding:1px 6px; border-radius:999px; background:var(--ok-bg); color:var(--ok); border:1px solid var(--line); }
  .cfg-more { margin-top:var(--sp-3); border-top:1px dashed var(--line); padding-top:var(--sp-2); }
  .cfg-more > summary, .cfg-tools > summary { cursor:pointer; font-size:12px; color:var(--muted); padding:2px 0; }
  .cfg-more > summary:hover, .cfg-tools > summary:hover { color:var(--txt); }
  .cfg-more .cfg-grid { margin-top:var(--sp-3); }
  .cfg-actions { margin-top:var(--sp-3); align-items:center; }
  .cfg-actions .msg { margin:0 0 0 2px; min-height:0; }
  .cfg-tools { margin-top:var(--sp-3); border-top:1px solid var(--line); padding-top:var(--sp-2); }
  .cfg-tool { padding:var(--sp-2) 0; }
  .cfg-tool + .cfg-tool { border-top:1px solid var(--line); }
  .cfg-tool-main { display:flex; align-items:center; justify-content:space-between; gap:var(--sp-2); flex-wrap:wrap; }
  .cfg-tool-text { min-width:0; }
  .cfg-tool-text b { font-size:13px; font-weight:600; }
  .cfg-tool-desc { display:block; font-size:12px; color:var(--muted); line-height:1.7; margin-top:2px; }
  .cfg-tool-params { margin-top:var(--sp-2); }
  .cfg-result { margin-top:var(--sp-2); }
  .cfg-result pre { margin:0; max-height:260px; overflow:auto; background:var(--input); border:1px solid var(--line); border-radius:var(--radius-xs); padding:10px; font-family:var(--font-mono); font-size:11.5px; line-height:1.7; color:var(--txt); white-space:pre-wrap; word-break:break-all; }
`;

export { renderConfigPanels, CONFIG_JS, CONFIG_CSS, KEEP_NAMES_SHIM, ADMIN_PATHS, AUTHED_PATHS, TAB_LABELS };
