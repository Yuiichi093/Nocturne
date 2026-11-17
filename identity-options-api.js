module.exports = function (app, db) {
  app.get('/api/identity-options', (req, res) => {
    const worlds = db.prepare(`
      SELECT id, name FROM worlds
      ORDER BY id ASC
    `).all();

    const result = worlds.map((world) => ({
      id: world.id,
      name: world.name,
      characters: db.prepare(`
        SELECT id, name, handle, avatar, persona, personality,
               background, speaking_style
        FROM characters
        WHERE world_id = ?
        ORDER BY id ASC
      `).all(world.id),
      personas: db.prepare(`
        SELECT id, name, avatar, bio, persona
        FROM user_personas
        WHERE world_id = ?
        ORDER BY id ASC
      `).all(world.id)
    }));

    res.json(result);
  });
};
