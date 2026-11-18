const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
const { getActiveWorldId } = require('./worlds');

const app = express();
const PORT = process.env.PORT || 8787;

// 多账号后每个账号有自己的图片目录：data/users/<id>/uploads
function uploadsDirFor(req) {
  if (!req.user) {
    throw new Error('未登录，不知道该把图片存给谁');
  }
  const dir = path.join(db.userDir(req.user.id), 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      cb(null, uploadsDirFor(req));
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    // 扩展名不能听客户端的，否则传个 x.html 也能被当网页执行
    const rawExt = path.extname(file.originalname).toLowerCase();
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = allowed.includes(rawExt) ? rawExt : '.jpg';
    const name = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      const error = new Error('只允许上传图片');
      error.status = 415;
      return cb(error);
    }
    cb(null, true);
  }
});

app.use(express.json({ limit: '10mb' }));

// 账号系统：先认出 cookie 里的账号（把后续处理包进该账号的数据库上下文），
// 再把没登录的挡在门外。必须排在所有接口和静态目录之前。
const auth = require('./auth-api');
app.use(auth.middleware);
app.use(auth.gate);
require('./auth-api')(app);
require('./chat-api')(app, db);
require('./ui-settings-api')(app, db);
require('./theater-api')(app, db);
require('./theater-play-api')(app, db);
require('./theater-extra-api')(app, db);
require('./moment-api')(app, db);
require('./world-api')(app, db);
require('./worldbook-api')(app, db);
require('./backup-api')(app, db);
require('./holiday-api')(app, db);
require('./calendar-extra-api')(app, db);
require('./identity-options-api')(app, db);
require('./profile-api')(app, db);
require('./sticker-api')(app, db);
require('./image-api')(app, db);
require('./update-api')(app);
// 上传的图片文件名带时间戳和随机串，内容永不会变，可以放心长期缓存。
// 必须挂在 no-store 中间件之前，否则会被一并禁止缓存，
// 结果就是每翻一页、每开一次首页，所有头像和背景图都要重新下载。
// 图片按账号隔离：同一个 /uploads/xxx.jpg 只在这个账号登录时能取到
app.use('/uploads', (req, res, next) => {
  if (!req.user) {
    return res.status(401).end();
  }
  const dir = path.join(db.userDir(req.user.id), 'uploads');
  express.static(dir, { maxAge: '365d', immutable: true })(req, res, next);
});

// 其余接口和前端代码继续保持不缓存：改完代码刷新就能生效，不用手动清缓存。
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// 图片到底是不是图片，得看文件头，不能听客户端报的 mimetype。
// 手机相机的 HEIC 也会报成 image/*，存下来浏览器根本解不出来，
// 表现就是「图传上去了但哪儿都不显示」，而且一点报错都没有。
function sniffImageExt(filePath) {
  let head;
  try {
    const fd = fs.openSync(filePath, 'r');
    head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
  } catch (e) {
    return null;
  }

  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head.slice(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (head.slice(0, 4).toString('latin1') === 'RIFF' &&
      head.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function isHeic(filePath) {
  let head;
  try {
    const fd = fs.openSync(filePath, 'r');
    head = Buffer.alloc(32);
    fs.readSync(fd, head, 0, 32, 0);
    fs.closeSync(fd);
  } catch (e) {
    return false;
  }
  const brand = head.slice(8, 32).toString('latin1');
  return /heic|heix|hevc|heim|heis|mif1|msf1/.test(brand);
}

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '没有收到图片' });
  }

  const ext = sniffImageExt(req.file.path);

  if (!ext) {
    const heic = isHeic(req.file.path);
    try { fs.unlinkSync(req.file.path); } catch (e) {}

    return res.status(400).json({
      error: heic
        ? '这张图是 HEIC 格式，浏览器显示不了，先转成 JPG 或 PNG 再传吧'
        : '这个文件看着不是图片，换个 JPG / PNG / WEBP 试试'
    });
  }

  // 扩展名按真实格式来，免得 jpeg 的头配个 .png 的名字
  let filename = req.file.filename;
  if (!filename.toLowerCase().endsWith('.' + ext)) {
    const renamed = filename.replace(/\.[^.]*$/, '.' + ext);
    try {
      fs.renameSync(req.file.path, path.join(path.dirname(req.file.path), renamed));
      filename = renamed;
    } catch (e) {}
  }

  res.json({ url: '/uploads/' + filename });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'Nocturne',
    time: new Date().toISOString()
  });
});

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

