const { getActiveWorldId } = require('./worlds');

module.exports = function (app, db) {
  function cleanText(value) {
    return String(value ?? '').trim();
  }

  app.get('/api/worldbook', (req, res) => {
    const worldId = getActiveWorldId();

    const rows = db.prepare(`
      SELECT * FROM worldbook_entries
      WHERE world_id = ?
      ORDER BY priority DESC, id DESC
    `).all(worldId);

    res.json(rows);
  });

  app.post('/api/worldbook', (req, res) => {
    const body = req.body || {};
    const worldId = getActiveWorldId();
    const title = cleanText(body.title);

    if (!title) {
      return res.status(400).json({ error: '条目标题必填' });
    }

    const result = db.prepare(`
      INSERT INTO worldbook_entries
        (world_id, title, keys, content, priority, constant, enabled, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      worldId,
      title,
      cleanText(body.keys),
      cleanText(body.content),
      Number(body.priority || 0),
      body.constant ? 1 : 0,
      body.enabled === false ? 0 : 1,
      cleanText(body.category) || '未分类'
    );

    const row = db.prepare('SELECT * FROM worldbook_entries WHERE id = ?')
      .get(Number(result.lastInsertRowid));

    res.json({ ok: true, entry: row });
  });

  app.put('/api/worldbook/:id', (req, res) => {
    const body = req.body || {};
    const worldId = getActiveWorldId();
    const title = cleanText(body.title);

    if (!title) {
      return res.status(400).json({ error: '条目标题必填' });
    }

    const existing = db.prepare(`
      SELECT * FROM worldbook_entries
      WHERE id = ? AND world_id = ?
    `).get(req.params.id, worldId);

    if (!existing) {
      return res.status(404).json({ error: '世界书条目不存在' });
    }

    db.prepare(`
      UPDATE worldbook_entries
      SET title = ?, keys = ?, content = ?, priority = ?,
          constant = ?, enabled = ?, category = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      title,
      cleanText(body.keys),
      cleanText(body.content),
      Number(body.priority || 0),
      body.constant ? 1 : 0,
      body.enabled === false ? 0 : 1,
      cleanText(body.category) || '未分类',
      req.params.id
    );

    const row = db.prepare('SELECT * FROM worldbook_entries WHERE id = ?')
      .get(req.params.id);

    res.json({ ok: true, entry: row });
  });

  app.post('/api/worldbook/import', (req, res) => {
    const worldId = getActiveWorldId();
    const data = req.body && req.body.data ? req.body.data : req.body;

    let list = [];

    if (Array.isArray(data)) {
      list = data;
    } else if (data && data.entries) {
      list = Array.isArray(data.entries)
        ? data.entries
        : Object.values(data.entries);
    }

    if (!list.length) {
      return res.status(400).json({ error: '没有找到世界书条目' });
    }

    const insert = db.prepare(`
      INSERT INTO worldbook_entries
        (world_id, title, keys, content, priority, constant, enabled, category, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let imported = 0;

    for (const item of list) {
      const keyList = [];

      const pushKeys = (value) => {
        if (Array.isArray(value)) {
          value.forEach((key) => {
            const text = cleanText(key);
            if (text) keyList.push(text);
          });
        } else if (typeof value === 'string') {
          value.split(/[,，]/).forEach((key) => {
            const text = cleanText(key);
            if (text) keyList.push(text);
          });
        }
      };

      pushKeys(item.key);
      pushKeys(item.keysecondary);

      const keys = Array.from(new Set(keyList)).join(', ');
      const title = cleanText(
        item.comment || item.name || keyList[0] || '未命名条目'
      );
      const content = cleanText(item.content || item.text || '');

      if (!content) continue;

      const priority = Number(item.order ?? item.priority ?? 0);
      const constant = item.constant ? 1 : 0;
      const enabled = item.disable ? 0 : 1;

      insert.run(
        worldId,
        title,
        keys,
        content,
        priority,
        constant,
        enabled,
        cleanText(item.group || item.category) || '导入',
        JSON.stringify(item)
      );

      imported += 1;
    }

    res.json({ ok: true, imported });
  });

  app.post('/api/worldbook/bulk-category', (req, res) => {
    const worldId = getActiveWorldId();
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const category = cleanText(req.body && req.body.category) || '未分类';

    if (!ids.length) {
      return res.status(400).json({ error: '没有选中条目' });
    }

    let updated = 0;

    for (const id of ids) {
      const result = db.prepare(`
        UPDATE worldbook_entries
        SET category = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND world_id = ?
      `).run(category, id, worldId);

      updated += Number(result.changes || 0);
    }

    res.json({ ok: true, updated, category });
  });

  app.post('/api/worldbook/bulk-delete', (req, res) => {
    const worldId = getActiveWorldId();
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];

    if (!ids.length) {
      return res.status(400).json({ error: '没有选中条目' });
    }

    let deleted = 0;

    for (const id of ids) {
      const result = db.prepare(`
        DELETE FROM worldbook_entries
        WHERE id = ? AND world_id = ?
      `).run(id, worldId);

      deleted += Number(result.changes || 0);
    }

    res.json({ ok: true, deleted });
  });

  app.get('/api/worldbook/other-worlds', (req, res) => {
    const worldId = getActiveWorldId();

    const worlds = db.prepare(`
      SELECT id, name FROM worlds
      WHERE id <> ?
      ORDER BY id ASC
    `).all(worldId);

    const result = worlds.map((world) => ({
      id: world.id,
      name: world.name,
      entries: db.prepare(`
        SELECT id, title, keys, content, priority, constant, enabled, category
        FROM worldbook_entries
        WHERE world_id = ?
        ORDER BY category ASC, id ASC
      `).all(world.id)
    }));

    res.json(result);
  });

  app.post('/api/worldbook/import-selected', (req, res) => {
    const worldId = getActiveWorldId();
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];

    if (!ids.length) {
      return res.status(400).json({ error: '没有选中条目' });
    }

    let imported = 0;

    for (const id of ids) {
      const source = db.prepare(`
        SELECT * FROM worldbook_entries
        WHERE id = ? AND world_id <> ?
      `).get(id, worldId);

      if (!source) continue;

      const exists = db.prepare(`
        SELECT id FROM worldbook_entries
        WHERE world_id = ? AND title = ? AND content = ?
        LIMIT 1
      `).get(worldId, source.title, source.content);

      if (exists) continue;

      db.prepare(`
        INSERT INTO worldbook_entries
          (world_id, title, keys, content, priority, constant, enabled, category, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        worldId,
        source.title,
        source.keys,
        source.content,
        source.priority,
        source.constant,
        source.enabled,
        source.category || '未分类',
        source.meta_json || '{}'
      );

      imported += 1;
    }

    res.json({ ok: true, imported });
  });

  app.delete('/api/worldbook/:id', (req, res) => {
    const worldId = getActiveWorldId();

    const existing = db.prepare(`
      SELECT * FROM worldbook_entries
      WHERE id = ? AND world_id = ?
    `).get(req.params.id, worldId);

    if (!existing) {
      return res.status(404).json({ error: '世界书条目不存在' });
    }

    db.prepare('DELETE FROM worldbook_entries WHERE id = ?')
      .run(req.params.id);

    res.json({ ok: true });
  });
};
