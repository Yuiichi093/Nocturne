const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const multer = require('multer');

const execFileAsync = promisify(execFile);

module.exports = function (app, db) {
  const root = __dirname;
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(dataDir, 'backups');
  const restoreDir = path.join(dataDir, 'restore');

  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(restoreDir, { recursive: true });

  const restoreStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, restoreDir),
    filename: (req, file, cb) => cb(null, 'backup.tar.gz')
  });

  const restoreUpload = multer({
    storage: restoreStorage,
    limits: { fileSize: 500 * 1024 * 1024 }
  });

  app.get('/api/backup/download', async (req, res) => {
    try {
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-');

      const stage = path.join(backupDir, 'stage-' + stamp);
      const archive = path.join(
        backupDir,
        'nocturne-backup-' + stamp + '.tar.gz'
      );

      fs.mkdirSync(stage, { recursive: true });
      fs.mkdirSync(path.join(stage, 'uploads'), { recursive: true });

      const tempDb = path.join(stage, 'saudade.db');
      const dbPath = path.join(dataDir, 'saudade.db');

      // 以前靠 sqlite3 命令行做热备份，可它不一定装了。
      // 现在两种驱动都走同一套：能 VACUUM INTO 就 VACUUM（node:sqlite），
      // 不能就导出字节（sql.js 的 WASM 文件系统写不到真实磁盘）。
      // 先把内存里还没落盘的改动刷一次，避免快照落后 80ms。
      if (typeof db.flushNow === 'function') db.flushNow();

      const source = db.openDatabase(dbPath, { readOnly: true });

      try {
        db.snapshotTo(source, tempDb);
      } finally {
        source.close();
      }

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

      const uploadsDir = path.join(dataDir, 'uploads');

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
      res.status(500).json({
        error: error.message || '备份失败'
      });
    }
  });

  app.post(
    '/api/backup/restore',
    restoreUpload.single('backup'),
    (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: '没有收到备份文件' });
      }

      res.json({
        ok: true,
        message: '备份已上传，正在恢复并重启服务'
      });

      setTimeout(() => {
        const child = spawn(
          'bash',
          [path.join(root, 'restore.sh')],
          {
            detached: true,
            stdio: 'ignore'
          }
        );

        child.unref();
      }, 1000);
    }
  );
};
