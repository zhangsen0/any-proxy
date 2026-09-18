#!/usr/bin/env node
/**
 * 配置页与接口目录自检。
 *
 * 这一层要防的是「界面和目录各说各话」——这类问题单测抓不到，
 * 因为它不报错，只是静默地对不上：
 *   - 模块 SPEC 加了字段，目录没加 → 界面少一个输入框，用户永远改不到那个配置
 *   - 目录写了字段，SPEC 里没有 → 界面多一个输入框，保存后被服务端悄悄丢掉
 *   - 同一个配置在配置页和功能页各有一份表单 → 改完一边忘了另一边，两边口径打架
 *   - 卡片漏写 data-pane → 它不参与选项卡切换，于是「在好几个选项卡里都有」
 *     （优选池 & 健康检查就是这么长在所有选项卡里的）
 *   - 某个选项卡的卡片自己写一套内边距、或者套一层带内边距的盒子 → 它的字段
 *     比别的选项卡窄一圈。宽度这类问题不报错、只是难看，所以要按数值验一遍
 *   - 目录写了不存在的接口 → 点下去只会拿到 404
 *
 * 用法：node tools/check-configui.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bindRuntime } from '../src/runtime.js';
import { API_CATALOG, flatCatalog, placementOf, splitCatalog, TAB_LABELS } from '../src/api-catalog.js';
import { renderConfigPanels, renderSettingForm, renderToolItem, CONFIG_JS, CONFIG_CSS } from '../src/config-ui.js';
import { BASE_VARS } from '../src/themes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  -> ' + extra : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? '  -> ' + extra : ''}`); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

// ---- 渲染管理页所需的运行环境（内存 KV，零网络） ----
const mem = new Map();
const kv = {
  async list(o = {}) {
    const p = (o && o.prefix) || '';
    return { keys: [...mem.keys()].filter(k => k.startsWith(p)).map(name => ({ name })), list_complete: true };
  },
  async get(k) { return mem.has(k) ? mem.get(k) : null; },
  async put(k, v) { mem.set(k, v); },
  async delete(k) { mem.delete(k); },
};
const env = { PASSWORD: 'dev', SITES: kv, PROXY_HOST: 'proxy.example.com' };
bindRuntime(env);
// 渲染管理页不该发任何网络请求；发了就让测试炸掉，而不是静默走网络
globalThis.fetch = async url => { throw new Error('管理页渲染期间不应发起网络请求：' + url); };

const { adminPage } = await import('../src/admin.js');
const pageHtml = await (await adminPage(true, 'https://proxy.example.com', env)).text();
const anonHtml = await (await adminPage(false, 'https://proxy.example.com', env)).text();
const adminJs = read('src/admin.js');

const panelsHtml = renderConfigPanels();
const flat = flatCatalog();

// ===================== 1. 目录本身 =====================
section('1. 目录结构');
{
  const ids = flat.map(i => i.id);
  const dupIds = ids.filter((x, i) => ids.indexOf(x) !== i);
  ok('接口 id 全目录唯一', dupIds.length === 0, dupIds.join(',') || `${ids.length} 个`);

  const groupIds = API_CATALOG.map(g => g.id);
  const dupGroups = groupIds.filter((x, i) => groupIds.indexOf(x) !== i);
  ok('分组 id 唯一', dupGroups.length === 0, dupGroups.join(',') || `${groupIds.length} 组`);

  ok('每个分组都有名称与说明', API_CATALOG.every(g => g.name && g.desc));
  ok('每个接口都有名称、路径与说明', flat.every(i => i.name && i.path && i.desc));
  ok('目录路径都是 /__api 前缀', flat.every(i => i.path.startsWith('/__api/')), '避免误伤业务路径');
  ok('每个接口都声明了 kind 或可推断', flat.every(i => ['setting', 'query', 'action'].includes(i.kind || (String(i.method || 'GET').toUpperCase() === 'GET' ? 'query' : 'action'))));

  const badTab = API_CATALOG.filter(g => g.tab && !TAB_LABELS[g.tab]).map(g => g.id);
  ok('归属选项卡都在选项卡清单里', badTab.length === 0, badTab.join(',') || Object.keys(TAB_LABELS).join(','));

  const orphan = API_CATALOG.filter(g => !g.hidden && !g.tab && !g.items.some(i => placementOf(g, i) !== 'off'));
  ok('没有既不可见又不归属任何地方的分组', orphan.length === 0, orphan.map(g => g.id).join(','));
}

// ===================== 2. 目录与 SPEC 双向一致 =====================
section('2. 字段与模块 SPEC 对齐');
{
  const withSpec = flat.filter(i => i.spec && i.params);
  ok('有 SPEC 的设置项都被检查到', withSpec.length >= 4, `${withSpec.length} 项`);
  for (const item of withSpec) {
    const specKeys = Object.keys(item.spec);
    const catKeys = item.params.map(p => p.key);
    const missing = specKeys.filter(k => !catKeys.includes(k));
    const extra = catKeys.filter(k => !specKeys.includes(k));
    ok(`${item.id}：SPEC 字段全部有对应控件`, missing.length === 0, missing.join(',') || specKeys.length + ' 个');
    ok(`${item.id}：没有目录里多写的字段`, extra.length === 0, extra.join(',') || '—');
  }
  const dupKey = [];
  for (const item of flat) {
    const keys = (item.params || []).map(p => p.key);
    if (keys.length !== new Set(keys).size) dupKey.push(item.id);
  }
  ok('同一接口内字段 key 不重复', dupKey.length === 0, dupKey.join(','));
}

// ===================== 3. 渲染覆盖：每一项都出现，且只出现一次 =====================
section('3. 面板渲染覆盖');
{
  const { cards, tools } = splitCatalog();
  const rendered = [];
  for (const { items } of cards) rendered.push(...items.map(i => i.id));
  rendered.push(...tools.map(i => i.id));

  const groupOf = item => API_CATALOG.find(g => g.id === item.group);
  const expected = flat.filter(i => ['stay', 'keep'].includes(placementOf(groupOf(i), i)));
  ok('应渲染的接口数与预期一致', rendered.length === expected.length,
    `渲染 ${rendered.length} / 预期 ${expected.length}`);
  const missing = expected.filter(i => !rendered.includes(i.id)).map(i => i.id);
  ok('没有漏渲染的接口', missing.length === 0, missing.join(',') || '—');
  const dup = rendered.filter((x, i) => rendered.indexOf(x) !== i);
  ok('没有重复渲染的接口', dup.length === 0, dup.join(',') || '—');

  const htmlUids = [...panelsHtml.matchAll(/data-(?:setting|tool) data-uid="([^"]+)"/g)].map(m => m[1]);
  ok('渲染出的接口块与清单一致', htmlUids.length === rendered.length, `块 ${htmlUids.length}`);

  // 归属选项卡的接口不该在配置页再长一份
  for (const item of flat) {
    const group = groupOf(item);
    if (!group || !group.tab || item.keep) continue;
    ok(`${item.id} 不在配置页重复出现（归属「${TAB_LABELS[group.tab]}」）`, !htmlUids.includes(item.id));
  }

  // 隐藏项一律不出现
  const hiddenItems = flat.filter(i => groupOf(i).hidden);
  ok('隐藏分组不出现在配置页', hiddenItems.every(i => !panelsHtml.includes(`data-uid="${i.id}"`)),
    hiddenItems.map(i => i.id).join(','));
}

// ===================== 4. 同一份配置全页只出现一次 =====================
section('4. 同一份配置只有一处可改');
{
  // 这是本次改动的核心：优选池 & 健康检查曾经同时长在「优选 IP」和「配置」页，
  // 于是「面板显示 A、实际生效 B」。
  //
  // 不变量是「**一份配置只有一张可编辑表单**」：同一接口路径最多一个 data-setting 块。
  // 动作块（data-tool）与表单共用路径是另一回事（读表单 + 触发一次动作，如
  // 「优选 IP 池」表单旁边挂「把当前池子写入 DNS」），所以只对 data-setting 计数。
  const settingPaths = [...pageHtml.matchAll(/data-setting data-uid="[^"]*" data-path="([^"]+)"/g)].map(m => m[1]);
  const tally = settingPaths.reduce((a, p) => (a[p] = (a[p] || 0) + 1, a), {});
  const dup = Object.entries(tally).filter(([, n]) => n > 1);
  ok('全页没有重复的设置表单（一份配置只有一张可编辑表单）', dup.length === 0,
    dup.length ? dup.map(([p, n]) => `${p}×${n}`).join(', ') : `${settingPaths.length} 张设置表单`);

  const preferredPaths = ['/__api/pool-config', '/__api/preferred-ips', '/__api/dns-config'];
  ok('优选池与优选 IP 的配置不在配置页出现', preferredPaths.every(p => !panelsHtml.includes(`data-path="${p}"`)),
    preferredPaths.join(', '));

  // 归属选项卡必须仍然能改到这些配置（搬家别搬丢）。
  // 走目录契约（data-uid + data-key）而不是手写元素 id：表单 id 由注册表推导，
  // 断言字段名才能同时钉住「表单在页面上」和「字段来自注册表」。
  const anchors = {
    preferred: ['data-uid="dns-config"', 'data-uid="preferred-ips"', 'data-uid="pool-config"',
      'data-key="preferred_ips"', 'data-key="pool_good_ips"', 'data-key="pref_domains"',
      'data-path="/__api/dns-run"', 'id="autoBtn"'],
    theme: ['themeGrid', 'rtMode', 'rtMinutes', 'rtPool', 'ctId'],
    security: ['disguiseCard'],
    share: ['shSite', 'shCreate', 'shList'],
    sites: ['addCard', 'editModal'],
    proxy: ['data-uid="node-config"', 'data-key="node_uuid"', 'data-key="node_host"',
      'data-uid="sub-config"', 'data-key="sub_url"',
      'data-uid="node-tag"', 'data-key="node_tag_enabled"', 'data-key="node_tag_style"'],
    // 驾驶舱：图表容器 + 设置表单都得在「数据驾驶舱」选项卡里，别在搬家时丢件
    stats: ['statsCard', 'stDays', 'stKpis', 'stChart', 'stRank'],
  };
  for (const [tab, ids] of Object.entries(anchors)) {
    const missing = ids.filter(id => !pageHtml.includes(id));
    ok(`「${TAB_LABELS[tab]}」选项卡仍能改到归属它的配置`, missing.length === 0, missing.join(',') || ids.length + ' 个入口');
  }

  ok('临时链接的设置表单在「临时链接」页里', /id="shareCard"[\s\S]*?data-setting[\s\S]*?data-path="\/__api\/share-config"/.test(pageHtml));
}

// ===================== 5. 选项卡归属：卡片必须挂在真实存在的标签上 =====================
section('5. 卡片与选项卡对应');
{
  // poolCard 漏写 data-pane 时，它不参与切换，于是在每个选项卡下都常驻显示。
  // 这条断言就是冲它去的：登录态的每张卡片都必须声明归属，且归属必须真实存在。
  const tabs = [...new Set([...pageHtml.matchAll(/data-tab="([a-z]+)"/g)].map(m => m[1]))];
  const cards = [...pageHtml.matchAll(/<div class="card[^"]*"([^>]*)>/g)].map(m => m[1]);
  ok('页面里能抓到卡片', cards.length >= 10, `${cards.length} 张`);
  const noPane = cards.filter(a => !/data-pane="/.test(a));
  ok('登录态每张卡片都声明了归属选项卡', noPane.length === 0,
    noPane.length ? noPane.map(a => a.trim().slice(0, 40)).join(' | ') : '—');
  const paneVals = [...new Set(cards.map(a => (a.match(/data-pane="([^"]+)"/) || [])[1]).filter(Boolean))];
  const unknown = paneVals.filter(p => !tabs.includes(p));
  ok('卡片归属的选项卡都存在', unknown.length === 0, unknown.join(',') || paneVals.join(','));
  const empty = tabs.filter(t => !paneVals.includes(t));
  ok('每个选项卡至少有一张卡片', empty.length === 0, empty.join(',') || tabs.join(','));

  const configCards = [...panelsHtml.matchAll(/class="card cfg-card"/g)].length;
  ok('配置页由目录生成卡片', configCards >= splitCatalog().cards.length, `${configCards} 张`);
}

// ===================== 6. 控件与交互 =====================
section('6. 控件与交互');
{
  const ids = [...panelsHtml.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  ok('配置页内元素 id 唯一', ids.length === new Set(ids).size, `${ids.length} 个`);

  const rendered = renderSettingForm(flat.find(i => i.id === 'ratelimit-config'));
  const keys = (flat.find(i => i.id === 'ratelimit-config').params || []).map(p => p.key);
  const missKey = keys.filter(k => !rendered.includes(`data-key="${k}"`));
  ok('设置项每个字段都渲染了控件', missKey.length === 0, missKey.join(',') || keys.length + ' 个字段');
  ok('设置块带保存与还原按钮', rendered.includes('data-act="save"') && rendered.includes('data-act="revert"'));
  ok('保存按钮初始禁用（未改动无意义操作）', /data-act="save" disabled/.test(rendered));
  ok('开关类字段渲染成开关而不是下拉', /type="checkbox"/.test(renderSettingForm(flat.find(i => i.id === 'stats-config'))));
  ok('数值字段带 SPEC 的范围限制', /min="1" max="3650"/.test(renderSettingForm(flat.find(i => i.id === 'stats-config'))), '保留天数');
  ok('进阶字段收进折叠区', /cfg-more/.test(rendered) && rendered.indexOf('cfg-more') < rendered.indexOf('data-key="whitelist"'));
  const alertForm = renderSettingForm(flat.find(i => i.id === 'alert-config'));
  ok('敏感字段标注「已配置」徽标', /data-secret-badge/.test(alertForm));
  ok('敏感字段用密码框', /type="password"[\s\S]*data-secret="1"/.test(alertForm));

  const query = renderToolItem(flat.find(i => i.id === 'ratelimit-bans'));
  const act = renderToolItem(flat.find(i => i.id === 'ratelimit-clear'));
  ok('查询类按钮是「查看」', query.includes('>查看<'));
  ok('动作类按钮是「执行」', />(确认)?执行</.test(act));
  ok('危险动作要二次确认', act.includes('data-confirm="1"') && act.includes('>确认执行<'));
  ok('工具结果区默认隐藏', /class="cfg-result" hidden/.test(query));
  const withQuery = renderToolItem(flat.find(i => i.id === 'stats'));
  ok('查询参数拼进查询串而非 body', withQuery.includes('data-in="query"'));
}

// ===================== 7. 接口真实存在 =====================
section('7. 目录里的接口都真的存在');
{
  const adminPaths = [...adminJs.matchAll(/['"`](\/__api[^'"`]*)['"`]/g)].map(m => m[1]);
  // 登录 / 登出挂在路由层（router.js + auth.js），不经过 handleAdmin，这里排除
  const routerOwned = ['/__api/login', '/__api/logout'];
  const bad = flat.filter(i => {
    if (routerOwned.includes(i.path)) return false;
    const p = i.path.replace(/<[^>]+>/g, '');
    return !adminPaths.some(a => a === p || a.startsWith(p + '/'));
  }).map(i => i.id + ' ' + i.path);
  ok('每个接口在 admin.js 里都有对应分支', bad.length === 0, bad.join(', ') || `${flat.length} 个接口`);

  // 反向也要查：admin.js 里新加了接口，目录却没跟上 ——
  // 面板不会渲染它、手册也不会收录它，而且**什么都不会报错**（页面照常渲染、检查照常绿）。
  // 这正是「这里改了、那里不生效」的另一种长相：功能能调，但运营在面板上永远看不见。
  // 白名单只放「刻意不进目录」的接口，每条都要写明理由，否则就不该在这张名单上。
  const OFF_CATALOG = [
    // 内部探活端点：dns.js 用它判断哪个边缘主机活着（PROBE_PATH），不是给人点的操作，
    // 出现在面板上只会被误点。
    '/__api/config',
    // 伪装页预览：管理员自查访客视角，入口按钮写在伪装卡片自己的脚本里（新标签页打开），
    // 不是「运营要改的配置」，所以不入目录。
    '/__api/disguise-preview',
  ];
  // 归一化：去掉 <id> 占位、去掉查询串（/__api/tempsubs?t=xxx 与 /__api/tempsubs 是同一条路由）、去掉尾斜杠
  const norm = p => p.replace(/<[^>]+>/g, '').split('?')[0].replace(/\/+$/, '');
  const catalogPaths = new Set(flat.map(i => norm(i.path)));
  const orphan = [...new Set(adminPaths.map(norm))]
    .filter(p => !catalogPaths.has(p) && !OFF_CATALOG.includes(p) && !routerOwned.includes(p));
  ok('admin.js 里的接口都在目录里（新增接口不会漏掉面板与手册）', orphan.length === 0,
    orphan.join(', ') || `已核对 ${new Set(adminPaths.map(norm)).size} 条路径`);
  for (const p of OFF_CATALOG) {
    ok(`白名单里的 ${p} 确实还没进目录（防止白名单写了却不生效）`,
      adminPaths.map(norm).includes(p) && !catalogPaths.has(p));
  }

  const routerJs = read('src/router.js');
  ok('登录 / 登出接口在路由里', routerJs.includes('/__api/login') && routerJs.includes('/__api/logout'));
}

// ===================== 8. 注入防护 =====================
section('8. 目录内容进 HTML 必须转义');
{
  const evil = '<script>alert(1)</script>';
  const html = renderToolItem({
    id: 'x', name: evil, desc: evil, path: '/__api/x', method: 'POST', auth: true,
    params: [{ key: 'k', label: evil, type: 'text', placeholder: evil, hint: evil }],
  }) + renderSettingForm({ id: 'y', name: evil, desc: evil, path: '/__api/y', method: 'POST', spec: { k: { type: 'str', default: evil } }, params: [{ key: 'k', label: evil }] });
  ok('名称与说明被转义', !/<script/i.test(html) && html.includes('&lt;script&gt;'));
  ok('字段标签与占位被转义', (html.match(/&lt;script&gt;/g) || []).length >= 4, `${(html.match(/&lt;script&gt;/g) || []).length} 处`);
  ok('下拉选项的值与文案被转义', !/<script/i.test(renderToolItem({
    id: 'z', name: 'z', path: '/__api/z', method: 'GET',
    params: [{ key: 'k', label: 'k', options: [{ value: evil, label: evil }] }],
  })));
}

// ===================== 9. 前端脚本 =====================
section('9. 前端脚本');
{
  ok('脚本语法可解析', (() => { try { new Function(CONFIG_JS); return true; } catch (e) { return false; } })());
  for (const marker of ['data-setting', 'data-tool', 'data-act', 'data-key', 'data-state']) {
    ok('脚本覆盖 ' + marker, CONFIG_JS.includes(marker));
  }
  ok('脚本被注入到管理页', pageHtml.includes('cfg-switch-label'));
  // 改完没点保存就离开，等于白改。脏状态必须能看出来
  ok('脚本会标记未保存状态', CONFIG_JS.includes('未保存'));
  ok('敏感项留空不覆盖原值', CONFIG_JS.includes("data-secret") && CONFIG_JS.includes('return;'));
  ok('危险动作在执行前弹确认', CONFIG_JS.includes('window.confirm'));

  const styleCss = read('src/config-ui.js');
  ok('配置页样式随主题变量走', /var\(--(line|card|input|txt)\)/.test(styleCss) && !/#[0-9a-f]{6}/i.test(styleCss.split('CONFIG_CSS')[1] || ''));
  // 「未登录不给设置表单」：断言的是设置块元素本身（data-setting data-uid=…），
  // 而不是 data-setting 这个字符串 —— 注入的页面脚本注释里也会出现它。
  ok('未登录分支不渲染配置分区', !/data-setting data-uid=/.test(anonHtml));

  // 页面脚本引用的 DOM id 必须真的存在。
  //
  // 起因：把几张手写卡片换成目录渲染的表单时，卡片连同它的输入框一起没了，
  // 但脚本里那段 `getElementById('xxx').onclick = …` 还留着。这类残留不会报错 ——
  // 页面照常打开、其它功能照常，只有那段逻辑静默失效（`?.` 或 `if (el)` 守卫把它吞了）。
  // 反过来「脚本还在、卡片已删」和「卡片在、脚本忘了配」都靠这一条兜住。
  const usedIds = new Set([...adminJs.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]));
  const ghostIds = [...usedIds].filter(id => !new RegExp(`id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(pageHtml)
    && !new RegExp(`id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(anonHtml));
  ok('页面脚本引用的 DOM id 都真实存在（删卡片时别把脚本落下）', ghostIds.length === 0,
    ghostIds.join(', ') || `已核对 ${usedIds.size} 个 id`);
}

// ===================== 10. 各选项卡的内容宽度 =====================
section('10. 布局度量一致（选项卡之间同宽）');
{
  // 起因：「临时链接」和「配置」两页的内容比前面几个选项卡窄一圈。三处叠加造成的 ——
  // 卡片内边距被各写一份（20px vs var(--sp-3) var(--sp-4)）、设置块外面又套了一层
  // 带内边距的盒子、字段栅格还是另一套列宽（210px 起排，被排成 3 列）。
  // 这一节把度量钉在唯一来源上：以后想让某个页面单独窄一点，只能改主题变量，
  // 改不动就会被这里拦下。
  ok('主题里声明了卡片内边距', !!BASE_VARS['--card-pad'], BASE_VARS['--card-pad']);
  ok('主题里声明了字段最小列宽', !!BASE_VARS['--field-min'], BASE_VARS['--field-min']);
  ok('主题里声明了栅格间距', !!BASE_VARS['--grid-gap'], BASE_VARS['--grid-gap']);

  // 变量值可能是引用（--grid-gap: var(--sp-3)），算数前先展开
  const expand = (value, depth = 0) => String(value).replace(
    /var\((--[a-z0-9-]+)(?:,\s*([^)]*))?\)/gi,
    (m, name, fallback) => (depth > 6 ? '' : expand(BASE_VARS[name] !== undefined ? BASE_VARS[name] : (fallback || ''), depth + 1)),
  );
  const pxOf = v => { const m = /^(-?[\d.]+)px$/.exec(String(v).trim()); return m ? parseFloat(m[1]) : null; };
  const cssRule = (css, selector) => {
    const re = new RegExp(selector.replace(/[.[\]()*+?^${}|\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
    const m = re.exec(css);
    return m ? m[1].trim() : '';
  };
  const declOf = (block, prop) => {
    const m = new RegExp('(?:^|;)\\s*' + prop + '\\s*:([^;]*)').exec(block);
    return m ? m[1].trim() : '';
  };
  /** padding:32px 16px 64px -> 左右 16px */
  const padXOf = v => {
    const parts = String(v).trim().split(/\s+/).filter(Boolean).map(pxOf);
    if (!parts.length || parts.some(n => n === null)) return null;
    return parts.length === 1 ? parts[0] : parts[1];
  };

  const cardBlock = cssRule(adminJs, '.card');
  ok('全站卡片的 padding 来自 --card-pad',
    declOf(cardBlock, 'padding') === 'var(--card-pad)', declOf(cardBlock, 'padding') || '(无)');

  const cfgCard = declOf(cssRule(CONFIG_CSS, '.cfg-card'), 'padding');
  ok('配置页卡片沿用同一度量', cfgCard === 'var(--card-pad)', cfgCard || '(无)');

  const cfgSet = cssRule(CONFIG_CSS, '.cfg-set');
  const setPad = declOf(cfgSet, 'padding');
  const setSide = declOf(cfgSet, 'padding-left') || declOf(cfgSet, 'padding-right');
  ok('设置块不再横向缩进（字段与卡片内容对齐）',
    !setSide && (!setPad || /^0(\s+0){0,3}$/.test(setPad)), setPad || '(无)');

  const grid = cssRule(CONFIG_CSS, '.cfg-grid');
  ok('字段栅格用 --field-min 定列宽', grid.includes('--field-min'));
  ok('字段栅格用 --grid-gap 定间距', declOf(grid, 'gap') === 'var(--grid-gap)', declOf(grid, 'gap'));

  // 站点页(.grid2) 与配置页(.cfg-grid) 必须共用同一套列公式（都走 --field-min 的 auto-fit），
  // 这样无论窗口多宽两页字段宽度都一致；谁把某一页改回 1fr 1fr 会被这条断言抓到
  const grid2Decl = declOf(cssRule(adminJs, '.grid2'), 'grid-template-columns');
  const cfgGridDecl = declOf(grid, 'grid-template-columns');
  const usesShared = s => /auto-fit/.test(s) && s.includes('--field-min');
  ok('站点页与配置页栅格共用 --field-min 公式（防某页被改窄）',
    usesShared(grid2Decl) && usesShared(cfgGridDecl),
    `grid2: ${grid2Decl} | cfg-grid: ${cfgGridDecl}`);
  const colsOf = decl => /auto-fit/.test(decl)
    ? Math.floor((inner + gridGap) / (fieldMin + gridGap))
    : ((decl.match(/1fr/g) || []).length || 1);

  ok('配置页文案行与卡片内容对齐',
    declOf(cssRule(CONFIG_CSS, '.cfg-lead'), 'padding') === '0 var(--card-pad)',
    declOf(cssRule(CONFIG_CSS, '.cfg-lead'), 'padding') || '(无)');

  // 选项卡的顶层块必须是同一种卡片：换个 class 就等于换了宽度来源
  const paneTags = [...pageHtml.matchAll(/<[a-z][^>]*\sdata-pane="[^"]*"[^>]*>/g)].map(m => m[0]);
  ok('选项卡顶层块数量与选项卡一致', paneTags.length >= Object.keys(TAB_LABELS).length, `${paneTags.length} 块`);
  // cfg-lead 是配置页的引导说明段落（不是卡片，也不该有卡片的边框/底色），允许作为顶层块；
  // 真正的纪律是「换 class = 换宽度来源」，引导段没有横向度量所以不破坏这条。
  const noCard = paneTags.filter(t => !/class="[^"]*\bcard\b/.test(t) && !/class="[^"]*\bcfg-lead\b/.test(t));
  ok('每个选项卡顶层块都是卡片（引导段除外）', noCard.length === 0, noCard.join(' | ') || '—');
  // 横向度量写进行内样式，就绕过了主题变量，也没法被这一节盯住
  const SIZING_RE = /(?:^|;|\s)(width|max-width|min-width|padding|padding-left|padding-right|margin-left|margin-right)\s*:/;
  const inlineSize = paneTags.filter(t => {
    const m = /style="([^"]*)"/.exec(t);
    return m ? SIZING_RE.test(m[1]) : false;
  });
  ok('选项卡块的横向尺寸不写在行内样式里', inlineSize.length === 0, inlineSize.join(' | ') || '—');

  // 算一遍真实宽度：配置页的栅格自动列数要和站点页的固定列数排出同样的字段宽
  const wrapBlock = cssRule(adminJs, '.wrap');
  const pageMax = pxOf(declOf(wrapBlock, 'max-width'));
  const pagePadX = padXOf(declOf(wrapBlock, 'padding'));
  const cardPad = pxOf(expand(BASE_VARS['--card-pad']));
  const fieldMin = pxOf(expand(BASE_VARS['--field-min']));
  const gridGap = pxOf(expand(BASE_VARS['--grid-gap']));
  const inner = pageMax - 2 * pagePadX - 2 * cardPad;
  const siteCols = colsOf(grid2Decl);
  const cfgCols = colsOf(cfgGridDecl);
  ok('配置页字段列数与站点页一致', cfgCols === siteCols,
    `配置页 ${cfgCols} 列 / 站点页 ${siteCols} 列（卡片内容宽 ${inner}px）`);
  const colW = n => (inner - (n - 1) * gridGap) / n;
  ok('两页字段宽度一致', Math.abs(colW(cfgCols) - colW(siteCols)) < 0.01, `${colW(cfgCols)}px vs ${colW(siteCols)}px`);
}

