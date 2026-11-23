module.exports = function (app, db) {
  // messages 的补列（narration / image_url / image_desc / sticker_id）和
  // message_variants 表统一在 schema.js + migrate.js 里建。以前写在这里，
  // 模块加载时还没有账号上下文，ALTER 全落到 system.db 上，新账号反而缺列。


  const { getActiveWorldId } = require('./worlds');
const { getWorldbookContext, getWorldbookContextByNames } = require('./worldbook');
const { getCalendarContext } = require('./calendar-context');
const {
  describeImage, requestChat, parseJsonLoose, stripCodeFence, extractContent, recordUsage
} = require('./llm');

  const DEFAULT_CHAT_STYLE = `【全局聊天风格】
你是在用手机和用户聊天，不是在写小说。
1. 像微信聊天一样说话，口语化、短句、有停顿。
2. 通常只回复 1-3 句，能一句说完就一句。
3. 用【旁白】写动作、神态、环境，用【对白】写角色说的话；对白里不要混动作描写。
4. **每条回复都要有【旁白】**，一句话就够，写具体在做什么、脸上什么表情、周围什么动静。
   旁白是这个角色「看得见」的部分，缺了它聊天就像干巴巴的短信。
   唯一可以省掉旁白的情况：你只回一个表情，或者只回一个「嗯」这种。
   也不要为了凑字硬编，写正在发生的那一个动作就行。
5. 不要总结、不要列点、不要客服腔。
6. 可以反问、吐槽、转移话题、短暂沉默。
7. 不要每句话都叫用户名字，不要过度抒情。
8. 如果用户只发很短的话，你的回复也要短。
9. 不要替用户说话或替用户做决定。

示例：
用户：晚上好
角色：【旁白】把手机从床头摸过来，眯着眼看屏幕。
【对白】晚上好。这个点还醒着，要么失眠，要么有事想说。

用户：你在干嘛
角色：【旁白】翻过一页书，没抬头。
【对白】看书。你那边怎么这么吵。

用户：算了，我先睡了
角色：【旁白】把台灯调暗了一点，声音放轻。
【对白】嗯，睡吧。明天要是还这样，记得跟我说。`;
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

  function getChatStylePrompt() {
    const row = db.prepare(`
      SELECT value FROM app_settings
      WHERE key = 'chat_style_prompt'
    `).get();

    return (row && row.value) || DEFAULT_CHAT_STYLE;
  }

  // 省 token 的两个开关：lean_mode='1' 跳过补问旁白的那次请求；
  // context_limit 决定发多少条历史（库里的脏值按 40 兜底）。
  const CONTEXT_LIMIT_MAX = 40;

  function readLeanSettings() {
    const rows = db.prepare(`
      SELECT key, value FROM app_settings
      WHERE key IN ('ui_lean_mode', 'ui_context_limit')
    `).all();

    const saved = {};

    for (const row of rows) {
      saved[row.key] = String(row.value == null ? '' : row.value).trim();
    }

    const limit = Number(saved.ui_context_limit);
    const contextLimit = Number.isInteger(limit) && limit >= 1 && limit <= CONTEXT_LIMIT_MAX
      ? limit
      : CONTEXT_LIMIT_MAX;

    return {
      leanMode: saved.ui_lean_mode === '1' ? '1' : '0',
      contextLimit
    };
  }

  app.get('/api/chats', (req, res) => {
    const rows = db.prepare(`
      SELECT
        c.id,
        c.name,
        c.handle,
        c.avatar,
        c.opening_line,
        c.is_pinned,
        c.user_persona_id,
        c.created_at,
        (
          SELECT content
          FROM messages m
          WHERE m.character_id = c.id
          ORDER BY m.id DESC
          LIMIT 1
        ) AS last_content,
        (
          SELECT created_at
          FROM messages m
          WHERE m.character_id = c.id
          ORDER BY m.id DESC
          LIMIT 1
        ) AS last_time
      FROM characters c
      WHERE c.world_id = ?
      ORDER BY
        c.is_pinned DESC,
        COALESCE(
          (
            SELECT created_at
            FROM messages m
            WHERE m.character_id = c.id
            ORDER BY m.id DESC
            LIMIT 1
          ),
          c.created_at
        ) DESC,
        c.id DESC
    `).all(getActiveWorldId());

    res.json(rows);
  });

  app.post('/api/characters/:id/pin', (req, res) => {
    const pinned = req.body && req.body.pinned ? 1 : 0;
    db.prepare('UPDATE characters SET is_pinned = ? WHERE id = ?')
      .run(pinned, req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/characters/:id/settings', (req, res) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?')
      .get(req.params.id);

    if (!character) {
      return res.status(404).json({ error: '角色不存在' });
    }

    const body = req.body || {};

    const personaId = body.user_persona_id !== undefined
      ? Number(body.user_persona_id || 0)
      : Number(character.user_persona_id || 0);

    const pinned = body.is_pinned !== undefined
      ? (body.is_pinned ? 1 : 0)
      : Number(character.is_pinned || 0);

    db.prepare(`
      UPDATE characters
      SET user_persona_id = ?, is_pinned = ?
      WHERE id = ?
    `).run(personaId, pinned, req.params.id);

    res.json({
      ok: true,
      user_persona_id: personaId,
      is_pinned: pinned
    });
  });

  app.get('/api/characters/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM characters WHERE id = ?')
      .get(req.params.id);

    if (!row) {
      return res.status(404).json({ error: '角色不存在' });
    }

    res.json(row);
  });

  app.get('/api/characters/:id/messages', (req, res) => {
    const rows = db.prepare(`
      SELECT
        m.*,
        s.image_url AS sticker_url,
        s.meaning AS sticker_meaning
      FROM messages m
      LEFT JOIN stickers s ON s.id = m.sticker_id
      WHERE m.character_id = ?
      ORDER BY m.id ASC
    `).all(req.params.id);

    res.json(rows);
  });

  app.post('/api/characters/:id/messages', (req, res) => {
    const content = String(req.body && req.body.content || '').trim();
    const narration = String(req.body && req.body.narration || '').trim();
    const imageUrl = String(req.body && req.body.image_url || '').trim();
    const stickerId = Number(req.body && req.body.sticker_id || 0);
    const role = ['user', 'character', 'system'].includes(req.body && req.body.role)
      ? req.body.role
      : 'user';

    if (!content && !narration && !imageUrl && !stickerId) {
      return res.status(400).json({ error: '对白和旁白不能同时为空' });
    }

    const character = db.prepare('SELECT * FROM characters WHERE id = ?')
      .get(req.params.id);

    if (!character) {
      return res.status(404).json({ error: '角色不存在' });
    }

    const count = db.prepare(`
      SELECT COUNT(*) AS count FROM messages WHERE character_id = ?
    `).get(req.params.id).count;

    if (Number(count) === 0 && character.opening_line) {
      db.prepare(`
        INSERT INTO messages (character_id, role, content)
        VALUES (?, ?, ?)
      `).run(req.params.id, 'character', character.opening_line);
    }

    const result = db.prepare(`
      INSERT INTO messages
        (character_id, role, content, narration, image_url, sticker_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      role,
      content,
      narration,
      imageUrl,
      stickerId > 0 ? stickerId : null
    );

    const preview = (content || narration || (stickerId ? '[表情]' : '[图片]'))
      .replace(/\s+/g, ' ').slice(0, 80);

    db.prepare(`
      UPDATE characters
      SET last_message_at = CURRENT_TIMESTAMP,
          last_message_preview = ?
      WHERE id = ?
    `).run(preview, req.params.id);

    const message = db.prepare('SELECT * FROM messages WHERE id = ?')
      .get(Number(result.lastInsertRowid));

    res.json({ ok: true, message });
  });

  app.put('/api/messages/:id', (req, res) => {
    const content = String(req.body && req.body.content || '').trim();
    const narration = String(req.body && req.body.narration || '').trim();

    if (!content && !narration) {
      return res.status(400).json({ error: '对白和旁白不能同时为空' });
    }

    const message = db.prepare('SELECT * FROM messages WHERE id = ?')
      .get(req.params.id);

    if (!message) {
      return res.status(404).json({ error: '消息不存在' });
    }

    db.prepare(`
      UPDATE messages
      SET content = ?, narration = ?, edited_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(content, narration, req.params.id);

    const last = db.prepare(`
      SELECT * FROM messages
      WHERE character_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(message.character_id);

    if (last && Number(last.id) === Number(message.id)) {
      db.prepare(`
        UPDATE characters
        SET last_message_preview = ?
        WHERE id = ?
      `).run((content || narration).replace(/\s+/g, ' ').slice(0, 80), message.character_id);
    }

    res.json({ ok: true });
  });

  app.delete('/api/messages/:id', (req, res) => {
    const message = db.prepare('SELECT * FROM messages WHERE id = ?')
      .get(req.params.id);

    if (!message) {
      return res.status(404).json({ error: '消息不存在' });
    }

    db.exec('BEGIN');

    try {
      // 消息删了，它的各个历史版本也要一起清掉，不然会一直躺在库里
      db.prepare('DELETE FROM message_variants WHERE message_id = ?')
        .run(req.params.id);
      db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.id);
      db.exec('COMMIT');
    } catch (deleteError) {
      db.exec('ROLLBACK');
      throw deleteError;
    }

    const last = db.prepare(`
      SELECT * FROM messages
      WHERE character_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(message.character_id);

    db.prepare(`
      UPDATE characters
      SET last_message_preview = ?
      WHERE id = ?
    `).run(
      last ? last.content.replace(/\s+/g, ' ').slice(0, 80) : '',
      message.character_id
    );

    res.json({ ok: true });
  });

  app.get('/api/settings/chat-style', (req, res) => {
    res.json({ content: getChatStylePrompt() });
  });

  app.post('/api/settings/chat-style', (req, res) => {
    const content = String(req.body && req.body.content || '').trim();

    if (!content) {
      return res.status(400).json({ error: '风格提示词不能为空' });
    }

    db.prepare(`
      INSERT INTO app_settings (key, value)
      VALUES ('chat_style_prompt', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(content);

    res.json({ ok: true });
  });

  app.get('/api/messages/:id/variants', (req, res) => {
    const message = db.prepare('SELECT * FROM messages WHERE id = ?')
      .get(req.params.id);

    if (!message) {
      return res.status(404).json({ error: '消息不存在' });
    }

    const variants = db.prepare(`
      SELECT * FROM message_variants
      WHERE message_id = ?
      ORDER BY id ASC
    `).all(message.id);

    res.json({ current: message, variants });
  });

  app.post('/api/messages/:id/variant', (req, res) => {
    const variantId = Number(req.body && req.body.variant_id || 0);

    const message = db.prepare('SELECT * FROM messages WHERE id = ?')
      .get(req.params.id);

    if (!message) {
      return res.status(404).json({ error: '消息不存在' });
    }

    const variant = db.prepare(`
      SELECT * FROM message_variants
      WHERE id = ? AND message_id = ?
    `).get(variantId, message.id);

    if (!variant) {
      return res.status(404).json({ error: '历史版本不存在' });
    }

    // 三步必须一起成功，中途被打断会把那一版内容弄丢
    db.exec('BEGIN');

    try {
      db.prepare(`
        INSERT INTO message_variants
          (message_id, content, narration, meta_json, sticker_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        message.id,
        message.content || '',
        message.narration || '',
        message.meta_json || '',
        message.sticker_id || null
      );

      db.prepare('DELETE FROM message_variants WHERE id = ?')
        .run(variant.id);

      db.prepare(`
        UPDATE messages
        SET content = ?, narration = ?, meta_json = ?, sticker_id = ?
        WHERE id = ?
      `).run(
        variant.content || '',
        variant.narration || '',
        variant.meta_json || '',
        variant.sticker_id || null,
        message.id
      );

      db.exec('COMMIT');
    } catch (switchError) {
      db.exec('ROLLBACK');
      throw switchError;
    }

    const last = db.prepare(`
      SELECT * FROM messages
      WHERE character_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(message.character_id);

    if (last && Number(last.id) === Number(message.id)) {
      db.prepare(`
        UPDATE characters
        SET last_message_preview = ?
        WHERE id = ?
      `).run(
        (variant.content || '').replace(/\s+/g, ' ').slice(0, 80),
        message.character_id
      );
    }

    const updated = db.prepare('SELECT * FROM messages WHERE id = ?')
      .get(message.id);

    res.json({ ok: true, message: updated });
  });

  function parseChatReply(text) {
    const raw = String(text || '').trim();

    if (!raw) {
      return { narration: '', dialogue: '' };
    }

    // 标记法：容忍【 旁白 】里的空格，以及标记后可能出现的冒号
    const narrationMatch = raw.match(/【\s*旁白\s*】\s*[:：]?\s*([\s\S]*?)(?=【\s*对白\s*】|$)/);
    const dialogueMatch = raw.match(/【\s*对白\s*】\s*[:：]?\s*([\s\S]*)/);

    if (narrationMatch || dialogueMatch) {
      return {
        narration: narrationMatch ? narrationMatch[1].trim() : '',
        dialogue: dialogueMatch ? dialogueMatch[1].trim() : ''
      };
    }

    // （旁白：xxx）形式
    const parenMatch = raw.match(/[（(]\s*旁白\s*[:：]\s*([\s\S]*?)[）)]/);

    if (parenMatch) {
      return {
        narration: parenMatch[1].trim(),
        dialogue: raw.replace(parenMatch[0], '').trim()
      };
    }

    try {
      const data = JSON.parse(raw);
      if (data && (data.narration || data.dialogue || data.content)) {
        return {
          narration: String(data.narration || '').trim(),
          dialogue: String(data.dialogue || data.content || '').trim()
        };
      }
    } catch (e) {}

    // 兜底：模型忘了写标记时，若首行是纯括号包着的动作描写，拆出来当旁白
    // 例：「（瞥了你一眼）\n有话快说。」
    const lines = raw.split('\n');
    const firstLine = (lines[0] || '').trim();
    const bracketOnly = firstLine.match(/^[（(]([\s\S]+)[）)]$/);

    if (bracketOnly && lines.length > 1) {
      const rest = lines.slice(1).join('\n').trim();
      if (rest) {
        return { narration: bracketOnly[1].trim(), dialogue: rest };
      }
    }

    return {
      narration: '',
      dialogue: raw
    };
  }

  app.post('/api/characters/:id/reply', async (req, res) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?')
      .get(req.params.id);

    if (!character) {
      return res.status(404).json({ error: '角色不存在' });
    }

    const requestBody = req.body || {};
    const regenerateId = Number(requestBody.regenerate_message_id || 0);
    let targetMessage = null;

    if (regenerateId) {
      targetMessage = db.prepare(`
        SELECT * FROM messages
        WHERE id = ? AND character_id = ? AND role = 'character'
      `).get(regenerateId, req.params.id);

      if (!targetMessage) {
        return res.status(404).json({ error: '要重新生成的消息不存在' });
      }
    }

    const modelRow = db.prepare(`
      SELECT * FROM model_profiles
      WHERE is_image = 0
      ORDER BY is_default DESC, id DESC
      LIMIT 1
    `).get();

    if (!modelRow) {
      return res.status(400).json({ error: '还没有配置模型 API' });
    }

    let userPersona = null;

    if (Number(character.user_persona_id || 0) > 0) {
      userPersona = db.prepare('SELECT * FROM user_personas WHERE id = ?')
        .get(character.user_persona_id);
    }

    if (!userPersona) {
      userPersona = db.prepare(`
        SELECT * FROM user_personas
        ORDER BY is_default DESC, id DESC
        LIMIT 1
      `).get();
    }

    const { leanMode, contextLimit } = readLeanSettings();

    const history = regenerateId
      ? db.prepare(`
          SELECT
            m.id, m.role, m.content, m.narration, m.image_url, m.image_desc,
            s.meaning AS sticker_meaning
          FROM messages m
          LEFT JOIN stickers s ON s.id = m.sticker_id
          WHERE m.character_id = ? AND m.id < ?
          ORDER BY m.id DESC
          LIMIT ?
        `).all(req.params.id, regenerateId, contextLimit).reverse()
      : db.prepare(`
          SELECT
            m.id, m.role, m.content, m.narration, m.image_url, m.image_desc,
            s.meaning AS sticker_meaning
          FROM messages m
          LEFT JOIN stickers s ON s.id = m.sticker_id
          WHERE m.character_id = ?
          ORDER BY m.id DESC
          LIMIT ?
        `).all(req.params.id, contextLimit).reverse();

    const worldId = Number(character.world_id || getActiveWorldId());
    // 把角色名和用户人设名一起作为检索词，
    // 这样世界书里「角色之间的关系」这类条目才会被命中。
    const worldbook = getWorldbookContextByNames(
      worldId,
      history.map((item) => [item.narration, item.content].filter(Boolean).join('\n')).join('\n'),
      [character.name, userPersona && userPersona.name]
    );

    const calendar = getCalendarContext(worldId);

    const systemParts = [
      `你正在扮演角色「${character.name}」。`,
      character.handle ? `角色用户名：${character.handle}` : '',
      character.personality ? `性格：${character.personality}` : '',
      character.background ? `背景：${character.background}` : '',
      character.speaking_style ? `说话方式：${character.speaking_style}` : '',
      character.persona ? `完整人设：${character.persona}` : '',
      userPersona
        ? `用户人设：${userPersona.name}。${userPersona.bio || ''}\n${userPersona.persona || ''}`
        : '用户人设：未设置。',
      worldbook.text ? `【世界书】\n${worldbook.text}` : '',
      calendar ? calendar : '',
      '请始终保持角色一致，不要跳出角色。用自然的中文对话回复，不要解释自己是 AI。',
      getChatStylePrompt(),
      '回复格式：',
      '【旁白】动作/神态/环境（每条都要写，一句话）',
      '【对白】角色说的话（可以没有）',
      '规则：【旁白】不许省。写完旁白再写对白；只做动作不说话时，只写【旁白】。',
      '旁白要写具体的、此刻正在发生的动作或表情，不要写心理总结，不要写「他心里想」。',
      '不要输出其他解释。'
    ].filter(Boolean);

    // 对方发的图片：先让看图模型把画面转成文字，存回数据库，
    // 这样这一轮和以后每一轮，角色都"记得"这张图。
    // 一次补最近三张还没描述过的：她连发几张也不会漏。
    const pendingImages = [...history]
      .reverse()
      .filter((item) => item.role === 'user' && item.image_url && !item.image_desc)
      .slice(0, 3);

    let imageNote = '';

    for (const row of pendingImages) {
      try {
        const caption = await describeImage({ imageUrl: row.image_url });

        if (caption) {
          row.image_desc = caption;

          db.prepare('UPDATE messages SET image_desc = ? WHERE id = ?')
            .run(caption, row.id);
        }
      } catch (e) {
        // 看图失败不影响聊天：这一轮先按"看不清"处理，并且告诉用户一声，
        // 免得她以为角色不吭声是没礼貌。
        imageNote = '他没看清你发的图：' + e.message;
      }
    }

    const messages = [
      { role: 'system', content: systemParts.join('\n') }
    ];

    history.forEach((row) => {
      let imageNote = '';

      if (row.image_url) {
        imageNote = row.image_desc
          ? '（图片内容：' + row.image_desc + '）'
          : '（对方发来一张图片，你看不清画面）';
      }

      const stickerNote = row.sticker_meaning
        ? '（发了一个表情包，意思是：' + row.sticker_meaning + '）'
        : '';

      const merged = [
        row.narration ? '（旁白：' + row.narration + '）' : '',
        row.content || '',
        imageNote,
        stickerNote
      ].filter(Boolean).join('\n');

      if (row.role === 'user') {
        messages.push({ role: 'user', content: merged });
      } else if (row.role === 'character') {
        messages.push({ role: 'assistant', content: merged });
      }
    });

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
      messages,
      temperature: Number(modelRow.temperature ?? 0.8)
    };

    const configuredMax = Number(modelRow.max_tokens) || 0;
    payload.max_tokens = configuredMax > 0
      ? Math.min(configuredMax, 500)
      : 500;

    const started = Date.now();
    const candidateCount = targetMessage
      ? Math.min(Math.max(Number(requestBody.candidates) || 1, 1), 3)
      : 1;
    const candidates = [];
    const baseTemperature = Number(modelRow.temperature ?? 0.8);

    const pushCandidate = (parsed, meta) => {
      const variantResult = db.prepare(`
        INSERT INTO message_variants
          (message_id, content, narration, meta_json, sticker_id)
        VALUES (?, ?, ?, ?, NULL)
      `).run(
        targetMessage.id,
        parsed.dialogue,
        parsed.narration,
        JSON.stringify(meta)
      );

      candidates.push({
        variant_id: Number(variantResult.lastInsertRowid),
        content: parsed.dialogue,
        narration: parsed.narration
      });
    };

    const makeMeta = (data, elapsed) => ({
      provider: modelRow.name,
      model: modelRow.model,
      usage: data && data.usage ? data.usage : null,
      latency_ms: elapsed,
      context_messages: history.length,
      worldbook_hits: worldbook.count
    });

    try {
      // 省 token：重新生成 3 条候选时先一次请求要 n 份。
      // 同一段历史发 3 遍很贵，能一次拿回来就省掉两次重复输入。
      if (candidateCount > 1) {
        const multiStarted = Date.now();
        let fallbackReason = '';
        let multiChoices = [];
        let multiData = null;

        try {
          const multiPayload = {
            ...payload,
            // n 路径只用基础温度，不跟逐次生成那套加温错开
            temperature: baseTemperature,
            n: candidateCount
          };

          // 很多兼容站不认 n，会直接 400；requestChat 会包成 502 抛出来，这里接住退回
          const result = await requestChat(modelRow, multiPayload, {
            timeoutMs: 60000,
            usageSource: 'regenerate',
            character
          });

          multiData = result.data;

          const choices = Array.isArray(multiData && multiData.choices)
            ? multiData.choices
            : [];

          multiChoices = choices
            .map((choice) => parseChatReply(
              extractContent((choice && choice.message) || {}, choice || {}).trim()
            ))
            .filter((parsed) => parsed.dialogue || parsed.narration);

          if (multiChoices.length < candidateCount) {
            fallbackReason =
              '上游只回了 ' + multiChoices.length + '/' + candidateCount + ' 份';
          }
        } catch (error) {
          fallbackReason = (error && (error.message || error.name)) || '请求失败';
        }

        if (!fallbackReason) {
          const meta = makeMeta(multiData, Date.now() - multiStarted);

          for (const parsed of multiChoices) {
            pushCandidate(parsed, meta);
          }

          return res.json({ ok: true, candidates });
        }

        console.log('[省token] 上游不支持 n，退回逐次生成：' + fallbackReason);
      }

      for (let attempt = 0; attempt < candidateCount; attempt += 1) {
        // 一次生成多份时把温度错开，免得三份一模一样
        payload.temperature = candidateCount > 1
          ? Math.min(1.3, baseTemperature + attempt * 0.2)
          : baseTemperature;

        const attemptStarted = Date.now();

        // requestChat 里已处理：推理模型把额度花在思考上、正文为空时自动重试；
        // 返回非 2xx 会抛出带 status=502 的错误，直接交给外层 catch。
        const { data, content: rawReply } = await requestChat(modelRow, payload, {
          timeoutMs: 60000,
          usageSource: candidateCount > 1 ? 'regenerate' : 'chat',
          character
        });

        let parsedReply = parseChatReply(rawReply);

        // 提示词里写死了要旁白，模型还是经常偷懒只回台词。
        // 这种时候补问一次，明确点名要动作/神态，比改提示词管用。
        if (!parsedReply.narration && candidateCount === 1 && leanMode !== '1') {
          try {
            const nudgePayload = {
              ...payload,
              messages: messages.concat([
                { role: 'assistant', content: rawReply },
                {
                  role: 'system',
                  content: '这一条少了【旁白】。请重写这条回复，必须带【旁白】：' +
                    '写角色此刻的动作、神态或周围的环境，一句话。格式：' +
                    '【旁白】…（换行）【对白】…'
                }
              ])
            };

            const nudgeController = new AbortController();
            const nudgeTimer = setTimeout(() => nudgeController.abort(), 60000);
            let nudgeText = '';

            try {
              const nudgeResponse = await fetch(buildChatUrl(modelRow.base_url), {
                method: 'POST',
                headers,
                body: JSON.stringify(nudgePayload),
                signal: nudgeController.signal
              });

              nudgeText = await nudgeResponse.text();
            } finally {
              clearTimeout(nudgeTimer);
            }

            const nudgeData = JSON.parse(nudgeText);

            recordUsage(payload, nudgeData, { usageSource: 'chat', character });

            const nudgeRaw = String(
              nudgeData && nudgeData.choices && nudgeData.choices[0] &&
              nudgeData.choices[0].message && nudgeData.choices[0].message.content || ''
            ).trim();
            const nudgeParsed = parseChatReply(nudgeRaw);

            if (nudgeParsed.narration && nudgeParsed.dialogue) {
              parsedReply = nudgeParsed;
            } else if (nudgeParsed.narration && !parsedReply.dialogue) {
              parsedReply = nudgeParsed;
            }
          } catch (e) {
            // 补问失败就用原来那条，不影响这次回复
          }
        }

        if (!parsedReply.narration && candidateCount === 1 && leanMode === '1') {
          console.log('[省token] 省 token 模式：这条缺旁白，跳过补问请求');
        }

        const dialogue = parsedReply.dialogue;
        const narration = parsedReply.narration;

        if (!dialogue && !narration) {
          const badError = new Error('模型没有返回有效内容');
          badError.status = 502;
          throw badError;
        }

        const meta = {
          provider: modelRow.name,
          model: modelRow.model,
          usage: data && data.usage ? data.usage : null,
          latency_ms: Date.now() - attemptStarted,
          context_messages: history.length,
          worldbook_hits: worldbook.count
        };

        // 预览模式（一次要 2~3 份）：先存成历史版本，不动当前正文
        if (candidateCount > 1) {
          pushCandidate({ dialogue, narration }, meta);
          continue;
        }

      if (targetMessage) {
        db.prepare(`
          INSERT INTO message_variants
            (message_id, content, narration, meta_json, sticker_id)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          targetMessage.id,
          targetMessage.content || '',
          targetMessage.narration || '',
          targetMessage.meta_json || '',
          targetMessage.sticker_id || null
        );

        db.prepare(`
          UPDATE messages
          SET content = ?, narration = ?, meta_json = ?, sticker_id = NULL
          WHERE id = ?
        `).run(
          dialogue,
          narration,
          JSON.stringify(meta),
          targetMessage.id
        );

        const last = db.prepare(`
          SELECT id FROM messages
          WHERE character_id = ?
          ORDER BY id DESC
          LIMIT 1
        `).get(req.params.id);

        if (last && Number(last.id) === Number(targetMessage.id)) {
          db.prepare(`
            UPDATE characters
            SET last_message_at = CURRENT_TIMESTAMP,
                last_message_preview = ?
            WHERE id = ?
          `).run(
            (dialogue || narration).replace(/\s+/g, ' ').slice(0, 80),
            req.params.id
          );
        }

        const message = db.prepare('SELECT * FROM messages WHERE id = ?')
          .get(targetMessage.id);

        return res.json({ ok: true, message, regenerated: true });
      }

      const result = db.prepare(`
        INSERT INTO messages (character_id, role, content, narration, meta_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        req.params.id,
        'character',
        dialogue,
        narration,
        JSON.stringify(meta)
      );

      db.prepare(`
        UPDATE characters
        SET last_message_at = CURRENT_TIMESTAMP,
            last_message_preview = ?
        WHERE id = ?
      `).run((dialogue || narration).replace(/\s+/g, ' ').slice(0, 80), req.params.id);

      const message = db.prepare('SELECT * FROM messages WHERE id = ?')
        .get(Number(result.lastInsertRowid));

        return res.json({ ok: true, message, image_note: imageNote });
      }

      return res.json({ ok: true, candidates });
    } catch (error) {
      res.status(error.status || 500).json({
        error: error.name === 'AbortError' ? '模型请求超时' : error.message
      });
    }
  });

  // 把模型给的回复建议解析成字符串数组：优先 JSON 数组，退化成按行切
  function parseSuggestions(content, limit) {
    const raw = String(content || '').trim();
    const picked = [];

    const push = (value) => {
      let text = String(value == null ? '' : value)
        .replace(/^[\s\-*•·[\]()]+/, '')
        .replace(/^\d+[.、)]\s*/, '')
        .replace(/^["“”'‘’]+/, '')
        .replace(/["“”'‘’\s]+$/, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!text) return;
      if (text.length > 240) text = text.slice(0, 240);

      if (!picked.includes(text)) picked.push(text);
    };

    let parsed = parseJsonLoose(raw);

    // 模型有时会先来一句「这是几条建议：」，parseJsonLoose 只认对象，这里再按数组捞一次
    if (!parsed) {
      const start = raw.indexOf('[');
      const end = raw.lastIndexOf(']');

      if (start >= 0 && end > start) {
        try {
          parsed = JSON.parse(raw.slice(start, end + 1));
        } catch (e) {}
      }
    }

    if (Array.isArray(parsed)) {
      parsed.forEach(push);
    } else if (parsed && typeof parsed === 'object') {
      const list = parsed.suggestions || parsed.replies || parsed.items || parsed.list;

      if (Array.isArray(list)) list.forEach(push);
      else if (typeof parsed.text === 'string') push(parsed.text);
    }

    if (!picked.length) {
      // 不是标准 JSON 就按行切，顺便跳过模型爱加的开场白
      for (const line of stripCodeFence(raw).split(/\n+/)) {
        const text = line.trim();

        if (!text) continue;
        if (/^(好的|当然|没问题|以下是|下面是|建议)[，,：:]?$/.test(text)) continue;

        push(text);
      }
    }

    return picked.slice(0, limit);
  }

  // 聊天「帮我想几句」：按当前剧情/角色设定，替用户想几条可以直接发出去的话
  app.post('/api/characters/:id/suggest-replies', async (req, res) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?')
      .get(req.params.id);

    if (!character) {
      return res.status(404).json({ error: '角色不存在' });
    }

    const modelRow = db.prepare(`
      SELECT * FROM model_profiles
      WHERE is_image = 0
      ORDER BY is_default DESC, id DESC
      LIMIT 1
    `).get();

    if (!modelRow) {
      return res.status(400).json({
        error: '还没有配置文本模型，先去「模型 API」里加一个'
      });
    }

    const recent = db.prepare(`
      SELECT role, content, narration FROM messages
      WHERE character_id = ?
      ORDER BY id DESC
      LIMIT 12
    `).all(req.params.id).reverse();

    if (!recent.length) {
      return res.status(400).json({
        error: '还没有聊天记录，先随便说一句再来'
      });
    }

    const body = req.body || {};
    const count = Math.min(Math.max(Number(body.count) || 3, 1), 5);

    let userPersona = null;

    if (Number(character.user_persona_id || 0) > 0) {
      userPersona = db.prepare('SELECT * FROM user_personas WHERE id = ?')
        .get(character.user_persona_id);
    }

    if (!userPersona) {
      userPersona = db.prepare(`
        SELECT * FROM user_personas
        WHERE is_default = 1
        ORDER BY id ASC
        LIMIT 1
      `).get();
    }

    const transcript = recent.map((row) => {
      const who = row.role === 'user' ? '我' : character.name;
      const text = String(row.content || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const narration = String(row.narration || '').replace(/\s+/g, ' ').trim().slice(0, 200);

      // 纯图片/纯旁白的气泡 content 可能是空的，别把它拼成「我：」
      if (!text) return narration ? '（旁白）' + narration : '';

      const line = who + '：' + text;

      return narration ? line + '（旁白：' + narration + '）' : line;
    }).filter(Boolean).join('\n');

    const characterCard = [
      '角色名：' + character.name,
      character.personality ? '性格：' + character.personality : '',
      character.speaking_style ? '说话风格：' + character.speaking_style : '',
      character.persona ? '人设：' + character.persona.slice(0, 600) : ''
    ].filter(Boolean).join('\n');

    const personaLine = userPersona
      ? '我（用户）的人设：' + userPersona.name +
        (userPersona.bio ? '，' + userPersona.bio : '') +
        (userPersona.persona ? '\n' + userPersona.persona.slice(0, 400) : '')
      : '';

    const messages = [
      {
        role: 'system',
        content: [
          '你在帮用户想接下来可以发出去的消息。',
          '用户正在和「' + character.name + '」聊天，你要站在用户自己的角度，写几条用户真的会发出去的话。',
          '要求：',
          '1. 每条 1~2 句，口语化，像微信聊天，不要书面语；',
          '2. 各条的切入角度要不一样（比如一条顺着聊、一条好奇追问、一条带点玩笑或小情绪）；',
          '3. 只写用户会说的话，不要写角色会说的话，不要加旁白、动作描写、引号或编号；',
          '4. 只输出 JSON 字符串数组，例如 ["……","……","……"]，不要输出任何解释。'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          characterCard,
          personaLine,
          '最近对话：\n' + transcript,
          '请给 ' + count + ' 条建议。'
        ].filter(Boolean).join('\n\n')
      }
    ];

    const payload = {
      model: modelRow.model,
      messages,
      temperature: Math.min(1.2, Math.max(0.7, Number(modelRow.temperature ?? 0.85))),
      max_tokens: Math.min(Math.max(Number(modelRow.max_tokens) || 700, 400), 900)
    };

    try {
      const { content } = await requestChat(modelRow, payload, {
        timeoutMs: 30000,
        usageSource: 'suggest',
        character
      });
      const suggestions = parseSuggestions(content, count);

      if (!suggestions.length) {
        return res.status(502).json({ error: '模型没写出建议，再试一次' });
      }

      res.json({ suggestions });
    } catch (error) {
      // requestChat 已经把超时包成 504、上游/网络错误包成 502，这里原样透出，不吞成 500。
      // 模型「只思考不写正文 / 返回空」这类没有状态码的，按契约统一成「没写出建议」。
      if (!error.status) {
        console.error('[建议回复] 出错了：', error);

        return res.status(502).json({ error: '模型没写出建议，再试一次' });
      }

      res.status(Number(error.status)).json({
        error: error.message || '生成建议失败，再试一次'
      });
    }
  });
};
