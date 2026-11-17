'use strict';
// 朋友圈的"角色自主行为"：
//   1. 角色能看见同世界观其他人发的朋友圈，并以自己身份去评论
//   2. 角色能自主发朋友圈（定时、随机挑人）
//   3. 生成内容时会参考：现实时间/节日/生日（calendar-context）、
//      世界书（含角色关系条目）、最近的聊天与朋友圈

const db = require('./db');
const { getActiveWorldId } = require('./worlds');
const { getWorldbookContextByNames } = require('./worldbook');
const { getCalendarContext } = require('./calendar-context');
const { callModel, describeImage, parseJsonLoose } = require('./llm');

const KEYS = {
  enabled: 'moments_auto_enabled',
  interval: 'moments_auto_interval_hours',
  comments: 'moments_auto_comments',
  lastAt: 'moments_auto_last_at',
  lastCharacter: 'moments_auto_last_character'
};

const TICK_MS = 30 * 60 * 1000; // 每 30 分钟检查一次

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  if (!row || row.value === null || row.value === undefined || row.value === '') {
    return fallback;
  }
  return row.value;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
    .run(key, String(value));
}

function timeOfDayHint(hour) {
  if (hour < 5) return '现在是深夜，大多数人都没睡，气氛安静';
  if (hour < 9) return '现在是清晨，刚起床不久';
  if (hour < 12) return '现在是上午';
  if (hour < 14) return '现在是中午，可能在吃饭';
  if (hour < 18) return '现在是下午';
  if (hour < 22) return '现在是晚上，一天里比较放松的时候';
  return '现在是深夜，夜猫子的时间';
}

// ---- 朋友圈里的图片：让角色真的"看得见" ----
// 一条动态最多看 3 张：再多提示词塞不下，也没必要。
const MAX_IMAGES_PER_MOMENT = 3;
// 单张描述 / 整条拼起来的上限，防止模型话痨把提示词撑爆。
const MAX_DESC_PER_IMAGE = 200;
const MAX_DESC_TOTAL = 400;
// 自动发动态时，最多给几条还没看过图的旧动态补描述，别一次扫一堆图。
const MAX_AUTO_DESCRIBE = 2;

function parseImages(text) {
  try {
    const list = JSON.parse(text || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter((item) => typeof item === 'string' && item.trim());
  } catch (e) {
    return [];
  }
}

function clipText(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max) + '…';
}

// 把一条朋友圈的图变成文字描述：
//   1. 库里存过就直接用，不重复调视觉模型（第二次点 AI 评论不再花钱）
//   2. 没存过才看图，看完写回 moments.image_desc
//   3. 某张失败就跳过，全部失败返回空串——评论照发，不因为有图就整单报错
async function ensureMomentImageDesc(moment) {
  if (!moment || !moment.id) return '';

  const cached = String(moment.image_desc || '').trim();
  if (cached) return cached;

  const images = parseImages(moment.images_json)
    .slice(0, MAX_IMAGES_PER_MOMENT);
  if (!images.length) return '';

  const parts = [];

  for (const imageUrl of images) {
    try {
      const desc = await describeImage({ imageUrl });
      const clipped = clipText(desc, MAX_DESC_PER_IMAGE);
      if (clipped) parts.push(clipped);
    } catch (e) {
      // 一张图看不到不影响别的图，更不影响评论
      console.error('[朋友圈] 看图失败：' + e.message);
    }
  }

  if (!parts.length) return '';

  const joined = clipText(parts.join(' ｜ '), MAX_DESC_TOTAL);

  // 只补还空着的那一行：并发请求可能刚好写完，别互相覆盖
  try {
    db.prepare(`
      UPDATE moments SET image_desc = ?
      WHERE id = ? AND (image_desc IS NULL OR image_desc = '')
    `).run(joined, moment.id);
    moment.image_desc = joined;
  } catch (e) {
    console.error('[朋友圈] 图片描述写回失败：' + e.message);
  }

  return joined;
}

