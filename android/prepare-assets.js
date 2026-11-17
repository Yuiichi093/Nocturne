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

/**
 * 替换依赖里依赖 ICU 的 Unicode 属性转义。
 * nodejs-mobile 的 Node 18 没有 ICU 数据，`\p{ID_Start}` 会让整个文件解析失败。
 * 我们的路由参数都是 ASCII，退化成 ASCII 字符类完全够用。
 */
function patchNoIcu(modulesDir) {
  const targets = [path.join(modulesDir, 'path-to-regexp', 'dist', 'index.js')];
  let patched = 0;
  for (const file of targets) {
    if (!fs.existsSync(file)) {
      continue;
    }
    const original = fs.readFileSync(file, 'utf8');
    const next = original
      .replace(/\^\[\$_\\p\{ID_Start\}\]\$/gu, '^[$_A-Za-z]$')
      .replace(/\^\[\$\\u200c\\u200d\\p\{ID_Continue\}\]\$/gu,
        '^[$\\u200c\\u200d0-9A-Za-z_]$')
      .replace(/\^\[\$_\\p\{ID_Start\}\]\[\$\\u200c\\u200d\\p\{ID_Continue\}\]\*\$/gu,
        '^[$_A-Za-z][$\\u200c\\u200d0-9A-Za-z_]*$');
    if (next.includes('\\p{ID_')) {
      console.error('path-to-regexp 还有没替换掉的 Unicode 属性正则，先把 prepare-assets.js 的 patchNoIcu 修一下');
      process.exit(1);
    }
    if (next !== original) {
      fs.writeFileSync(file, next);
      patched++;
      console.log('  已去掉 path-to-regexp 的 ICU 依赖');
    }
  }
  if (!patched) {
    console.log('  提示：没找到需要打补丁的依赖（版本可能变了）');
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

  // 2.5 nodejs-mobile 自带的 Node 18 是没编 ICU 的，\p{ID_Start} 这种 Unicode
  //     属性正则会在解析阶段直接抛 SyntaxError（express 5 依赖 path-to-regexp 就中招）。
  //     这里把这几处正则换成等价的 ASCII 写法，只影响打进 APK 的这份拷贝。
  patchNoIcu(path.join(STAGE, 'node_modules'));

  // 3. 入口
  fs.writeFileSync(path.join(STAGE, 'main.js'), `// 由 prepare-assets.js 生成，不要手改
const fs = require('fs');
const path = require('path');

// 一切输出都同时写进 boot.log，起不来的时候 MainActivity 会把这份日志显示出来
const LOG = path.join(__dirname, 'boot.log');
function record(line) {
  try {
    fs.appendFileSync(LOG, line + '\\n');
  } catch (e) {
    // 写不了就算了，别把启动带崩
  }
}
function fmt(args) {
  return args
    .map((a) => (a && a.stack ? a.stack : typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .join(' ');
}

for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    record(new Date().toISOString() + ' [' + level + '] ' + fmt(args));
    original(...args);
  };
}

record('=== ' + new Date().toISOString() + ' ===');
record('node ' + process.version + ' / ' + process.platform + ' ' + process.arch);
record('目录 ' + __dirname);

process.on('uncaughtException', (e) => {
  console.error('未捕获异常:', e);
});
process.on('unhandledRejection', (e) => {
  console.error('未处理的 Promise 拒绝:', e);
});

process.chdir(__dirname);
process.env.ROLEPHONE_SQLITE = process.env.ROLEPHONE_SQLITE || 'sqljs';
process.env.PORT = process.env.PORT || '8787';

try {
  require('./server.js');
  record('server.js 已加载');
} catch (e) {
  console.error('server.js 加载失败:', e);
  throw e;
}
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
