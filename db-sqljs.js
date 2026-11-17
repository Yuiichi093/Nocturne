'use strict';
/**
 * sql.js 兼容层：让 rolephone 在没有 node:sqlite 的 Node（Node 18 / nodejs-mobile /
 * Android APK）上也能跑，同时对外保持与 node:sqlite 的 DatabaseSync 一致的最小接口：
 *
 *   new DatabaseSync(file) / prepare(sql) -> { run, get, all } / exec(sql) / close()
 *
 * 实现要点：
 * 1) sql.js 是 WASM 版 SQLite，纯 JS 无需编译；但它官方的 initSqlJs() 返回 Promise，
 *    而 db.js 在 require 阶段就要同步建表、跑 migrate。所以这里做「同步引导」：
 *    - 给 initSqlJs 传 instantiateWasm，用 new WebAssembly.Module/Instance 同步实例化；
 *    - sql.js 内部还有两处 Promise 调度（见 SYNC_PATCHES），vm 在内存里改成同步调用。
 *    补丁只匹配 sql.js 1.16.x 的构建产物；版本不对会直接抛错，不会静默降级。
 * 2) 数据库常驻内存，写操作后 80ms debounce 导出 db.export() 写回磁盘；
 *    close() / 进程退出前强制 flush。
 * 3) VACUUM INTO 在 WASM 里只会写进 emscripten 的 MEMFS，拿不到真实文件，
 *    所以这里改成「导出字节直接写目标路径」，语义等价（一致快照）。
 *
 * 注意：sql.js 打开的是磁盘上的主库文件。如果存在非空 <db>-wal（上一个 node:sqlite
 * 进程没做 checkpoint），首次落盘前会把 -wal 改名保留为 .bak-<时间戳>，避免两边状态
 * 打架把库写坏；改名而不是删除，数据还能人工捞回来。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const FLUSH_DELAY_MS = 80;

/* ------------------------------------------------------------------ */
/* sql.js 同步引导                                                      */
/* ------------------------------------------------------------------ */

// sql.js 1.16.x dist/sql-wasm.js 里的两处异步调度：
//   ① 有 instantiateWasm 时：if(d)return new Promise(c=>{d(b,e=>c(a(e)))})
//   ② 初始化完成后：        })().then(()=>fd())
// 前者改成在回调里同步接住实例化结果；后者改成同步调用 fd()。
// 两者都改掉之后，initSqlJs() 返回时 Module.Database 已经可用 —— 这就是同步引导。
const SYNC_PATCHES = [
  [
    'if(d)return new Promise(c=>{d(b,e=>c(a(e)))})',
    'if(d){var _syncReady=!1,_syncRet;d(b,function(_e){_syncRet=a(_e);_syncReady=!0});' +
      'if(!_syncReady)throw new Error("sql.js: WebAssembly 同步实例化失败");' +
      'return _syncRet}'
  ],
  [
    '})().then(()=>fd());',
    '})();fd();'
  ]
];

let SQL = null;
let sqljsVersion = '';

function readSqljsVersion(dir) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, '..', 'package.json'), 'utf8')
    );
    return pkg.version || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

