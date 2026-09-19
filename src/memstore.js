// 存储降级：KV / D1 读写出问题时，把读写整体落到进程内内存里，让服务继续能跑。
//
// 这不是「第二套存储」，是一条**逃生通道**，有三条必须讲清的边界：
//   1. 内存里的东西 isolate 回收或冷启动就没了 —— 它是临时的，不是持久层；
//   2. Workers 有多少 isolate 不由我们控制且无法枚举，自动降级大概率**只在当前实例**
//      生效，所以状态里带 scope，面板必须按 scope 说实话（见 getStatus）；
//   3. 切回存储之前要用「写回」把变更搬回去，否则内存期间的改动就没了 ——
//      「还剩几个键没写回」是接口必须回答的问题，不能让用户自己猜。
//
// 为什么上层模块浑然不觉：`runtime.KV` 是唯一的存储出口（17 个模块都只认它），
// 这里给出的代理与原生 KV 同形（同样的 get / put / delete / list），上层零改动。
//
// ⚠️ 循环依赖：本模块包着 runtime.KV，而「读降级阈值」本身要过 runtime.KV ——
// 若在这里 import settings 就成环（memstore → settings → runtime.KV(代理) → memstore）。
// 所以本文件不依赖任何会读存储的模块，阈值是个同步变量，
// 由 settings.js 的 readSettings() 在返回前顺手同步进来（见 setFailThreshold）。

const STATE_MAX = 20000;      // 内存键数上限（含影子副本）
const EVENT_MAX = 20;         // 事件日志保留条数
const DEFAULT_THRESHOLD = 3;  // 连续失败几次才降级（可被面板的 storage_fail_threshold 覆盖）

// ===================== 状态 =====================
//
// 状态**不挂在代理闭包上**：bindRuntime() 每个请求都调用一次，闭包每次都是新的，
// 挂上去等于每个请求都失忆。放在 WeakMap 的 value 里则跨调用留存。
// key 用平台注入的那个稳定对象（env.DB / env.SITES），同一个 binding 多次 bind
// 复用同一份状态；不同 binding 各一份，互不串味 —— check-heal.mjs 会在同一进程里
// 交替 bind 几个不同的 SITES 对象，单槽写法会在 A→B→A 之间丢数据。

const states = new WeakMap();
const proxyOwner = new WeakMap();   // 代理 -> 状态。给上层一个「我现在用的到底是哪套状态」的反查入口
const NO_BINDING = { __noBinding: true };   // 没有平台 binding 时用它兜一个稳定 key

/** 由 runtime.KV 那个代理反查它背后的状态（面板渲染状态条时用） */
export function stateOf(kvProxy) {
  return proxyOwner.get(kvProxy);
}

let failThreshold = DEFAULT_THRESHOLD;

/** settings 每次读完配置顺手把阈值同步进来（同步变量，不 await，避免递归） */
export function setFailThreshold(n) {
  const v = Number(n);
  if (Number.isFinite(v) && v >= 1) failThreshold = Math.floor(v);
}

function bindKey(raw, env) {
  return raw || (env && env.DB) || (env && env.SITES) || NO_BINDING;
}

function newState(raw, env) {
  const s = {
    mode: 'storage',
    mem: new Map(),       // key -> value（内存模式下的主数据，降级时由 shadow 灌入）
    base: new Map(),      // key -> value（进入内存那一刻的后端快照，用来判写盘冲突）
    dirty: new Set(),     // 内存模式下被 put / delete 过的键
    shadow: new Map(),    // storage 模式下最近读到的值，降级时当遗产搬进 mem
    fails: 0,
    events: [],
    since: Date.now(),
    reason: '',
    source: '',           // 'manual' | 'auto'
    scope: 'isolate',     // 'global' | 'global-best-effort' | 'isolate'
    overflow: false,
    raw: raw || null,
    env: env || null,
  };
  seed(s, env);
  // 压根没绑定存储 -> 直接就是内存模式，不必等它失败
  if (!s.raw) {
    s.mode = 'memory';
    s.source = 'manual';
    s.reason = '未绑定存储后端';
    s.scope = 'global';
  }
  return s;
}

/** 取（或建）某个 binding 对应的状态 */
export function getState(raw, env) {
  const k = bindKey(raw, env);
  let s = states.get(k);
  if (!s) {
    s = newState(raw, env);
    states.set(k, s);
  }
  if (!s.raw && raw) s.raw = raw;
  return s;
}

