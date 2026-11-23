/**
 * 旧数据扫描 / 认领恢复（Auth 事故应急）
 * ---------------------------------------------------------------
 * 场景：升级后 auth.db 丢了（或 WAL 没合并上），登录页显示「这台设备上还没有账号」，
 * 用户重新注册了账号，旧的 data/users/<id>/saudade.db 和 uploads 还躺在私有目录里。
 * App 私有目录外部工具读不到，只能让 App 自己扫、自己认领。
 *
 * 两个接口都挂在 /api/auth/ 前缀下（auth-api 的 gate 里这个前缀是放行的），所以要手输确认短语。
 *
 * 原则：
 *   1. 扫描只读——只 stat / readdir，不打开任何库（打开 sql.js 库会触发 WAL 合并改名，属于写操作）
 *   2. 认领只做「重命名」——旧目录先搬到暂存名，建好账号后再搬到新 id 名下；
 *      目标位置已有东西就改名成 .bak-<时间> 留档；任何一步失败都往回搬，绝不删任何文件
 *   3. 返回体不带 password_hash / api_key 这类敏感字段
 */
const fs = require('fs');
const path = require('path');
const authDb = require('./auth-db');
const db = require('./db');
const authApi = require('./auth-api');

const CONFIRM_PHRASE = '我要重置密码';
const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5-]{2,20}$/;
const BACKUP_RE = /\.(db|tar\.gz|tgz)$/i;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const normConfirm = (value) => String(value || '').replace(/\s+/g, '');

function confirmOk(body) {
  return normConfirm((body || {}).confirm) === CONFIRM_PHRASE;
}

function rejectConfirm(res) {
  return res.status(400).json({
    error: '确认短语不对，请原样输入：' + CONFIRM_PHRASE
  });
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch (error) {
    return null;
  }
}

const sizeOf = (file) => {
  const stat = safeStat(file);
  return stat ? stat.size : 0;
};

const mtimeOf = (file) => {
  const stat = safeStat(file);
  return stat ? stat.mtime.toISOString() : null;
};

const relPath = (full) => path.relative(db.dataDir, full).split(path.sep).join('/');

/** 文件名里能用的时间戳：2026-11-18T22-20-01-123Z */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 数一个目录里有多少文件（递归，上限防止扫爆） */
function countFiles(dir, limit) {
  const cap = limit || 3000;
  let total = 0;
  const stack = [dir];

  while (stack.length && total < cap) {
    const current = stack.pop();
    let entries = [];

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        total += 1;
        if (total >= cap) break;
      }
    }
  }

  return total;
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

/**
 * 读 auth.db 里的账号。
 * 不另开连接：sql.js 模式的落盘是 80ms debounce，另开只读连接可能读到「还没刷下去的旧文件」
 * （刚注册的账号看不见，会误判成 missing）。这里直接问正在运行的那条连接，看到的就是最新状态。
 * 注意 listUsers() 不带 id，所以按用户名再取一次完整行（getById 之外唯一能拿到 id 的口子）。
 */
function readAuthUsers() {
  const file = authDb.file;
  const exists = Boolean(safeStat(file));
  const size = sizeOf(file);

  // 文件都不在了（被删/没建起来）就别拿进程内存里的账号糊弄人，按磁盘实况报空
  if (!exists) {
    return { exists: false, size: 0, users: [] };
  }

  let users = [];

  try {
    users = authDb.listUsers().map((row) => {
      let id = null;

      try {
        const full = authDb.findByName(row.username);
        if (full) id = Number(full.id);
      } catch (error) {
        id = null;
      }

      return {
        id,
        username: row.username,
        nickname: row.nickname || row.username,
        created_at: row.created_at
      };
    });
  } catch (error) {
    users = [];
  }

  return { exists, size, users };
}

function listUserDirs() {
  let entries = [];

  try {
    entries = fs.readdirSync(db.usersRoot, { withFileTypes: true });
  } catch (error) {
    entries = [];
  }

  const dirs = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^\d+$/.test(entry.name)) continue;

    const dir = path.join(db.usersRoot, entry.name);
    const dbFile = path.join(dir, 'saudade.db');
    const uploads = path.join(dir, 'uploads');
    const uploadsStat = safeStat(uploads);

    dirs.push({
      name: entry.name,
      hasDb: Boolean(safeStat(dbFile)),
      dbSize: sizeOf(dbFile),
      hasUploads: Boolean(uploadsStat && uploadsStat.isDirectory()),
      uploadCount: uploadsStat && uploadsStat.isDirectory() ? countFiles(uploads) : 0,
      modified: mtimeOf(dbFile) || mtimeOf(dir)
    });
  }

  dirs.sort((a, b) => Number(a.name) - Number(b.name));
  return dirs;
}

