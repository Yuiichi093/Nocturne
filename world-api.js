const { getActiveWorldId } = require('./worlds');

module.exports = function (app, db) {
  function cleanText(value) {
    return String(value ?? '').trim();
  }

  app.get('/api/worlds', (req, res) => {
    const activeId = getActiveWorldId();

    const rows = db.prepare(`
      SELECT * FROM worlds
      ORDER BY id ASC
    `).all();

    res.json(rows.map((row) => ({
      ...row,
      is_active: Number(row.id) === Number(activeId)
    })));
  });

  app.get('/api/worlds/active', (req, res) => {
    const activeId = getActiveWorldId();

    const world = db.prepare('SELECT * FROM worlds WHERE id = ?')
      .get(activeId);

    res.json(world);
  });

  app.get('/api/worlds/:id', (req, res) => {
    const world = db.prepare('SELECT * FROM worlds WHERE id = ?')
      .get(req.params.id);

    if (!world) {
      return res.status(404).json({ error: '世界观不存在' });
    }

    res.json(world);
  });

  app.post('/api/worlds', (req, res) => {
    const body = req.body || {};
    const name = cleanText(body.name);

    if (!name) {
      return res.status(400).json({ error: '世界观名字必填' });
    }

    let themeJson = body.theme_json || '{}';
    if (typeof themeJson !== 'string') {
      themeJson = JSON.stringify(themeJson);
    }

    try {
      JSON.parse(themeJson);
    } catch (e) {
      return res.status(400).json({ error: 'theme_json 不是合法 JSON' });
    }

    const result = db.prepare(`
      INSERT INTO worlds (name, description, cover, theme_json)
      VALUES (?, ?, ?, ?)
    `).run(
      name,
      cleanText(body.description),
      cleanText(body.cover),
      themeJson
    );

    const world = db.prepare('SELECT * FROM worlds WHERE id = ?')
      .get(Number(result.lastInsertRowid));

    res.json({ ok: true, world });
  });

  app.put('/api/worlds/:id', (req, res) => {
    const body = req.body || {};
    const name = cleanText(body.name);

    if (!name) {
      return res.status(400).json({ error: '世界观名字必填' });
    }

    const existing = db.prepare('SELECT id FROM worlds WHERE id = ?')
      .get(req.params.id);

    if (!existing) {
      return res.status(404).json({ error: '世界观不存在' });
    }

    let themeJson = body.theme_json || '{}';
    if (typeof themeJson !== 'string') {
      themeJson = JSON.stringify(themeJson);
    }

    try {
      JSON.parse(themeJson);
    } catch (e) {
      return res.status(400).json({ error: 'theme_json 不是合法 JSON' });
    }

    db.prepare(`
      UPDATE worlds
      SET name = ?, description = ?, cover = ?, theme_json = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name,
      cleanText(body.description),
      cleanText(body.cover),
      themeJson,
      req.params.id
    );

    const world = db.prepare('SELECT * FROM worlds WHERE id = ?')
      .get(req.params.id);

    res.json({ ok: true, world });
  });

  app.post('/api/worlds/:id/switch', (req, res) => {
    const world = db.prepare('SELECT * FROM worlds WHERE id = ?')
      .get(req.params.id);

    if (!world) {
      return res.status(404).json({ error: '世界观不存在' });
    }

    db.prepare(`
      INSERT INTO app_settings (key, value)
      VALUES ('active_world_id', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(world.id));

    res.json({ ok: true, world });
  });
};
