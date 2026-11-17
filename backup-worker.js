'use strict';
// 定时备份。由 server.js 在启动时引入，之后常驻后台。
//
// 备份策略（每个账号各备各的）：
//   数据库：每天一份一致性快照（VACUUM INTO），保留最近 7 份
//   图片  ：每 7 天一份 tar.gz，保留最近 1 份
//
// 为什么要用 VACUUM INTO 而不是直接 cp：
// 数据库跑在 WAL 模式下，直接复制 .db 文件可能拿到一个缺了最新事务的
// 残缺库；VACUUM INTO 会生成一个自洽的完整副本，不会出现"备份了但打不开"。
//
// 也可以手动跑一次：  node backup-worker.js

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const KEEP_DB = 7;
const KEEP_UPLOADS = 1;
const DAY = 24 * 60 * 60 * 1000;

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayStamp(d) {
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
}

function prune(dir, prefix, ext, keep) {
  let files;
  try {
    files = fs.readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
      .sort();
  } catch (e) {
    return;
  }
  while (files.length > keep) {
    const f = files.shift();
    try {
      fs.unlinkSync(path.join(dir, f));
      console.log('[备份] 清理旧备份 ' + f);
    } catch (e) {}
  }
}

// 下面几个函数都要在 db.runWithUser(id, ...) 里调用：
// 不带账号参数的 db.xxx 会落到「当前上下文」那个账号头上
function backupDatabase(db, id) {
  const dir = db.backupsDir(id);
  fs.mkdirSync(dir, { recursive: true });

  const name = 'saudade-' + dayStamp(new Date()) + '.db';
  const target = path.join(dir, name);

  // 今天已经备过就跳过，避免每次重启都生成一堆重复文件
  if (fs.existsSync(target)) return;

  const escaped = target.replace(/'/g, "''");
  db.exec("VACUUM INTO '" + escaped + "'");
  console.log('[备份] 账号 ' + id + ' 数据库快照 -> ' + name);
  prune(dir, 'saudade-', '.db', KEEP_DB);
}

function backupUploads(db, id) {
  const dir = db.uploadsDir(id);
  if (!fs.existsSync(dir)) return;

  let count = 0;
  try {
    count = fs.readdirSync(dir).length;
  } catch (e) {
    return;
  }
  if (count === 0) return;

  const backupDir = db.backupsDir(id);
  fs.mkdirSync(backupDir, { recursive: true });

  // 图片只会新增、不会修改，没必要天天备份；7 天一份足够
  let newest = 0;
  try {
    const files = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith('uploads-') && f.endsWith('.tar.gz'))
      .sort();
    if (files.length) {
      newest = fs.statSync(path.join(backupDir, files[files.length - 1])).mtimeMs;
    }
  } catch (e) {}

  if (Date.now() - newest < 7 * DAY) return;

  const name = 'uploads-' + dayStamp(new Date()) + '.tar.gz';
  try {
    execFileSync('tar', ['-czf', path.join(backupDir, name), '-C', path.dirname(dir), 'uploads'], {
      stdio: 'ignore'
    });
    console.log('[备份] 账号 ' + id + ' 图片备份 -> ' + name);
    prune(backupDir, 'uploads-', '.tar.gz', KEEP_UPLOADS);
  } catch (e) {
    console.error('[备份] 账号 ' + id + ' 图片备份失败：' + e.message);
  }
}

function runOnce(db) {
  const ids = db.listUserIds();

  if (!ids.length) {
    console.log('[备份] 还没有账号，这次跳过');
    return;
  }

  for (const id of ids) {
    // 一个账号失败不能拖累其它账号
    try {
      db.runWithUser(id, () => {
        try {
          backupDatabase(db, id);
        } catch (e) {
          console.error('[备份] 账号 ' + id + ' 数据库备份失败：' + e.message);
        }
        try {
          backupUploads(db, id);
        } catch (e) {
          console.error('[备份] 账号 ' + id + ' 图片备份失败：' + e.message);
        }
      });
    } catch (e) {
      console.error('[备份] 账号 ' + id + ' 备份失败：' + e.message);
    }
  }
}

module.exports = function startBackup(db) {
  // 启动 20 秒后再检查，避免和服务器启动抢资源
  setTimeout(() => runOnce(db), 20 * 1000).unref();
  // 之后每 6 小时检查一次；是否真正备份由"今天是否已备过"决定
  setInterval(() => runOnce(db), 6 * 60 * 60 * 1000).unref();
};

// 允许手动执行：node backup-worker.js
if (require.main === module) {
  const db = require('./db');
  runOnce(db);
  setTimeout(() => process.exit(0), 200);
}