/** data/auth.db* 里除 auth.db 本体以外的文件（WAL、WAL 的 .bak、临时文件…） */
function listAuthSidecars() {
  let names = [];

  try {
    names = fs.readdirSync(db.dataDir);
  } catch (error) {
    names = [];
  }

  return names
    .filter((name) => name.startsWith('auth.db') && name !== 'auth.db')
    .sort();
}

/** data/users/<id>/backups 与 data/backups 里的备份文件 */
function listBackups(userDirs) {
  const roots = [path.join(db.dataDir, 'backups')];

  for (const dir of userDirs) {
    roots.push(path.join(db.usersRoot, dir.name, 'backups'));
  }

  const out = [];

  for (const root of roots) {
    const stat = safeStat(root);

    if (!stat || !stat.isDirectory()) continue;

    let names = [];

    try {
      names = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      continue;
    }

    for (const entry of names) {
      if (!entry.isFile()) continue;
      if (!BACKUP_RE.test(entry.name)) continue;

      const full = path.join(root, entry.name);

      out.push({ name: relPath(full), size: sizeOf(full) });
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 有目录、但 auth.db 里没有对应用户的（=要救的） */
function findMissingUserDirs(userDirs) {
  const missing = [];

  for (const dir of userDirs) {
    let row = null;

    try {
      row = authDb.getById(Number(dir.name));
    } catch (error) {
      row = null;
    }

    if (!row) missing.push(dir);
  }

  return missing;
}

function buildScan() {
  const auth = readAuthUsers();
  const userDirs = listUserDirs();
  const missing = findMissingUserDirs(userDirs);

  // 待恢复的目录里，带库的按修改时间从新到旧排（最新的最可能是她真正在用的那个）
  const missingWithDb = missing
    .filter((dir) => dir.hasDb)
    .sort((a, b) => {
      const ta = a.modified || '';
      const tb = b.modified || '';
      if (ta !== tb) return ta < tb ? 1 : -1;
      return Number(a.name) - Number(b.name);
    });

  const primary = missingWithDb[0] || null;

  return {
    auth,
    wal: listAuthSidecars(),
    userDirs,
    legacy: {
      exists: Boolean(safeStat(db.legacyDbPath)),
      size: sizeOf(db.legacyDbPath)
    },
    backups: listBackups(userDirs),
    missingUsers: missing.map((dir) => dir.name),
    orphans: missingWithDb.map((dir) => path.posix.join('data/users', dir.name, 'saudade.db')),
    orphanDb: primary ? path.posix.join('data/users', primary.name, 'saudade.db') : null
  };
}

/* ------------------------------------------------------------------ */
/* 认领                                                                */
/* ------------------------------------------------------------------ */

/** 认领前把旧目录搬到暂存名：这样后面无论建号拿到什么 id，都不会覆盖正在恢复的库 */
function stageOldDir(dirName) {
  const source = path.join(db.usersRoot, dirName);
  const staged = path.join(db.usersRoot, '.recover-' + dirName + '-' + stamp());

  fs.renameSync(source, staged);
  return { source, staged };
}

function restoreStaged(staged, source) {
  try {
    if (safeStat(staged) && !safeStat(source)) {
      fs.renameSync(staged, source);
      return true;
    }
  } catch (error) {
    console.error('[恢复] 暂存目录搬回去失败：', error.message);
  }

  return false;
}

module.exports = function registerAuthRecover(app) {
  /** 扫一遍 data 目录：有没有能救的库、WAL 备份、老库、备份文件 */
  app.post('/api/auth/recover/scan', (req, res) => {
    const body = req.body || {};

    if (!confirmOk(body)) {
      return rejectConfirm(res);
    }

    let scan;

    try {
      scan = buildScan();
    } catch (error) {
      console.error('[恢复] 扫描失败：', error);
      return res.status(500).json({
        error: '扫描时出错了（可能是权限问题）：' + error.message
      });
    }

    console.log(
      '[恢复] 扫描完成：' + scan.auth.users.length + ' 个账号、' +
        scan.userDirs.length + ' 个账号目录、待恢复 ' + scan.missingUsers.length + ' 个'
    );

    res.json({
      ok: true,
      ...scan
    });
  });

  /**
   * 把某个 missing 目录认领给新建的账号。
   * 顺序：确认短语 → 校验目录/用户名 → 旧目录搬到暂存 → 建账号 → 目标位置让位 → 暂存搬到新 id
   * 任何一步失败都往回搬；绝不删任何文件。
   */
  app.post('/api/auth/recover/apply', (req, res) => {
    const body = req.body || {};

    if (!confirmOk(body)) {
      return rejectConfirm(res);
    }

    const dirName = String(body.dir === undefined || body.dir === null ? '' : body.dir).trim();

    if (!/^\d+$/.test(dirName)) {
      return res.status(400).json({ error: '要恢复的目录名不对（应该是数字）' });
    }

    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    // 和注册一样的校验，提前做——别把目录搬来搬去之后才发现用户名不合法
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({
        error: '用户名 2-20 个字符，可以是中文、字母、数字、下划线或短横线'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: '密码至少 6 位' });
    }

    if (authDb.findByName(username)) {
      return res.status(400).json({ error: '这个用户名已经有人用了' });
    }

    // 再扫一遍，确认这个目录真的还没被认领（防止两次点击 / 并发）
    let missing = [];

    try {
      missing = findMissingUserDirs(listUserDirs());
    } catch (error) {
      console.error('[恢复] 认领前扫描失败：', error);
      return res.status(500).json({ error: '认领前检查目录时出错了：' + error.message });
    }

    const targetDir = missing.find((dir) => dir.name === dirName);

    if (!targetDir) {
      return res.status(400).json({
        error: '这个目录不在可恢复列表里（可能已经被认领了，重新扫描看看）'
      });
    }

    const sourceDir = path.join(db.usersRoot, dirName);

    if (!safeStat(sourceDir) || !safeStat(sourceDir).isDirectory()) {
      return res.status(400).json({ error: '这个目录已经不在了：data/users/' + dirName });
    }

    let staged = null;
    let user = null;
    let finalDir = '';
    let parkedTarget = '';

    try {
      staged = stageOldDir(dirName);
      console.log('[恢复] 旧目录已暂存：' + relPath(staged.staged));

      // createUser 会顺带做 legacy 继承（第一个账号拿走 data/saudade.db）。
      // 旧目录已经先搬走了，所以就算新 id 恰好等于旧目录名，也不会覆盖正在恢复的库。
      user = authDb.createUser(username, password, body.nickname);
      finalDir = db.userDir(user.id);

      // 新 id 目录里如果已经有东西（legacy 继承来的、上次失败留下的），先改名留档
      if (safeStat(finalDir)) {
        parkedTarget = finalDir + '.bak-' + stamp();
        fs.renameSync(finalDir, parkedTarget);
        console.log('[恢复] 目标位置已有内容，已改名留档：' + relPath(parkedTarget));
      }

      fs.renameSync(staged.staged, finalDir);
      staged = null; // 搬成功，不再需要回滚
      console.log('[恢复] 已把 data/users/' + dirName + ' 认领给账号 #' + user.id);

      // 恢复完直接给新账号发登录态；这一步失败不影响数据已经救回来的事实
      let loggedIn = false;

      try {
        const { token } = authDb.createSession(user.id);
        authDb.touchLogin(user.id);
        authApi.setSessionCookie(res, token, authDb.SESSION_DAYS * 86400);
        loggedIn = true;
      } catch (error) {
        console.error('[恢复] 登录态创建失败（数据不受影响）：', error.message);
      }

      res.json({
        ok: true,
        user,
        restoredFrom: dirName,
        restoredTo: 'data/users/' + user.id,
        backupDir: parkedTarget ? relPath(parkedTarget) : null,
        loggedIn
      });
    } catch (error) {
      console.error('[恢复] 认领失败：', error);

      // 往回搬：目标位置的东西还原，暂存目录搬回原来的名字
      if (finalDir && parkedTarget && safeStat(parkedTarget)) {
        try {
          if (safeStat(finalDir)) {
            // 理论上到不了这里（搬暂存成功后才可能失败），保守起见先挪到一边再还原
            fs.renameSync(finalDir, finalDir + '.failed-' + stamp());
          }
          fs.renameSync(parkedTarget, finalDir);
        } catch (inner) {
          console.error('[恢复] 还原目标目录失败：', inner.message);
        }
      }

      let restored = false;

      if (staged) {
        restored = restoreStaged(staged.staged, staged.source);
      }

      const note = user
        ? '（刚建的账号 ' + username + ' 已经存在但还没有关联数据，可以换个用户名再试）'
        : '';

      res.status(500).json({
        error:
          '恢复失败了：' + String(error.message || '未知错误').split(db.dataDir).join('data') +
          (restored || !staged ? '，原来的目录已经还原，文件都还在' : '，暂存目录请手动检查') +
          note
      });
    }
  });
};
