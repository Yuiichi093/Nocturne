#!/usr/bin/env node
/**
 * 把仓库里的 JS 应用打成一个 zip 放进 assets。
 * 为什么是 zip：APK 首次启动时逐个解几千个文件太慢，一个压缩包一次解开快得多。
 *
 * 由 Gradle 的 stageNodeProject 任务在 preBuild 阶段调用。
 * 只装运行期需要的东西；data/ logs/ backups/ 这些运行期产物不进安装包。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const STAGE = path.join(__dirname, '.staging', 'nodejs-project');
const ASSETS = path.join(__dirname, 'app', 'src', 'main', 'assets');
const ZIP_OUT = path.join(ASSETS, 'nodejs-project.zip');

// 搬进去的顶层内容
const SKIP_DIRS = new Set([
  'node_modules', 'data', 'logs', 'backups', '_legacy', 'android', 'docs', '.git',
]);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (entry.isSymbolicLink()) {
      try {
        fs.copyFileSync(fs.realpathSync(from), to); // .bin 里的软链解开成实体文件
      } catch (e) {
        // 断链跳过
      }
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function main() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    console.error('没找到 node_modules，先在仓库根目录 npm install');
    process.exit(1);
  }

  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  // 1. 根目录的 js 与 package.json，加上 public/
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    const name = entry.name;
    if (entry.isFile()) {
      if (name.endsWith('.js') || name === 'package.json') {
        fs.copyFileSync(path.join(ROOT, name), path.join(STAGE, name));
      }
    } else if (entry.isDirectory() && name === 'public') {
      copyDir(path.join(ROOT, name), path.join(STAGE, name));
    }
  }

  // 2. 依赖（跳过测试/文档这类运行时用不上的东西）
  copyDir(path.join(ROOT, 'node_modules'), path.join(STAGE, 'node_modules'));

  // 3. 入口
  fs.writeFileSync(path.join(STAGE, 'main.js'), `// 由 prepare-assets.js 生成，不要手改
process.chdir(__dirname);

// APK 里的 Node 是 18，没有 node:sqlite，走 sql.js 兼容层
process.env.ROLEPHONE_SQLITE = process.env.ROLEPHONE_SQLITE || 'sqljs';
process.env.PORT = process.env.PORT || '8787';

console.log('[rolephone] 启动服务：' + __dirname);
require('./server.js');
`);

  // 4. 打成 zip（自己写，免得依赖系统里的 zip 命令）
  fs.mkdirSync(ASSETS, { recursive: true });
  fs.rmSync(ZIP_OUT, { force: true });
  zipDir(STAGE, ZIP_OUT);

  const size = fs.statSync(ZIP_OUT).size;
  console.log(`assets/nodejs-project.zip 就绪（${(size / 1024 / 1024).toFixed(1)} MB）`);
}

/* ---------- 极简 zip 写入器：deflate + central directory ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, rel));
    else if (entry.isFile()) out.push({ rel, full });
  }
  return out;
}

function zipDir(srcDir, outFile) {
  const files = listFiles(srcDir).sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const chunks = [];
  const central = [];
  let offset = 0;

  const dosTime = 0; // 时间戳留空：解包时不需要
  const dosDate = 0x21; // 1980-01-01

  for (const file of files) {
    const data = fs.readFileSync(file.full);
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const name = Buffer.from(file.rel, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 文件名
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attr
    cd.writeUInt32LE(0, 38); // external attr
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(outFile, Buffer.concat([...chunks, centralBuf, eocd]));
}

main();