// 拼成提示词里的一句。没图返回空；有图但看不懂也留一句"看不清"，比装没看见好。
async function momentImageBlock(moment) {
  const images = parseImages(moment && moment.images_json);
  if (!images.length) return '';

  const desc = await ensureMomentImageDesc(moment);

  return desc
    ? '（图片内容：' + desc + '）'
    : '（配了 ' + images.length + ' 张图片，但看不清画面）';
}

function listWorldCharacters(worldId) {
  return db.prepare(`
    SELECT * FROM characters WHERE world_id = ? ORDER BY id ASC
  `).all(worldId);
}

function formatCharacterCard(row) {
  return [
    `角色名：${row.name}`,
    row.handle ? `用户名：${row.handle}` : '',
    row.personality ? `性格：${row.personality}` : '',
    row.background ? `背景：${row.background}` : '',
    row.speaking_style ? `说话方式：${row.speaking_style}` : '',
    row.persona ? `完整人设：${row.persona}` : ''
  ].filter(Boolean).join('\n');
}

function worldbookFor(worldId, text, characters) {
  const names = characters.map((item) => item.name).filter(Boolean);
  return getWorldbookContextByNames(worldId, text, names, 3000);
}

async function recentMomentsText(worldId, limit) {
  const rows = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.images_json, m.image_desc,
           c.name AS character_name
    FROM moments m
    LEFT JOIN characters c ON c.id = m.character_id
    WHERE m.world_id = ?
    ORDER BY m.id DESC
    LIMIT ?
  `).all(worldId, limit || 8);

  // 新→旧遍历：只给最近几条还没描述过的动态补看图，
  // 已经描述过的直接复用库里的，不重复花钱。
  let budget = MAX_AUTO_DESCRIBE;
  const lines = [];

  for (const row of rows) {
    let imageNote = '';

    if (parseImages(row.images_json).length) {
      const cached = String(row.image_desc || '').trim();

      if (cached) {
        imageNote = '（图片内容：' +
          clipText(cached, MAX_DESC_PER_IMAGE) + '）';
      } else if (budget > 0) {
        budget -= 1;
        const desc = await ensureMomentImageDesc(row);
        if (desc) {
          imageNote = '（图片内容：' +
            clipText(desc, MAX_DESC_PER_IMAGE) + '）';
        }
      }
    }

    lines.push(
      `- ${row.character_name || '某人'}：${row.content}` +
      (imageNote ? ' ' + imageNote : '')
    );
  }

  return lines.reverse().join('\n');
}

function recentChatText(characterId, limit) {
  const rows = db.prepare(`
    SELECT role, content, narration FROM messages
    WHERE character_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(characterId, limit || 8);

  return rows.reverse()
    .map((row) => {
      const who = row.role === 'user' ? '用户' : '角色';
      return `${who}：${[row.narration, row.content].filter(Boolean).join(' ')}`;
    })
    .join('\n');
}

function realWorldBlock(worldId) {
  const now = new Date();
  const calendar = getCalendarContext(worldId);
  return [
    '【现实世界】',
    `今天是${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日，${timeOfDayHint(now.getHours())}。`,
    calendar || ''
  ].filter(Boolean).join('\n');
}

function getAutoSettings() {
  return {
    enabled: getSetting(KEYS.enabled, '1') === '1',
    interval_hours: Number(getSetting(KEYS.interval, '6')) || 6,
    auto_comments: getSetting(KEYS.comments, '1') === '1',
    last_at: getSetting(KEYS.lastAt, '')
  };
}

function saveAutoSettings(payload) {
  const body = payload || {};
  if (body.enabled !== undefined) setSetting(KEYS.enabled, body.enabled ? '1' : '0');
  if (body.interval_hours !== undefined) {
    const hours = Math.min(Math.max(Number(body.interval_hours) || 6, 1), 72);
    setSetting(KEYS.interval, String(hours));
  }
  if (body.auto_comments !== undefined) {
    setSetting(KEYS.comments, body.auto_comments ? '1' : '0');
  }
  return getAutoSettings();
}

