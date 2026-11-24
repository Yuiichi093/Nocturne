/**
 * 统一数据库迁移入口（幂等）
 * ---------------------------------------------------------------
 * 原先建表和补列逻辑散落在 12 个互不引用、需要手工按顺序执行的文件里：
 *   world-migrate.js / theater-migrate.js / worldbook-migrate.js /
 *   moment-migrate.js / moment-social-migrate.js / holiday-migrate.js /
 *   profile-migrate.js / message-variant-migrate.js /
 *   fix-worldbook.js / fix-world-events.js / fix-message-variants.js /
 *   fix-chat-narration.js
 *
 * 依赖顺序靠记忆维护（例如 world-migrate 必须在 theater-migrate 之后跑，
 * 否则 ALTER TABLE theater_scripts 会因表不存在而崩），换设备就全乱。
 *
 * 现在全部收拢到这里，由 db.js 在导出后自动调用，任何入口 require db
 * 都会先把结构准备好。所有语句都是 IF NOT EXISTS / 存在性检查，可反复执行。
 */

// 现在不再是「require 即执行」，而是被 userdata.js 对每个账号的库调用一次。
// 参数 db 就是那个账号的数据库连接。
module.exports = function migrate(db) {

function createTable(sql) {
  db.exec(sql);
}

function tableExists(name) {
  return Boolean(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name));
}

function columnExists(table, column) {
  if (!tableExists(table)) return false;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  return columns.some((item) => item.name === column);
}

