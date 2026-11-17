'use strict';
// 表情包：每个角色一套，用户自己上传并写「这个表情是什么意思」。
// 意思是给模型看的——你发一个表情，角色得知道它代表什么情绪。

module.exports = function (app, db) {
  // 建表语句统一在 schema.js（这里在模块加载时还没有账号上下文）

  function cleanText(value) {
    return String(value == null ? '' : value).trim();
  }

  app.get('/api/characters/:id/stickers', (req, res) => {
    const rows = db.prepare(`
      SELECT * FROM stickers
      WHERE character_id = ?
      ORDER BY id ASC
    `).all(req.params.id);

    res.json(rows);
  });

  app.post('/api/characters/:id/stickers', (req, res) => {
    const character = db.prepare('SELECT id FROM characters WHERE id = ?')
      .get(req.params.id);

    if (!character) {
      return res.status(404).json({ error: '角色不存在' });
    }

    const imageUrl = cleanText(req.body && req.body.image_url);
    const meaning = cleanText(req.body && req.body.meaning);

    if (!imageUrl) {
      return res.status(400).json({ error: '还没上传表情图片' });
    }

    const result = db.prepare(`
      INSERT INTO stickers (character_id, image_url, meaning)
      VALUES (?, ?, ?)
    `).run(character.id, imageUrl, meaning);

    const sticker = db.prepare('SELECT * FROM stickers WHERE id = ?')
      .get(Number(result.lastInsertRowid));

    res.json({ ok: true, sticker });
  });

  app.post('/api/stickers/:id', (req, res) => {
    const sticker = db.prepare('SELECT * FROM stickers WHERE id = ?')
      .get(req.params.id);

    if (!sticker) {
      return res.status(404).json({ error: '表情不存在' });
    }

    const meaning = cleanText(req.body && req.body.meaning);

    db.prepare('UPDATE stickers SET meaning = ? WHERE id = ?')
      .run(meaning, sticker.id);

    res.json({ ok: true });
  });

  app.delete('/api/stickers/:id', (req, res) => {
    db.prepare('DELETE FROM stickers WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });
};
