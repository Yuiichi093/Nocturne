const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const multer = require('multer');

const execFileAsync = promisify(execFile);

module.exports = function (app, db) {
  // 备份、暂存、恢复都用当前账号自己的目录：data/users/<id>/backups
  // （不带参数时 db 会按当前请求的账号解析，这里显式传 id 更直观）
  function backupDirFor(userId) {
    const dir = db.backupsDir(userId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function requireUser(req, res) {
    if (req.user) return true;
    res.status(401).json({ error: '未登录' });
    return false;
  }

  function stampNow() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  // 恢复包是用户自己上传的文件，解压前先看一遍条目：
  // 带 ../ 或绝对路径的包会写到账号目录之外，绝不能放行
  function assertSafeArchive(listOutput) {
    for (const line of String(listOutput).split('\n')) {
      const entry = line.trim();
      if (!entry) continue;
      if (entry.startsWith('/') || entry.split('/').includes('..')) {
        const error = new Error('备份包里有可疑路径，已拒绝恢复：' + entry.slice(0, 80));
        error.badRequest = true;
        throw error;
      }
    }
  }

  // 老备份包的库在根上，也可能被套了一层 data/ 或目录；挨个位置找一遍
  function locateRestoredDb(baseDir) {
    const candidates = [
      path.join(baseDir, 'saudade.db'),
      path.join(baseDir, 'data', 'saudade.db')
    ];

    for (const file of candidates) {
      if (fs.existsSync(file)) return file;
    }

    const queue = [{ dir: baseDir, depth: 0 }];
    while (queue.length) {
      const { dir, depth } = queue.shift();
      if (depth > 3) continue;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === 'saudade.db') return full;
        if (entry.isDirectory()) queue.push({ dir: full, depth: depth + 1 });
      }
    }

    return '';
  }

  // 只认 Nocturne 自己的库，免得把随便一个 sqlite 文件恢复进来把账号搞坏
  function validateRestoredDb(file) {
    const conn = db.openDatabase(file);
    try {
      const tables = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      ).all().map((row) => row.name);

      const core = ['characters', 'messages', 'model_profiles', 'app_settings'];
      if (!tables.some((name) => core.includes(name))) {
        throw new Error('这个备份里没有 Nocturne 的数据表');
      }
    } finally {
      conn.close();
    }
  }

  // 恢复上传先落到当前账号的 backups/restore，别人的目录不碰
  const restoreStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        if (!req.user) throw new Error('未登录');
        cb(null, backupDirFor(req.user.id));
      } catch (error) {
        cb(error);
      }
    },
    filename: (req, file, cb) => cb(null, 'restore-upload.tar.gz')
  });

  const restoreUpload = multer({
    storage: restoreStorage,
    limits: { fileSize: 500 * 1024 * 1024 }
  });

  app.get('/api/backup/download', async (req, res) => {
    if (!requireUser(req, res)) return;

    const userId = req.user.id;
    let stage = '';

    try {
      const stamp = stampNow();
      const backupDir = backupDirFor(userId);

      stage = path.join(backupDir, 'stage-' + stamp);
      const archive = path.join(
        backupDir,
        'nocturne-backup-' + stamp + '.tar.gz'
      );

      fs.mkdirSync(stage, { recursive: true });
      fs.mkdirSync(path.join(stage, 'uploads'), { recursive: true });

      const tempDb = path.join(stage, 'saudade.db');

      // 以前靠 sqlite3 命令行做热备份，可它不一定装了。
      // 现在两种驱动都走同一套：能 VACUUM INTO 就 VACUUM（node:sqlite），
      // 不能就导出字节（sql.js 的 WASM 文件系统写不到真实磁盘）。
      // 直接拿当前账号的活连接做快照，别再去猜库文件路径。
      const source = db.currentConnection();

      if (!source) {
        throw new Error('拿不到当前账号的数据库连接');
      }

      // sql.js 的改动还在内存里，快照前先刷一次，避免落后 80ms
      if (typeof source.flush === 'function') source.flush();

      db.snapshotTo(source, tempDb);

      // 默认不把 API Key 打包进备份：备份下载会落到「下载」这种共享目录，
      // 手机里其它 App 理论上就能读到，不该顺带泄露密钥
      const withKeys = String(req.query.with_keys || '') === '1';

      if (!withKeys) {
        const copy = db.openDatabase(tempDb);

        try {
          copy.prepare("UPDATE model_profiles SET api_key = ''").run();
        } finally {
          copy.close();
        }

        fs.writeFileSync(
          path.join(stage, '备份说明.txt'),
          [
            '这个备份里没有 API Key（为了安全，默认不带）。',
            '恢复之后去「模型设置」把每个模型的 Key 重新填一次就行。',
            '如果你确实需要连 Key 一起备份，在下载按钮旁边勾上「带上 API Key」再下载。',
            '',
            '生成时间：' + new Date().toLocaleString('zh-CN')
          ].join('\n')
        );
      }

      // 只带当前账号的图片，别人的 uploads 不该出现在这个包里
      const uploadsDir = db.uploadsDir(userId);

      if (fs.existsSync(uploadsDir)) {
        fs.cpSync(
          uploadsDir,
          path.join(stage, 'uploads'),
          { recursive: true }
        );
      }

      await execFileAsync('tar', [
        '-czf',
        archive,
        '-C',
        stage,
        '.'
      ]);

      fs.rmSync(stage, { recursive: true, force: true });
      stage = '';

      res.download(
        archive,
        path.basename(archive),
        (error) => {
          if (!error) {
            fs.unlink(archive, () => {});
          }
        }
      );
    } catch (error) {
      console.error('[备份] 导出失败：', error);
      if (stage) fs.rmSync(stage, { recursive: true, force: true });
      res.status(500).json({
        error: error.message || '备份失败'
      });
    }
  });

  app.post(
    '/api/backup/restore',
    restoreUpload.single('backup'),
    async (req, res) => {
      if (!requireUser(req, res)) return;

      if (!req.file) {
        return res.status(400).json({ error: '没有收到备份文件' });
      }

      const userId = req.user.id;
      const archive = req.file.path;
      const backupDir = backupDirFor(userId);
      const extractDir = path.join(backupDir, 'restore-' + stampNow());

      try {
        // 先看条目再解压，避免备份包里的 ../ 写到账号目录外面
        let listing = null;

        try {
          listing = await execFileAsync('tar', ['-tzf', archive]);
        } catch (tarError) {
          // 用户传错文件时不要把 tar 的报错和服务器绝对路径回显出来
          const bad = new Error('这个文件不是有效的 .tar.gz 备份包，换一个再试');
          bad.badRequest = true;
          throw bad;
        }
        assertSafeArchive(listing.stdout);

        fs.mkdirSync(extractDir, { recursive: true });
        await execFileAsync('tar', ['-xzf', archive, '-C', extractDir]);

        const restoredDb = locateRestoredDb(extractDir);

        if (!restoredDb) {
          return res.status(400).json({ error: '无效备份：里面没有 saudade.db' });
        }

        validateRestoredDb(restoredDb);

        // 恢复前先给自己留一份现状，万一新库打不开还能退回来
        const safety = path.join(backupDir, 'before-restore-' + stampNow() + '.db');
        const current = db.currentConnection();

        if (current) {
          if (typeof current.flush === 'function') current.flush();
          db.snapshotTo(current, safety);
        }

        // 库文件正被连接占着，只能先全部关掉再换文件（其它账号下次访问会自动重开，
        // 它们的库文件一个字节都不动），换完立刻重开当前账号的库
        // 只关当前账号的连接：closeAll() 会连累别的账号在途请求（database is closed）
        db.closeUser(userId);

        const targetDb = db.userDbPath(userId);

        for (const suffix of ['', '-wal', '-shm']) {
          fs.rmSync(targetDb + suffix, { force: true });
        }

        fs.copyFileSync(restoredDb, targetDb);

        try {
          // openUserDatabase 会顺手补结构，老备份缺的列在这里补上
          db.openUserDatabase(userId);
        } catch (error) {
          // 新库跑不起来就把刚才的快照放回去，别把账号留在打不开的状态
          if (fs.existsSync(safety)) {
            try {
              fs.copyFileSync(safety, targetDb);
              db.openUserDatabase(userId);
            } catch (rollbackError) {
              console.error('[恢复] 回滚失败：', rollbackError);
            }
          }
          throw new Error('恢复后的数据库打不开，已回退到恢复前的状态：' + error.message);
        }

        // 库能用了再换图片目录；老备份没有 uploads 就清空，避免新旧图片混在一起
        const restoredUploads = path.join(path.dirname(restoredDb), 'uploads');
        const uploadsTarget = db.uploadsDir(userId);

        fs.rmSync(uploadsTarget, { recursive: true, force: true });

        if (fs.existsSync(restoredUploads) && fs.statSync(restoredUploads).isDirectory()) {
          fs.cpSync(restoredUploads, uploadsTarget, { recursive: true });
        } else {
          fs.mkdirSync(uploadsTarget, { recursive: true });
        }

        res.json({
          ok: true,
          message: '备份已恢复到当前账号，刷新页面就能看到数据。'
        });
      } catch (error) {
        console.error('[恢复] 失败：', error);
        res.status(error.badRequest ? 400 : 500).json({ error: error.message || '恢复失败' });
      } finally {
        // 解压出来的东西和上传的包都不留着：里面可能有 API Key 和整库数据
        fs.rmSync(extractDir, { recursive: true, force: true });
        fs.rmSync(archive, { force: true });
      }
    }
  );
};
