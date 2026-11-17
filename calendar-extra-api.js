const { getActiveWorldId } = require('./worlds');

module.exports = function (app, db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS world_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      world_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      rule_text TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  function cleanText(value) {
    return String(value ?? '').trim();
  }

  app.get('/api/settings/user-birthday', (req, res) => {
    const row = db.prepare(`
      SELECT value FROM app_settings
      WHERE key = 'user_birthday'
    `).get();

    res.json({ birthday: row ? row.value : '' });
  });

  app.post('/api/settings/user-birthday', (req, res) => {
    const birthday = cleanText(req.body && req.body.birthday);

    db.prepare(`
      INSERT INTO app_settings (key, value)
      VALUES ('user_birthday', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(birthday);

    res.json({ ok: true, birthday });
  });

  app.get('/api/world-events', (req, res) => {
    const worldId = getActiveWorldId();

    const rows = db.prepare(`
      SELECT * FROM world_events
      WHERE world_id = ?
      ORDER BY id ASC
    `).all(worldId);

    res.json(rows);
  });

  app.post('/api/world-events', (req, res) => {
    const body = req.body || {};
    const worldId = getActiveWorldId();
    const name = cleanText(body.name);

    if (!name) {
      return res.status(400).json({ error: '节日名字必填' });
    }

    const result = db.prepare(`
      INSERT INTO world_events
        (world_id, name, rule_text, enabled)
      VALUES (?, ?, ?, ?)
    `).run(
      worldId,
      name,
      cleanText(body.rule_text),
      body.enabled === false ? 0 : 1
    );

    const row = db.prepare('SELECT * FROM world_events WHERE id = ?')
      .get(Number(result.lastInsertRowid));

    res.json({ ok: true, event: row });
  });

  app.put('/api/world-events/:id', (req, res) => {
    const body = req.body || {};
    const worldId = getActiveWorldId();
    const name = cleanText(body.name);

    if (!name) {
      return res.status(400).json({ error: '节日名字必填' });
    }

    const existing = db.prepare(`
      SELECT * FROM world_events
      WHERE id = ? AND world_id = ?
    `).get(req.params.id, worldId);

    if (!existing) {
      return res.status(404).json({ error: '世界节日不存在' });
    }

    db.prepare(`
      UPDATE world_events
      SET name = ?, rule_text = ?, enabled = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name,
      cleanText(body.rule_text),
      body.enabled === false ? 0 : 1,
      req.params.id
    );

    const row = db.prepare('SELECT * FROM world_events WHERE id = ?')
      .get(req.params.id);

    res.json({ ok: true, event: row });
  });

  app.delete('/api/world-events/:id', (req, res) => {
    const worldId = getActiveWorldId();

    const existing = db.prepare(`
      SELECT * FROM world_events
      WHERE id = ? AND world_id = ?
    `).get(req.params.id, worldId);

    if (!existing) {
      return res.status(404).json({ error: '世界节日不存在' });
    }

    db.prepare('DELETE FROM world_events WHERE id = ?')
      .run(req.params.id);

    res.json({ ok: true });
  });

  app.post('/api/characters/:id/birthday', (req, res) => {
    const worldId = getActiveWorldId();
    const birthday = cleanText(req.body && req.body.birthday);

    const character = db.prepare(`
      SELECT * FROM characters
      WHERE id = ? AND world_id = ?
    `).get(req.params.id, worldId);

    if (!character) {
      return res.status(404).json({ error: '角色不存在' });
    }

    db.prepare(`
      UPDATE characters
      SET birthday = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(birthday, req.params.id);

    res.json({ ok: true, birthday });
  });
};