export function logEvent(s, kind, detail) {
  s.events.unshift({ ts: Date.now(), kind, detail: String(detail || '').slice(0, 300) });
  if (s.events.length > EVENT_MAX) s.events.length = EVENT_MAX;
  // 失败要响：降级这种事只在内存里记一笔，等于没说
  if (kind === 'degrade' || kind === 'flush-fail' || kind === 'write-degraded') {
    console.error('[memstore] ' + kind + ': ' + detail);
  }
}

// ===================== 种子 =====================
//
// 降级或纯内存启动之后，内存本来是空的 —— 站点、配置一概读不到，服务等于瘫着。
// 所以需要一个「把内容灌进内存」的入口：**环境变量 SEED_JSON**（JSON 对象，
// 键值与 KV 完全同形）。它是本次要绕过 D1 / KV 配额时唯一还能持久的地方 ——
// CF 的环境变量不占 D1 / KV 的读写额度。
//
// 诚实边界：SEED_JSON 之外的键（本实例从没读过的冷门键）内存里依然没有，
// status.memKeys 是如实给出的数字，不假装什么都救回来了。

function seed(s, env) {
  const rawSeed = env && (env.SEED_JSON || env.seed_json);
  if (!rawSeed || typeof rawSeed !== 'string') return;
  let obj = null;
  try {
    obj = JSON.parse(rawSeed);
  } catch (e) {
    logEvent(s, 'seed-bad-json', String(e && e.message).slice(0, 200));
    return;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    logEvent(s, 'seed-bad-shape', 'SEED_JSON 应是 {"键":"值"} 形式的对象');
    return;
  }
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    s.mem.set(String(k), v === null || v === undefined ? null : String(v));
    n++;
  }
  logEvent(s, 'seed', `从 SEED_JSON 灌入 ${n} 个键`);
}

// ===================== 降级 =====================

function degrade(s, reason) {
  if (s.mode === 'memory') return;
  s.mode = 'memory';
  s.source = 'auto';
  s.reason = String(reason || '').slice(0, 300);
  s.since = Date.now();
  s.scope = 'isolate';   // 自动降级默认只在本实例；广播成功才升级为 best-effort
  // 遗产：storage 模式下读过的键先搬进来，免得「一降级就回到默认值」——
  // 那比存储坏了更糟：站点全丢、配置回出厂，看起来像被人清了库
  for (const [k, v] of s.shadow) s.mem.set(k, v);
  s.base = new Map(s.mem);
  s.fails = 0;
  logEvent(s, 'degrade', reason);
}

/** 切入 / 切回都只走这一个出口 —— 「绝不自动切回存储」是硬约束 */
export function setStorageMode(s, mode, opts = {}) {
  if (mode === 'memory') {
    degrade(s, opts.reason || '手动切入内存模式');
    s.source = 'manual';
    s.scope = 'global';       // 手动是显式操作，用户知情
    return preload(s);
  }
  if (mode === 'storage') {
    if (!s.raw) {
      const err = '没有可用的存储绑定，无法切回存储模式';
      logEvent(s, 'mode-switch-fail', err);
      return { ok: false, error: err };
    }
    s.mode = 'storage';
    s.source = 'manual';
    s.reason = '';
    s.fails = 0;
    logEvent(s, 'restore', '已切回存储模式');
    return { ok: true };
  }
  return { ok: false, error: '未知模式：' + mode };
}

/**
 * 手动切内存时把控制面能读的都先读进来。
 * 跳过统计类前缀（量大且丢得起），只捞「没有就跑不起来」的那部分。
 */