// 各家报错格式不一样，但「模型不存在」这件事大家都用了差不多的字眼，
// 顺手把「去拉一份列表」的出路指给她，省得她对着 JSON 猜模型名
function modelHint(message) {
  const text = String(message || '');

  if (/model_not_found|not available for this group|invalid model|model.*does not exist|no such model/i.test(text)) {
    return text + '\n\n（这个模型名在这家服务商那儿用不了。可以在上面的表单里点「拉取模型列表」，看看这个 Key 到底能用哪些名字。）';
  }

  return text;
}

// 参考图：一个角色/人设可以挂多张，统一走 ref_images 表
function readRefImages(db, ownerType, ownerId) {
  return db.prepare(`
    SELECT image_url FROM ref_images
    WHERE owner_type = ? AND owner_id = ?
    ORDER BY sort ASC, id ASC
  `).all(ownerType, ownerId).map((row) => row.image_url);
}

function writeRefImages(db, ownerType, ownerId, list, legacyColumnTable) {
  const urls = (Array.isArray(list) ? list : [])
    .map((item) => cleanText(item))
    .filter(Boolean)
    .slice(0, 12);

  db.prepare(
    'DELETE FROM ref_images WHERE owner_type = ? AND owner_id = ?'
  ).run(ownerType, ownerId);

  urls.forEach((url, index) => {
    db.prepare(`
      INSERT INTO ref_images (owner_type, owner_id, image_url, sort)
      VALUES (?, ?, ?, ?)
    `).run(ownerType, ownerId, url, index);
  });

  // 老字段保留成第一张，方便旧代码和备份不至于一片空白
  if (legacyColumnTable) {
    db.prepare(
      `UPDATE ${legacyColumnTable} SET ref_image = ? WHERE id = ?`
    ).run(urls[0] || '', ownerId);
  }

  return urls;
}

function refListFromBody(body) {
  if (Array.isArray(body && body.ref_images)) return body.ref_images;

  const single = cleanText(body && body.ref_image);

  return single ? [single] : null;
}

function cleanText(value) {
  return String(value ?? '').trim();
}

app.get('/api/models', (req, res) => {
  const rows = db.prepare(`
    SELECT
      id,
      name,
      protocol,
      base_url,
      model,
      temperature,
      max_tokens,
      stream,
      is_default,
      is_vision,
      is_image,
      created_at,
      CASE WHEN api_key <> '' THEN 1 ELSE 0 END AS has_key
    FROM model_profiles
    ORDER BY is_default DESC, id DESC
  `).all();

  res.json(rows);
});

