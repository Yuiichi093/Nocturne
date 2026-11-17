module.exports = function (app, db) {
  function cleanText(value) {
    return String(value ?? '').trim();
  }

  function rollDice(formula) {
    const text = String(formula || '1d20').trim().toLowerCase();
    const match = text.match(/^(\d*)d(\d+)([+-]\d+)?$/i);

    if (!match) {
      throw new Error('投掷格式不对，例如 1d20、2d6+3');
    }

    const count = Math.min(Math.max(Number(match[1] || 1), 1), 20);
    const sides = Math.min(Math.max(Number(match[2] || 20), 2), 1000);
    const modifier = Number(match[3] || 0);

    const rolls = [];

    for (let i = 0; i < count; i += 1) {
      rolls.push(Math.floor(Math.random() * sides) + 1);
    }

    const sum = rolls.reduce((total, value) => total + value, 0);
    const total = sum + modifier;

    return {
      formula: text,
      count,
      sides,
      modifier,
      rolls,
      subtotal: sum,
      total
    };
  }

  app.post('/api/theater/sessions/:id/dice', (req, res) => {
    const session = db.prepare('SELECT * FROM theater_sessions WHERE id = ?')
      .get(req.params.id);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    const formula = cleanText(req.body && req.body.formula) || '1d20';

    let result;

    try {
      result = rollDice(formula);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const modifierText = result.modifier === 0
      ? ''
      : result.modifier > 0
        ? ' + ' + result.modifier
        : ' - ' + Math.abs(result.modifier);

    const content = '投掷 ' + result.formula + '：' +
      result.rolls.join(' + ') + modifierText +
      ' = ' + result.total;

    const meta = {
      type: 'dice',
      formula: result.formula,
      count: result.count,
      sides: result.sides,
      modifier: result.modifier,
      rolls: result.rolls,
      subtotal: result.subtotal,
      total: result.total
    };

    const insert = db.prepare(`
      INSERT INTO theater_messages
        (session_id, role, content, meta_json)
      VALUES (?, 'dice', ?, ?)
    `).run(session.id, content, JSON.stringify(meta));

    db.prepare(`
      UPDATE theater_sessions
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(session.id);

    const message = db.prepare('SELECT * FROM theater_messages WHERE id = ?')
      .get(Number(insert.lastInsertRowid));

    res.json({
      ok: true,
      result,
      message
    });
  });

  app.get('/api/theater/sessions/:id/corrections', (req, res) => {
    const rows = db.prepare(`
      SELECT * FROM theater_corrections
      WHERE session_id = ?
      ORDER BY id DESC
    `).all(req.params.id);

    res.json(rows);
  });

  app.post('/api/theater/sessions/:id/corrections', (req, res) => {
    const session = db.prepare('SELECT * FROM theater_sessions WHERE id = ?')
      .get(req.params.id);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    const content = cleanText(req.body && req.body.content);

    if (!content) {
      return res.status(400).json({ error: '修正内容不能为空' });
    }

    const insert = db.prepare(`
      INSERT INTO theater_corrections
        (session_id, content, active)
      VALUES (?, ?, 1)
    `).run(session.id, content);

    const correction = db.prepare('SELECT * FROM theater_corrections WHERE id = ?')
      .get(Number(insert.lastInsertRowid));

    res.json({ ok: true, correction });
  });

  app.post('/api/theater/sessions/:id/rewrite', (req, res) => {
    const session = db.prepare('SELECT * FROM theater_sessions WHERE id = ?')
      .get(req.params.id);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    const content = cleanText(req.body && req.body.content);

    if (!content) {
      return res.status(400).json({ error: '修正内容不能为空' });
    }

    db.prepare(`
      INSERT INTO theater_corrections
        (session_id, content, active)
      VALUES (?, ?, 1)
    `).run(session.id, content);

    const lastOptions = db.prepare(`
      SELECT * FROM theater_messages
      WHERE session_id = ? AND role = 'options'
      ORDER BY id DESC
      LIMIT 1
    `).get(session.id);

    const lastNarration = db.prepare(`
      SELECT * FROM theater_messages
      WHERE session_id = ? AND role = 'narration'
      ORDER BY id DESC
      LIMIT 1
    `).get(session.id);

    let deletedOptions = 0;
    let deletedNarration = 0;

    if (lastOptions) {
      db.prepare('DELETE FROM theater_messages WHERE id = ?')
        .run(lastOptions.id);
      deletedOptions = 1;

      if (lastNarration) {
        db.prepare('DELETE FROM theater_messages WHERE id = ?')
          .run(lastNarration.id);
        deletedNarration = 1;
      }
    }

    res.json({
      ok: true,
      correction: content,
      deleted_options: deletedOptions,
      deleted_narration: deletedNarration,
      needs_next: deletedOptions === 1
    });
  });
};
