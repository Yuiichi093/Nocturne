const { getActiveWorldId } = require('./worlds');

module.exports = function (app, db) {
  function cleanText(value) {
    return String(value ?? '').trim();
  }

  const defaults = {
    name: '你的名字',
    handle: '@your_handle',
    bio: '在这里写一句你的签名。',
    location: 'Saudade',
    avatar: '',
    bg: ''
  };

  app.get('/api/profile', (req, res) => {
    const worldId = getActiveWorldId();

    const row = db.prepare(`
      SELECT * FROM world_profiles WHERE world_id = ?
    `).get(worldId);

    res.json(row || defaults);
  });

  app.post('/api/profile', (req, res) => {
    const worldId = getActiveWorldId();
    const body = req.body || {};

    const profile = {
      name: cleanText(body.name) || defaults.name,
      handle: cleanText(body.handle) || defaults.handle,
      bio: cleanText(body.bio) || defaults.bio,
      location: cleanText(body.location) || defaults.location,
      avatar: cleanText(body.avatar),
      bg: cleanText(body.bg)
    };

    db.prepare(`
      INSERT INTO world_profiles
        (world_id, name, handle, bio, location, avatar, bg)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(world_id) DO UPDATE SET
        name = excluded.name,
        handle = excluded.handle,
        bio = excluded.bio,
        location = excluded.location,
        avatar = excluded.avatar,
        bg = excluded.bg,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      worldId,
      profile.name,
      profile.handle,
      profile.bio,
      profile.location,
      profile.avatar,
      profile.bg
    );

    res.json({ ok: true, profile });
  });
};