app.post('/api/models', (req, res) => {
  const body = req.body || {};

  const name = cleanText(body.name);
  const base_url = cleanText(body.base_url);
  const api_key = cleanText(body.api_key);
  const model = cleanText(body.model);

  if (!name || !base_url || !api_key || !model) {
    return res.status(400).json({
      error: '名称、Base URL、API Key、模型名都必须填写'
    });
  }

  let extra_headers = body.extra_headers || '{}';
  if (typeof extra_headers !== 'string') {
    extra_headers = JSON.stringify(extra_headers);
  }

  try {
    JSON.parse(extra_headers);
  } catch (e) {
    return res.status(400).json({ error: '额外 Header 不是合法 JSON' });
  }

  const result = db.prepare(`
    INSERT INTO model_profiles
      (name, protocol, base_url, api_key, model, extra_headers,
       temperature, max_tokens, stream, is_default, is_vision, is_image)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    'openai',
    base_url,
    api_key,
    model,
    extra_headers,
    Number(body.temperature ?? 0.8),
    Number(body.max_tokens ?? 2048),
    body.stream ? 1 : 0,
    body.is_default ? 1 : 0,
    body.is_vision ? 1 : 0,
    body.is_image ? 1 : 0
  );

  const id = Number(result.lastInsertRowid);

  if (body.is_default) {
    db.prepare('UPDATE model_profiles SET is_default = 0 WHERE id <> ?').run(id);
  }

  res.json({ ok: true, id });
});

// 只允许改这几个开关，不允许从这里改 key / 地址
app.put('/api/models/:id', (req, res) => {
  const body = req.body || {};
  const row = db.prepare('SELECT * FROM model_profiles WHERE id = ?')
    .get(req.params.id);

  if (!row) {
    return res.status(404).json({ error: '模型不存在' });
  }

  // 补充：允许单独补填 / 更换 Key（恢复过不带 Key 的备份之后要用）
  if (body.api_key !== undefined && cleanText(body.api_key)) {
    db.prepare('UPDATE model_profiles SET api_key = ? WHERE id = ?')
      .run(cleanText(body.api_key), row.id);
  }

  if (body.is_vision !== undefined) {
    db.prepare('UPDATE model_profiles SET is_vision = ? WHERE id = ?')
      .run(body.is_vision ? 1 : 0, row.id);
  }

  if (body.is_image !== undefined) {
    db.prepare('UPDATE model_profiles SET is_image = ? WHERE id = ?')
      .run(body.is_image ? 1 : 0, row.id);
  }

  if (body.is_default !== undefined) {
    db.prepare('UPDATE model_profiles SET is_default = ? WHERE id = ?')
      .run(body.is_default ? 1 : 0, row.id);

    if (body.is_default) {
      db.prepare('UPDATE model_profiles SET is_default = 0 WHERE id <> ?')
        .run(row.id);
    }
  }

  res.json({ ok: true });
});

app.delete('/api/models/:id', (req, res) => {
  db.prepare('DELETE FROM model_profiles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// 1x1 的小图，用来探「这个模型到底吃不吃图片输入」
const VISION_PROBE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function probeVision(row, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(buildChatUrl(row.base_url), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: row.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '这张图整体是什么颜色？只回答颜色。' },
              { type: 'image_url', image_url: { url: VISION_PROBE_IMAGE } }
            ]
          }
        ],
        temperature: 0,
        max_tokens: 800,
        stream: false
      }),
      signal: controller.signal
    });

    const text = await response.text();

    if (!response.ok) {
      if (/image|vision|multimodal|unsupported/i.test(text)) {
        return '看图：用不了（这个模型不吃图片输入）';
      }

      return '看图：用不了（' + text.slice(0, 200) + '）';
    }

    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {}

    const message = (data && data.choices && data.choices[0] &&
      data.choices[0].message) || {};
    const content = String(message.content || '').trim();
    const reasoning = String(message.reasoning_content || '').trim();
    const blindPattern =
      /(无法查看图片|看不到图片|图片不受支持|不受支持的图片|unsupported image|没有提供图片|未提供图片|cannot see the image)/i;

    // 有的模型不报错，只是在回答里说「我看不到这张图」，这种也得算不支持
    if (blindPattern.test(content) || blindPattern.test(reasoning)) {
      return '看图：用不了（它自己说看不到图片）';
    }

    if (content) {
      return '看图：可用（它说图是「' + content.slice(0, 30) + '」）';
    }

    if (reasoning) {
      const color = reasoning.match(
        /(红|橙|黄|绿|青|蓝|紫|粉|棕|灰|白|黑|透明)色?/
      );

      if (color) {
        return '看图：可用（它认出了「' + color[1] + '」，只是结论写在思考里）';
      }

      return '看图：不确定（它只回了思考内容，再点一次试试）';
    }

    return '看图：不确定（返回了空内容）';
  } catch (error) {
    return '看图：用不了（' + (error.name === 'AbortError' ? '请求超时' : error.message) + '）';
  } finally {
    clearTimeout(timer);
  }
}

app.post('/api/models/:id/test', async (req, res) => {
  const row = db.prepare('SELECT * FROM model_profiles WHERE id = ?').get(req.params.id);

  if (!row) {
    return res.status(404).json({ error: '模型配置不存在' });
  }

  const extraHeaders = safeJsonParse(row.extra_headers, {});
  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders
  };

  if (!headers.Authorization && !headers.authorization) {
    headers.Authorization = 'Bearer ' + row.api_key;
  }

  // 生图模型拿聊天接口去测是测不出来的，单独走一次真实的生图请求
  if (row.is_image) {
    try {
      const probe = require('./image-api').probe;

      if (typeof probe !== 'function') {
        return res.status(500).json({ error: '生图模块还没加载好，重启一次再看' });
      }

      const result = await probe(row);

      // 顺手把看图能力也探一下，省得她来回切
      const lines = [result.reply];

      if (row.is_vision) {
        lines.push(await probeVision(row, headers));
      }

      return res.json({ ok: true, reply: lines.join('\n') });
    } catch (error) {
      return res.status(400).json({ error: modelHint(error.message) });
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(buildChatUrl(row.base_url), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: row.model,
        messages: [
          { role: 'user', content: '请只回复：连接成功' }
        ],
        temperature: 0,
        max_tokens: 512,
        stream: false
      }),
      signal: controller.signal
    });

    const text = await response.text();

    if (!response.ok) {
      return res.status(400).json({ error: modelHint(text.slice(0, 800)) });
    }

    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {}

    // 带思考的模型有时把话全说在 reasoning 里，正文是空的
    const reply = String(
      (data?.choices?.[0]?.message?.content || '').trim() ||
      (data?.choices?.[0]?.message?.reasoning_content || '').trim().slice(0, 200) ||
      '连接成功'
    );

    if (row.is_vision) {
      return res.json({ ok: true, reply: reply + '\n' + await probeVision(row, headers) });
    }

    res.json({ ok: true, reply });
  } catch (error) {
    res.status(500).json({
      error: error.name === 'AbortError' ? '请求超时' : error.message
    });
  } finally {
    clearTimeout(timer);
  }
});

// 从服务商那里把可用模型列表拉下来，省得猜模型名叫什么
app.post('/api/models/catalog', async (req, res) => {
  const body = req.body || {};
  const baseUrl = cleanText(body.base_url).replace(/\/+$/, '');

  if (!baseUrl) {
    return res.status(400).json({ error: '先填 Base URL' });
  }

  const headers = {
    'Content-Type': 'application/json',
    ...safeJsonParse(body.extra_headers, {})
  };

  if (!headers.Authorization && !headers.authorization) {
    headers.Authorization = 'Bearer ' + cleanText(body.api_key);
  }

  const urls = baseUrl.endsWith('/models')
    ? [baseUrl]
    : /\/v\d+$/.test(baseUrl)
      ? [baseUrl + '/models']
      : [baseUrl + '/v1/models', baseUrl + '/models'];

  let lastError = '';

  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal
      });

      const text = await response.text();

      if (!response.ok) {
        lastError = text.slice(0, 400);

        if (response.status === 404 || response.status === 405) continue;

        return res.status(400).json({ error: modelHint(lastError) });
      }

      let data = null;
      try {
        data = JSON.parse(text);
      } catch (e) {}

      const list = Array.isArray(data && data.data)
        ? data.data
        : Array.isArray(data && data.models)
          ? data.models
          : null;

      if (!list) {
        return res.status(400).json({ error: '这个接口没返回模型列表' });
      }

      const models = list
        .map((item) => ({
          id: cleanText(typeof item === 'string' ? item : item && item.id),
          owned_by: cleanText(item && item.owned_by)
        }))
        .filter((item) => item.id)
        .sort((a, b) => a.id.localeCompare(b.id));

      return res.json({ ok: true, models });
    } catch (error) {
      lastError = error.name === 'AbortError' ? '请求超时' : error.message;
    } finally {
      clearTimeout(timer);
    }
  }

  return res.status(400).json({ error: modelHint(lastError || '拉不到模型列表') });
});

app.get('/api/personas', (req, res) => {
  const worldId = getActiveWorldId();

  const rows = db.prepare(`
    SELECT * FROM user_personas
    WHERE world_id = ?
    ORDER BY is_default DESC, id DESC
  `).all(worldId);

  res.json(rows.map((row) => {
    const refs = readRefImages(db, 'persona', row.id);
    return { ...row, ref_image: refs[0] || row.ref_image || '', ref_images: refs };
  }));
});

app.post('/api/personas', (req, res) => {
  const body = req.body || {};
  const name = cleanText(body.name);

  if (!name) {
    return res.status(400).json({ error: '用户人设名字必填' });
  }

  const worldId = getActiveWorldId();

  const result = db.prepare(`
    INSERT INTO user_personas
      (name, avatar, bio, persona, is_default, world_id, ref_image)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    cleanText(body.avatar),
    cleanText(body.bio),
    cleanText(body.persona),
    body.is_default ? 1 : 0,
    worldId,
    cleanText(body.ref_image)
  );

  const id = Number(result.lastInsertRowid);
  const refs = refListFromBody(body);

  if (refs) {
    writeRefImages(db, 'persona', id, refs, 'user_personas');
  }

  if (body.is_default) {
    db.prepare('UPDATE user_personas SET is_default = 0 WHERE id <> ?').run(id);
  }

  res.json({ ok: true, id });
});

