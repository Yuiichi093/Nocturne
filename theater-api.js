module.exports = function (app, db) {
  const { getActiveWorldId } = require('./worlds');
  function cleanText(value) {
    return String(value ?? '').trim();
  }

  function safeJsonParse(text, fallback) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return fallback;
    }
  }

  function parseScript(row) {
    return {
      ...row,
      cast_ids: safeJsonParse(row.cast_ids, []),
      identities: safeJsonParse(row.identities_json, [])
    };
  }

  app.get('/api/theater/scripts', (req, res) => {
    const worldId = getActiveWorldId();

    const rows = db.prepare(`
      SELECT * FROM theater_scripts
      WHERE world_id = ?
      ORDER BY id DESC
    `).all(worldId);

    res.json(rows.map(parseScript));
  });

  app.post('/api/theater/scripts', (req, res) => {
    const body = req.body || {};
    const title = cleanText(body.title);

    if (!title) {
      return res.status(400).json({ error: '剧本标题必填' });
    }

    const castIds = Array.isArray(body.cast_ids) ? body.cast_ids : [];
    const identities = Array.isArray(body.identities) ? body.identities : [];

    const worldId = getActiveWorldId();

    const result = db.prepare(`
      INSERT INTO theater_scripts
        (title, subtitle, premise, opening, rules, cast_ids, identities_json, world_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      title,
      cleanText(body.subtitle),
      cleanText(body.premise),
      cleanText(body.opening),
      cleanText(body.rules),
      JSON.stringify(castIds),
      JSON.stringify(identities),
      worldId
    );

    const script = db.prepare('SELECT * FROM theater_scripts WHERE id = ?')
      .get(Number(result.lastInsertRowid));

    res.json({ ok: true, script: parseScript(script) });
  });

  app.get('/api/theater/scripts/:id', (req, res) => {
    const script = db.prepare('SELECT * FROM theater_scripts WHERE id = ?')
      .get(req.params.id);

    if (!script) {
      return res.status(404).json({ error: '剧本不存在' });
    }

    res.json(parseScript(script));
  });

  app.put('/api/theater/scripts/:id', (req, res) => {
    const body = req.body || {};
    const title = cleanText(body.title);

    if (!title) {
      return res.status(400).json({ error: '剧本标题必填' });
    }

    const existing = db.prepare('SELECT * FROM theater_scripts WHERE id = ?')
      .get(req.params.id);

    if (!existing) {
      return res.status(404).json({ error: '剧本不存在' });
    }

    // 没传的字段沿用原来的值，避免局部更新把其他内容清空
    const pick = (key) => {
      return body[key] === undefined
        ? (existing[key] || '')
        : cleanText(body[key]);
    };

    const castIds = Array.isArray(body.cast_ids)
      ? body.cast_ids
      : safeJsonParse(existing.cast_ids, []);

    const identities = Array.isArray(body.identities)
      ? body.identities
      : safeJsonParse(existing.identities_json, []);

    db.prepare(`
      UPDATE theater_scripts
      SET title = ?, subtitle = ?, premise = ?, opening = ?, rules = ?,
          cast_ids = ?, identities_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      title,
      pick('subtitle'),
      pick('premise'),
      pick('opening'),
      pick('rules'),
      JSON.stringify(castIds),
      JSON.stringify(identities),
      req.params.id
    );

    const script = db.prepare('SELECT * FROM theater_scripts WHERE id = ?')
      .get(req.params.id);

    res.json({ ok: true, script: parseScript(script) });
  });

  app.get('/api/theater/scripts/:id/sessions', (req, res) => {
    const worldId = getActiveWorldId();

    const script = db.prepare(`
      SELECT * FROM theater_scripts
      WHERE id = ? AND world_id = ?
    `).get(req.params.id, worldId);

    if (!script) {
      return res.status(404).json({ error: '剧本不存在' });
    }

    const rows = db.prepare(`
      SELECT
        s.*,
        (
          SELECT content FROM theater_messages m
          WHERE m.session_id = s.id
          ORDER BY m.id DESC
          LIMIT 1
        ) AS last_content
      FROM theater_sessions s
      WHERE s.script_id = ? AND s.world_id = ?
      ORDER BY s.updated_at DESC, s.id DESC
    `).all(script.id, worldId);

    res.json(rows);
  });

  app.post('/api/theater/sessions', (req, res) => {
    const body = req.body || {};
    const scriptId = Number(body.script_id || 0);
    const godMode = Boolean(body.god_mode);

    const identityName = godMode ? '上帝视角' : cleanText(body.identity_name);
    const identityRole = godMode ? '上帝视角' : cleanText(body.identity_role);
    const identityDesc = godMode
      ? '不扮演任何角色，只从上帝视角旁观故事，并替主角选择下一步。'
      : cleanText(body.identity_desc);

    if (!scriptId) {
      return res.status(400).json({ error: '缺少剧本 ID' });
    }

    if (!godMode && (!identityName || !identityRole)) {
      return res.status(400).json({ error: '身份姓名和身份必填' });
    }

    const script = db.prepare('SELECT * FROM theater_scripts WHERE id = ?')
      .get(scriptId);

    if (!script) {
      return res.status(404).json({ error: '剧本不存在' });
    }

    const result = db.prepare(`
      INSERT INTO theater_sessions
        (script_id, title, identity_name, identity_role, identity_desc, identity_avatar, world_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      scriptId,
      script.title,
      identityName,
      identityRole,
      identityDesc,
      cleanText(body.identity_avatar),
      Number(script.world_id || getActiveWorldId())
    );

    const sessionId = Number(result.lastInsertRowid);

    if (cleanText(script.opening)) {
      db.prepare(`
        INSERT INTO theater_messages
          (session_id, role, content)
        VALUES (?, 'narration', ?)
      `).run(sessionId, cleanText(script.opening));
    }

    const session = db.prepare('SELECT * FROM theater_sessions WHERE id = ?')
      .get(sessionId);

    res.json({ ok: true, session });
  });

  app.put('/api/theater/sessions/:id', (req, res) => {
    const worldId = getActiveWorldId();
    const title = String(req.body && req.body.title || '').trim();

    if (!title) {
      return res.status(400).json({ error: '名字不能为空' });
    }

    const session = db.prepare(`
      SELECT * FROM theater_sessions
      WHERE id = ? AND world_id = ?
    `).get(req.params.id, worldId);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    db.prepare(`
      UPDATE theater_sessions
      SET title = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(title, session.id);

    res.json({
      ok: true,
      session: db.prepare('SELECT * FROM theater_sessions WHERE id = ?')
        .get(session.id)
    });
  });

  app.delete('/api/theater/sessions/:id', (req, res) => {
    const worldId = getActiveWorldId();

    const session = db.prepare(`
      SELECT * FROM theater_sessions
      WHERE id = ? AND world_id = ?
    `).get(req.params.id, worldId);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    db.prepare('DELETE FROM theater_messages WHERE session_id = ?')
      .run(session.id);

    db.prepare('DELETE FROM theater_corrections WHERE session_id = ?')
      .run(session.id);

    db.prepare('DELETE FROM theater_sessions WHERE id = ?')
      .run(session.id);

    res.json({ ok: true });
  });

  app.post('/api/theater/sessions/:id/fork', (req, res) => {
    const worldId = getActiveWorldId();

    const session = db.prepare(`
      SELECT * FROM theater_sessions
      WHERE id = ? AND world_id = ?
    `).get(req.params.id, worldId);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    const title = String(
      req.body && req.body.title ||
      session.title + ' · 分支'
    ).trim();

    // 可以只在某条消息处开分支：up_to_message_id 之后的剧情不带过去
    const upTo = Number(req.body && req.body.up_to_message_id || 0);

    const result = db.prepare(`
      INSERT INTO theater_sessions
        (script_id, title, identity_name, identity_role,
         identity_desc, identity_avatar, status, world_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.script_id,
      title,
      session.identity_name,
      session.identity_role,
      session.identity_desc,
      session.identity_avatar,
      'active',
      worldId
    );

    const newSessionId = Number(result.lastInsertRowid);

    if (upTo > 0) {
      db.prepare(`
        INSERT INTO theater_messages
          (session_id, role, character_id, content, image_url, meta_json, created_at)
        SELECT ?, role, character_id, content, image_url, meta_json, created_at
        FROM theater_messages
        WHERE session_id = ? AND id <= ?
        ORDER BY id ASC
      `).run(newSessionId, session.id, upTo);
    } else {
      db.prepare(`
        INSERT INTO theater_messages
          (session_id, role, character_id, content, image_url, meta_json, created_at)
        SELECT ?, role, character_id, content, image_url, meta_json, created_at
        FROM theater_messages
        WHERE session_id = ?
        ORDER BY id ASC
      `).run(newSessionId, session.id);
    }

    db.prepare(`
      INSERT INTO theater_corrections
        (session_id, content, active, created_at)
      SELECT ?, content, active, created_at
      FROM theater_corrections
      WHERE session_id = ?
      ORDER BY id ASC
    `).run(newSessionId, session.id);

    const newSession = db.prepare(`
      SELECT * FROM theater_sessions WHERE id = ?
    `).get(newSessionId);

    res.json({ ok: true, session: newSession });
  });

  app.get('/api/theater/sessions/:id', (req, res) => {
    const session = db.prepare('SELECT * FROM theater_sessions WHERE id = ?')
      .get(req.params.id);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    const script = db.prepare('SELECT * FROM theater_scripts WHERE id = ?')
      .get(session.script_id);

    res.json({
      session,
      script: script ? parseScript(script) : null
    });
  });

  app.get('/api/theater/sessions/:id/messages', (req, res) => {
    const rows = db.prepare(`
      SELECT * FROM theater_messages
      WHERE session_id = ?
      ORDER BY id ASC
    `).all(req.params.id);

    res.json(rows);
  });
};
