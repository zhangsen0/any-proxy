// D1-backed KV-compatible storage. Keeps existing modules independent of the storage backend.
//
// ⚠️ 这一层的每一行 SQL 都在 D1 的计费路径上。改动前请先读 docs/07-踩坑记录.md 第 33 条：
//    `key LIKE 'x%'` 在本表的索引形态下会退化成**全索引扫描**，一次扫掉整张表的行数，
//    而这正是 2026-09-18 那天 rows read 打爆 500 万日限额的直接原因。
//    所以列前缀一律用「范围比较」，不要改回 LIKE。

/**
 * 前缀的上界：`list('site:')` 要的是 [site:, site;)，而不是「所有含 site 的键」。
 *
 * 做法是把最后一个字符的码位 +1 得到开区间的另一端。
 * **拿不到安全上界时必须返回 undefined（走无上界分支），绝不能瞎算一个 ——
 * 算小了会漏键，而漏掉一个键比慢一点严重得多。**
 *
 * @param {string} prefix
 * @returns {string|undefined} 上界；undefined 表示「不做上限过滤」
 */
export function prefixUpperBound(prefix) {
  const p = String(prefix || '');
  if (!p) return undefined;                       // 空前缀 = 全部，不需要上界
  const last = p.charCodeAt(p.length - 1);
  // 代理项（emoji 的半边）单独 +1 会得到另一个无效的半边，
  // 而且不能保证落在目标字符串之后 —— 宁可放弃优化也要保证不漏。
  if (!Number.isFinite(last)) return undefined;
  if (last >= 0xd800 && last <= 0xdfff) return undefined;
  if (last >= 0xffff) return undefined;
  return p.slice(0, -1) + String.fromCharCode(last + 1);
}

export function createD1KV(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('D1 binding is not configured');

  /**
   * 按前缀列举键。
   *
   * 为什么用范围比较而不是 LIKE：
   * `key LIKE 'x%'` 要能走索引，SQLite 要求「索引的 collation 与 case_sensitive_like 匹配」——
   * 本表的 key 是 TEXT PRIMARY KEY（BINARY），索引也是 BINARY，而 case_sensitive_like 默认关闭，
   * 于是 LIKE 优化不生效，执行计划是 `SCAN kv USING COVERING INDEX`：
   * 表里有多少行就扫多少行，跟 LIMIT 多大、匹配几行几乎无关。
   *
   * 改成 `key >= ? AND key < ?` 之后计划变成 `SEARCH ... (key>? AND key<?)`，
   * 只读命中的那几行。实测（SQLite，2993 行）：同样查 `site:%`，前者扫 2993 行，后者读 1 行。
   */
  async function list(options = {}) {
    const prefix = String(options.prefix || '');
    const limit = Math.min(Math.max(Number(options.limit) || 1000, 1), 1000);
    const upper = prefixUpperBound(prefix);
    const rows = upper === undefined
      ? await db.prepare('SELECT key FROM kv WHERE key >= ? ORDER BY key LIMIT ?')
        .bind(prefix, limit).all()
      : await db.prepare('SELECT key FROM kv WHERE key >= ? AND key < ? ORDER BY key LIMIT ?')
        .bind(prefix, upper, limit).all();
    return { keys: (rows.results || []).map(r => ({ name: r.key })), list_complete: true, cursor: '' };
  }

  return {
    async get(key) {
      const row = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(String(key)).first();
      return row ? row.value : null;
    },
    async put(key, value) {
      await db.prepare('INSERT INTO kv(key, value, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP').bind(String(key), String(value)).run();
    },
    async delete(key) {
      await db.prepare('DELETE FROM kv WHERE key = ?').bind(String(key)).run();
    },
    list,
  };
}
