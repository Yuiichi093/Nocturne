/**
 * 账号与登录态（全局一份，放在 data/auth.db）
 * 和内容库分开放：内容库每个账号一个，账号表只有一个。
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const authFile = path.join(db.dataDir, 'auth.db');
fs.mkdirSync(path.dirname(authFile), { recursive: true });

const conn = db.openDatabase(authFile);
conn.exec('PRAGMA journal_mode = WAL;');
conn.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    nickname TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TEXT
  );
`);
conn.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
  );
`);
conn.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);');

const SESSION_DAYS = 30;

function scryptHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return 'scrypt$' + salt + '$' + derived;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const salt = parts[1];
  const expected = Buffer.from(parts[2], 'hex');
  let derived;
  try {
    derived = crypto.scryptSync(String(password), salt, expected.length);
  } catch (error) {
    return false;
  }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function countUsers() {
  return conn.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname || row.username,
    created_at: row.created_at,
  };
}

function findByName(username) {
  return conn.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
}

function getById(id) {
  return conn.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
}

function createUser(username, password, nickname) {
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5-]{2,20}$/.test(name)) {
    throw new Error('用户名 2-20 个字符，可以是中文、字母、数字、下划线或短横线');
  }
  if (String(password || '').length < 6) {
    throw new Error('密码至少 6 位');
  }
  if (findByName(name)) {
    throw new Error('这个用户名已经有人用了');
  }

  const first = countUsers() === 0;
  const info = conn.prepare(
    'INSERT INTO users (username, nickname, password_hash) VALUES (?, ?, ?)'
  ).run(name, String(nickname || name).trim() || name, scryptHash(password));

  const id = Number(info.lastInsertRowid);

  // 第一个账号继承老版本的数据（原来的 data/saudade.db 和图片）
  if (first && db.hasLegacyData()) {
    try {
      db.adoptLegacyData(id);
      console.log('[账号] 第一个账号继承了原有数据');
    } catch (error) {
      console.error('[账号] 继承原有数据失败:', error.message);
    }
  }

  return publicUser(getById(id));
}

function touchLogin(id) {
  conn.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(Number(id));
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  conn.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(hashToken(token), Number(userId), expires);
  return { token, expires };
}

function deleteSession(token) {
  if (!token) return false;
  const info = conn.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  return Number(info.changes) > 0;
}

function userByToken(token) {
  if (!token) return null;
  const row = conn.prepare(`
    SELECT users.* FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > datetime('now')
  `).get(hashToken(token));
  return row || null;
}

function changePassword(userId, newPassword) {
  if (String(newPassword || '').length < 6) {
    throw new Error('新密码至少 6 位');
  }
  conn.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(scryptHash(newPassword), Number(userId));
  // 换密码后其它设备上的登录全部失效，只保留当前这条
  return true;
}

function dropSessionsOf(userId, exceptToken) {
  if (exceptToken) {
    conn.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')
      .run(Number(userId), hashToken(exceptToken));
  } else {
    conn.prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(userId));
  }
}

function purgeExpired() {
  conn.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
}

purgeExpired();

module.exports = {
  file: authFile,
  countUsers,
  findByName,
  getById,
  createUser,
  publicUser,
  verifyPassword,
  createSession,
  deleteSession,
  userByToken,
  changePassword,
  dropSessionsOf,
  touchLogin,
  purgeExpired,
  SESSION_DAYS,
};
