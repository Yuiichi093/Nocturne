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

  // ---------- 省钱：剧情记忆档位 ----------
  // 一步剧场最贵的是「把全部历史 + 全员角色卡 + 世界书再发一遍」，
  // 所以这里只压缩老的、最近几步原样保留，观感不变但输入小很多。
  const THEATER_CONTEXT_LIMITS = [12, 20, 40];
  const THEATER_CONTEXT_DEFAULT = 20;
  const LEAN_KEEP_RECENT = 8;
  const LEAN_OLD_CONTENT_CHARS = 160;
  const CAST_MAX_CHARS = 120;
  const CAST_MAX_COUNT = 8;
  const WORLDBOOK_MAX_CHARS = 1200;

  // 读 app_settings 里的两个键：真实 key 是 ui_ 前缀（设置界面写的），
  // 兼容不带前缀的写法；脏值一律回默认（精简开、带 20 步）。
  function readTheaterCostSettings() {
    const rows = db.prepare(`
      SELECT key, value FROM app_settings
      WHERE key IN (
        'ui_theater_lean', 'ui_theater_context_limit',
        'theater_lean', 'theater_context_limit'
      )
    `).all();

    const saved = {};

    for (const row of rows) {
      saved[row.key] = String(row.value == null ? '' : row.value).trim();
    }

    const leanRaw = saved.ui_theater_lean !== undefined
      ? saved.ui_theater_lean
      : saved.theater_lean;
    const limitRaw = saved.ui_theater_context_limit !== undefined
      ? saved.ui_theater_context_limit
      : saved.theater_context_limit;
    const limit = Number(limitRaw);

    return {
      lean: leanRaw === '0' || leanRaw === '1' ? leanRaw : '1',
      contextLimit: THEATER_CONTEXT_LIMITS.indexOf(limit) >= 0
        ? limit
        : THEATER_CONTEXT_DEFAULT
    };
  }

  // 哪些历史条目算「剧情」：选项（options）不进提示词，插画（narrator）本来
  // 就只截 200 字、也不占「最近 8 条」的名额，只压缩真正的长剧情。
  function historyToPrompt(row) {
    return row.role === 'user' ||
      row.role === 'narration' ||
      row.role === 'character' ||
      row.role === 'dice';
  }

  // 老剧情只留开头 160 字（够模型知道发生过什么），尾巴用「…（略）」标出来
  function leanHistoryContent(content) {
    const text = String(content == null ? '' : content);

    if (text.length <= LEAN_OLD_CONTENT_CHARS) return text;

    return text.slice(0, LEAN_OLD_CONTENT_CHARS) + '…（略）';
  }

  // 世界书按总字数封顶，截断时补省略号
  function trimWorldbook(text, maxChars) {
    const value = String(text == null ? '' : text);

    if (value.length <= maxChars) return value;

    return value.slice(0, maxChars) + '…';
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
      timeoutMs: 60000,
      usageSource: 'image_prompt'
    });

    const prompt = cleanImagePrompt(result.content);

    if (!prompt) {
      throw new Error('模型没写出画面描述，稍后再试，或者自己写一句');
    }

    return prompt;
  }

  // 身份卡 / 角色设定图都是 /uploads/ 相对地址，统一清洗一下
  function refImageUrl(value) {
    let url = cleanText(value);

    if (!url) return '';

    if (/^https?:\/\//i.test(url)) {
      try {
        url = new URL(url).pathname || '';
      } catch (e) {
        return '';
      }
    }

    return url.startsWith('/uploads/') ? url : '';
  }

  function ownerRefImages(ownerType, ownerId, legacyUrl) {
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
      const url = refImageUrl(row.image_url);
      if (url && !list.includes(url)) list.push(url);
    });

    if (!list.length) {
      const legacy = refImageUrl(legacyUrl);
      if (legacy) list.push(legacy);
    }

    return list;
  }

  // 角色的全局设定图：角色自己的 + 它绑的用户人设的（跟生图接口的兜底逻辑一致）
  function characterRefImages(characterId) {
    if (!Number(characterId)) return [];

    const character = db.prepare('SELECT * FROM characters WHERE id = ?')
      .get(characterId);

    if (!character) return [];

    const list = ownerRefImages('character', character.id, character.ref_image);

    let persona = null;

    if (Number(character.user_persona_id || 0) > 0) {
      persona = db.prepare('SELECT * FROM user_personas WHERE id = ?')
        .get(character.user_persona_id);
    }

    if (!persona) {
      persona = db.prepare(`
        SELECT * FROM user_personas
        ORDER BY is_default DESC, id DESC
        LIMIT 1
      `).get();
    }

    if (persona) {
      ownerRefImages('persona', persona.id, persona.ref_image).forEach((url) => {
        if (!list.includes(url)) list.push(url);
      });
    }

    return list;
  }

  // 本次生图用哪些参考图：身份卡优先，再补被画角色的设定图，去重、上限 4 张
  function buildSceneReferences(session, characterId) {
    const merged = [];
    const sources = [];

    function addAll(urls, tag) {
      let used = false;

      urls.forEach((url) => {
        if (merged.length >= 4) return;
        if (merged.includes(url)) return;

        merged.push(url);
        used = true;
      });

      if (used) sources.push(tag);
    }

    addAll(safeJsonParse(session.identity_refs, []).map(refImageUrl).filter(Boolean), 'identity');
    addAll(characterRefImages(characterId), 'character');

    return { refImages: merged, sources };
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
      worldbook.text ? '【世界书】\n' + trimWorldbook(worldbook.text, WORLDBOOK_MAX_CHARS) : '',
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
          // 选项就四行短句，不用给 1200；省下的都是钱
          maxTokens: 400,
          timeoutMs: 60000,
          usageSource: 'theater'
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

  // ---------- 选项版本 ----------
  // 同一段旁白可以有好几批选项（换一批 / 手改），都留在 theater_messages 里，
  // meta_json 里记 narration_id + version；旧版本不删，前端才能翻回去看。
  function optionsMeta(row) {
    const meta = safeJsonParse(row && row.meta_json, {});

    return {
      options: Array.isArray(meta.options) ? meta.options : [],
      narration_id: Number(meta.narration_id) || 0,
      version: Number(meta.version) || 0,
      source: String(meta.source || ''),
      edited_at: String(meta.edited_at || '')
    };
  }

  function lastNarrationOf(sessionId) {
    return db.prepare(`
      SELECT * FROM theater_messages
      WHERE session_id = ? AND role = 'narration'
      ORDER BY id DESC
      LIMIT 1
    `).get(sessionId) || null;
  }

  // 某段旁白的选项版本 = 这段旁白之后、下一段旁白之前的 options 行
  function optionRowsOfNarration(sessionId, narrationId) {
    const nextNarration = db.prepare(`
      SELECT id FROM theater_messages
      WHERE session_id = ? AND role = 'narration' AND id > ?
      ORDER BY id ASC
      LIMIT 1
    `).get(sessionId, narrationId);

    const upper = nextNarration ? Number(nextNarration.id) : Number.MAX_SAFE_INTEGER;

    return db.prepare(`
      SELECT * FROM theater_messages
      WHERE session_id = ? AND role = 'options' AND id > ? AND id < ?
      ORDER BY id ASC
    `).all(sessionId, narrationId, upper);
  }

  function versionedOptions(sessionId, narrationId) {
    return optionRowsOfNarration(sessionId, narrationId).map((row, index) => {
      const meta = optionsMeta(row);

      return {
        id: Number(row.id),
        options: meta.options,
        version: meta.version || index + 1,
        created_at: row.created_at,
        source: meta.source,
        edited_at: meta.edited_at
      };
    });
  }

  function nextOptionVersion(sessionId, narrationId) {
    const rows = optionRowsOfNarration(sessionId, narrationId);
    let max = 0;

    rows.forEach((row, index) => {
      const version = optionsMeta(row).version || index + 1;
      if (version > max) max = version;
    });

    return max + 1;
  }

  // 追加一版选项，返回这一版的对象（id / options / version / created_at / source）
  function insertOptionVersion(sessionId, narrationId, options, source) {
    const version = nextOptionVersion(sessionId, narrationId);

    const result = db.prepare(`
      INSERT INTO theater_messages
        (session_id, role, content, meta_json)
      VALUES (?, 'options', '下一步', ?)
    `).run(
      sessionId,
      JSON.stringify({
        options,
        narration_id: Number(narrationId),
        version,
        source
      })
    );

    const row = db.prepare('SELECT * FROM theater_messages WHERE id = ?')
      .get(Number(result.lastInsertRowid));
    const meta = optionsMeta(row);

    return {
      id: Number(row.id),
      options: meta.options,
      version: meta.version || version,
      created_at: row.created_at,
      source: meta.source || source,
      edited_at: ''
    };
  }

  function normalizeOptionList(value) {
    if (!Array.isArray(value)) {
      return { error: '选项格式不对' };
    }

    const list = value.map((item) => cleanText(item)).filter(Boolean);

    if (list.length < 2 || list.length > 6) {
      return { error: '选项要保留 2 到 6 条' };
    }

    if (list.some((item) => item.length > 200)) {
      return { error: '单个选项最长 200 字' };
    }

    return { list };
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

    // 换一批选项：追加一版，旧的留着（以前是直接覆盖，旧版永远丢了）
    const version = insertOptionVersion(
      session.id,
      Number(lastNarration.id),
      options,
      'refresh'
    );

    res.json({
      ok: true,
      options,
      message: db.prepare('SELECT * FROM theater_messages WHERE id = ?')
        .get(version.id),
      narration_id: Number(lastNarration.id),
      version
    });
  });

  // 某段旁白的全部选项版本（默认最后一段），翻页条用
  app.get('/api/theater/sessions/:id/options', (req, res) => {
    const session = db.prepare('SELECT * FROM theater_sessions WHERE id = ?')
      .get(req.params.id);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    let narrationId = Number(req.query.narration_id) || 0;

    if (narrationId > 0) {
      const narration = db.prepare(`
        SELECT id FROM theater_messages
        WHERE session_id = ? AND role = 'narration' AND id = ?
      `).get(session.id, narrationId);

      if (!narration) {
        return res.status(404).json({ error: '这一段旁白不存在' });
      }
    } else {
      const lastNarration = lastNarrationOf(session.id);

      if (!lastNarration) {
        return res.json({
          ok: true,
          narration_id: 0,
          total: 0,
          active_index: -1,
          versions: []
        });
      }

      narrationId = Number(lastNarration.id);
    }

    const versions = versionedOptions(session.id, narrationId);

    res.json({
      ok: true,
      narration_id: narrationId,
      total: versions.length,
      active_index: versions.length ? versions.length - 1 : -1,
      versions
    });
  });

  // 整个会话所有步骤的选项版本，一次拿全（历史卡片翻页用，切步骤不再发请求）
  app.get('/api/theater/sessions/:id/options/all', (req, res) => {
    const session = db.prepare('SELECT * FROM theater_sessions WHERE id = ?')
      .get(req.params.id);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    const narrations = db.prepare(`
      SELECT id FROM theater_messages
      WHERE session_id = ? AND role = 'narration'
      ORDER BY id ASC
    `).all(session.id);

    const groups = [];

    narrations.forEach((narration) => {
      const versions = versionedOptions(session.id, Number(narration.id));

      if (versions.length) {
        groups.push({
          narration_id: Number(narration.id),
          versions
        });
      }
    });

    res.json({ ok: true, groups });
  });

  // 只重新生成选项（旁白不动），追加新版本
  app.post('/api/theater/sessions/:id/options', async (req, res) => {
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
    let narration = null;

    if (Number(body.narration_id) > 0) {
      narration = db.prepare(`
        SELECT * FROM theater_messages
        WHERE session_id = ? AND role = 'narration' AND id = ?
      `).get(session.id, Number(body.narration_id));
    } else {
      narration = lastNarrationOf(session.id);
    }

    if (!narration) {
      return res.status(400).json({ error: '还没有旁白可以生成选项' });
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

    const history = db.prepare(`
      SELECT role, content, image_url FROM theater_messages
      WHERE session_id = ? AND id < ?
      ORDER BY id DESC
      LIMIT 20
    `).all(session.id, narration.id).reverse();

    const options = await generateTheaterOptions(
      modelRow,
      script,
      session,
      narration.content,
      history
    );

    const version = insertOptionVersion(
      session.id,
      Number(narration.id),
      options,
      'regenerate'
    );

    const versions = versionedOptions(session.id, Number(narration.id));

    res.json({
      ok: true,
      narration_id: Number(narration.id),
      total: versions.length,
      active_index: versions.length - 1,
      version,
      versions
    });
  });

  // 编辑任意一版选项（以前的版本也能改）
  app.put('/api/theater/options/:id', (req, res) => {
    const row = db.prepare(`
      SELECT * FROM theater_messages WHERE id = ? AND role = 'options'
    `).get(req.params.id);

    if (!row) {
      return res.status(404).json({ error: '这一版选项不见了' });
    }

    const body = req.body || {};
    const checked = normalizeOptionList(body.options);

    if (checked.error) {
      return res.status(400).json({ error: checked.error });
    }

    const meta = safeJsonParse(row.meta_json, {});

    meta.options = checked.list;
    meta.edited_at = new Date().toISOString();

    // 老数据没回填过的话，这里顺手补上归属，别让版本翻页找不到它
    if (!Number(meta.narration_id)) {
      const narration = db.prepare(`
        SELECT id FROM theater_messages
        WHERE session_id = ? AND role = 'narration' AND id < ?
        ORDER BY id DESC LIMIT 1
      `).get(row.session_id, row.id);

      if (narration) {
        meta.narration_id = Number(narration.id);
        meta.version = meta.version || nextOptionVersion(row.session_id, Number(narration.id));
      }
    }

    meta.source = meta.source || 'legacy';

    db.prepare('UPDATE theater_messages SET meta_json = ? WHERE id = ?')
      .run(JSON.stringify(meta), row.id);

    const updated = db.prepare('SELECT * FROM theater_messages WHERE id = ?')
      .get(row.id);

    res.json({
      ok: true,
      version: {
        id: Number(updated.id),
        options: checked.list,
        version: Number(meta.version) || 0,
        created_at: updated.created_at,
        source: String(meta.source || ''),
        edited_at: String(meta.edited_at || '')
      }
    });
  });

  // 删掉某一版选项；一段旁白至少留一版
  app.delete('/api/theater/options/:id', (req, res) => {
    const row = db.prepare(`
      SELECT * FROM theater_messages WHERE id = ? AND role = 'options'
    `).get(req.params.id);

    if (!row) {
      return res.status(404).json({ error: '这一版选项不见了' });
    }

    const meta = optionsMeta(row);
    let narrationId = meta.narration_id;

    if (!narrationId) {
      const narration = db.prepare(`
        SELECT id FROM theater_messages
        WHERE session_id = ? AND role = 'narration' AND id < ?
        ORDER BY id DESC LIMIT 1
      `).get(row.session_id, row.id);

      narrationId = narration ? Number(narration.id) : 0;
    }

    const siblings = narrationId
      ? optionRowsOfNarration(row.session_id, narrationId)
      : [row];

    if (siblings.length <= 1) {
      return res.status(400).json({ error: '这一步至少要留一版选项' });
    }

    db.prepare('DELETE FROM theater_messages WHERE id = ?').run(row.id);

    const left = narrationId
      ? versionedOptions(row.session_id, narrationId)
      : [];

    res.json({
      ok: true,
      removed: Number(row.id),
      narration_id: narrationId,
      total: left.length,
      active_index: left.length ? left.length - 1 : -1
    });
  });

  // 重选：把最后一段旁白和最后一批选项删掉，然后重新生成
  app.post('/api/theater/sessions/:id/undo', (req, res) => {
    const session = db.prepare('SELECT * FROM theater_sessions WHERE id = ?')
      .get(req.params.id);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    const lastNarration = db.prepare(`
      SELECT id FROM theater_messages
      WHERE session_id = ? AND role = 'narration'
      ORDER BY id DESC LIMIT 1
    `).get(session.id);

    let removed = 0;

    if (lastNarration) {
      // 这一段的所有选项版本一起删，不能只删最新一版，
      // 不然重选之后旧版本会挂在上一段旁边
      const versions = optionRowsOfNarration(session.id, Number(lastNarration.id));

      versions.forEach((row) => {
        db.prepare('DELETE FROM theater_messages WHERE id = ?').run(row.id);
        removed += 1;
      });

      db.prepare('DELETE FROM theater_messages WHERE id = ?').run(lastNarration.id);
      removed += 1;
    }

    res.json({ ok: true, removed });
  });

  // 整段重写：把最后一段旁白 + 这一步的所有选项版本一起删掉，
  // 前端收到 needs_next 后再走一次自然续写（sendAction('')）生成新的旁白+选项。
  // 删之前先确认模型可用，别把剧情删了才发现没配模型。
  app.post('/api/theater/sessions/:id/rewrite-last', (req, res) => {
    const session = db.prepare('SELECT * FROM theater_sessions WHERE id = ?')
      .get(req.params.id);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    const modelRow = db.prepare(`
      SELECT id FROM model_profiles
      WHERE is_image = 0
      ORDER BY is_default DESC, id DESC
      LIMIT 1
    `).get();

    if (!modelRow) {
      return res.status(400).json({ error: '还没有配置模型 API' });
    }

    const lastNarration = lastNarrationOf(session.id);

    if (!lastNarration) {
      return res.status(400).json({ error: '还没有旁白可以重写' });
    }

    const versions = optionRowsOfNarration(session.id, Number(lastNarration.id));
    let removed = 0;

    versions.forEach((row) => {
      db.prepare('DELETE FROM theater_messages WHERE id = ?').run(row.id);
      removed += 1;
    });

    db.prepare('DELETE FROM theater_messages WHERE id = ?').run(lastNarration.id);
    removed += 1;

    res.json({
      ok: true,
      needs_next: true,
      narration_id: Number(lastNarration.id),
      removed
    });
  });

  // 撤回上一步：把最后一整步删掉，回到上一次的选项卡片，让她重新选。
  // 「一整步」= 她的行动 + 最后一段旁白 + 那批选项 + 这一步之后画的插画。
  app.post('/api/theater/sessions/:id/rollback', (req, res) => {
    const session = db.prepare('SELECT * FROM theater_sessions WHERE id = ?')
      .get(req.params.id);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    const lastNarration = db.prepare(`
      SELECT * FROM theater_messages
      WHERE session_id = ? AND role = 'narration'
      ORDER BY id DESC
      LIMIT 1
    `).get(session.id);

    // 上一批选项在最后一段旁白之前，它才是要回去的地方，不能被删
    const prevOptions = lastNarration
      ? db.prepare(`
          SELECT * FROM theater_messages
          WHERE session_id = ? AND role = 'options' AND id < ?
          ORDER BY id DESC
          LIMIT 1
        `).get(session.id, lastNarration.id)
      : null;

    if (!lastNarration || !prevOptions) {
      return res.status(400).json({ error: '已经回到开头了，没有更早的选项可以返回' });
    }

    let removed = 0;

    // 删除 + 更新时间要么一起成，要么一起不动
    db.exec('BEGIN');

    try {
      const result = db.prepare(`
        DELETE FROM theater_messages
        WHERE session_id = ? AND id > ?
      `).run(session.id, prevOptions.id);

      removed = Number(result.changes || 0);

      db.prepare(`
        UPDATE theater_sessions
        SET updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(session.id);

      db.exec('COMMIT');
    } catch (writeError) {
      db.exec('ROLLBACK');
      throw writeError;
    }

    res.json({ ok: true, removed, options: prevOptions });
  });

  // 「从以前的进度创建分支」用的步骤列表：每段旁白算一步，
  // 带上紧随它的那批选项 id，前端点一下就从那一刻开分支。
  app.get('/api/theater/sessions/:id/history', (req, res) => {
    const session = db.prepare('SELECT * FROM theater_sessions WHERE id = ?')
      .get(req.params.id);

    if (!session) {
      return res.status(404).json({ error: '剧场会话不存在' });
    }

    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), 60)
      : 40;

    const rows = db.prepare(`
      SELECT id, role, content, created_at
      FROM theater_messages
      WHERE session_id = ?
      ORDER BY id ASC
    `).all(session.id);

    // 每段旁白算一步，index 从 0 起（0 = 开头那段），按 id 升序
    const steps = [];
    let pending = null;

    rows.forEach((row) => {
      if (row.role === 'narration') {
        if (pending) steps.push(pending);

        pending = {
          narration_id: Number(row.id),
          options_id: 0,
          preview: '',
          created_at: row.created_at,
          index: steps.length,
          text: String(row.content == null ? '' : row.content)
        };

        return;
      }

      // 紧随旁白的第一批选项才是这一步的选项
      if (pending && row.role === 'options' && !pending.options_id) {
        pending.options_id = Number(row.id);
      }
    });

    if (pending) steps.push(pending);

    steps.forEach((step) => {
      const plain = stripMetaNotes(step.text)
        .replace(/\s+/g, ' ')
        .trim();

      step.preview = plain.length > 40 ? plain.slice(0, 40) + '…' : plain;
      delete step.text;
    });

    // 太长就只回最近 limit 步；index 还是全局的，前端「第 N 步」不会错位
    const visible = steps.length > limit ? steps.slice(steps.length - limit) : steps;

    res.json({ ok: true, steps: visible });
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

    // 角色卡只带摘要：每个角色 120 字、最多 8 个，多出来的写一行「（其余角色略）」
    const castTextParts = cast.slice(0, CAST_MAX_COUNT).map((item) => {
      const parts = [
        `角色名：${item.name}`,
        item.handle ? `用户名：${item.handle}` : '',
        item.personality ? `性格：${item.personality}` : '',
        item.background ? `背景：${item.background}` : '',
        item.speaking_style ? `说话方式：${item.speaking_style}` : '',
        item.persona ? `完整人设：${item.persona}` : ''
      ].filter(Boolean);
      const text = parts.join('\n');

      return text.length > CAST_MAX_CHARS ? text.slice(0, CAST_MAX_CHARS) + '…' : text;
    });

    if (cast.length > CAST_MAX_COUNT) {
      castTextParts.push('（其余角色略）');
    }

    const castText = castTextParts.join('\n\n');

    const corrections = db.prepare(`
      SELECT content FROM theater_corrections
      WHERE session_id = ? AND active = 1
      ORDER BY id DESC
      LIMIT 5
    `).all(session.id);

    const correctionText = corrections.length
      ? corrections.map((item, index) => `${index + 1}. ${item.content}`).join('\n')
      : '无';

    const costSettings = readTheaterCostSettings();

    const history = db.prepare(`
      SELECT role, content, image_url FROM theater_messages
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(session.id, costSettings.contextLimit).reverse();

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
      worldbook.text ? `【世界书】\n${trimWorldbook(worldbook.text, WORLDBOOK_MAX_CHARS)}` : '',
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

    // 精简模式下：最近 8 条剧情原样，更早的只留开头 160 字。
    // 选项（options）本来就不进提示词，所以不占这 8 个名额。
    const leanOn = costSettings.lean === '1';
    const promptRowIndexes = [];

    history.forEach((row, index) => {
      if (historyToPrompt(row)) promptRowIndexes.push(index);
    });

    const olderCount = Math.max(0, promptRowIndexes.length - LEAN_KEEP_RECENT);
    const oldRowIndexes = new Set(
      leanOn ? promptRowIndexes.slice(0, olderCount) : []
    );

    history.forEach((row, index) => {
      const content = oldRowIndexes.has(index)
        ? leanHistoryContent(row.content)
        : row.content;

      if (row.role === 'user') {
        messages.push({ role: 'user', content });
      } else if (row.role === 'narration' || row.role === 'character') {
        // 历史里的旁白补回【旁白】标记，让模型照着格式学，
        // 不然它会以为上一轮就是纯散文，自己也只写散文、不给选项。
        messages.push({
          role: 'assistant',
          content: '【旁白】\n' + content
        });
      } else if (row.role === 'dice') {
        messages.push({ role: 'system', content: '[投掷结果] ' + content });
      } else if (row.role === 'narrator') {
        // 之前生成的插画只作为画面参考，不进正文
        messages.push({
          role: 'system',
          content: '[本段插画] ' + String(content || '').slice(0, 200)
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

    // 输出额度：不再无条件 3000。4 个选项写得完就行，
    // 但也不能压到 1200 以下，不然长旁白会被截断。
    const configuredTokens = Number(modelRow.max_tokens) || 0;
    payload.max_tokens = Math.min(Math.max(configuredTokens, 1200), 2400);

    const started = Date.now();

    try {
      // 推理模型会把额度花在思考上、正文为空，requestChat 里会自动翻额度重试
      const { content: rawReply, data } = await requestChat(modelRow, payload, {
        timeoutMs: 90000,
        usageSource: 'theater'
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
          JSON.stringify({
            options: finalOptions,
            narration_id: Number(narrationResult.lastInsertRowid),
            version: 1,
            source: 'next'
          })
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

    const sceneRefs = buildSceneReferences(session, characterId);

    let result = null;

    try {
      result = await requestTheaterImage({
        prompt,
        size,
        // 有拼好的参考图就显式传，生图接口优先用它
        ref_images: sceneRefs.refImages.length ? sceneRefs.refImages : undefined,
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
    const referenceError = cleanText(result.data && result.data.reference_error).slice(0, 200);

    const meta = {
      kind: 'image',
      provider: modelRow.name,
      model: modelRow.model,
      size,
      with_reference: withReference,
      auto_prompted: autoPrompted,
      character_id: characterId || 0
    };

    // 记一下这次参考图是从哪来的，排查「为什么没套上我的设定图」时有用
    if (sceneRefs.refImages.length) {
      meta.reference_sources = sceneRefs.sources.slice();
      meta.reference_count = sceneRefs.refImages.length;
    }

    // 有参考图却没套上时，把原因一起留在消息里，前端好如实告诉她
    if (!withReference && referenceError) {
      meta.reference_error = referenceError;
    }

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

    const imageResponse = {
      ok: true,
      message,
      prompt,
      auto_prompted: autoPrompted,
      with_reference: withReference
    };

    if (!withReference && referenceError) {
      imageResponse.reference_error = referenceError;
    }

    res.json(imageResponse);
  });
};