function loadSqlJsSync() {
  if (SQL) return SQL;

  const distEntry = require.resolve('sql.js/dist/sql-wasm.js');
  const distDir = path.dirname(distEntry);
  sqljsVersion = readSqljsVersion(distDir);

  let src = fs.readFileSync(distEntry, 'utf8');

  for (const [from, to] of SYNC_PATCHES) {
    if (!src.includes(from)) {
      throw new Error(
        '[db-sqljs] 无法同步初始化 sql.js（当前版本 ' + sqljsVersion +
        '）：内部构建产物和补丁不匹配。' +
        'rolephone 锁定的 sql.js 版本是 1.16.x，如果升级了 sql.js，' +
        '请同步更新 db-sqljs.js 里的 SYNC_PATCHES。'
      );
    }
    src = src.replace(from, to);
  }

  // 用 vm 在内存里跑打过补丁的构建产物，不落临时文件（手机上 /tmp 常常只读）
  const sandboxModule = new Module(distEntry, module);
  sandboxModule.filename = distEntry;
  sandboxModule.paths = Module._nodeModulePaths(distDir);
  const wrapper = vm.runInThisContext(Module.wrap(src), {
    filename: distEntry + ' (db-sqljs sync patched)'
  });
  wrapper.call(
    sandboxModule.exports,
    sandboxModule.exports,
    require,
    sandboxModule,
    distEntry,
    distDir
  );

  const initSqlJs = sandboxModule.exports;
  const wasmBinary = fs.readFileSync(path.join(distDir, 'sql-wasm.wasm'));

  const debug = String(process.env.ROLEPHONE_SQLJS_DEBUG || '') === '1';
  const config = {
    wasmBinary,
    print: debug ? (text) => console.log('[sql.js] ' + text) : () => {},
    printErr: debug ? (text) => console.error('[sql.js] ' + text) : () => {},
    instantiateWasm: (imports, successCallback) => {
      const module = new WebAssembly.Module(wasmBinary);
      const instance = new WebAssembly.Instance(module, imports);
      successCallback(instance, module);
      return instance.exports;
    }
  };

  // 打完补丁后这里已经完全同步；返回的 Promise 只是 sql.js 自己的糖，忽略即可
  initSqlJs(config);

  if (typeof config.Database !== 'function') {
    throw new Error(
      '[db-sqljs] sql.js 同步初始化后仍拿不到 Database 构造函数（版本 ' +
      sqljsVersion + '），请检查 SYNC_PATCHES 是否需要更新。'
    );
  }

  SQL = config;
  return SQL;
}

/* ------------------------------------------------------------------ */
/* WAL 合并：sql.js 只能喂给它一个 .db 字节串，读不到 -wal 文件          */
/*                                                                     */
/* Termux 上跑的是 node:sqlite（WAL 模式），进程被 kill 时不会 checkpoint，*/
/* 最近写入可能只存在于 <db>-wal 里（实测 721KB WAL / 主库只有 4KB）。     */
/* 直接拿主库裸文件覆盖着用 = 丢数据，所以这里按 SQLite 的 WAL 格式       */
/* （src/wal.c：walChecksumBytes / walDecodeFrame 的语义）把已提交帧      */
/* 回放进主库，丢弃未提交尾巴和校验和不通过的部分。                       */
/* ------------------------------------------------------------------ */

const HOST_LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const WAL_MAGIC_BE = 0x377f0683;
const WAL_MAGIC_LE = 0x377f0682;
const WAL_MAX_VERSION = 3007000;

function swap32(value) {
  return (
    ((value >>> 24) |
      ((value >>> 8) & 0x0000ff00) |
      ((value << 8) & 0x00ff0000) |
      (value << 24)) >>>
    0
  );
}

function readWord(buf, offset, native) {
  const raw = HOST_LE ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
  return native ? raw : swap32(raw);
}

/**
 * SQLite walChecksumBytes 的 JS 版：每次吃 8 字节，
 *   s0 += w0 + s1;  s1 += w1 + s0;
 * native=true 表示按本机字节序读；false 表示按 BYTESWAP32 处理。
 */
function walChecksum(buf, offset, length, s0, s1, native) {
  let p = offset;
  let n = length;

  while (n >= 8) {
    const w0 = readWord(buf, p, native);
    const w1 = readWord(buf, p + 4, native);
    s0 = (s0 + w0 + s1) >>> 0;
    s1 = (s1 + w1 + s0) >>> 0;
    p += 8;
    n -= 8;
  }

  return [s0, s1];
}

function removeIfEmpty(file) {
  try {
    if (fs.statSync(file).size === 0) fs.unlinkSync(file);
  } catch (err) {}
}

/**
 * 把 <db>-wal 里已经提交的事务合并进主库文件。
 * 返回 { applied, frames, pages }；解析不出有效帧时抛错，由调用方决定降级方式。
 */
