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
  // 于是「面板显示 A、实际生效 B」。这里按接口路径统计全页出现次数。
  const paths = [...pageHtml.matchAll(/data-path="([^"]+)"/g)].map(m => m[1]);
  const tally = paths.reduce((a, p) => (a[p] = (a[p] || 0) + 1, a), {});
  const dup = Object.entries(tally).filter(([, n]) => n > 1);
  ok('全页没有重复的设置表单 / 接口块', dup.length === 0,
    dup.length ? dup.map(([p, n]) => `${p}×${n}`).join(', ') : `${paths.length} 个接口块`);

  const preferredPaths = ['/__api/pool-config', '/__api/preferred-ips', '/__api/dns-config'];
  ok('优选池与优选 IP 的配置不在配置页出现', preferredPaths.every(p => !panelsHtml.includes(`data-path="${p}"`)),
    preferredPaths.join(', '));

  // 归属选项卡必须仍然能改到这些配置（搬家别搬丢）
  // 手写表单没有 data-path，所以这里按页面元素 id 核对
  const anchors = {
    preferred: ['dnsInterval', 'prefIps', 'poolDomains', 'dnsRunBtn', 'poolSaveBtn', 'autoBtn'],
    theme: ['themeGrid', 'rtMode', 'rtMinutes', 'rtPool', 'ctId'],
    security: ['disguiseCard'],
    share: ['shSite', 'shCreate', 'shList'],
    sites: ['addCard', 'editModal'],
    proxy: ['nodeTagCard', 'subUrl', 'ntEnabled'],
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
  ok('未登录分支不渲染配置分区', !/data-setting/.test(anonHtml));
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

globalThis.fetch = undefined;

console.log(`\n=== ${fail === 0 ? '全部通过' : '存在失败'} ===`);console.log(`配置页与接口目录：${pass + fail} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：' + failures.join('、')); process.exit(1); }
