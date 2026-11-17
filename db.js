const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// 驱动选择：优先用 Node 自带的 node:sqlite（快、行为最接近原版）；
// 拿不到（Node 18 / nodejs-mobile / 打包成 APK 时）就用 sql.js 的 WASM 兼容层。
// 强制指定：ROLEPHONE_SQLITE=sqljs / ROLEPHONE_SQLITE=native
// ---------------------------------------------------------------------------
const driverPref = String(process.env.ROLEPHONE_SQLITE || '').trim().toLowerCase();

let DatabaseSync;
let driver;

if (driverPref === 'sqljs') {
  ({ DatabaseSync } = require('./db-sqljs'));
  driver = 'sqljs';
} else if (driverPref === 'native' || driverPref === 'node:sqlite') {
  ({ DatabaseSync } = require('node:sqlite'));
  driver = 'node:sqlite';
} else {
  try {
    ({ DatabaseSync } = require('node:sqlite'));
    driver = 'node:sqlite';
  } catch (error) {
    ({ DatabaseSync } = require('./db-sqljs'));
    driver = 'sqljs';
  }
}

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'saudade.db');

const db = new DatabaseSync(dbPath);

console.log(
  '[数据库] 驱动 = ' +
    (driver === 'node:sqlite'
      ? 'node:sqlite（Node 内置 SQLite）'
      : 'sql.js（WebAssembly 兼容层）') +
    '，库文件 = ' + dbPath
);

db.driver = driver;

// 给上层（backup-api）用的两个能力：
//   openDatabase(file, opts) —— 按当前驱动再开一个连接
//   snapshotTo(source, file) —— 做一致性快照：先试 VACUUM INTO，不行就导出字节
function openDatabase(file, options) {
  // node:sqlite 对第二个参数很挑剔：显式传 undefined 会报
  // TypeError: The "options" argument must be an object，所以只有真要选项时才带
  return options ? new DatabaseSync(file, options) : new DatabaseSync(file);
}

function snapshotTo(source, target) {
  const escaped = String(target).replace(/'/g, "''");

  try {
    source.exec("VACUUM INTO '" + escaped + "'");
    return 'vacuum';
  } catch (error) {
    if (typeof source.exportTo === 'function') {
      source.exportTo(target);
      return 'export';
    }
    if (typeof source.export === 'function') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(source.export()));
      return 'export';
    }
    throw error;
  }
}

db.openDatabase = openDatabase;
db.snapshotTo = snapshotTo;

// sql.js 路径下数据先写内存再 debounce 落盘，备份前先强制落一次盘；
// node:sqlite 没有这个概念，flush() 只是空操作
const driverFlush = typeof db.flush === 'function' ? db.flush.bind(db) : null;

db.flushNow = function flushNow() {
  if (driverFlush) driverFlush();
  return true;
};

db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
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

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

db.exec(`
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

db.exec(`
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

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing('characters', 'is_pinned', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('characters', 'last_message_at', 'TEXT');
addColumnIfMissing('characters', 'last_message_preview', 'TEXT');
addColumnIfMissing('characters', 'user_persona_id', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

addColumnIfMissing('messages', 'meta_json', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('messages', 'edited_at', 'TEXT');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_character
  ON messages(character_id, id DESC);
`);

module.exports = db;

// 统一数据库迁移：必须放在 module.exports 之后，
// 因为 migrate.js 会 require('./db')。CommonJS 缓存此时已把
// module.exports 指向 db 实例，迁移脚本拿到的就是可用的连接。
require('./migrate');
