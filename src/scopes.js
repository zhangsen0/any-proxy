// 访问通道登记表 —— 全站「有哪些访问通道」的唯一真源。
//
// 为什么单独抽一个模块：通道信息原本散在三处各写一份 ——
//   worker.js     用一长串 if 认路径，
//   stats.js      另写一份 ADMIN_SCOPES 判断哪些算管理通道，
//   stats-ui.js   又抄一份 scope -> 中文名的映射表。
// 结果是「加一个通道要改三个文件」，漏掉任何一处都不会报错，只会静默出错：
// 要么驾驶舱里出现一条叫 `p:foo` 的生 id，要么管理通道被算进公开流量。
//
// 现在只在这张表里加一行（或者干脆改 KV 里的配置，见下），三处自动一致。
//
// 关于「可配置」的边界：这张表描述的是**路由语义**（哪个路径属于哪个通道），
// 它必须与 router.js 的实际路由保持一一对应，所以它是代码而不是用户配置项 ——
// 让用户在面板上随手改，只会让统计与路由对不上。表本身是完全声明式的：
// 想调整归类（例如把 /admin 也算进管理通道），改一行即可；每个通道要记哪些维度、
// 保留多久、记不记管理等**策略**，全部落在 stats.js 的 SPEC 里，走 KV / 环境变量可配。

/**
 * @typedef {object} VisitScope
 * @property {string}   id        通道标识，落盘键与接口返回都用它
 * @property {string}   label     驾驶舱里显示的中文名
 * @property {string[]} prefixes  路径前缀，按表顺序匹配
 * @property {boolean} [capture]  动态通道：把前缀之后的第一段并进通道 id（/p/<站点id> → p:<站点id>）
 * @property {boolean} [admin]    是否管理侧通道，受 record_admin 开关控制
 */

/** @type {VisitScope[]} 顺序即优先级：第一条命中的规则获胜 */
export const VISIT_SCOPES = [
  { id: 'p', label: '站点', prefixes: ['/p/'], capture: true },
  { id: 'share', label: '站点临时链接', prefixes: ['/s/'] },
  { id: 'tsub', label: '临时订阅', prefixes: ['/tsub'] },
  { id: 'sub', label: '主订阅', prefixes: ['/sub'] },
  { id: 'edt', label: '代理节点', prefixes: ['/edt'] },
  { id: 'edt-admin', label: '代理面板', prefixes: ['/admin'], admin: true },
  { id: 'admin', label: '管理面板', prefixes: ['/__admin', '/__tsub', '/__api'], admin: true },
  { id: 'login', label: '登录页', prefixes: ['/__login', '/login'], admin: true },
];

/**
 * 单条前缀规则。边界按「整段或下一段」判定，避免 `/admin` 误吃 `/administrator`；
 * 前缀自带斜杠（如 `/p/`）时就直接按它切开。capture 为真则取下一段并进通道 id。
 */
function matchPrefix(path, prefix, capture) {
  const boundary = prefix.endsWith('/') ? prefix : prefix + '/';
  if (path !== prefix && !path.startsWith(boundary)) return '';
  if (!capture) return prefix;
  const seg = path.slice(boundary.length).split('/')[0];
  return seg ? decodeURIComponent(seg) : '';
}

/**
 * 请求路径 → 统计通道；返回空字符串表示不计入（伪装页、favicon、robots 这类噪声）。
 * @param {string} pathname
 * @returns {string}
 */
export function matchVisitScope(pathname) {
  const path = String(pathname || '');
  for (const scope of VISIT_SCOPES) {
    for (const prefix of scope.prefixes) {
      const hit = matchPrefix(path, prefix, scope.capture);
      if (!hit) continue;
      return scope.capture ? `${scope.id}:${hit}` : scope.id;
    }
  }
  return '';
}

/** 动态通道（如 p:uhdnow）的基名 —— 归属判断与取名都按基名走 */
export function baseScope(scope) {
  const s = String(scope || '');
  const i = s.indexOf(':');
  return i < 0 ? s : s.slice(0, i);
}

/** 动态通道的后缀（站点 id 之类）；非动态通道返回空串 */
export function scopeSuffix(scope) {
  const s = String(scope || '');
  const i = s.indexOf(':');
  return i < 0 ? '' : s.slice(i + 1);
}

/** 登记表里的定义，找不到返回 null（历史遗留通道要能优雅降级） */
export function scopeDef(scope) {
  const id = baseScope(scope);
  return VISIT_SCOPES.find(s => s.id === id) || null;
}

/**
 * 管理侧通道：面板与登录页自己的访问。它们只有开 record_admin 时才计入 ——
 * 否则「我自己看面板」会把访客统计搅浑（统计是用来看谁在用站点，不是看自己）。
 */
export function isAdminScope(scope) {
  const def = scopeDef(scope);
  return !!(def && def.admin);
}

/** 通道标识 → 中文名。纯数据，可直接序列化进前端脚本（函数没法 toString 过去） */
export function scopeLabels() {
  /** @type {Record<string,string>} */
  const out = {};
  for (const scope of VISIT_SCOPES) out[scope.id] = scope.label;
  return out;
}
