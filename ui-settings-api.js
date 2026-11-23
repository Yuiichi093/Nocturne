// 界面设置：每账号独立存在自己的 app_settings 里（头像形状 / 主页白框内容与对齐）
// 路由：GET /api/settings/ui、POST /api/settings/ui
module.exports = function (app, db) {
  const AVATAR_SHAPES = ['circle', 'square'];
  const ALIGNMENTS = ['left', 'center', 'right'];
  const HOME_NOTE_MAX = 500;
  // 省 token 模式的开关和上下文档位：档位只给四个，太少会丢剧情，太多就白烧钱
  const LEAN_MODES = ['0', '1'];
  const CONTEXT_LIMITS = [12, 20, 28, 40];
  // 剧场（小剧场）自己的省钱档位：默认就精简，档位只有 12/20/40，和聊天的 28 不通用
  const THEATER_CONTEXT_LIMITS = [12, 20, 40];

  const KEYS = {
    avatar_shape: 'ui_avatar_shape',
    home_note: 'ui_home_note',
    home_note_align: 'ui_home_note_align',
    lean_mode: 'ui_lean_mode',
    context_limit: 'ui_context_limit',
    theater_lean: 'ui_theater_lean',
    theater_context_limit: 'ui_theater_context_limit'
  };

  function readSettings() {
    const rows = db.prepare(`
      SELECT key, value FROM app_settings
      WHERE key IN (
        'ui_avatar_shape', 'ui_home_note', 'ui_home_note_align',
        'ui_lean_mode', 'ui_context_limit',
        'ui_theater_lean', 'ui_theater_context_limit'
      )
    `).all();

    const saved = {};
    for (const row of rows) {
      saved[row.key] = String(row.value == null ? '' : row.value);
    }

    const shape = saved[KEYS.avatar_shape];
    const align = saved[KEYS.home_note_align];
    const lean = saved[KEYS.lean_mode];
    const limit = Number(saved[KEYS.context_limit]);
    const theaterLean = saved[KEYS.theater_lean];
    const theaterLimit = Number(saved[KEYS.theater_context_limit]);

    return {
      // 库里的值也可能是老版本/手改出来的脏值，读的时候按默认值兜一下
      avatar_shape: AVATAR_SHAPES.includes(shape) ? shape : 'circle',
      home_note: saved[KEYS.home_note] || '',
      home_note_align: ALIGNMENTS.includes(align) ? align : 'left',
      lean_mode: LEAN_MODES.includes(lean) ? lean : '0',
      // 数字字段返回数字，前端不用再 parseInt
      context_limit: CONTEXT_LIMITS.includes(limit) ? limit : 40,
      // 精简剧情记忆默认开：剧场上下文本就短，开着更省
      theater_lean: LEAN_MODES.includes(theaterLean) ? theaterLean : '1',
      theater_context_limit: THEATER_CONTEXT_LIMITS.includes(theaterLimit)
        ? theaterLimit
        : 20
    };
  }

  function saveSetting(key, value) {
    db.prepare(`
      INSERT INTO app_settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  app.get('/api/settings/ui', (req, res) => {
    res.json({ settings: readSettings() });
  });

  app.post('/api/settings/ui', (req, res) => {
    const body = req.body || {};
    const updates = [];

    if (body.avatar_shape !== undefined) {
      const shape = String(body.avatar_shape || '').trim();

      if (!AVATAR_SHAPES.includes(shape)) {
        return res.status(400).json({
          error: '头像形状只能是 circle（圆）或 square（方角）'
        });
      }

      updates.push([KEYS.avatar_shape, shape]);
    }

    if (body.home_note_align !== undefined) {
      const align = String(body.home_note_align || '').trim();

      if (!ALIGNMENTS.includes(align)) {
        return res.status(400).json({
          error: '对齐方式只能是 left、center 或 right'
        });
      }

      updates.push([KEYS.home_note_align, align]);
    }

    if (body.lean_mode !== undefined) {
      const lean = String(body.lean_mode == null ? '' : body.lean_mode).trim();

      if (!LEAN_MODES.includes(lean)) {
        return res.status(400).json({
          error: '省 token 模式只能是 0（关）或 1（开）'
        });
      }

      updates.push([KEYS.lean_mode, lean]);
    }

    if (body.context_limit !== undefined) {
      const limit = Number(String(body.context_limit == null ? '' : body.context_limit).trim());

      if (!CONTEXT_LIMITS.includes(limit)) {
        return res.status(400).json({
          error: '上下文条数只能是 12、20、28 或 40'
        });
      }

      updates.push([KEYS.context_limit, String(limit)]);
    }

    if (body.theater_lean !== undefined) {
      const lean = String(body.theater_lean == null ? '' : body.theater_lean).trim();

      if (!LEAN_MODES.includes(lean)) {
        return res.status(400).json({
          error: '剧场精简模式只能是 0（关）或 1（开）'
        });
      }

      updates.push([KEYS.theater_lean, lean]);
    }

    if (body.theater_context_limit !== undefined) {
      const limit = Number(
        String(body.theater_context_limit == null ? '' : body.theater_context_limit).trim()
      );

      if (!THEATER_CONTEXT_LIMITS.includes(limit)) {
        return res.status(400).json({
          error: '剧场上下文条数只能是 12、20 或 40'
        });
      }

      updates.push([KEYS.theater_context_limit, String(limit)]);
    }

    if (body.home_note !== undefined) {
      // 超长直接截断，不报错：按字符数截，别把 emoji 劈成两半
      const note = Array.from(String(body.home_note == null ? '' : body.home_note))
        .slice(0, HOME_NOTE_MAX)
        .join('');

      updates.push([KEYS.home_note, note]);
    }

    for (const [key, value] of updates) {
      saveSetting(key, value);
    }

    res.json({ ok: true, settings: readSettings() });
  });
};
