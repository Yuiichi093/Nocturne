const { getActiveWorldId } = require('./worlds');
const { getWorldbookContext } = require('./worldbook');
const { getCalendarContext } = require('./calendar-context');
const momentAi = require('./moment-ai');

module.exports = function (app, db) {
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

  function buildChatUrl(baseUrl) {
    const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (clean.endsWith('/chat/completions')) return clean;
    return clean + '/chat/completions';
  }

  function parseMoment(row) {
    return {
      ...row,
      images: safeJsonParse(row.images_json, [])
    };
  }

  app.get('/api/moments', (req, res) => {
    const worldId = getActiveWorldId();
    // 角色主页要看「这个角色的朋友圈」，所以支持按角色过滤
    const characterId = Number(req.query.character_id || 0);

    const rows = characterId
      ? db.prepare(`
          SELECT
            m.*,
            c.name AS character_name,
            c.avatar AS character_avatar
          FROM moments m
          LEFT JOIN characters c ON c.id = m.character_id
          WHERE m.world_id = ? AND m.character_id = ?
          ORDER BY m.id DESC
          LIMIT 100
        `).all(worldId, characterId)
      : db.prepare(`
          SELECT
            m.*,
            c.name AS character_name,
            c.avatar AS character_avatar
          FROM moments m
          LEFT JOIN characters c ON c.id = m.character_id
          WHERE m.world_id = ?
          ORDER BY m.id DESC
          LIMIT 100
        `).all(worldId);

    // 一次查完所有点赞 / 评论，再在内存里分组。
    // 原来每条动态查两次，100 条就是 200 多次 SQL，
    // 而朋友圈页每 60 秒刷新一次，放着不动就一直这么查。
    const ids = rows.map((row) => row.id);
    const marks = ids.map(() => '?').join(',') || 'NULL';

    const likeRows = ids.length
      ? db.prepare(`
          SELECT moment_id, user_name FROM moment_likes
          WHERE moment_id IN (${marks})
          ORDER BY id ASC
        `).all(...ids)
      : [];

    const commentRows = ids.length
      ? db.prepare(`
          SELECT
            mc.moment_id,
            mc.author_name,
            mc.content,
            mc.created_at,
            mc.character_id,
            c.avatar AS character_avatar
          FROM moment_comments mc
          LEFT JOIN characters c ON c.id = mc.character_id
          WHERE mc.moment_id IN (${marks})
          ORDER BY mc.id ASC
        `).all(...ids)
      : [];

    const likesByMoment = new Map();
    likeRows.forEach((item) => {
      if (!likesByMoment.has(item.moment_id)) likesByMoment.set(item.moment_id, []);
      likesByMoment.get(item.moment_id).push(item.user_name);
    });

    const commentsByMoment = new Map();
    commentRows.forEach((item) => {
      if (!commentsByMoment.has(item.moment_id)) commentsByMoment.set(item.moment_id, []);
      const { moment_id: ignored, ...rest } = item;
      commentsByMoment.get(item.moment_id).push(rest);
    });

    const result = rows.map((row) => {
      const moment = parseMoment(row);

      // 自己发的动态没有角色，用存下来的作者信息填上
      if (row.author_type === 'user') {
        moment.character_name = row.author_name || '我';
        moment.character_avatar = row.author_avatar || '';
      }

      const likes = likesByMoment.get(row.id) || [];
      const comments = commentsByMoment.get(row.id) || [];

      return {
        ...moment,
        likes,
        liked: likes.includes('我'),
        comments
      };
    });

    res.json(result);
  });

  app.post('/api/moments', (req, res) => {
    const body = req.body || {};
    const worldId = getActiveWorldId();
    const content = cleanText(body.content);
    const isUser = body.author_type === 'user';

    if (!content) {
      return res.status(400).json({ error: '写点内容吧' });
    }

    let characterId = Number(body.character_id || 0);
    let authorName = '';
    let authorAvatar = '';

    if (isUser) {
      // 自己发的动态挂在 0 号“角色”上（表里 character_id 是非空的），
      // 真正的名字和头像存在 author_* 里
      characterId = 0;
      authorName = cleanText(body.author_name) || '我';
      authorAvatar = cleanText(body.author_avatar);
    } else {
      if (!characterId) {
        return res.status(400).json({ error: '角色和内容必填' });
      }

      const character = db.prepare(`
        SELECT * FROM characters
        WHERE id = ? AND world_id = ?
      `).get(characterId, worldId);

      if (!character) {
        return res.status(404).json({ error: '角色不存在' });
      }
    }

    const images = Array.isArray(body.images) ? body.images : [];

    const result = db.prepare(`
      INSERT INTO moments
        (world_id, character_id, content, images_json, source,
         author_type, author_name, author_avatar)
      VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)
    `).run(
      worldId,
      characterId,
      content,
      JSON.stringify(images),
      isUser ? 'user' : 'character',
      authorName,
      authorAvatar
    );

    const moment = db.prepare(`
      SELECT
        m.*,
        c.name AS character_name,
        c.avatar AS character_avatar
      FROM moments m
      LEFT JOIN characters c ON c.id = m.character_id
      WHERE m.id = ?
    `).get(Number(result.lastInsertRowid));

    res.json({ ok: true, moment: parseMoment(moment) });
  });

  app.delete('/api/moments/:id', (req, res) => {
    const worldId = getActiveWorldId();

    const moment = db.prepare(`
      SELECT * FROM moments
      WHERE id = ? AND world_id = ?
    `).get(req.params.id, worldId);

    if (!moment) {
      return res.status(404).json({ error: '朋友圈不存在' });
    }

    // 点赞和评论跟着一起删，不然会留下永远查不到也删不掉的垃圾
    db.exec('BEGIN');

    try {
      db.prepare('DELETE FROM moment_likes WHERE moment_id = ?').run(req.params.id);
      db.prepare('DELETE FROM moment_comments WHERE moment_id = ?').run(req.params.id);
      db.prepare('DELETE FROM moments WHERE id = ?').run(req.params.id);
      db.exec('COMMIT');
    } catch (deleteError) {
      db.exec('ROLLBACK');
      throw deleteError;
    }

    res.json({ ok: true });
  });

  // 朋友圈消息提醒：角色在我自己发的动态下面的评论
  app.get('/api/moments/notifications', (req, res) => {
    const worldId = getActiveWorldId();

    const rows = db.prepare(`
      SELECT
        mc.id,
        mc.moment_id,
        mc.author_name,
        mc.content,
        mc.created_at,
        c.avatar AS author_avatar,
        m.content AS moment_content
      FROM moment_comments mc
      JOIN moments m ON m.id = mc.moment_id
      LEFT JOIN characters c ON c.id = mc.character_id
      WHERE m.world_id = ?
        AND m.author_type = 'user'
        AND mc.author_name <> '我'
      ORDER BY mc.id DESC
      LIMIT 50
    `).all(worldId);

    res.json(rows);
  });

  // 朋友圈封面：全局一份，不再按世界分开。
  // 以前按世界存，切了世界（或者新建一个世界后）回首页就发现「刚换的背景没了」，
  // 所以现在优先读全局 key，读不到再回退到老的世界 key，老图不会丢。
  function readCover(worldId) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?')
      .get('moments_cover');

    if (row && row.value) return row.value;

    if (worldId) {
      const legacy = db.prepare('SELECT value FROM app_settings WHERE key = ?')
        .get('moments_cover_' + worldId);
      if (legacy && legacy.value) return legacy.value;
    }

    return '';
  }

  function saveSetting(key, value) {
    db.prepare(`
      INSERT INTO app_settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  app.get('/api/moments/settings', (req, res) => {
    let worldId = '';
    try {
      worldId = getActiveWorldId();
    } catch (e) {
      // 还没有世界观时不该让整个朋友圈设置接口 500，封面按空的返回就行
      worldId = '';
    }

    try {
      res.json({ cover: readCover(worldId) });
    } catch (e) {
      res.json({ cover: '' });
    }
  });

  app.post('/api/moments/cover', (req, res) => {
    const cover = cleanText(req.body && req.body.cover);

    saveSetting('moments_cover', cover);

    res.json({ ok: true, cover });
  });

  app.put('/api/moments/:id', (req, res) => {
    const worldId = getActiveWorldId();
    const content = cleanText(req.body && req.body.content);

    if (!content) {
      return res.status(400).json({ error: '内容不能为空' });
    }

    const moment = db.prepare(`
      SELECT * FROM moments
      WHERE id = ? AND world_id = ?
    `).get(req.params.id, worldId);

    if (!moment) {
      return res.status(404).json({ error: '朋友圈不存在' });
    }

    const images = Array.isArray(req.body.images)
      ? req.body.images
      : safeJsonParse(moment.images_json, []);

    db.prepare(`
      UPDATE moments
      SET content = ?, images_json = ?
      WHERE id = ?
    `).run(content, JSON.stringify(images), req.params.id);

    res.json({ ok: true });
  });

  app.post('/api/moments/:id/like', (req, res) => {
    const worldId = getActiveWorldId();

    const moment = db.prepare(`
      SELECT * FROM moments
      WHERE id = ? AND world_id = ?
    `).get(req.params.id, worldId);

    if (!moment) {
      return res.status(404).json({ error: '朋友圈不存在' });
    }

    const userName = cleanText(req.body && req.body.user_name) || '我';
    const existing = db.prepare(`
      SELECT * FROM moment_likes
      WHERE moment_id = ? AND user_name = ?
    `).get(moment.id, userName);

    if (existing) {
      db.prepare('DELETE FROM moment_likes WHERE id = ?').run(existing.id);
    } else {
      db.prepare(`
        INSERT INTO moment_likes (moment_id, user_name)
        VALUES (?, ?)
      `).run(moment.id, userName);
    }

    const likes = db.prepare(`
      SELECT user_name FROM moment_likes
      WHERE moment_id = ?
      ORDER BY id ASC
    `).all(moment.id).map((item) => item.user_name);

    res.json({
      ok: true,
      liked: likes.includes(userName),
      likes
    });
  });

  app.post('/api/moments/:id/comments', (req, res) => {
    const worldId = getActiveWorldId();
    const content = cleanText(req.body && req.body.content);

    if (!content) {
      return res.status(400).json({ error: '评论不能为空' });
    }

    const moment = db.prepare(`
      SELECT * FROM moments
      WHERE id = ? AND world_id = ?
    `).get(req.params.id, worldId);

    if (!moment) {
      return res.status(404).json({ error: '朋友圈不存在' });
    }

    const authorName = cleanText(req.body && req.body.author_name) || '我';

    const result = db.prepare(`
      INSERT INTO moment_comments
        (moment_id, author_name, content)
      VALUES (?, ?, ?)
    `).run(moment.id, authorName, content);

    const comment = db.prepare(`
      SELECT * FROM moment_comments WHERE id = ?
    `).get(Number(result.lastInsertRowid));

    res.json({ ok: true, comment });
  });

  // 让同世界观的其他角色来评论这条朋友圈
  app.post('/api/moments/:id/comments/ai', async (req, res) => {
    try {
      const worldId = getActiveWorldId();
      const moment = db.prepare(`
        SELECT id FROM moments WHERE id = ? AND world_id = ?
      `).get(req.params.id, worldId);

      if (!moment) {
        return res.status(404).json({ error: '朋友圈不存在' });
      }

      const count = Math.min(Math.max(Number(req.body && req.body.count) || 2, 1), 4);
      const result = await momentAi.generateCommentsForMoment(moment.id, {
        worldId,
        count
      });

      res.json({
        ok: true,
        comments: result.comments,
        skipped: result.skipped || ''
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 自动发朋友圈的设置
  app.get('/api/moments/auto-settings', (req, res) => {
    res.json(momentAi.getAutoSettings());
  });

  app.post('/api/moments/auto-settings', (req, res) => {
    const settings = momentAi.saveAutoSettings(req.body || {});
    res.json({ ok: true, settings });
  });

  // 手动触发一次自动发布（调试 / 想让角色现在就发一条时用）
  app.post('/api/moments/auto/run', async (req, res) => {
    try {
      const result = await momentAi.runAutoTick(true);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/moments/generate', async (req, res) => {
    const body = req.body || {};
    const worldId = getActiveWorldId();
    const characterId = Number(body.character_id || 0);

    if (!characterId) {
      return res.status(400).json({ error: '缺少角色 ID' });
    }

    const character = db.prepare(`
      SELECT * FROM characters
      WHERE id = ? AND world_id = ?
    `).get(characterId, worldId);

    if (!character) {
      return res.status(404).json({ error: '角色不存在' });
    }

    const modelRow = db.prepare(`
      SELECT * FROM model_profiles
      ORDER BY is_default DESC, id DESC
      LIMIT 1
    `).get();

    if (!modelRow) {
      return res.status(400).json({ error: '还没有配置模型 API' });
    }

    const history = db.prepare(`
      SELECT role, content FROM messages
      WHERE character_id = ?
      ORDER BY id DESC
      LIMIT 8
    `).all(characterId).reverse();

    const recentText = history
      .map((item) => {
        const name = item.role === 'user' ? '用户' : character.name;
        return name + '：' + item.content;
      })
      .join('\n');

    const worldbook = getWorldbookContext(
      Number(character.world_id || getActiveWorldId()),
      recentText
    );

    const calendar = getCalendarContext(
      Number(character.world_id || getActiveWorldId())
    );

    const systemPrompt = [
      `你正在扮演角色「${character.name}」。`,
      `请以这个角色的身份，写一条发在朋友圈/碎碎念里的短动态。`,
      character.personality ? `性格：${character.personality}` : '',
      character.background ? `背景：${character.background}` : '',
      character.speaking_style ? `说话方式：${character.speaking_style}` : '',
      character.persona ? `完整人设：${character.persona}` : '',
      recentText ? `最近聊天：\n${recentText}` : '',
      worldbook.text ? `【世界书】\n${worldbook.text}` : '',
      calendar ? calendar : '',
      '要求：',
      '1. 1-3 句，短，口语化。',
      '2. 像随手发的朋友圈，不要旁白，不要解释。',
      '3. 不要写“今天的朋友圈”这种标题。',
      '4. 不要 hashtag，不要列表。',
      '5. 不要替用户说话。'
    ].filter(Boolean).join('\n');

    const extraHeaders = safeJsonParse(modelRow.extra_headers, {});
    const headers = {
      'Content-Type': 'application/json',
      ...extraHeaders
    };

    if (!headers.Authorization && !headers.authorization) {
      headers.Authorization = 'Bearer ' + modelRow.api_key;
    }

    const payload = {
      model: modelRow.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '写一条你今天的朋友圈。' }
      ],
      temperature: Number(modelRow.temperature ?? 0.9),
      max_tokens: 300
    };

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(buildChatUrl(modelRow.base_url), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const text = await response.text();

      if (!response.ok) {
        return res.status(502).json({ error: text.slice(0, 1000) });
      }

      let data = null;
      try {
        data = JSON.parse(text);
      } catch (e) {}

      const content = String(
        data?.choices?.[0]?.message?.content || ''
      ).trim();

      if (!content) {
        return res.status(502).json({ error: '模型返回了空内容' });
      }

      const meta = {
        provider: modelRow.name,
        model: modelRow.model,
        usage: data.usage || null,
        latency_ms: Date.now() - started,
        worldbook_hits: worldbook.count
      };

      const result = db.prepare(`
        INSERT INTO moments
          (world_id, character_id, content, images_json, source, meta_json)
        VALUES (?, ?, ?, '[]', 'ai', ?)
      `).run(
        worldId,
        characterId,
        content,
        JSON.stringify(meta)
      );

      const moment = db.prepare(`
        SELECT
          m.*,
          c.name AS character_name,
          c.avatar AS character_avatar
        FROM moments m
        LEFT JOIN characters c ON c.id = m.character_id
        WHERE m.id = ?
      `).get(Number(result.lastInsertRowid));

      res.json({ ok: true, moment: parseMoment(moment) });
    } catch (error) {
      res.status(500).json({
        error: error.name === 'AbortError' ? '生成超时' : error.message
      });
    } finally {
      clearTimeout(timer);
    }
  });
};