async function generateMomentForCharacter(characterId, options) {
  const opts = options || {};
  const worldId = Number(opts.worldId || getActiveWorldId());

  const character = db.prepare(`
    SELECT * FROM characters WHERE id = ? AND world_id = ?
  `).get(characterId, worldId);

  if (!character) throw new Error('角色不存在');

  const others = listWorldCharacters(worldId).filter((item) => item.id !== character.id);
  const chatText = recentChatText(character.id, 8);
  const momentsText = await recentMomentsText(worldId, 8);

  const worldbook = worldbookFor(
    worldId,
    [chatText, momentsText, character.name].join('\n'),
    [character].concat(others)
  );

  const system = [
    `你正在扮演角色「${character.name}」，用他的身份写一条朋友圈动态。`,
    formatCharacterCard(character),
    '',
    realWorldBlock(worldId),
    worldbook.text ? '【世界书】\n' + worldbook.text : '',
    chatText ? '【最近和用户的聊天】\n' + chatText : '',
    momentsText ? '【最近大家发的朋友圈】\n' + momentsText : '',
    '',
    '写作要求：',
    '1. 1-3 句，短，口语化，像随手发的一条动态。',
    '2. 内容要贴合当前现实时间、节日或最近发生的事，不要说空话。',
    '3. 不要旁白标记，不要标题，不要话题标签，不要解释。',
    '4. 不要替用户说话。'
  ].filter(Boolean).join('\n');

  const result = await callModel({
    system,
    user: '发一条朋友圈。',
    temperature: Number(opts.temperature ?? 0.95),
    maxTokens: 800
  });

  const content = result.content.trim();

  const meta = {
    ...result.meta,
    worldbook_hits: worldbook.count,
    auto: opts.source === 'auto'
  };

  const insert = db.prepare(`
    INSERT INTO moments (world_id, character_id, content, images_json, source, meta_json)
    VALUES (?, ?, ?, '[]', ?, ?)
  `).run(worldId, character.id, content, opts.source || 'ai', JSON.stringify(meta));

  return db.prepare(`
    SELECT m.*, c.name AS character_name, c.avatar AS character_avatar
    FROM moments m
    LEFT JOIN characters c ON c.id = m.character_id
    WHERE m.id = ?
  `).get(Number(insert.lastInsertRowid));
}

async function generateCommentsForMoment(momentId, options) {
  const opts = options || {};
  const worldId = Number(opts.worldId || getActiveWorldId());

  const moment = db.prepare(`
    SELECT m.*, c.name AS character_name
    FROM moments m
    LEFT JOIN characters c ON c.id = m.character_id
    WHERE m.id = ? AND m.world_id = ?
  `).get(momentId, worldId);

  if (!moment) throw new Error('朋友圈不存在');

  const characters = listWorldCharacters(worldId);
  const candidates = characters.filter((item) => item.id !== Number(moment.character_id || 0));

  if (!candidates.length) {
    return { comments: [], skipped: '这个世界只有一个角色，没人能来评论' };
  }

  // 角色评论前先看懂图：有图且没描述过就现在看，看完存进 DB
  const imageBlock = await momentImageBlock(moment);

  const existing = db.prepare(`
    SELECT author_name, content FROM moment_comments
    WHERE moment_id = ?
    ORDER BY id ASC
  `).all(momentId);

  const existingText = existing.length
    ? existing.map((row) => `${row.author_name}：${row.content}`).join('\n')
    : '暂无';

  const allNames = characters.map((item) => item.name).filter(Boolean);
  const worldbook = worldbookFor(
    worldId,
    [moment.content, imageBlock, existingText].concat(allNames).join('\n'),
    characters
  );

  const candidateCards = candidates.map((item) => {
    return `- id=${item.id}｜${formatCharacterCard(item).replace(/\n/g, '｜')}`;
  }).join('\n');

  const want = Math.min(Number(opts.count || 2), candidates.length);

  const system = [
    '你在扮演同一世界观里的几个角色，去评论别人发的朋友圈。',
    '',
    `【朋友圈作者】${moment.character_name || '某人'}`,
    `【朋友圈内容】${moment.content}${imageBlock ? '\n' + imageBlock : ''}`,
    existingText !== '暂无' ? `【已有评论】\n${existingText}` : '【已有评论】暂无',
    '',
    realWorldBlock(worldId),
    worldbook.text ? '【世界书】\n' + worldbook.text : '',
    '',
    '【可以发言的角色】',
    candidateCards,
    '',
    `请从中挑 ${want} 位最有理由来评论的角色（优先关系亲近或会拌嘴的），各写一句评论。`,
    '要求：',
    '1. 每条 1 句，30 字以内，符合角色性格和他们之间的关系。',
    '2. 不要旁白，不要动作描写，不要写角色名前缀。',
    '3. 不要重复已有评论的意思。',
    '4. 只能使用上面列出的 id。',
    '只输出 JSON，不要输出别的内容：',
    '{"comments":[{"character_id":数字,"content":"评论内容"}]}'
  ].filter(Boolean).join('\n');

  const result = await callModel({
    system,
    user: '请给出评论。',
    temperature: Number(opts.temperature ?? 0.9),
    maxTokens: 1200
  });

  const parsed = parseJsonLoose(result.content);
  const rawList = parsed && Array.isArray(parsed.comments) ? parsed.comments : [];

  const byId = new Map(candidates.map((item) => [Number(item.id), item]));
  const inserted = [];
  const used = new Set();

  for (const item of rawList) {
    const cid = Number(item && item.character_id);
    const content = String(item && item.content || '').trim();

    if (!cid || !content) continue;
    if (!byId.has(cid)) continue;
    if (used.has(cid)) continue;

    used.add(cid);

    const character = byId.get(cid);
    const row = db.prepare(`
      INSERT INTO moment_comments (moment_id, author_name, content, character_id)
      VALUES (?, ?, ?, ?)
    `).run(momentId, character.name, content, cid);

    inserted.push({
      id: Number(row.lastInsertRowid),
      moment_id: Number(momentId),
      author_name: character.name,
      content,
      character_id: cid,
      character_avatar: character.avatar || ''
    });
  }

  return {
    comments: inserted,
    skipped: inserted.length ? '' : '模型没有给出可用评论',
    meta: result.meta
  };
}

