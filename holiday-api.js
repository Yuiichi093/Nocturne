const { getActiveWorldId } = require('./worlds');

module.exports = function (app, db) {
  app.get('/api/holidays', (req, res) => {
    const worldId = getActiveWorldId();

    const rows = db.prepare(`
      SELECT
        h.*,
        COALESCE(s.enabled, 1) AS enabled
      FROM holidays h
      LEFT JOIN world_holiday_settings s
        ON s.holiday_id = h.id AND s.world_id = ?
      ORDER BY h.sort_order ASC, h.id ASC
    `).all(worldId);

    res.json(rows);
  });

  app.post('/api/holidays/:id/toggle', (req, res) => {
    const worldId = getActiveWorldId();
    const holidayId = Number(req.params.id);
    const enabled = req.body && req.body.enabled ? 1 : 0;

    const holiday = db.prepare('SELECT id FROM holidays WHERE id = ?')
      .get(holidayId);

    if (!holiday) {
      return res.status(404).json({ error: '节日不存在' });
    }

    db.prepare(`
      INSERT INTO world_holiday_settings
        (world_id, holiday_id, enabled)
      VALUES (?, ?, ?)
      ON CONFLICT(world_id, holiday_id)
      DO UPDATE SET enabled = excluded.enabled
    `).run(worldId, holidayId, enabled);

    res.json({ ok: true, enabled });
  });
};
