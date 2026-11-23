/**
 * 单个数据库文件的结构初始化（幂等）。
 * 以前这段在 db.js 里，只对一个库跑一次；现在每个账号一个库，所以抽成函数。
 */
const migrate = require('./migrate');

module.exports = function applySchema(conn) {
  conn.exec('PRAGMA journal_mode = WAL;');

conn.exec(`
  CREATE TABLE IF NOT EXISTS model_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL DEFAULT 'openai',
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT NOT NULL,
    extra_headers TEXT NOT NULL DEFAULT '{}',
    temperature REAL NOT NULL DEFAULT 0.8,
    max_tokens INTEGER NOT NULL DEFAULT 2048,
    stream INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

conn.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

conn.exec(`
  CREATE TABLE IF NOT EXISTS user_personas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    persona TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

conn.exec(`
  CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    handle TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    persona TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '',
    background TEXT NOT NULL DEFAULT '',
    speaking_style TEXT NOT NULL DEFAULT '',
    opening_line TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    birthday TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    source_card_json TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

function addColumn(table, column, definition) {
  const columns = conn.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumn('characters', 'is_pinned', 'INTEGER NOT NULL DEFAULT 0');
addColumn('characters', 'last_message_at', 'TEXT');
addColumn('characters', 'last_message_preview', 'TEXT');
addColumn('characters', 'user_persona_id', 'INTEGER NOT NULL DEFAULT 0');

conn.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

addColumn('messages', 'meta_json', "TEXT NOT NULL DEFAULT ''");
addColumn('messages', 'edited_at', 'TEXT');

conn.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_character
  ON messages(character_id, id DESC);
`);

// 表情包：以前由 sticker-api.js 在模块加载时建表，那时还没有「当前账号」，
// 表会建到 system.db 里，新注册的账号反而没有这张表（发消息 LEFT JOIN 就报
// no such table: stickers）。现在统一在这里建。
conn.exec(`
  CREATE TABLE IF NOT EXISTS stickers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL,
    image_url TEXT NOT NULL DEFAULT '',
    meaning TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_stickers_character
  ON stickers(character_id, id);
`);


  const result = migrate(conn);
  return result;
};
