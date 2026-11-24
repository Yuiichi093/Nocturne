module.exports = function (app, db) {
  function cleanText(value) {
    return String(value == null ? '' : value).trim();
  }

  // 参考图统一走 ref_images；老数据只有 ref_image 一列时也带上
  function refImagesOf(ownerType, ownerId, legacyUrl) {
    let rows = [];

    try {
      rows = db.prepare(`
        SELECT image_url FROM ref_images
        WHERE owner_type = ? AND owner_id = ?
        ORDER BY sort ASC, id ASC
      `).all(ownerType, ownerId);
    } catch (e) {
      rows = [];
    }

    const list = [];

    rows.forEach((row) => {
      const url = cleanText(row.image_url);
      if (url && !list.includes(url)) list.push(url);
    });

    if (!list.length) {
      const legacy = cleanText(legacyUrl);
      if (legacy) list.push(legacy);
    }

    return list;
  }

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
               background, speaking_style, ref_image
        FROM characters
        WHERE world_id = ?
        ORDER BY id ASC
      `).all(world.id).map((row) => {
        const refImages = refImagesOf('character', row.id, row.ref_image);

        return Object.assign({}, row, {
          ref_images: refImages,
          ref_image: cleanText(row.ref_image) || (refImages[0] || '')
        });
      }),
      personas: db.prepare(`
        SELECT id, name, avatar, bio, persona, ref_image
        FROM user_personas
        WHERE world_id = ?
        ORDER BY id ASC
      `).all(world.id).map((row) => {
        const refImages = refImagesOf('persona', row.id, row.ref_image);

        return Object.assign({}, row, {
          ref_images: refImages,
          ref_image: cleanText(row.ref_image) || (refImages[0] || '')
        });
      })
    }));

    res.json(result);
  });
};