app.put('/api/personas/:id', (req, res) => {
  const body = req.body || {};
  const name = cleanText(body.name);

  if (!name) {
    return res.status(400).json({ error: '用户人设名字必填' });
  }

  const existing = db.prepare('SELECT id FROM user_personas WHERE id = ?').get(req.params.id);

  if (!existing) {
    return res.status(404).json({ error: '用户人设不存在' });
  }

  db.prepare(`
    UPDATE user_personas
    SET name = ?, avatar = ?, bio = ?, persona = ?, is_default = ?,
        ref_image = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    name,
    cleanText(body.avatar),
    cleanText(body.bio),
    cleanText(body.persona),
    body.is_default ? 1 : 0,
    cleanText(body.ref_image),
    req.params.id
  );

  const refs = refListFromBody(body);

  if (refs) {
    writeRefImages(db, 'persona', Number(req.params.id), refs, 'user_personas');
  }

  if (body.is_default) {
    db.prepare('UPDATE user_personas SET is_default = 0 WHERE id <> ?').run(req.params.id);
  }

  res.json({ ok: true });
});

app.delete('/api/personas/:id', (req, res) => {
  db.prepare('DELETE FROM user_personas WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/characters', (req, res) => {
  const worldId = getActiveWorldId();

  const rows = db.prepare(`
    SELECT * FROM characters
    WHERE world_id = ?
    ORDER BY id DESC
  `).all(worldId);

  res.json(rows.map((row) => {
    const refs = readRefImages(db, 'character', row.id);
    return { ...row, ref_image: refs[0] || row.ref_image || '', ref_images: refs };
  }));
});

app.post('/api/characters', (req, res) => {
  const body = req.body || {};
  const name = cleanText(body.name);

  if (!name) {
    return res.status(400).json({ error: '角色名字必填' });
  }

  const worldId = getActiveWorldId();

  const result = db.prepare(`
    INSERT INTO characters
      (name, handle, avatar, persona, personality, background,
       speaking_style, opening_line, tags, birthday, source, source_card_json, world_id,
       ref_image)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    cleanText(body.handle),
    cleanText(body.avatar),
    cleanText(body.persona),
    cleanText(body.personality),
    cleanText(body.background),
    cleanText(body.speaking_style),
    cleanText(body.opening_line),
    cleanText(body.tags),
    cleanText(body.birthday),
    'manual',
    '',
    worldId,
    cleanText(body.ref_image)
  );

  const characterId = Number(result.lastInsertRowid);
  const refs = refListFromBody(body);

  if (refs) {
    writeRefImages(db, 'character', characterId, refs, 'characters');
  }

  res.json({ ok: true, id: characterId });
});

