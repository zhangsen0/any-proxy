// 站点模式注册表自检：内置键保护（不可删 / 引擎不可改）、自定义键增删改、
// 非法输入净化、执行引擎解析（engine 优先 / 自定义键查注册表 / 旧数据兼容 / 回退 normal）。
//
// 用法：node tools/check-site-modes.mjs
import { DEFAULT_SITE_MODES, normalizeModes, resolveEngine, SITE_ENGINES, BADGE_CLASSES } from '../src/site-modes.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  -> ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
}

console.log('[1] 默认注册表结构与引擎三选一');
{
  check('三个内置键都在', ['normal', 'media', 'ai'].every(k => DEFAULT_SITE_MODES[k]), Object.keys(DEFAULT_SITE_MODES).join(','));
  check('每个内置键 engine 与键名一致', ['normal', 'media', 'ai'].every(k => DEFAULT_SITE_MODES[k].engine === k));
  check('engine 词表只有三档', SITE_ENGINES.length === 3 && SITE_ENGINES.join() === 'normal,media,ai');
  check('徽标色板类非空', BADGE_CLASSES.length >= 4);
}

console.log('\n[2] 内置键保护：删不掉、引擎改不动、文案可改');
{
  const input = {
    media: { label: '改过的流媒体', badge: '影', badgeClass: 'badge-purple', hint: '改过', engine: 'ai' }, // 内置键试图改 engine -> 被强制回 media
    // 试图删除 normal / ai：不传即代表删
  };
  const out = normalizeModes(input);
  check('删除内置键会被补回', out.normal && out.ai && out.media, 'keys=' + Object.keys(out).join(','));
  check('内置键 engine 强制等于键名', out.media.engine === 'media');
  check('内置键文案允许修改', out.media.label === '改过的流媒体' && out.media.badge === '影' && out.media.hint === '改过');
  check('内置键徽标样式允许修改', out.media.badgeClass === 'badge-purple');
}

console.log('\n[3] 自定义键：增删改 + engine 白名单');
{
  const out = normalizeModes({
    'custom-1': { label: '我的影视', badge: '影视', badgeClass: 'badge-red', hint: '自用', engine: 'media' },
    'custom-2': { label: '坏引擎', badge: 'x', badgeClass: 'badge-normal', hint: '', engine: 'hack' }, // 非法引擎 -> 整条丢弃
    'UPPER-BAD': { label: '大写键', badge: 'x', badgeClass: 'badge-normal', hint: '', engine: 'normal' },  // 非法键名 -> 丢弃
    'bad key': { label: '含空格', badge: 'x', badgeClass: 'badge-normal', hint: '', engine: 'normal' },   // 非法键名 -> 丢弃
  });
  check('合法自定义键被保留', !!out['custom-1'] && out['custom-1'].engine === 'media');
  check('非法引擎的自定义键被丢弃', !out['custom-2']);
  check('非法键名被丢弃', !out['UPPER-BAD'] && !out['bad key']);
  check('内置键始终补齐', !!out.normal && !!out.media && !!out.ai);
  // 删除自定义键
  const out2 = normalizeModes({ ...out, 'custom-1': null });
  check('自定义键可删除', !out2['custom-1']);
  // 徽标类白名单
  const out3 = normalizeModes({ 'custom-9': { label: 'l', badge: 'b', badgeClass: 'not-a-class', hint: '', engine: 'ai' } });
  check('非法徽标类回退 badge-normal', out3['custom-9'].badgeClass === 'badge-normal');
}

console.log('\n[4] resolveEngine：engine 优先 / 注册表查自定义键 / 旧数据兼容 / 回退');
{
  const modes = normalizeModes({ 'custom-1': { label: '影视', badge: '影', badgeClass: 'badge-red', hint: '', engine: 'media' } });
  check('site.engine 优先', resolveEngine({ proxyMode: 'custom-1', engine: 'media' }, modes) === 'media');
  check('自定义键经注册表解析引擎', resolveEngine({ proxyMode: 'custom-1' }, modes) === 'media');
  check('内置键正常解析', resolveEngine({ proxyMode: 'ai' }, modes) === 'ai');
  check('旧数据 media 兼容映射', resolveEngine({ proxyMode: 'media' }, null) === 'media');
  check('旧数据 ai 兼容映射', resolveEngine({ proxyMode: 'ai' }, null) === 'ai');
  check('未登记键回退 normal', resolveEngine({ proxyMode: 'ghost' }, modes) === 'normal');
  check('空站点回退 normal', resolveEngine(null) === 'normal');
}

console.log(`\n站点模式注册表：${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