function recoverWalIntoMain(dbPath) {
  const walPath = dbPath + '-wal';
  let walSize = -1;

  try {
    walSize = fs.statSync(walPath).size;
  } catch (err) {
    return { applied: false, frames: 0, pages: 0, missing: true };
  }

  if (walSize === 0) {
    removeIfEmpty(walPath);
    removeIfEmpty(dbPath + '-shm');
    return { applied: false, frames: 0, pages: 0, empty: true };
  }

  if (walSize < 32) {
    throw new Error('WAL 文件长度不足 32 字节，不是有效的 WAL 头');
  }

  const wal = fs.readFileSync(walPath);
  const main = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : Buffer.alloc(0);

  const magic = wal.readUInt32BE(0);
  const version = wal.readUInt32BE(4);

  if (
    (magic !== WAL_MAGIC_LE && magic !== WAL_MAGIC_BE) ||
    version !== WAL_MAX_VERSION
  ) {
    throw new Error('WAL 头不合法（magic=' + magic + ', version=' + version + '）');
  }

  // 与 SQLite 一致：magic 最低位表示 WAL 是用大端还是小端写的
  const bigEndCksum = magic & 1;
  const native = HOST_LE ? bigEndCksum === 0 : bigEndCksum === 1;

  let pageSize = wal.readUInt32BE(8);

  if (!pageSize && main.length >= 100) {
    const raw = main.readUInt16BE(16);
    pageSize = raw === 1 ? 65536 : raw;
  }

  if (
    !pageSize ||
    pageSize < 512 ||
    pageSize > 65536 ||
    (pageSize & (pageSize - 1)) !== 0
  ) {
    throw new Error('WAL 头里的页大小不合法：' + pageSize);
  }

  const headerChecksum = walChecksum(wal, 0, 24, 0, 0, native);

  if (
    headerChecksum[0] !== wal.readUInt32BE(24) ||
    headerChecksum[1] !== wal.readUInt32BE(28)
  ) {
    throw new Error('WAL 头部校验和不匹配，不敢合并');
  }

  const salt1 = wal.readUInt32BE(16);
  const salt2 = wal.readUInt32BE(20);

  let s0 = headerChecksum[0];
  let s1 = headerChecksum[1];
  let offset = 32;
  let frames = 0;
  let lastCommitFrame = 0;
  let committedPages = main.length >= 100 ? main.readUInt32BE(28) : 0;

  const framePages = [];

  while (offset + 24 + pageSize <= wal.length) {
    const pgno = wal.readUInt32BE(offset);

    if (pgno === 0) break;
    if (
      wal.readUInt32BE(offset + 8) !== salt1 ||
      wal.readUInt32BE(offset + 12) !== salt2
    ) {
      break;
    }

    // 校验和覆盖帧头前 8 字节 + 页数据
    const c1 = walChecksum(wal, offset, 8, s0, s1, native);
    const c2 = walChecksum(wal, offset + 24, pageSize, c1[0], c1[1], native);

    if (
      c2[0] !== wal.readUInt32BE(offset + 16) ||
      c2[1] !== wal.readUInt32BE(offset + 20)
    ) {
      break;
    }

    s0 = c2[0];
    s1 = c2[1];

    const commitSize = wal.readUInt32BE(offset + 4);

    framePages.push({
      pgno,
      data: Buffer.from(wal.subarray(offset + 24, offset + 24 + pageSize))
    });

    frames += 1;

    if (commitSize > 0) {
      lastCommitFrame = frames;
      committedPages = commitSize;
    }

    offset += 24 + pageSize;
  }

  if (lastCommitFrame === 0 || committedPages <= 0) {
    // 只有校验和有效的完整事务才算数，半个事务直接丢
    return { applied: false, frames, pages: 0 };
  }

  const size = committedPages * pageSize;
  const merged = Buffer.alloc(size);

  main.copy(merged, 0, 0, Math.min(main.length, size));

  for (let i = 0; i < lastCommitFrame; i += 1) {
    const frame = framePages[i];
    if (frame.pgno > committedPages) continue;
    frame.data.copy(merged, (frame.pgno - 1) * pageSize);
  }

  // 主库头里的页数要跟提交后的库大小一致
  merged.writeUInt32BE(committedPages, 28);

  const tmp = dbPath + '.walm-' + process.pid;
  fs.writeFileSync(tmp, merged);
  fs.renameSync(tmp, dbPath);

  // 合并过的 WAL 改名留档（不删，真要人工排查还有原始字节）
  try {
    fs.renameSync(walPath, walPath + '.applied-' + Date.now());
  } catch (err) {}
  removeIfEmpty(dbPath + '-shm');

  return { applied: true, frames: lastCommitFrame, pages: committedPages };
}

/* ------------------------------------------------------------------ */
/* SQL 语句粗分类：只用来决定「要不要落盘」，不影响执行                     */
/* ------------------------------------------------------------------ */

