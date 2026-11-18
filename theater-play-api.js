const { getActiveWorldId } = require('./worlds');
const { getWorldbookContext } = require('./worldbook');
const { getCalendarContext } = require('./calendar-context');
const { callModel, requestChat } = require('./llm');

module.exports = function (app, db) {
  function cleanText(value) {
    return String(value ?? '').trim();
  }

  // 模型有时会把推理/创作说明写进正文，例如：
  // （注意：这里出现的人是砂金。接下来可以给用户选项去反应。）
  // 这些不是剧情，必须清掉。
  function stripMetaNotes(text) {
    const metaWord = /(注意|提示|备注|说明|PS|P\.S)/;
    const lines = String(text || '').split(/\n+/);

    const kept = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^[（(【\[]/.test(trimmed) && /[）)】\]]$/.test(trimmed)) {
        if (metaWord.test(trimmed)) return false;
      }
      return true;
    });

    return kept.join('\n')
      .replace(/[（(][^（）()]{0,60}?(注意|提示|备注|说明)[^（）()]{0,60}?[）)]/g, '')
      // 去掉混进正文的格式标记
      .replace(/^\s*(【\s*(?:旁白|对白)\s*】\s*[:：]?\s*)+/, '')
      .replace(/^【\s*(?:旁白|对白|选项)\s*】\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
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

  function parseOptionLines(text) {
    return String(text || '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => /^[A-DＡ-Ｄ][.、:：\)]\s*/.test(line))
      .map((line) => line.replace(/^[A-DＡ-Ｄ][.、:：\)]\s*/, '').trim())
      .filter(Boolean);
  }

  function parseTheaterJson(text) {
    const raw = String(text || '').trim();
    const fallbackOptions = ['继续观察', '开口询问', '暂时离开', '做点别的'];

    // 1. 先尝试 JSON
    let jsonText = raw;
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) jsonText = fence[1].trim();

    const first = jsonText.indexOf('{');
    const last = jsonText.lastIndexOf('}');

    if (first >= 0 && last > first) {
      try {
        const data = JSON.parse(jsonText.slice(first, last + 1));
        const narration = cleanText(data.narration || data.text || '');
        const options = Array.isArray(data.options)
          ? data.options.map((item) => cleanText(item)).filter(Boolean).slice(0, 6)
          : [];

        if (narration || options.length) {
          return {
            narration: stripMetaNotes(narration || raw),
            options
          };
        }
      } catch (e) {}
    }

    // 2. 再尝试【旁白】/【选项】格式
    let narration = raw;
    let optionBlock = '';

    const narrationMatch = raw.match(/【旁白】\s*([\s\S]*?)(?=【选项】|$)/);
    const optionsMatch = raw.match(/【选项】\s*([\s\S]*)/);

    if (narrationMatch) narration = narrationMatch[1].trim();
    if (optionsMatch) optionBlock = optionsMatch[1];

    let options = parseOptionLines(optionBlock);

    // 3. 最后尝试从全文里找 A/B/C/D 行
    if (!options.length) {
      options = parseOptionLines(raw);
    }

    if (options.length) {
      return {
        narration: stripMetaNotes(narration || raw),
        options: options.slice(0, 6)
      };
    }

    // 走到这里说明既不是 JSON 也解析不出选项。
    // 如果原文看着就是一段没合上的 JSON，宁可报错重试，
    // 也不能把 `{"narration": ...` 这种半截东西写进剧情。
    if (raw.trim().startsWith('{') || raw.includes('"narration"')) {
      throw new Error('模型返回的 JSON 不完整，请重试');
    }

    return {
      narration: stripMetaNotes(raw),
      options: []
    };
  }


  // ---------- 剧场插画 ----------

  // 生图请求是回去打自己进程里的 /api/generate-image，
  // 端口必须和 server.js 的 listening 端口一致。
  function localPort() {
    return Number(process.env.PORT) || 8787;
  }

  function imageModelRow(id) {
    if (id) {
      return db.prepare('SELECT * FROM model_profiles WHERE id = ?').get(id);
    }

    return db.prepare(`
      SELECT * FROM model_profiles
      WHERE is_image = 1
      ORDER BY is_default DESC, id DESC
      LIMIT 1
    `).get();
  }

  // 写画面描述要的是文本模型，别挑到生图模型头上
  function textModelRow() {
    return db.prepare(`
      SELECT * FROM model_profiles
      WHERE is_image = 0
      ORDER BY is_default DESC, id DESC
      LIMIT 1
    `).get();
  }

  // 模型经常把解释、引号、前缀一起吐出来，这里只留干净的一行画面描述
  function cleanImagePrompt(text) {
    const raw = String(text || '').trim();

    const withoutFence = raw.replace(/```[a-zA-Z]*/g, '').replace(/```/g, '');

    const firstLine = withoutFence
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)[0] || '';

    return firstLine
      .replace(/^(画面描述|插画描述|场景描述|画面|描述)\s*[:：]\s*/, '')
      .replace(/^[「『"'【\s]+/, '')
      .replace(/[」』"'】\s]+$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
  }

  // 只取剧情消息，选项那行不是剧情
  function recentSceneRows(sessionId, limit) {
    return db.prepare(`
      SELECT role, content, image_url
      FROM theater_messages
      WHERE session_id = ? AND role <> 'options'
      ORDER BY id DESC
      LIMIT ?
    `).all(sessionId, Number(limit) || 10).reverse();
  }

  // 兜底：模型怎么都写不出描述时，直接拿最近几段剧情的文字拼一段当描述。
  // 剧情本身就是画面描写，够模型画一张了，总比直接报错让她画不成强。
  function fallbackImagePrompt(session) {
    const rows = recentSceneRows(session.id, 8);

    const parts = rows.map((row) => {
      if (row.role === 'dice') return '';
      if (row.role === 'narrator') return '';
      return String(row.content || '')
        .replace(/\s+/g, ' ')
        .replace(/[「」“”"]/g, '')
        .trim();
    }).filter((line) => line.length >= 8);

    if (!parts.length) return '';

    const text = parts.slice(-3).join('；');
    return text.slice(0, 300);
  }

  // 让文本模型根据最近剧情写一句画面描述（不是台词，是画面）
  async function writeImagePrompt(session, script, history) {
    const rows = Array.isArray(history) && history.length
      ? history
      : recentSceneRows(session.id, 10);

    if (!rows.length) {
      throw new Error('这一章还没有剧情内容，先让故事跑几轮再画');
    }

    const modelRow = textModelRow();

    if (!modelRow) {
      throw new Error('还没有配置文本模型，没法自动写画面描述；你可以自己写一句再生成');
    }

    const roleLabel = {
      narration: '旁白',
      user: '用户行动',
      character: '角色',
      narrator: '已有的插画',
      dice: '投掷结果'
    };

    const sceneText = rows.map((row) => {
      const label = roleLabel[row.role] || '剧情';
      const content = String(row.content || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400);
      return '【' + label + '】' + content;
    }).filter((line) => line.replace(/^【[^】]*】/, '').trim()).join('\n');

    const system = [
      '你是一个插画师，负责给互动小说画插画。',
      '根据下面的最近剧情，写一段可以直接交给文生图模型的画面描述。',
      '要求：',
      '1. 只写这一帧看得见的东西：环境、光线、时间、人物姿态与表情、衣饰、前景和背景。',
      '2. 不要写对白，不要抄任何台词原文，不要写"他说/她说"，不要总结剧情，不要写"接下来"。',
      '3. 不要出现引号、编号、括号备注、创作说明。',
      '4. 用第三人称描述，不要用"你"。',
      '5. 只输出一行中文，60 到 120 字。'
    ].join('\n');

    const user = [
      '剧本：' + script.title,
      script.premise ? '背景：' + String(script.premise).slice(0, 400) : '',
      '',
      '最近剧情（旧→新）：',
      sceneText
    ].filter(Boolean).join('\n');

    const result = await callModel({
      modelRow,
      system,
      user,
      temperature: 0.9,
      maxTokens: 800,
      timeoutMs: 60000
    });

    const prompt = cleanImagePrompt(result.content);

    if (!prompt) {
      throw new Error('模型没写出画面描述，稍后再试，或者自己写一句');
    }

    return prompt;
  }

  // 有的家出错时回一坨 JSON，捞一句人话出来
  function imageErrorMessage(raw) {
    const text = cleanText(raw);

    if (!text) return '生图失败：服务商没有返回原因';

    const quoted = text.match(/"error"\s*:\s*"([^"]{1,200})"/i);
    if (quoted) return '生图失败：服务商返回 ' + quoted[1];

    return text.slice(0, 300);
  }

  // 服务端内部调 /api/generate-image：复用它的模型选择、参考图和 base64 落盘逻辑。
  // 这是打自己进程的 HTTP 请求，会再过一遍登录守卫，所以要把当前用户的 cookie 带上，
  // 不然内部请求拿到的是 401「未登录」。
  async function requestTheaterImage(payload, cookie) {
    const url = 'http://127.0.0.1:' + localPort() + '/api/generate-image';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240000);

    const headers = { 'Content-Type': 'application/json' };

    if (cookie) headers.Cookie = cookie;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const text = await response.text();

      let data = null;
      try {
        data = JSON.parse(text);
      } catch (e) {}

      return {
        ok: response.ok,
        status: response.status,
        data: data || {},
        text
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('生图超时，稍后再试');
      }
      throw new Error('调不到生图服务：' + (error.message || '未知错误'));
    } finally {
      clearTimeout(timer);
    }
  }

  async function generateTheaterOptions(modelRow, script, session, narration, history) {
    const fallback = ['继续观察', '开口询问', '暂时离开', '做点别的'];

    const worldId = Number(script.world_id || getActiveWorldId());
    const worldbook = getWorldbookContext(worldId, narration + '\n' + script.title);
    const calendar = getCalendarContext(worldId);

    const prompt = [
      '你是一个互动小说 / 跑团 GM。',
      '根据下面的剧情，生成 4 个用户下一步可以采取的行动选项。',
      '只输出 4 行，格式严格为：',
      'A. 选项一',
      'B. 选项二',
      'C. 选项三',
      'D. 选项四',
      '不要输出旁白，不要解释，不要 JSON，不要写任何括号备注。',
      '',
      '剧本：' + script.title,
      String(session.identity_role || '') === '上帝视角'
        ? '视角：上帝视角，用户不扮演角色，只是旁观并替主角选下一步；选项要写成第三人称主角能做的事。'
        : '用户身份：' + session.identity_name + '，' + session.identity_role,
      worldbook.text ? '【世界书】\n' + worldbook.text : '',
      calendar || '',
      '',
      '最近剧情：',
      narration
    ].filter(Boolean).join('\n');

    // 推理模型有时会把 token 全花在推理上，或者格式跑偏，
    // 所以最多试 2 次，两次都失败才用兜底选项。
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await callModel({
          modelRow,
          system: prompt,
          user: '请生成 4 个下一步选项。',
          temperature: 0.9,
          maxTokens: 1200,
          timeoutMs: 60000
        });

        const options = parseOptionLines(result.content)
          .map((item) => stripMetaNotes(item.replace(/[（(][^）)]*[）)]/g, '')).trim())
          .filter(Boolean);

        if (options.length) {
          return options.slice(0, 4);
        }

        console.error('[剧场] 选项解析失败，原始内容：' + result.content.slice(0, 400));
      } catch (error) {
        console.error('[剧场] 生成选项失败（第 ' + (attempt + 1) + ' 次）：' + error.message);
      }
    }

    return fallback;
  }

  app.post('/api/theater/sessions/:id/options/refresh', async (req, res) => {
    const session = db.prepare('SELECT * FROM theater_sessions WHERE id = ?')
      .get(req.params.id);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    const script = db.prepare('SELECT * FROM theater_scripts WHERE id = ?')
      .get(session.script_id);

    if (!script) {
      return res.status(404).json({ error: '剧本不存在' });
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

    const lastNarration = db.prepare(`
      SELECT * FROM theater_messages
      WHERE session_id = ? AND role = 'narration'
      ORDER BY id DESC
      LIMIT 1
    `).get(session.id);

    if (!lastNarration) {
      return res.status(400).json({ error: '还没有旁白可以生成选项' });
    }

    const history = db.prepare(`
      SELECT role, content, image_url FROM theater_messages
      WHERE session_id = ? AND id < ?
      ORDER BY id DESC
      LIMIT 20
    `).all(session.id, lastNarration.id).reverse();

    const options = await generateTheaterOptions(
      modelRow,
      script,
      session,
      lastNarration.content,
      history
    );

    const lastOptions = db.prepare(`
      SELECT * FROM theater_messages
      WHERE session_id = ? AND role = 'options'
      ORDER BY id DESC
      LIMIT 1
    `).get(session.id);

    if (lastOptions) {
      db.prepare(`
        UPDATE theater_messages
        SET meta_json = ?
        WHERE id = ?
      `).run(
        JSON.stringify({ options }),
        lastOptions.id
      );

      const updated = db.prepare('SELECT * FROM theater_messages WHERE id = ?')
        .get(lastOptions.id);

      return res.json({ ok: true, options, message: updated });
    }

    const result = db.prepare(`
      INSERT INTO theater_messages
        (session_id, role, content, meta_json)
      VALUES (?, 'options', '下一步', ?)
    `).run(
      session.id,
      JSON.stringify({ options })
    );

    const message = db.prepare('SELECT * FROM theater_messages WHERE id = ?')
      .get(Number(result.lastInsertRowid));

    res.json({ ok: true, options, message });
  });

  // 重选：把最后一段旁白和最后一批选项删掉，然后重新生成
  app.post('/api/theater/sessions/:id/undo', (req, res) => {
    const session = db.prepare('SELECT * FROM theater_sessions WHERE id = ?')
      .get(req.params.id);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    const lastOptions = db.prepare(`
      SELECT id FROM theater_messages
      WHERE session_id = ? AND role = 'options'
      ORDER BY id DESC LIMIT 1
    `).get(session.id);

    const lastNarration = db.prepare(`
      SELECT id FROM theater_messages
      WHERE session_id = ? AND role = 'narration'
      ORDER BY id DESC LIMIT 1
    `).get(session.id);

    let removed = 0;

    if (lastOptions) {
      db.prepare('DELETE FROM theater_messages WHERE id = ?').run(lastOptions.id);
      removed += 1;
    }

    if (lastNarration) {
      db.prepare('DELETE FROM theater_messages WHERE id = ?').run(lastNarration.id);
      removed += 1;
    }

    res.json({ ok: true, removed });
  });

  app.post('/api/theater/sessions/:id/next', async (req, res) => {
    const session = db.prepare('SELECT * FROM theater_sessions WHERE id = ?')
      .get(req.params.id);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    const script = db.prepare('SELECT * FROM theater_scripts WHERE id = ?')
      .get(session.script_id);

    if (!script) {
      return res.status(404).json({ error: '剧本不存在' });
    }

    const body = req.body || {};
    const action = cleanText(body.action);
    const direction = cleanText(body.direction);

    // 先确认模型可用，再写用户的行动，
    // 否则没配模型时会把这句话白白留在剧情里
    const modelRow = db.prepare(`
      SELECT * FROM model_profiles
      WHERE is_image = 0
      ORDER BY is_default DESC, id DESC
      LIMIT 1
    `).get();

    if (!modelRow) {
      return res.status(400).json({ error: '还没有配置模型 API' });
    }

    if (action) {
      db.prepare(`
        INSERT INTO theater_messages (session_id, role, content)
        VALUES (?, 'user', ?)
      `).run(session.id, action);
    }

    const castIds = safeJsonParse(script.cast_ids, []);
    const cast = castIds
      .map((id) => db.prepare(`
        SELECT id, name, handle, personality, background,
               speaking_style, persona
        FROM characters
        WHERE id = ?
      `).get(id))
      .filter(Boolean);

    const castText = cast.map((item) => {
      const parts = [
        `角色名：${item.name}`,
        item.handle ? `用户名：${item.handle}` : '',
        item.personality ? `性格：${item.personality}` : '',
        item.background ? `背景：${item.background}` : '',
        item.speaking_style ? `说话方式：${item.speaking_style}` : '',
        item.persona ? `完整人设：${item.persona}` : ''
      ].filter(Boolean);
      return parts.join('\n');
    }).join('\n\n');

    const corrections = db.prepare(`
      SELECT content FROM theater_corrections
      WHERE session_id = ? AND active = 1
      ORDER BY id DESC
      LIMIT 5
    `).all(session.id);

    const correctionText = corrections.length
      ? corrections.map((item, index) => `${index + 1}. ${item.content}`).join('\n')
      : '无';

    const history = db.prepare(`
      SELECT role, content, image_url FROM theater_messages
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT 40
    `).all(session.id).reverse();

    const worldbook = getWorldbookContext(
      Number(script.world_id || getActiveWorldId()),
      history.map((row) => row.content).join('\n') + '\n' + action
    );

    const calendar = getCalendarContext(
      Number(script.world_id || getActiveWorldId())
    );

    const godMode = String(session.identity_role || '') === '上帝视角';

    const identityBlock = godMode
      ? '视角：上帝视角。用户不扮演任何角色，只是旁观故事，并在关键处替主角选择下一步。'
      : [
          `用户身份：${session.identity_name}，${session.identity_role}`,
          session.identity_desc ? `身份描述：${session.identity_desc}` : ''
        ].filter(Boolean).join('\n');

    const writingRules = godMode
      ? [
          '1. 用第三人称写，像小说旁白；不要用"你"来称呼读者。',
          '2. 旁白要具体、有画面感，不要总结式概括。',
          '3. 角色对白要符合角色人设。',
          '4. 可以自由描写所有角色；选项写成第三人称主角能做的事。',
          '5. 不要在正文里写任何括号注释、创作说明、推理过程，也不要写"接下来可以…"这类提示；只写故事本身。',
          '6. 严格按下面格式输出，不要输出 Markdown 代码块。'
        ]
      : [
          '1. 用第二人称"你"描述用户。',
          '2. 旁白要具体、有画面感，不要总结式概括。',
          '3. 角色对白要符合角色人设。',
          '4. 不要替用户做决定，不要替用户说台词。',
          '5. 不要在正文里写任何括号注释、创作说明、推理过程，也不要写"接下来可以…"这类提示；只写故事本身。',
          '6. 严格按下面格式输出，不要输出 Markdown 代码块。'
        ];

    const systemPrompt = [
      '你是一个互动小说 / 跑团 GM。',
      '你需要根据剧本、角色、用户身份、历史剧情和修正规则，续写一段旁白，并给出 4 个下一步选项。',
      '',
      `剧本标题：${script.title}`,
      script.subtitle ? `副标题：${script.subtitle}` : '',
      script.premise ? `背景：${script.premise}` : '',
      script.rules ? `世界规则：${script.rules}` : '',
      '',
      identityBlock,
      '',
      `参演角色：\n${castText || '无'}`,
      '',
      `持续修正规则：\n${correctionText}`,
      worldbook.text ? `【世界书】\n${worldbook.text}` : '',
      calendar ? calendar : '',
      '',
      direction ? `用户希望的剧情走向（参考用，不要直接照抄，也不要说破）：\n${direction}` : '',
      '',
      '写作要求：',
      ...writingRules,
      '【旁白】',
      '本段剧情',
      '【选项】',
      'A. 选项一',
      'B. 选项二',
      'C. 选项三',
      'D. 选项四'
    ].filter(Boolean).join('\n');

    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    history.forEach((row) => {
      if (row.role === 'user') {
        messages.push({ role: 'user', content: row.content });
      } else if (row.role === 'narration' || row.role === 'character') {
        // 历史里的旁白补回【旁白】标记，让模型照着格式学，
        // 不然它会以为上一轮就是纯散文，自己也只写散文、不给选项。
        messages.push({
          role: 'assistant',
          content: '【旁白】\n' + row.content
        });
      } else if (row.role === 'dice') {
        messages.push({ role: 'system', content: '[投掷结果] ' + row.content });
      } else if (row.role === 'narrator') {
        // 之前生成的插画只作为画面参考，不进正文
        messages.push({
          role: 'system',
          content: '[本段插画] ' + String(row.content || '').slice(0, 200)
        });
      }
    });

    // 结尾再提醒一次格式，模型对最后一条指令更敏感
    messages.push({
      role: 'system',
      content: '格式提醒：本次回复必须包含【旁白】和【选项】两部分，【选项】下面必须有 A/B/C/D 四行，不能省略标记。'
    });

    const payload = {
      model: modelRow.model,
      messages,
      temperature: Number(modelRow.temperature ?? 0.8)
    };

    payload.max_tokens = Math.max(Number(modelRow.max_tokens) || 0, 3000);

    const started = Date.now();

    try {
      // 推理模型会把额度花在思考上、正文为空，requestChat 里会自动翻额度重试
      const { content: rawReply, data } = await requestChat(modelRow, payload, {
        timeoutMs: 90000
      });

      const parsed = parseTheaterJson(rawReply);

      let finalOptions = Array.isArray(parsed.options)
        ? parsed.options
        : [];

      if (!finalOptions.length) {
        finalOptions = await generateTheaterOptions(
          modelRow,
          script,
          session,
          parsed.narration,
          history
        );
      }

      // 原始回复只留在日志里，不写进数据库（每一轮 4KB，攒起来很占地方）
      const meta = {
        provider: modelRow.name,
        model: modelRow.model,
        usage: data.usage || null,
        latency_ms: Date.now() - started,
        context_messages: history.length,
        world_id: Number(script.world_id || getActiveWorldId()),
        worldbook_hits: worldbook.count
      };

      // 旁白 + 选项 + 更新时间必须一起成功，
      // 不然中途被打断就会留下「有旁白没选项」的半截回合
      const writeTurn = db.prepare(`
        INSERT INTO theater_messages
          (session_id, role, content, meta_json)
        VALUES (?, 'narration', ?, ?)
      `);

      const writeOptions = db.prepare(`
        INSERT INTO theater_messages
          (session_id, role, content, meta_json)
        VALUES (?, 'options', '下一步', ?)
      `);

      const touchSession = db.prepare(`
        UPDATE theater_sessions
        SET updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);

      let narrationResult = null;
      let optionsResult = null;

      db.exec('BEGIN');

      try {
        narrationResult = writeTurn.run(
          session.id,
          parsed.narration,
          JSON.stringify(meta)
        );

        optionsResult = writeOptions.run(
          session.id,
          JSON.stringify({ options: finalOptions })
        );

        touchSession.run(session.id);
        db.exec('COMMIT');
      } catch (writeError) {
        db.exec('ROLLBACK');
        throw writeError;
      }

      res.json({
        ok: true,
        narration: db.prepare('SELECT * FROM theater_messages WHERE id = ?')
          .get(Number(narrationResult.lastInsertRowid)),
        options: db.prepare('SELECT * FROM theater_messages WHERE id = ?')
          .get(Number(optionsResult.lastInsertRowid))
      });
    } catch (error) {
      // requestChat 已经把人话写进 message 了，这里原样带出去
      res.status(error.status || 500).json({
        error: error.name === 'AbortError' ? '剧场生成超时' : error.message
      });
    }
  });
  // 给当前这一幕生成一张插画，作为一条带图消息进对话流
  app.post('/api/theater/sessions/:id/image', async (req, res) => {
    const session = db.prepare('SELECT * FROM theater_sessions WHERE id = ?')
      .get(req.params.id);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    const script = db.prepare('SELECT * FROM theater_scripts WHERE id = ?')
      .get(session.script_id);

    if (!script) {
      return res.status(404).json({ error: '剧本不存在' });
    }

    const body = req.body || {};

    const modelRow = imageModelRow(Number(body.model_id || 0));

    if (!modelRow) {
      return res.status(400).json({
        error: '还没有设置生图模型。去「模型设置」里选一个支持生图的模型。'
      });
    }

    const requestedSize = cleanText(body.size);
    const size = /^\d{3,5}x\d{3,5}$/.test(requestedSize)
      ? requestedSize
      : '1024x1024';

    let prompt = cleanText(body.prompt).slice(0, 400);
    let autoPrompted = false;

    // 不写描述就让模型按最近剧情自己写一句画面
    if (!prompt) {
      if (!recentSceneRows(session.id, 10).length) {
        return res.status(400).json({
          error: '这一章还没有剧情内容，先让故事跑几轮再画'
        });
      }

      if (!textModelRow()) {
        return res.status(400).json({
          error: '还没有配置文本模型，没法自动写画面描述；你可以自己写一句再生成'
        });
      }

      try {
        prompt = await writeImagePrompt(session, script);
        autoPrompted = true;
      } catch (error) {
        console.error('[剧场生图] 自动写描述失败，改用剧情原文兜底：' + (error && error.message));

        const fallback = fallbackImagePrompt(session);

        if (!fallback) {
          return res.status(error.status || 502).json({
            error: '自动写画面描述失败：' + error.message + '；你也可以自己写一句描述再生成'
          });
        }

        prompt = fallback;
        autoPrompted = true;
      }
    }

    // 参考图默认给剧本里的第一个角色，也可以显式传 character_id
    let characterId = Number(body.character_id || 0);

    if (!characterId) {
      const castIds = safeJsonParse(script.cast_ids, []);
      characterId = Number(castIds[0] || 0);
    }

    let result = null;

    try {
      result = await requestTheaterImage({
        prompt,
        size,
        character_id: characterId || undefined,
        model_id: Number(body.model_id || 0) || undefined
      }, req.headers.cookie);
    } catch (error) {
      return res.status(502).json({ error: error.message });
    }

    if (!result.ok) {
      const rawMessage = cleanText(result.data && result.data.error) ||
        cleanText(result.text);

      const message = /"error"\s*:/.test(rawMessage)
        ? imageErrorMessage(rawMessage)
        : (rawMessage || '生图失败');

      return res.status(result.status === 400 ? 400 : 502)
        .json({ error: message });
    }

    const url = cleanText(result.data && result.data.url);

    if (!url) {
      return res.status(502).json({ error: '生图接口没有返回图片地址' });
    }

    const withReference = !!(result.data && result.data.with_reference);

    const meta = {
      kind: 'image',
      provider: modelRow.name,
      model: modelRow.model,
      size,
      with_reference: withReference,
      auto_prompted: autoPrompted,
      character_id: characterId || 0
    };

    const inserted = db.prepare(`
      INSERT INTO theater_messages
        (session_id, role, content, image_url, meta_json)
      VALUES (?, 'narrator', ?, ?, ?)
    `).run(session.id, prompt, url, JSON.stringify(meta));

    db.prepare(`
      UPDATE theater_sessions
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(session.id);

    const message = db.prepare('SELECT * FROM theater_messages WHERE id = ?')
      .get(Number(inserted.lastInsertRowid));

    res.json({
      ok: true,
      message,
      prompt,
      auto_prompted: autoPrompted,
      with_reference: withReference
    });
  });
};