async function preload(s) {
  const raw = s.raw;
  if (!raw) return { ok: true, loaded: 0, failed: 0, truncated: false };
  const wanted = ['APP_CONFIG', 'config.json', 'DISGUISE_CONFIG', 'PREF_IPS', 'GOOD_IPS', 'SITE_MODES'];
  const prefixes = ['site:', 'share:', 'tempsub:'];
  let loaded = 0;
  let failed = 0;
  let truncated = false;
  for (const k of wanted) {
    try {
      const v = await raw.get(k);
      if (v !== null && v !== undefined) { s.mem.set(k, String(v)); loaded++; }
    } catch { failed++; }
  }
  for (const p of prefixes) {
    try {
      const r = await raw.list({ prefix: p, limit: 1000 });
      const keys = (r && r.keys) || [];
      if (!r || r.list_complete === false) truncated = true;
      for (const it of keys) {
        try {
          const v = await raw.get(it.name);
          if (v !== null && v !== undefined) { s.mem.set(it.name, String(v)); loaded++; }
        } catch { failed++; }
      }
    } catch (e) {
      // 预加载失败不算致命 —— 它只是「尽量多救一点」，不能带崩切模式这件事。
      // 但要响：静默失败会让用户以为全都搬过来了。
      failed++;
      logEvent(s, 'preload-fail', String(e && e.message).slice(0, 200));
    }
  }
  s.base = new Map(s.mem);
  logEvent(s, 'preload', `预加载 ${loaded} 个键，失败 ${failed} 个`);
  return { ok: true, loaded, failed, truncated };
}

// ===================== 写回 =====================

/**
 * 把内存期间的改动搬回存储。
 *
 * 冲突处理（定为：跳过并列出，force=1 才覆盖）：降级期间别的实例或定时任务
 * 可能已经改过这些键了，无脑覆盖等于把别人的新数据打回去。所以每个 dirty 键都
 * 先用 baseline（进入内存那一刻的值）对照后端现值 —— 现值等于 baseline 说明没人
 * 动过，可以安全写；不等就是冲突，列出来交给用户决定。
 */
export async function flush(s, opts = {}) {
  const raw = opts.raw || s.raw;
  if (!raw) return { ok: false, error: '没有可用的存储绑定，无法写回' };
  const force = !!opts.force;
  const written = [];
  const skipped = [];
  const failed = [];
  for (const key of Array.from(s.dirty)) {
    const value = s.mem.get(key);
    let cur = null;
    try {
      cur = await raw.get(key);
    } catch (e) {
      failed.push({ key, error: String(e && e.message).slice(0, 200) });
      logEvent(s, 'flush-fail', `${key} 读取失败：${e && e.message}`);
      continue;
    }
    const baseline = s.base.has(key) ? s.base.get(key) : undefined;
    if (!force && cur !== null && cur !== baseline) {
      skipped.push({ key, reason: 'conflict' });
      continue;
    }
    try {
      if (value === null || value === undefined) await raw.delete(key);
      else await raw.put(key, String(value));
      written.push(key);
      s.base.set(key, value);
      s.dirty.delete(key);
    } catch (e) {
      failed.push({ key, error: String(e && e.message).slice(0, 200) });
      logEvent(s, 'flush-fail', `${key} 写入失败：${e && e.message}`);
    }
  }
  // ⚠️ 写不回去的必须留在 dirty 里 —— 否则用户点重试时「看起来已经写过了」，
  // 实际一个字节都没进存储。这与 settings 那条「保存成功不等于生效」同源。
  logEvent(s, 'flush', `写回 ${written.length} 个，跳过 ${skipped.length} 个，失败 ${failed.length} 个`);
  return { ok: failed.length === 0, written, skipped, failed, pending: s.dirty.size };
}

/** 探测存储是否恢复。**只做探测，绝不动 mode** —— 自动切回是明确不要的行为 */
export async function probe(s) {
  const raw = s.raw;
  if (!raw) return { ok: false, error: '没有可用的存储绑定' };
  try {
    await raw.get('__probe_' + Date.now());
    return { ok: true, detail: '存储可读写' };
  } catch (e) {
    return { ok: false, error: String(e && e.message).slice(0, 300) };
  }
}

// ===================== 状态快照 =====================

export function getStatus(s) {
  // scope 三种真话：
  //   global             —— 手动切换，用户知情且是显式操作
  //   global-best-effort —— 自动降级，且已尽力让其它实例也跟进
  //   isolate            —— 只在当前边缘实例生效，其它实例可能仍在读（可能是坏的）存储
  return {
    mode: s.mode,
    source: s.source,
    scope: s.mode === 'memory' ? s.scope : 'global',
    reason: s.reason,
    since: s.since,
    memKeys: s.mem.size,
    dirtyKeys: s.dirty.size,
    overflow: s.overflow,
    consecutiveFails: s.fails,
    failThreshold,
    events: s.events.slice(0, EVENT_MAX),
  };
}

// ===================== 代理 =====================

/**
 * 包一层，得到与 KV 完全同形的存储对象。
 * @param {object|undefined} raw 真实存储（D1KV 或 KV binding）；undefined 表示只用内存
 * @param {object} env 平台注入的绑定（用来拿 SEED_JSON 与稳定 WeakMap key）
 */