// ===================== 11. 临时链接区块：api 契约行为校验 =====================
section('11. 临时链接区块（api 包装契约行为校验）');
{
  // api() 返回 { ok, status, data } 包装结构。这里把渲染产物里的「站点临时访问链接」
  // IIFE 原样抠出来，在裸沙盒里配桩真跑一遍。历史上它按旧契约直接读 r.sites / r.shares，
  // 「生成链接」的站点下拉永远只有占位项——不报错、只静默为空，字符串断言抓不到，
  // 只有把脚本真正执行起来才能暴露。
  const marker = '站点临时访问链接：列表 + 生成 + 停用 / 启用 + 删除';
  const mi = pageHtml.indexOf(marker);
  ok('能定位到临时链接区块脚本', mi > 0);
  if (mi > 0) {
    const start = pageHtml.indexOf('(function () {', mi);
    const end = pageHtml.indexOf('</script>', mi);
    const code = start > 0 && end > start ? pageHtml.slice(start, end).trim() : '';
    ok('成功截取完整 IIFE（以 })(); 结尾）', code.endsWith('})();'));
    ok('share 脚本不经 r.sites / r.shares 等旧契约读字段（一律走 r.data.*）',
      code.length > 0 && !/\br\.(sites|shares|path|error)\b/.test(code));
    // 复制链接：路径必须来自 data-path 属性（不从展示文本反解析——文案一改就解析错），
    // 且必须走带 execCommand 降级的 copyText（裸 navigator.clipboard 失败即静默丢）
    ok('复制链接基于行上的 data-path', code.includes("getAttribute('data-path')")
      && !code.includes("querySelector('.site-target').textContent"));
    ok('复制链接走 copyText 助手（带降级）', /copyText\(full/.test(code));

    const runShare = async data => {
      const els = {};
      const mk = () => ({ innerHTML: '', addEventListener() {}, value: '', onclick: null });
      const doc = { getElementById: id => (els[id] || (els[id] = mk())) };
      const api = () => Promise.resolve({ ok: true, status: 200, data });
      let err = '';
      try {
        new Function('document', 'api', 'copyText', code)(doc, api, () => {});
        await new Promise(r => setTimeout(r, 20));
      } catch (e) { err = String(e && e.message || e); }
      return {
        err,
        shSite: (els.shSite && els.shSite.innerHTML) || '',
        shList: (els.shList && els.shList.innerHTML) || '',
      };
    };
    const good = await runShare({
      sites: [{ id: 's1', name: '站点一' }],
      shares: [{ token: 't1', note: '演示', site: 's1', path: '/s/abc', hits: 1, max_hits: 0, disabled: false, left_hours: 3 }],
    });
    ok('沙盒执行无异常', !good.err, good.err);
    ok('站点下拉被真实填充（占位 + 1 个站点）',
      (good.shSite.match(/<option/g) || []).length === 2 && good.shSite.includes('站点一'),
      `option=${(good.shSite.match(/<option/g) || []).length}`);
    ok('临时链接列表被真实渲染', good.shList.includes('演示') && good.shList.includes('/s/abc'));

    const empty = await runShare({ sites: [], shares: [] });
    ok('空数据时保留占位项并显示空态',
      (empty.shSite.match(/<option/g) || []).length === 1 && empty.shList.includes('还没有临时链接'));
  }
}

// ===================== 12. 长表单切成分组标签 =====================
section('12. 长表单切成分组标签（一屏不再滚很久）');
{
  const runtime = flat.find(i => i.id === 'settings-runtime');
  const html = renderSettingForm(runtime);
  const groups = [...new Set(runtime.params.map(p => p.section))];
  const panes = [...html.matchAll(/data-gpane="(\d+)"/g)].map(m => m[1]);

  ok('长表单确实触发了分组标签', html.includes('data-cfg-subtabs'), `${runtime.params.length} 个字段`);
  ok('标签数与分组数一致', (html.match(/class="subtab/g) || []).length === groups.length, `${groups.length} 组`);
  ok('每组一个容器且编号连续', panes.length === groups.length
    && panes.every((v, i) => String(i) === v), panes.join(','));
  ok('只有第一组默认展开', /data-gpane="0">/.test(html)
    && !/data-gpane="0" hidden/.test(html)
    && (html.match(/data-gpane="\d+" hidden/g) || []).length === groups.length - 1);
  // 切页只是 hidden，不是不渲染 —— 否则「切到别的组再保存」会把前一组的值静默丢掉
  const missKey = runtime.params.map(p => p.key)
    .filter(k => !html.includes(`data-key="${k}"`));
  ok('所有字段仍然渲染（切页不销毁字段）', missKey.length === 0, missKey.join(',') || runtime.params.length + ' 个');
  ok('组内的进阶项仍然收进折叠', (html.match(/cfg-more/g) || []).length >= 1,
    `${(html.match(/cfg-more/g) || []).length} 个折叠块`);
  ok('分组标签也是主题变量配色（无写死色值）', !/#[0-9a-f]{6}/i.test(
    (CONFIG_CSS.split('.cfg-subtabs')[1] || '').split('.cfg-num')[0] || ''));

  const short = renderSettingForm(flat.find(i => i.id === 'ratelimit-config'));
  ok('短表单不被切成标签（切了反而更麻烦）', !short.includes('data-cfg-subtabs'));

  ok('前端脚本绑定了分组标签', CONFIG_JS.includes('data-cfg-subtabs') && CONFIG_JS.includes('data-gpane'));
  ok('切页时会同步 aria 选中态', CONFIG_JS.includes('aria-selected'));
  ok('有未保存改动的分组会在标签上留记号', CONFIG_JS.includes('data-dot'));
  ok('管理页真的渲染出了运行参数分组标签', pageHtml.includes('data-cfg-subtabs'));
}

globalThis.fetch = undefined;

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);console.log(`配置页与接口目录：${pass + fail} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：' + failures.join('、')); process.exit(1); }
