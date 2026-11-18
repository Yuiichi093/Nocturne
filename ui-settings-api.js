// 界面设置：每账号独立存在自己的 app_settings 里（头像形状 / 主页白框内容与对齐）
// 路由：GET /api/settings/ui、POST /api/settings/ui
module.exports = function (app, db) {
  const AVATAR_SHAPES = ['circle', 'square'];
  const ALIGNMENTS = ['left', 'center', 'right'];
  const HOME_NOTE_MAX = 500;

  const KEYS = {
    avatar_shape: 'ui_avatar_shape',
    home_note: 'ui_home_note',
    home_note_align: 'ui_home_note_align'
  };

  function readSettings() {
    const rows = db.prepare(`
      SELECT key, value FROM app_settings
      WHERE key IN ('ui_avatar_shape', 'ui_home_note', 'ui_home_note_align')
    `).all();

    const saved = {};
    for (const row of rows) {
      saved[row.key] = String(row.value == null ? '' : row.value);
    }

    const shape = saved[KEYS.avatar_shape];
    const align = saved[KEYS.home_note_align];

    return {
      // 库里的值也可能是老版本/手改出来的脏值，读的时候按默认值兜一下
      avatar_shape: AVATAR_SHAPES.includes(shape) ? shape : 'circle',
      home_note: saved[KEYS.home_note] || '',
      home_note_align: ALIGNMENTS.includes(align) ? align : 'left'
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
