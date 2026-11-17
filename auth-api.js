/**
 * 账号接口 + 登录守卫中间件
 *
 * 登录态放 HttpOnly cookie，页面请求未登录直接 302 到 /login.html，
 * 接口请求未登录返回 401（前端 auth-guard.js 接住后跳登录页）。
 */
const authDb = require('./auth-db');
const db = require('./db');

const COOKIE = 'nocturne_session';
const PUBLIC_PATHS = ['/login.html', '/auth-guard.js', '/manifest.json', '/sw.js'];
const PUBLIC_PREFIX = ['/icons/', '/api/auth/', '/api/health'];
const STATIC_EXT = new Set([
  '.css', '.js', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf',
]);

// 密码错了就错，但别让它一秒试一千次。同一来源连错 5 次先晾 3 秒。
const failures = new Map();

function throttleKey(req) {
  return String(req.ip || req.socket.remoteAddress || 'local');
}

function tooManyFailures(key) {
  const item = failures.get(key);
  if (!item) return false;
  if (item.until > Date.now()) return true;
  if (item.until) failures.delete(key);
  return false;
}

function recordFailure(key) {
  const now = Date.now();
  let item = failures.get(key);
  if (!item || now - item.last > 300000) {
    item = { count: 0, until: 0, last: now };
  }
  item.count += 1;
  item.last = now;
  if (item.count >= 5) {
    item.until = now + 3000;
    item.count = 0;
  }
  failures.set(key, item);
}

function readCookie(header, name) {
  const raw = String(header || '');
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return '';
}

function setSessionCookie(res, token, maxAge) {
  const bits = [
    COOKIE + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + maxAge,
  ];
  res.append('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function isStaticAsset(pathname) {
  const dot = pathname.lastIndexOf('.');
  if (dot === -1) return false;
  return STATIC_EXT.has(pathname.slice(dot).toLowerCase());
}

/** 解析 cookie 里的账号，并把后续处理包进该账号的数据库上下文 */
function middleware(req, res, next) {
  const token = readCookie(req.headers.cookie, COOKIE);
  const user = token ? authDb.userByToken(token) : null;

  req.user = user ? authDb.publicUser(user) : null;
  req.sessionToken = user ? token : '';

  if (!user) {
    return next();
  }
  // 之后的 handler、await 之后的数据库访问都属于这个账号
  return db.runWithUser(user.id, () => next());
}

/** 没登录就别想进来 */
function gate(req, res, next) {
  if (req.user) {
    return next();
  }

  const p = req.path;
  if (PUBLIC_PATHS.includes(p) || PUBLIC_PREFIX.some((prefix) => p.startsWith(prefix))) {
    return next();
  }
  if (isStaticAsset(p)) {
    return next();
  }
  if (p.startsWith('/api/') || p.startsWith('/uploads/')) {
    return res.status(401).json({ error: '未登录' });
  }

  const raw = String(req.originalUrl || '');
  const target = raw.startsWith('/') && !raw.startsWith('//') && raw !== '/' ? raw : '';
  const suffix = target ? '?next=' + encodeURIComponent(target) : '';
  return res.redirect('/login.html' + suffix);
}

module.exports = function registerAuth(app) {
  app.post('/api/auth/register', (req, res) => {
    const body = req.body || {};
    try {
      const user = authDb.createUser(body.username, body.password, body.nickname);
      const { token } = authDb.createSession(user.id);
      authDb.touchLogin(user.id);
      setSessionCookie(res, token, authDb.SESSION_DAYS * 86400);
      res.json({ user });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    const body = req.body || {};
    const key = throttleKey(req);
    if (tooManyFailures(key)) {
      return res.status(429).json({ error: '试太多次了，等几秒再来' });
    }
    const row = authDb.findByName(body.username);
    if (!row || !authDb.verifyPassword(body.password, row.password_hash)) {
      recordFailure(key);
      return res.status(400).json({ error: '用户名或密码不对' });
    }
    failures.delete(key);
    const { token } = authDb.createSession(row.id);
    authDb.touchLogin(row.id);
    setSessionCookie(res, token, authDb.SESSION_DAYS * 86400);
    res.json({ user: authDb.publicUser(row) });
  });

  app.post('/api/auth/logout', (req, res) => {
    authDb.deleteSession(req.sessionToken || readCookie(req.headers.cookie, COOKIE));
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: '未登录' });
    }
    res.json({
      user: req.user,
      is_first: authDb.countUsers() === 1,
    });
  });

  /** 还没人注册时，登录页要显示「创建第一个账号」 */
  app.get('/api/auth/status', (req, res) => {
    res.json({
      has_users: authDb.countUsers() > 0,
      logged_in: Boolean(req.user),
    });
  });

  app.post('/api/auth/password', (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: '未登录' });
    }
    const body = req.body || {};
    const row = authDb.getById(req.user.id);
    if (!row || !authDb.verifyPassword(body.old_password, row.password_hash)) {
      return res.status(400).json({ error: '原密码不对' });
    }
    try {
      authDb.changePassword(req.user.id, body.new_password);
      authDb.dropSessionsOf(req.user.id, req.sessionToken);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
};

module.exports.middleware = middleware;
module.exports.gate = gate;
module.exports.COOKIE = COOKIE;
module.exports.readCookie = readCookie;
