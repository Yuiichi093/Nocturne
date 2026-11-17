'use strict';
// 定时备份。由 server.js 在启动时引入，之后常驻后台。
//
// 备份策略：
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

const ROOT = __dirname;
const BACKUP_DIR = path.join(ROOT, 'backups');
const DATA_DIR = path.join(ROOT, 'data');

const KEEP_DB = 7;
const KEEP_UPLOADS = 1;
const DAY = 24 * 60 * 60 * 1000;

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayStamp(d) {
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
}

function ensureDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function prune(prefix, ext, keep) {
  let files;
  try {
    files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
      .sort();
  } catch (e) {
    return;
  }
  while (files.length > keep) {
    const f = files.shift();
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      console.log('[备份] 清理旧备份 ' + f);
    } catch (e) {}
  }
}

function backupDatabase(db) {
  ensureDir();
  const name = 'saudade-' + dayStamp(new Date()) + '.db';
  const target = path.join(BACKUP_DIR, name);

  // 今天已经备过就跳过，避免每次重启都生成一堆重复文件
  if (fs.existsSync(target)) return;

  const escaped = target.replace(/'/g, "''");
  db.exec("VACUUM INTO '" + escaped + "'");
  console.log('[备份] 数据库快照 -> ' + name);
  prune('saudade-', '.db', KEEP_DB);
}

function backupUploads() {
  const dir = path.join(DATA_DIR, 'uploads');
  if (!fs.existsSync(dir)) return;

  let count = 0;
  try {
    count = fs.readdirSync(dir).length;
  } catch (e) {
    return;
  }
  if (count === 0) return;

  // 图片只会新增、不会修改，没必要天天备份；7 天一份足够
  let newest = 0;
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('uploads-') && f.endsWith('.tar.gz'))
      .sort();
    if (files.length) {
      newest = fs.statSync(path.join(BACKUP_DIR, files[files.length - 1])).mtimeMs;
    }
  } catch (e) {}

  if (Date.now() - newest < 7 * DAY) return;

  ensureDir();
  const name = 'uploads-' + dayStamp(new Date()) + '.tar.gz';
  try {
    execFileSync('tar', ['-czf', path.join(BACKUP_DIR, name), '-C', DATA_DIR, 'uploads'], {
      stdio: 'ignore'
    });
    console.log('[备份] 图片备份 -> ' + name);
    prune('uploads-', '.tar.gz', KEEP_UPLOADS);
  } catch (e) {
    console.error('[备份] 图片备份失败：' + e.message);
  }
}

function runOnce(db) {
  try {
    backupDatabase(db);
  } catch (e) {
    console.error('[备份] 数据库备份失败：' + e.message);
  }
  try {
    backupUploads();
  } catch (e) {
    console.error('[备份] 图片备份失败：' + e.message);
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
