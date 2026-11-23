const db = require('./db');

function getActiveWorldId() {
  const row = db.prepare(`
    SELECT value FROM app_settings
    WHERE key = 'active_world_id'
  `).get();

  const id = Number(row && row.value || 0);

  if (id) {
    const exists = db.prepare('SELECT id FROM worlds WHERE id = ?').get(id);
    if (exists) return id;
  }

  const first = db.prepare(`
    SELECT id FROM worlds
    ORDER BY id ASC
    LIMIT 1
  `).get();

  if (!first) {
    const error = new Error('还没有世界观，先去「世界观」页建一个');
    error.status = 409;
    error.code = 'NO_WORLD';
    throw error;
  }

  db.prepare(`
    INSERT INTO app_settings (key, value)
    VALUES ('active_world_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(first.id));

  return Number(first.id);
}

function resolveWorldId(value) {
  const id = Number(value || 0);
  if (id) return id;
  return getActiveWorldId();
}

module.exports = {
  getActiveWorldId,
  resolveWorldId
};
