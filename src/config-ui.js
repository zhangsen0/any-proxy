/**
 * 管理页「配置」分区的渲染层：把 src/api-catalog.js 里的接口清单渲染成表单。
 *
 * 这里刻意不写任何具体接口的业务逻辑 —— 加一个新配置项 = 在目录里加一条数据，
 * 界面自动出现对应表单。渲染与提交都按数据走，避免「目录改了、面板没改」的分叉。
 */

import { API_CATALOG } from './api-catalog.js';
import { esc } from './util.js';

const ADMIN_PATHS = ['/__api'];
const AUTHED_PATHS = ['/__api/login', '/__api/logout', '/__api/config'];

/** 一个参数控件：type 决定用哪种 input；name 必须与接口字段名一致（实名 If 之前の約定） */
function field(param, itemId) {
  const id = `cfg-${itemId}-${param.key}`;
  const common = `id="${id}" data-key="${esc(param.key)}"`;
  if (param.type === 'textarea') {
    return `<textarea ${common} rows="3" placeholder="${esc(param.placeholder || '')}" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;"></textarea>`;
  }
  if (param.type === 'bool') {
    return `<select ${common}>
      <option value="true">是</option>
      <option value="false">否</option>
    </select>`;
  }
  if (param.type === 'number') {
    return `<input type="number" ${common} placeholder="${esc(param.placeholder || '')}">`;
  }
  if (param.type === 'password') {
    return `<input type="password" ${common} placeholder="${esc(param.placeholder || '')}">`;
  }
  if (param.type === 'select' && param.optionsFrom === 'disguiseTemplates') {
    // 模板清单由 disguise.js 维护（它是唯一知道模板的人），这里在装载时回填选项
    return `<select ${common} data-options="disguiseTemplates"></select>`;
  }
  return `<input type="text" ${common} placeholder="${esc(param.placeholder || '')}">`;
}

/** 单个接口块：说明 + 参数控件 + 执行按钮 + 结果区 */
function endpoint(group, item) {
  const itemId = `${group.id}-${item.id}`;
  const params = item.params || [];
  const body = params.length
    ? params.map(p => `<label for="cfg-${itemId}-${esc(p.key)}">${esc(p.label)}</label>${field(p, itemId)}`).join('')
    : '<div class="hint">该接口不需要参数，直接执行即可。</div>';
  const danger = item.danger ? ' danger' : '';
  const method = item.method === 'GET' ? 'GET' : (item.writeMethod || item.method);
  const canWrite = method !== 'GET';
  return `<div class="endpoint" data-endpoint="${esc(itemId)}" data-path="${esc(item.path)}" data-method="${esc(method)}">
    <div class="endpoint-head"><b>${esc(item.name)}</b> <span class="tag">${esc(item.method)} ${esc(item.path)}</span></div>
    <div class="hint">${esc(item.desc)}${item.auth === false ? '（匿名可读）' : ''}</div>
    ${item.pathParam ? `<label for="cfg-${itemId}-__path">${esc(item.pathParam.label)}</label><input type="text" id="cfg-${itemId}-__path" data-pathparam="1" placeholder="${esc(item.pathParam.placeholder || '')}">` : ''}
    ${body}
    <div class="row">
      ${item.method === 'GET' ? `<button type="button" class="mini" data-act="read">读取当前值</button>` : ''}
      ${canWrite ? `<button type="button" class="mini${danger}" data-act="write">保存 / 执行</button>` : ''}
    </div>
    <div class="msg" id="res-${esc(itemId)}"></div>
  </div>`;
}

/** 整个配置分区：每个分组一张卡片 */
function renderConfigPanels() {
  return API_CATALOG.map(g => `<div class="card" data-pane="config" data-group="${esc(g.id)}">
    <h2>${esc(g.name)}</h2>
    <div class="hint" style="margin:-8px 0 8px;">${esc(g.desc)}</div>
    ${(g.items || []).map(i => endpoint(g, i)).join('<hr class="sep">')}
  </div>`).join('');
}

// ===================== 前端脚本 =====================

const CONFIG_JS = `
/* ===== 配置分区：按 src/api-catalog.js 自动生成的接口表单 ===== */
(function () {
  function panelInputs(root) { return root.querySelectorAll('[data-key]'); }
  function fill(el, value) {
    if (el.tagName === 'SELECT') { el.value = String(value); return; }
    if (el.tagName === 'TEXTAREA') { el.value = Array.isArray(value) ? value.join('\\n') : String(value == null ? '' : value); return; }
    el.value = String(value == null ? '' : value);
  }
  function bodyOf(root) {
    const out = {};
    panelInputs(root).forEach(function (el) {
      const key = el.getAttribute('data-key');
      let v = el.value;
      if (el.tagName === 'SELECT' && el.firstElementChild && el.firstElementChild.tagName === 'OPTION') {
        v = (v === 'true');
      }
      if (el.tagName === 'TEXTAREA' && root.getAttribute('data-normalize') === 'disguise') {
        // anything licenses: units reliable - items/posts 为行进单位的分之制 행 split
        out[key] = String(v).split('\\n').map(function (s) { return s.trim(); }).filter(Boolean);
        return;
      }
      out[key] = v;
    });
    return out;
  }
  function pathOf(root) {
    const tpl = root.getAttribute('data-path') || '';
    const ph = root.querySelector('[data-pathparam]');
    if (!ph) return tpl;
    return tpl.replace('<id>', encodeURIComponent(ph.value.trim()));
  }
  document.querySelectorAll('[data-endpoint]').forEach(function (root) {
    const res = root.querySelector('.msg');
    const readBtn = root.querySelector('[data-act="read"]');
    const writeBtn = root.querySelector('[data-act="write"]');
    if (readBtn) readBtn.onclick = function () {
      api(pathOf(root)).then(function (r) {
        const data = (r && r.config) ? r.config : r;
        panelInputs(root).forEach(function (el) {
          const key = el.getAttribute('data-key');
          if (data && data[key] !== undefined) fill(el, data[key]);
        });
        if (res) setMsg(res.id || '', '已读取当前值', false);
      }).catch(function (e) { if (res) res.textContent = String(e && e.message || e); });
    };
    if (writeBtn) writeBtn.onclick = function () {
      const method = root.getAttribute('data-method') || 'POST';
      api(pathOf(root), { method: method, body: JSON.stringify(bodyOf(root)) }).then(function (r) {
        setMsg(res.id, r && r.error ? r.error : '已保存', !!r && !!r.error);
      }).catch(function (e) { setMsg(res.id, String(e && e.message || e), true); });
    };
  });
})();
`;

export { renderConfigPanels, CONFIG_JS, ADMIN_PATHS, AUTHED_PATHS };