app.put('/api/characters/:id', (req, res) => {
  const body = req.body || {};
  const name = cleanText(body.name);

  if (!name) {
    return res.status(400).json({ error: '角色名字必填' });
  }

  const existing = db.prepare('SELECT id FROM characters WHERE id = ?').get(req.params.id);

  if (!existing) {
    return res.status(404).json({ error: '角色不存在' });
  }

  db.prepare(`
    UPDATE characters
    SET name = ?, handle = ?, avatar = ?, persona = ?, personality = ?,
        background = ?, speaking_style = ?, opening_line = ?, tags = ?,
        birthday = ?, ref_image = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    name,
    cleanText(body.handle),
    cleanText(body.avatar),
    cleanText(body.persona),
    cleanText(body.personality),
    cleanText(body.background),
    cleanText(body.speaking_style),
    cleanText(body.opening_line),
    cleanText(body.tags),
    cleanText(body.birthday),
    cleanText(body.ref_image),
    req.params.id
  );

  const refs = refListFromBody(body);

  if (refs) {
    writeRefImages(db, 'character', Number(req.params.id), refs, 'characters');
  }

  res.json({ ok: true });
});

app.delete('/api/characters/:id', (req, res) => {
  const characterId = Number(req.params.id);

  // 删角色要把它的聊天记录、历史版本、朋友圈和相关零碎一起收拾干净，
  // 否则聊天列表里会留下一堆「无名角色」的孤儿消息，永远查不到也删不掉
  db.exec('BEGIN');

  try {
    db.prepare(`
      DELETE FROM message_variants
      WHERE message_id IN (SELECT id FROM messages WHERE character_id = ?)
    `).run(characterId);

    db.prepare('DELETE FROM messages WHERE character_id = ?').run(characterId);

    db.prepare(`
      DELETE FROM moment_likes
      WHERE moment_id IN (SELECT id FROM moments WHERE character_id = ?)
    `).run(characterId);

    db.prepare(`
      DELETE FROM moment_comments
      WHERE moment_id IN (SELECT id FROM moments WHERE character_id = ?)
         OR character_id = ?
    `).run(characterId, characterId);

    db.prepare('DELETE FROM moments WHERE character_id = ?').run(characterId);

    db.prepare('DELETE FROM characters WHERE id = ?').run(characterId);

    // 剧本里如果挂了这位角色，顺手从阵容里剔掉
    const scripts = db.prepare('SELECT id, cast_ids FROM theater_scripts').all();
    const updateCast = db.prepare('UPDATE theater_scripts SET cast_ids = ? WHERE id = ?');

    scripts.forEach((script) => {
      let castIds = [];
      try {
        castIds = JSON.parse(script.cast_ids || '[]');
      } catch (e) {
        castIds = [];
      }

      if (!Array.isArray(castIds)) castIds = [];

      const next = castIds.filter((id) => Number(id) !== characterId);

      if (next.length !== castIds.length) {
        updateCast.run(JSON.stringify(next), script.id);
      }
    });

    db.exec('COMMIT');
  } catch (deleteError) {
    db.exec('ROLLBACK');
    throw deleteError;
  }

  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

// 客户端错误（传错文件、body 太大、JSON 写坏了）不该报成 500，
// 也不能把 express 的原始报错原文直接甩到前端。
app.use((err, req, res, next) => {
  const status = Number(err.status || err.statusCode) ||
    (err.code === 'LIMIT_FILE_SIZE' ||
      err.type === 'entity.too.large' ? 413 :
      err.type === 'entity.parse.failed' ? 400 : 500);

  const friendly = {
    400: '请求格式不对',
    413: '文件太大了，换个小一点的',
    415: err.message || '只允许上传图片'
  };

  if (status >= 500) console.error(err);

  res.status(status).json({
    error: status >= 500 ? (err.message || '服务器错误') : (friendly[status] || err.message)
  });
});

// 定时备份：服务跑着的时候每天自动给数据库留一份快照，保留最近 7 份。
require('./backup-worker')(db);

// 朋友圈：角色定时自主发动态 / 评论
require('./moment-ai').startAutoPilot();

const httpServer = app.listen(PORT, '127.0.0.1', () => {
  console.log('Nocturne 已启动：http://127.0.0.1:' + PORT);
});

httpServer.on('error', (e) => {
  console.error('监听失败：' + (e && e.stack ? e.stack : e));
});

// 诊断：node 有时会在启动后自己退出（exit code 0），留个心跳看它到底还在不在。
// 这个定时的 interval 同时也是让事件循环保持活跃的把手。
let heartbeat = 0;
setInterval(() => {
  heartbeat++;
  // 只在前一分钟留痕，之后安静地守着事件循环，免得 boot.log 一直长
  if (process.uptime() < 60) {
    console.log('心跳 ' + heartbeat + '，已跑 ' + Math.round(process.uptime())
      + ' 秒，listening=' + httpServer.listening);
  }
}, 10 * 1000);

process.on('beforeExit', (code) => {
  // 正常情况不该走到这里：还有 HTTP 服务在跑，事件循环不该空
  let handles = -1;
  try {
    handles = process._getActiveHandles().length;
  } catch (e) {
    handles = -2;
  }
  console.log('beforeExit code=' + code + '，活跃句柄 ' + handles);
});