function addColumnIfMissing(table, column, definition) {
  if (!tableExists(table)) return false;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/* ========== 1. 世界观 ========== */
createTable(`
  CREATE TABLE IF NOT EXISTS worlds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    cover TEXT NOT NULL DEFAULT '',
    theme_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

/* ========== 2. 小剧场 ========== */
createTable(`
  CREATE TABLE IF NOT EXISTS theater_scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    premise TEXT NOT NULL DEFAULT '',
    opening TEXT NOT NULL DEFAULT '',
    rules TEXT NOT NULL DEFAULT '',
    cast_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

createTable(`
  CREATE TABLE IF NOT EXISTS theater_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    script_id INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    identity_name TEXT NOT NULL DEFAULT '',
    identity_role TEXT NOT NULL DEFAULT '',
    identity_desc TEXT NOT NULL DEFAULT '',
    identity_avatar TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

createTable(`
  CREATE TABLE IF NOT EXISTS theater_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    character_id INTEGER,
    content TEXT NOT NULL DEFAULT '',
    meta_json TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

createTable(`
  CREATE TABLE IF NOT EXISTS theater_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_theater_messages_session
  ON theater_messages(session_id, id ASC);
`);

/* ========== 3. 世界书 ========== */
createTable(`
  CREATE TABLE IF NOT EXISTS worldbook_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    world_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    keys TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 0,
    constant INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

addColumnIfMissing('worldbook_entries', 'meta_json', "TEXT NOT NULL DEFAULT '{}'");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_worldbook_world
  ON worldbook_entries(world_id, priority DESC, id DESC);
`);

/* ========== 4. 世界事件 ========== */
createTable(`
  CREATE TABLE IF NOT EXISTS world_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    world_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    rule_text TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

/* ========== 5. 动态 / 朋友圈 ========== */
createTable(`
  CREATE TABLE IF NOT EXISTS moments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    world_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    images_json TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'manual',
    meta_json TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// 动态可以是角色发的，也可以是自己发的；
// 自己发的没有角色，所以作者信息单独存
addColumnIfMissing('moments', 'author_type', "TEXT NOT NULL DEFAULT 'character'");
addColumnIfMissing('moments', 'author_name', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('moments', 'author_avatar', "TEXT NOT NULL DEFAULT ''");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_moments_world
  ON moments(world_id, id DESC);
`);

createTable(`
  CREATE TABLE IF NOT EXISTS moment_likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    moment_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(moment_id, user_name)
  );
`);

createTable(`
  CREATE TABLE IF NOT EXISTS moment_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    moment_id INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_moment_likes_moment
  ON moment_likes(moment_id, id ASC);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_moment_comments_moment
  ON moment_comments(moment_id, id ASC);
`);

/* ========== 6. 节日 ========== */
createTable(`
  CREATE TABLE IF NOT EXISTS holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    rule_type TEXT NOT NULL DEFAULT 'solar',
    month INTEGER,
    day INTEGER,
    rule_text TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

createTable(`
  CREATE TABLE IF NOT EXISTS world_holiday_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    world_id INTEGER NOT NULL,
    holiday_id INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(world_id, holiday_id)
  );
`);

/* ========== 7. 世界资料 ========== */
createTable(`
  CREATE TABLE IF NOT EXISTS world_profiles (
    world_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '你的名字',
    handle TEXT NOT NULL DEFAULT '@your_handle',
    bio TEXT NOT NULL DEFAULT '在这里写一句你的签名。',
    location TEXT NOT NULL DEFAULT 'Saudade',
    avatar TEXT NOT NULL DEFAULT '',
    bg TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

/* ========== 8. 消息版本 ========== */
createTable(`
  CREATE TABLE IF NOT EXISTS message_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    meta_json TEXT NOT NULL DEFAULT '',
    sticker_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

/* ========== 9. 补列 ========== */
// messages 补列顺序与历史库保持一致，便于结构对比
addColumnIfMissing('messages', 'sticker_id', 'INTEGER');
addColumnIfMissing('messages', 'narration', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('messages', 'image_url', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('messages', 'image_desc', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('model_profiles', 'is_vision', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('model_profiles', 'is_image', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('characters', 'ref_image', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('user_personas', 'ref_image', "TEXT NOT NULL DEFAULT ''");

// 参考图从「一人一张」升级成「一人若干张」：老的单张字段保留不删，
// 启动时把里面的地址搬进新表，之后就都由新表说话
db.exec(`
  CREATE TABLE IF NOT EXISTS ref_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type TEXT NOT NULL DEFAULT 'character',
    owner_id INTEGER NOT NULL,
    image_url TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_ref_images_owner
  ON ref_images(owner_type, owner_id, sort)
`);

for (const [ownerType, table] of [
  ['character', 'characters'],
  ['persona', 'user_personas']
]) {
  if (!tableExists(table) || !columnExists(table, 'ref_image')) continue;

  const rows = db.prepare(
    `SELECT id, ref_image FROM ${table} WHERE ref_image <> ''`
  ).all();

  for (const row of rows) {
    const existing = db.prepare(`
      SELECT COUNT(*) AS total FROM ref_images
      WHERE owner_type = ? AND owner_id = ?
    `).get(ownerType, row.id);

    if (Number(existing.total) > 0) continue;

    db.prepare(`
      INSERT INTO ref_images (owner_type, owner_id, image_url, sort)
      VALUES (?, ?, ?, 0)
    `).run(ownerType, row.id, row.ref_image);
  }
}
addColumnIfMissing('moments', 'author_type', "TEXT NOT NULL DEFAULT 'character'");
addColumnIfMissing('moments', 'author_name', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('moments', 'author_avatar', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('worldbook_entries', 'category', "TEXT NOT NULL DEFAULT '未分类'");
addColumnIfMissing('message_variants', 'narration', "TEXT NOT NULL DEFAULT ''");

// 朋友圈的图片也存一份文字描述，角色之后发的评论才"记得"画面
addColumnIfMissing('moments', 'image_desc', "TEXT NOT NULL DEFAULT ''");
// 小剧场里也能生图：一条消息可以带一张图
addColumnIfMissing('theater_messages', 'image_url', "TEXT NOT NULL DEFAULT ''");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_message_variants_message
  ON message_variants(message_id, id)
`);

addColumnIfMissing('characters', 'world_id', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('user_personas', 'world_id', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('theater_scripts', 'identities_json', "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing('theater_scripts', 'world_id', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('theater_sessions', 'world_id', 'INTEGER NOT NULL DEFAULT 0');

/* ========== 9.5 剧场选项版本回填 ========== */
// 以前 options 行的 meta_json 只有 { options }，没记 narration_id / version。
// 这里按「前面最近一条旁白」补上归属，同一段旁的多个版本按 id 顺序编号；
// 已经有 narration_id 的行直接跳过，所以反复启动也不会改坏。
if (tableExists('theater_messages')) {
  const rows = db.prepare(`
    SELECT id, session_id, role, meta_json
    FROM theater_messages
    WHERE role IN ('narration', 'options')
    ORDER BY session_id ASC, id ASC
  `).all();

  const theaterLastNarration = {};
  const theaterVersionCounter = {};

  db.exec('BEGIN');

  try {
    for (const row of rows) {
      if (row.role === 'narration') {
        theaterLastNarration[row.session_id] = Number(row.id);
        continue;
      }

      let meta = {};

      try {
        meta = JSON.parse(row.meta_json || '{}') || {};
      } catch (e) {
        meta = {};
      }

      if (!Array.isArray(meta.options)) meta.options = [];

      const narrationId = theaterLastNarration[row.session_id] || 0;

      if (!narrationId) continue;

      const existingVersion = Number(meta.version) || 0;

      if (Number(meta.narration_id) === narrationId && existingVersion > 0) {
        if (existingVersion > (theaterVersionCounter[narrationId] || 0)) {
          theaterVersionCounter[narrationId] = existingVersion;
        }
        continue;
      }

      const version = (theaterVersionCounter[narrationId] || 0) + 1;
      theaterVersionCounter[narrationId] = version;

      meta.narration_id = narrationId;
      meta.version = version;
      meta.source = meta.source || 'legacy';

      db.prepare('UPDATE theater_messages SET meta_json = ? WHERE id = ?')
        .run(JSON.stringify(meta), row.id);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    console.error('[migrate] 剧场选项版本回填失败：' + (error && error.message));
  }
}

/* ========== 10. 默认世界 + 数据回填 ========== */
let defaultWorld = db.prepare(
  'SELECT * FROM worlds ORDER BY id ASC LIMIT 1'
).get();

if (!defaultWorld) {
  const result = db.prepare(
    'INSERT INTO worlds (name, description) VALUES (?, ?)'
  ).run('默认世界', '现有角色、人设和剧本都会归到这里');

  defaultWorld = db.prepare('SELECT * FROM worlds WHERE id = ?')
    .get(Number(result.lastInsertRowid));
}

const defaultWorldId = Number(defaultWorld.id);

for (const table of ['characters', 'user_personas', 'theater_scripts', 'theater_sessions']) {
  if (!tableExists(table)) continue;
  db.prepare(`
    UPDATE ${table} SET world_id = ?
    WHERE world_id = 0 OR world_id IS NULL
  `).run(defaultWorldId);
}

const active = db.prepare(
  "SELECT value FROM app_settings WHERE key = 'active_world_id'"
).get();

if (!active) {
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES ('active_world_id', ?)"
  ).run(String(defaultWorldId));
}

/* ========== 11. 通用节日种子 ========== */
const holidayCount = db.prepare(
  'SELECT COUNT(*) AS count FROM holidays'
).get().count;

if (Number(holidayCount) === 0) {
  const insert = db.prepare(`
    INSERT INTO holidays (name, rule_type, month, day, rule_text, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const list = [
    ['元旦', 'solar', 1, 1, '公历 1月1日', 10],
    ['春节', 'lunar', 1, 1, '农历 正月初一', 20],
    ['元宵节', 'lunar', 1, 15, '农历 正月十五', 30],
    ['清明节', 'solar', 4, 4, '公历 4月4日前后', 40],
    ['劳动节', 'solar', 5, 1, '公历 5月1日', 50],
    ['端午节', 'lunar', 5, 5, '农历 五月初五', 60],
    ['七夕', 'lunar', 7, 7, '农历 七月初七', 70],
    ['中秋节', 'lunar', 8, 15, '农历 八月十五', 80],
    ['国庆节', 'solar', 10, 1, '公历 10月1日', 90],
    ['重阳节', 'lunar', 9, 9, '农历 九月初九', 100],
    ['除夕', 'lunar', 12, 0, '农历 腊月最后一天', 110]
  ];

  for (const item of list) insert.run(...item);
}

/* ========== 20. 朋友圈 AI 互动 ========== */
// 评论可能是用户写的（character_id 为空），也可能是角色写的（存角色 id）。
addColumnIfMissing('moment_comments', 'character_id', 'INTEGER');

/* ========== 21. 模型用量账本 ========== */
// 每成功调一次模型记一行：界面据此算今天/7 天/30 天花了多少 token、估多少钱。
// 多账号下各库独立，不需要 user_id 列。
createTable(`
  CREATE TABLE IF NOT EXISTS usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source TEXT NOT NULL DEFAULT 'chat',
    model TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    character_id INTEGER NOT NULL DEFAULT 0,
    character_name TEXT NOT NULL DEFAULT ''
  );
`);

createTable(`
  CREATE INDEX IF NOT EXISTS idx_usage_logs_created ON usage_logs(created_at);
`);

  return { defaultWorldId };
};