const READ_START = /^\s*(SELECT|EXPLAIN|VALUES)\b/i;
const READ_PRAGMA = /^\s*PRAGMA\s+[\w.]+\s*(\([^)]*\))?\s*$/i;

function isReadOnlySql(sql) {
  const parts = String(sql)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return true;

  return parts.every(
    (part) => READ_START.test(part) || READ_PRAGMA.test(part)
  );
}

function matchVacuumInto(sql) {
  const m = /^\s*VACUUM\s+INTO\s+'((?:[^']|'')+)'\s*;?\s*$/i.exec(
    String(sql)
  );
  if (!m) return null;
  return m[1].replace(/''/g, "'");
}

/* ------------------------------------------------------------------ */
/* 参数归一化：sql.js 的 bind 比 node:sqlite 挑食                       */
/* ------------------------------------------------------------------ */

function normalizeParam(value) {
  if (value === undefined) return null;
  if (value === null) return null;

  const type = typeof value;
  if (type === 'boolean') return value ? 1 : 0;
  if (type === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (type === 'number' || type === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  // Buffer 是 Uint8Array 的子类，但 sql.js 只认标准的 Uint8Array，转一层更稳
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}

function normalizeParams(args) {
  return args.map(normalizeParam);
}

/* ------------------------------------------------------------------ */
/* 退出前落盘                                                          */
/* ------------------------------------------------------------------ */

const instances = new Set();
let flushHooksInstalled = false;

function flushAll() {
  for (const db of instances) {
    try {
      db.flush();
    } catch (err) {
      console.error('[db-sqljs] 退出前落盘失败：' + (err.message || err));
    }
  }
}

function installFlushHooks() {
  if (flushHooksInstalled) return;
  flushHooksInstalled = true;

  process.on('exit', flushAll);
  process.on('beforeExit', flushAll);

  // SIGINT/SIGTERM：先落盘，再把默认信号行为还回去（不会吞掉 Ctrl-C）
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const onSignal = () => {
      flushAll();
      process.removeListener(signal, onSignal);
      try {
        process.kill(process.pid, signal);
      } catch (err) {
        process.exit(0);
      }
    };
    process.on(signal, onSignal);
  }
}

/* ------------------------------------------------------------------ */
/* 与 node:sqlite DatabaseSync 对齐的封装                              */
/* ------------------------------------------------------------------ */

class DatabaseSync {
  constructor(file, options) {
    const SQL = loadSqlJsSync();
    const opts = options || {};

    this.driver = 'sqljs';
    this._file = file ? path.resolve(String(file)) : null;
    this._readOnly = Boolean(opts.readOnly);
    this._db = null;
    this._dirty = false;
    this._timer = null;
    this._closed = false;
    this._walHandled = false;

    let bytes = null;

    if (this._file) {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      this._reconcileWal();

      if (fs.existsSync(this._file)) {
        const stat = fs.statSync(this._file);
        if (stat.size > 0) bytes = new Uint8Array(fs.readFileSync(this._file));
      }
    }

    this._db = bytes ? new SQL.Database(bytes) : new SQL.Database();

    instances.add(this);
    installFlushHooks();
  }

  /** 打开前处理 <db>-wal：能合并就合并，合不了就留档而不是悄悄丢掉 */
  _reconcileWal() {
    if (!this._file || this._readOnly) return;

    const walPath = this._file + '-wal';

    try {
      const result = recoverWalIntoMain(this._file);

      if (result.applied) {
        console.log(
          '[db-sqljs] 已把 ' + result.frames + ' 个 WAL 帧合并进主库（' +
            result.pages + ' 页），原始 WAL 改名留档'
        );
      } else if (result.empty || result.missing) {
        // 没有 WAL 或只剩空壳：正常启动，不打扰日志
      } else {
        console.log('[db-sqljs] WAL 里没有已提交事务，忽略');
        if (fs.existsSync(walPath)) {
          try {
            fs.renameSync(walPath, walPath + '.empty-' + Date.now());
          } catch (err) {}
        }
      }
    } catch (error) {
      const kept = walPath + '.bak-' + Date.now();
      try {
        fs.renameSync(walPath, kept);
        console.warn(
          '[db-sqljs] WAL 合并失败（' + error.message + '）：已把 WAL 改名保留为 ' +
            path.basename(kept) + '，先按最后一次 checkpoint 的状态使用主库。'
        );
      } catch (err) {
        console.warn('[db-sqljs] WAL 合并失败：' + error.message);
      }
    }

    removeIfEmpty(this._file + '-shm');
  }

  /* ---------------- 落盘 ---------------- */

  _markDirty() {
    if (this._closed || this._readOnly || !this._file) return;
    this._dirty = true;
    if (this._timer) return;

    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        this.flush();
      } catch (err) {
        console.error('[db-sqljs] 落盘失败：' + (err.message || err));
      }
    }, FLUSH_DELAY_MS);

    if (this._timer && typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  /**
   * 落盘前顺手清掉 0 字节的 -wal / -shm（WAL 合并本身在打开时做完了，
   * 见 _reconcileWal；这里只处理运行期间系统留下的空壳文件）。
   */
  _dropEmptySidecars() {
    if (!this._file || this._readOnly) return;

    try {
      if (fs.statSync(this._file + '-wal').size === 0) {
        fs.unlinkSync(this._file + '-wal');
      }
    } catch (err) {}

    try {
      if (fs.statSync(this._file + '-shm').size === 0) {
        fs.unlinkSync(this._file + '-shm');
      }
    } catch (err) {}
  }

  flush() {
    if (!this._file || this._readOnly || this._closed || !this._dirty) {
      return this;
    }
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    this._dirty = false;
    this._dropEmptySidecars();

    const bytes = Buffer.from(this._db.export());
    const tmp = this._file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, this._file);
    return this;
  }

  /** 导出当前内存库的字节（给 backup-api 做兜底快照用） */
  export() {
    return this._db.export();
  }

  exportTo(target) {
    const file = path.resolve(String(target));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, Buffer.from(this._db.export()));
    fs.renameSync(tmp, file);
    return file;
  }

  /* ---------------- SQL 接口 ---------------- */

  exec(sql) {
    this._assertOpen();
    const text = String(sql);

    // WASM 里的 VACUUM INTO 只会写进 MEMFS，真实磁盘上看不到，这里改成导出字节
    const vacuumTarget = matchVacuumInto(text);
    if (vacuumTarget) {
      this.exportTo(vacuumTarget);
      return this;
    }

    this._db.exec(text);

    if (!isReadOnlySql(text)) this._markDirty();
    return this;
  }

  _readLastInsertRowid() {
    const stmt = this._db.prepare('SELECT last_insert_rowid() AS id');
    try {
      if (!stmt.step()) return 0;
      const row = stmt.getAsObject();
      return row && row.id != null ? row.id : 0;
    } finally {
      stmt.free();
    }
  }

  prepare(sql) {
    this._assertOpen();
    const self = this;
    const text = String(sql);
    const readOnly = isReadOnlySql(text);

    function makeStatement(args) {
      const stmt = self._db.prepare(text);
      if (args.length) stmt.bind(normalizeParams(args));
      return stmt;
    }

    return {
      run(...args) {
        self._assertOpen();
        const stmt = makeStatement(args);
        let changes = 0;
        try {
          stmt.step();
          changes = self._db.getRowsModified();
        } finally {
          stmt.free();
        }

        const lastInsertRowid = readOnly ? 0 : self._readLastInsertRowid();
        if (!readOnly) self._markDirty();

        return { lastInsertRowid, changes };
      },

      get(...args) {
        self._assertOpen();
        const stmt = makeStatement(args);
        try {
          if (!stmt.step()) return null;
          return stmt.getAsObject();
        } finally {
          stmt.free();
        }
      },

      all(...args) {
        self._assertOpen();
        const stmt = makeStatement(args);
        const rows = [];
        try {
          while (stmt.step()) rows.push(stmt.getAsObject());
        } finally {
          stmt.free();
        }
        return rows;
      }
    };
  }

  close() {
    if (this._closed) return;
    try {
      this.flush();
    } finally {
      this._closed = true;
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      instances.delete(this);
      try {
        this._db.close();
      } catch (err) {}
    }
  }

  _assertOpen() {
    if (this._closed) {
      throw new Error('database is closed');
    }
  }
}

DatabaseSync.driverName = 'sqljs';

module.exports = {
  DatabaseSync,
  driverName: 'sqljs',
  flushAll,
  getSqljsVersion: () => sqljsVersion
};
