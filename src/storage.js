// D1-backed KV-compatible storage. Keeps existing modules independent of the storage backend.
export function createD1KV(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('D1 binding is not configured');
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
    async list(options = {}) {
      const prefix = String(options.prefix || '');
      const limit = Math.min(Math.max(Number(options.limit) || 1000, 1), 1000);
      const rows = await db.prepare('SELECT key FROM kv WHERE key LIKE ? ORDER BY key LIMIT ?').bind(prefix + '%', limit).all();
      return { keys: (rows.results || []).map(r => ({ name: r.key })), list_complete: true, cursor: '' };
    },
  };
}
