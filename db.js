/**
 * 数据库入口（多账号版）
 * ---------------------------------------------------------------
 * 每个账号一份独立的库：data/users/<id>/saudade.db
 * 老的 data/saudade.db 会被第一个注册的账号继承。
 *
 * 上层代码照旧 `const db = require('./db')` 然后 db.prepare(...)，
 * 这里用 AsyncLocalStorage 把「当前请求属于哪个账号」带下去，
 * 所以各个 api 模块一行都不用改。
 */
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');

// ---------------------------------------------------------------------------
// 驱动选择：优先用 Node 自带的 node:sqlite；拿不到（Node 18 / APK）就用 sql.js
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
const usersRoot = path.join(dataDir, 'users');
const legacyDbPath = path.join(dataDir, 'saudade.db');
const legacyUploads = path.join(dataDir, 'uploads');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(usersRoot, { recursive: true });

const applySchema = require('./schema');
const systemDbPath = path.join(dataDir, 'system.db');

function openDatabase(file, options) {
  // node:sqlite 对第二个参数很挑剔：显式传 undefined 会报类型错误
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

// ---------------------------------------------------------------------------
// 每个账号的目录与连接
// ---------------------------------------------------------------------------
const connections = new Map();

function userDir(userId) {
  return path.join(usersRoot, String(userId));
}

function userDbPath(userId) {
  return path.join(userDir(userId), 'saudade.db');
}

function contextUserId() {
  const store = als.getStore();
  return store ? store.userId : null;
}

function uploadsDir(userId) {
  const id = userId == null ? contextUserId() : userId;
  if (!id) {
    return path.join(dataDir, 'uploads');
  }
  const conn = openUserDatabase(id);
  return path.join(path.dirname(conn.file), 'uploads');
}

function backupsDir(userId) {
  const id = userId == null ? contextUserId() : userId;
  if (!id) {
    return path.join(dataDir, 'backups');
  }
  return path.join(userDir(id), 'backups');
}

function ensureUserDirs(userId) {
  const dir = userDir(userId);
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  return dir;
}

function openUserDatabase(userId) {
  const id = Number(userId);
  if (connections.has(id)) {
    return connections.get(id);
  }
  ensureUserDirs(id);
  const file = userDbPath(id);
  const conn = openDatabase(file);
  applySchema(conn);
  conn.userId = id;
  conn.file = file;
  connections.set(id, conn);
  return conn;
}

function listUserIds() {
  try {
    return fs.readdirSync(usersRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .filter((id) => fs.existsSync(userDbPath(id)))
      .sort((a, b) => a - b);
  } catch (error) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 老数据继承：第一个账号拿走原来的库与图片
// ---------------------------------------------------------------------------
function hasLegacyData() {
  return fs.existsSync(legacyDbPath);
}

function adoptLegacyData(userId) {
  const dir = ensureUserDirs(userId);
  const moves = [];

  if (fs.existsSync(legacyDbPath)) {
    moves.push([legacyDbPath, path.join(dir, 'saudade.db')]);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(legacyDbPath + suffix)) {
        moves.push([legacyDbPath + suffix, path.join(dir, 'saudade.db' + suffix)]);
      }
    }
  }

  for (const [from, to] of moves) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  }

  if (fs.existsSync(legacyUploads)) {
    const target = path.join(dir, 'uploads');
    for (const name of fs.readdirSync(legacyUploads)) {
      const src = path.join(legacyUploads, name);
      if (!fs.statSync(src).isFile()) continue;
      fs.renameSync(src, path.join(target, name));
    }
    fs.rmSync(legacyUploads, { recursive: true, force: true });
  }

  return true;
}

// 启动阶段（还没收到任何请求、不知道是哪个账号）有些模块会做一遍防御性的
// 建表/补列。那些语句跟「谁在用」无关，给它们一个中立的 system.db，
// 免得每个账号的库被启动代码顺手改一遍。
let systemConnection = null;
function systemDb() {
  if (!systemConnection) {
    systemConnection = openDatabase(systemDbPath);
    applySchema(systemConnection);
  }
  return systemConnection;
}

// ---------------------------------------------------------------------------
// 上下文路由
// ---------------------------------------------------------------------------
const als = new AsyncLocalStorage();

const helpers = {
  driver,
  dataDir,
  usersRoot,
  userDir,
  userDbPath,
  ensureUserDirs,
  uploadsDir,
  backupsDir,
  openUserDatabase,
  openDatabase,
  snapshotTo,
  listUserIds,
  hasLegacyData,
  adoptLegacyData,
  legacyDbPath,

  /** 在该账号的库上执行 fn，期间所有 db.xxx 都落到它头上 */
  runWithUser(userId, fn) {
    const conn = openUserDatabase(userId);
    return als.run({ userId: Number(userId), conn }, fn);
  },

  /** 当前上下文的账号 id，不在请求里则为 null */
  currentUserId: contextUserId,

  /** 当前上下文的连接（调试用） */
  currentConnection() {
    const store = als.getStore();
    return store ? store.conn : null;
  },

  /** 把还没落盘的（sql.js）数据都刷下去 */
  flushAll() {
    const done = [];
    for (const conn of connections.values()) {
      if (typeof conn.flush === 'function') {
        try {
          conn.flush();
        } catch (error) {
          // 刷不下去也得让别的库继续
        }
      }
      done.push(conn);
    }
    return done.length;
  },

  closeAll() {
    helpers.flushAll();
    for (const conn of connections.values()) {
      try {
        conn.close();
      } catch (error) {
        // 关不掉就算了，进程都要退了
      }
    }
    connections.clear();
  },
};

// 代理：SQL 方法都转发给「当前账号」的连接
const db = new Proxy(helpers, {
  get(target, prop, receiver) {
    if (prop in target) {
      return Reflect.get(target, prop, receiver);
    }
    const store = als.getStore();
    const conn = store ? store.conn : systemDb();
    const value = conn[prop];
    return typeof value === 'function' ? value.bind(conn) : value;
  },
  has(target, prop) {
    return prop in target;
  },
});

module.exports = db;

// sql.js 落盘是定时导出的，进程退出前补一次
const shutdown = () => {
  try {
    helpers.closeAll();
  } catch (error) {
    // 退出路径上别抛异常
  }
};
process.on('exit', shutdown);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown();
    process.exit(0);
  });
}