// 手动/定时触发一次：按设置决定要不要发
async function runAutoTick(force) {
  const settings = getAutoSettings();

  if (!settings.enabled && !force) {
    return { ok: false, skipped: '自动发朋友圈未开启' };
  }

  const worldId = Number(getActiveWorldId());
  const characters = listWorldCharacters(worldId);

  if (!characters.length) {
    return { ok: false, skipped: '当前世界还没有角色' };
  }

  if (!force) {
    const lastAt = settings.last_at ? new Date(settings.last_at).getTime() : 0;
    const elapsed = Date.now() - lastAt;
    if (lastAt && elapsed < settings.interval_hours * 3600 * 1000) {
      return { ok: false, skipped: '还没到时间' };
    }
  }

  // 尽量别让同一个角色连着发
  const lastCharacterId = Number(getSetting(KEYS.lastCharacter, '0'));
  let pool = characters;
  if (characters.length > 1) {
    pool = characters.filter((item) => item.id !== lastCharacterId);
    if (!pool.length) pool = characters;
  }

  const character = pool[Math.floor(Math.random() * pool.length)];

  const moment = await generateMomentForCharacter(character.id, { worldId, source: 'auto' });
  setSetting(KEYS.lastAt, new Date().toISOString());
  setSetting(KEYS.lastCharacter, String(character.id));

  let comments = [];
  if (settings.auto_comments) {
    // 七成概率会有人来接话
    if (Math.random() < 0.7) {
      try {
        const result = await generateCommentsForMoment(moment.id, { worldId });
        comments = result.comments || [];
      } catch (e) {
        console.error('[朋友圈] 自动评论失败：' + e.message);
      }
    }
  }

  return { ok: true, moment, comments };
}

let timer = null;

function startAutoPilot() {
  if (timer) return;

  const tick = () => {
    runAutoTick(false).catch((error) => {
      console.error('[朋友圈] 自动发布失败：' + error.message);
    });
  };

  // 启动 90 秒后再开始，别和服务器启动抢资源
  setTimeout(tick, 90 * 1000).unref();
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}

module.exports = {
  generateMomentForCharacter,
  generateCommentsForMoment,
  runAutoTick,
  startAutoPilot,
  getAutoSettings,
  saveAutoSettings
};