export function wrapStorage(raw, env) {
  const s = getState(raw, env);

  const note = (e) => {
    s.fails++;
    if (s.fails >= failThreshold && s.mode === 'storage') degrade(s, failMessage(e));
    return e;
  };
  const ok = () => { s.fails = 0; };

  const proxy = {
    async get(key) {
      if (s.mode === 'memory') return memGet(s, key);
      try {
        const v = await s.raw.get(String(key));
        ok();
        remember(s, key, v);   // 留一份遗产，降级时不用从零开始
        return v;
      } catch (e) {
        throw note(e);
      }
    },
    async put(key, value) {
      if (s.mode === 'memory') { memPut(s, key, value); return; }
      try {
        await s.raw.put(String(key), String(value));
        ok();
        remember(s, key, value);
      } catch (e) {
        note(e);
        // 写失败的值先落进内存保住，让用户这一笔不至于凭空消失。
        // ⚠️ 但异常**必须照旧抛出**：stats.js 的「写失败的那笔稍后重试补上」正是靠这个
        // 异常感知失败的；把它吞掉，数据就在谁都不知道的情况下丢了，而面板显示一切正常。
        // 所以这里做两件事（留内存 + 抛异常），不是二选一。
        memPut(s, key, value);
        logEvent(s, 'write-degraded', `${key} 写入失败，已暂留内存`);
        throw e;
      }
    },
    async delete(key) {
      if (s.mode === 'memory') { memDel(s, key); return; }
      try {
        await s.raw.delete(String(key));
        ok();
        remember(s, key, null);
      } catch (e) {
        note(e);
        memDel(s, key);   // 同上：先在内存里标掉，再把失败照样抛出去
        logEvent(s, 'delete-degraded', `${key} 删除失败，已在内存里标记`);
        throw e;
      }
    },
    async list(options = {}) {
      if (s.mode === 'memory') return memList(s, options);
      try {
        const r = await s.raw.list(options || {});
        ok();
        return r;
      } catch (e) {
        note(e);
        // 已经降级了就给内存清单兜底，不用再抛 —— 上层要不到东西也做不了别的。
        // 还没降级（未到阈值）则照旧抛出，不替上层决定这次失败不要紧。
        if (s.mode === 'memory') return memList(s, options);
        throw e;
      }
    },
  };
  proxyOwner.set(proxy, s);
  return proxy;
}

function memGet(s, key) {
  const k = String(key || '');
  return s.mem.has(k) ? s.mem.get(k) : null;
}

function memPut(s, key, value) {
  const k = String(key || '');
  if (!s.mem.has(k) && s.mem.size >= STATE_MAX) {
    // 容量超限也不能拒绝写入 —— 拒绝写入会让「提示保存成功、值没变」重演。
    s.overflow = true;
    logEvent(s, 'overflow', `内存键数已达上限 ${STATE_MAX}，继续写入（不再扩容）`);
  }
  s.mem.set(k, value === null || value === undefined ? null : String(value));
  s.dirty.add(k);
}

function memDel(s, key) {
  const k = String(key || '');
  s.mem.set(k, null);   // 墓碑：留着 key，避免被误判成「从没听说过」
  s.dirty.add(k);
}

function memList(s, options = {}) {
  const prefix = String((options && options.prefix) || '');
  const names = [];
  for (const [k, v] of s.mem) {
    if (v === null || v === undefined) continue;   // 墓碑不出现在列表里
    if (prefix && !k.startsWith(prefix)) continue;
    names.push({ name: k });
  }
  names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const limit = Math.min(Math.max(Number((options && options.limit) || 1000, 1), 1000));
  return { keys: names.slice(0, limit), list_complete: names.length <= limit, cursor: '' };
}

function remember(s, key, value) {
  if (s.shadow.size >= STATE_MAX) return;
  s.shadow.set(String(key), value === null || value === undefined ? null : String(value));
}

function failMessage(e) {
  const m = String((e && e.message) || e || '未知错误').slice(0, 200);
  return `存储连续 ${failThreshold} 次读写失败（${m}），已切到内存模式`;
}

/** 单测用：丢掉某个 binding 的全部状态，避免用例之间互相影响 */
export function resetState(raw, env) {
  states.delete(bindKey(raw, env));
}
