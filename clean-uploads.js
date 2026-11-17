#!/usr/bin/env node
// 清理 data/uploads 里没有任何数据库记录引用的图片（换头像/换背景/删角色后留下的）。
//
//   node clean-uploads.js            只看清单，不删任何东西
//   node clean-uploads.js --delete   真删（会先把整个 uploads 打包备份到 backups/）
//
// 判断依据：扫描数据库所有表的全部文本字段，凡是出现过 /uploads/xxx 的都算被引用。
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');

const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');
const BACKUP_DIR = path.join(__dirname, 'backups');
const DO_DELETE = process.argv.includes('--delete');

function collectReferencedPaths() {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all().map((row) => row.name);

  const referenced = new Set();

  for (const table of tables) {
    let columns;
    try {
      columns = db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name);
    } catch (e) {
      continue;
    }

    for (const column of columns) {
      let rows;
      try {
        rows = db.prepare(
          'SELECT ' + column + ' AS value FROM ' + table +
          " WHERE " + column + " LIKE '%/uploads/%'"
        ).all();
      } catch (e) {
        continue;
      }

      for (const row of rows) {
        const matches = String(row.value || '').match(/\/uploads\/[^"')\s]+/g) || [];
        for (const item of matches) referenced.add(item);
      }
    }
  }

  return referenced;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function main() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    console.log('没有 data/uploads 目录，无需清理。');
    return;
  }

  const referenced = collectReferencedPaths();
  const files = fs.readdirSync(UPLOAD_DIR).filter((name) => {
    return fs.statSync(path.join(UPLOAD_DIR, name)).isFile();
  });

  const orphans = [];
  let orphanBytes = 0;

  for (const name of files) {
    if (referenced.has('/uploads/' + name)) continue;
    const size = fs.statSync(path.join(UPLOAD_DIR, name)).size;
    orphans.push({ name, size });
    orphanBytes += size;
  }

  console.log('uploads 文件总数 : ' + files.length);
  console.log('被数据库引用     : ' + (files.length - orphans.length));
  console.log('无人引用的孤儿   : ' + orphans.length + '（' + formatSize(orphanBytes) + '）');
  console.log('');

  if (orphans.length === 0) {
    console.log('很干净，没有需要清理的文件。');
    return;
  }

  console.log('孤儿文件清单：');
  for (const item of orphans) {
    console.log('  ' + item.name + '  ' + formatSize(item.size));
  }
  console.log('');

  if (!DO_DELETE) {
    console.log('以上只是预览，没有删除任何文件。');
    console.log('确认无误后执行：node clean-uploads.js --delete');
    return;
  }

  // 删除前先把整个 uploads 打包备份，反悔了还能找回来
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
    '_' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
  const backupPath = path.join(BACKUP_DIR, 'uploads-' + stamp + '.tar.gz');

  try {
    const { execFileSync } = require('child_process');
    execFileSync('tar', ['-czf', backupPath, '-C', path.join(__dirname, 'data'), 'uploads']);
    console.log('已备份到：' + backupPath);
  } catch (e) {
    console.error('备份失败，为安全起见已中止删除：' + e.message);
    process.exit(1);
  }

  let removed = 0;
  for (const item of orphans) {
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, item.name));
      removed += 1;
    } catch (e) {
      console.error('删除失败 ' + item.name + '：' + e.message);
    }
  }

  console.log('');
  console.log('已删除 ' + removed + ' 个文件，释放 ' + formatSize(orphanBytes));
}

main();
