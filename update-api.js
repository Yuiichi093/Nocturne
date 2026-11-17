// 检查更新：问 GitHub 上最新的 release，跟当前版本比一比
//
// 坑：国内直连 api.github.com 经常超时（App 里就表现为「检查更新一直失败」）。
// 所以这里准备了几条路，按顺序试，前面不通就走后面的：
//   1. 直连 api.github.com
//   2. 走 gh-proxy 镜像的 api.github.com
//   3. 走 gh-proxy 镜像的 raw.githubusercontent.com 读 package.json
// 结果缓存 30 分钟，省着点用 GitHub 的匿名额度（每小时 60 次）
const https = require('https');
const REPO = 'Yuiichi093/Nocturne';
const CURRENT = require('./package.json').version;
const CACHE_MS = 30 * 60 * 1000;
const PROXY = 'https://gh-proxy.com/';

function fetchJson(url, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Nocturne/' + CURRENT,
        Accept: 'application/vnd.github+json',
      },
      timeout: 12000,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && depth < 4) {
        res.resume();
        return resolve(fetchJson(new URL(res.headers.location, url).toString(), depth + 1));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 404) {
          const err = new Error('仓库里还没有发布过安装包');
          err.status = 404;
          return reject(err);
        }
        if (res.statusCode !== 200) {
          const err = new Error('GitHub 回了 ' + res.statusCode);
          err.status = res.statusCode;
          return reject(err);
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('返回的不是 JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
  });
}

// 一条一条试，谁能用就用谁
async function firstOk(urls) {
  const failures = [];
  for (const url of urls) {
    try {
      const data = await fetchJson(url);
      return { data, url };
    } catch (e) {
      failures.push((e.code || e.message || 'error') + ' @ ' + url);
    }
  }
  const err = new Error('都连不上：' + failures.join('；'));
  err.failures = failures;
  throw err;
}

function parts(version) {
  return String(version || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((n) => parseInt(n, 10) || 0);
}

function isNewer(latest, current) {
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

function pickAsset(release) {
  const assets = release.assets || [];
  const apk = assets.find((a) => a.name === 'app-release.apk')
    || assets.find((a) => /\.apk$/i.test(a.name));
  return apk ? apk.browser_download_url : '';
}

// 手机直接下 github.com 的附件基本没戏，走镜像给她
function proxied(url) {
  if (!url || !/^https?:\/\//i.test(url)) return url || '';
  if (url.indexOf(PROXY) === 0) return url;
  return PROXY + url;
}

module.exports = function (app) {
  let cache = null;
  let cacheAt = 0;

  async function versionFromRepo() {
    // 兜底：读仓库里 main 上的 package.json（直连不通就走镜像）
    try {
      const { data } = await firstOk([
        'https://api.github.com/repos/' + REPO + '/contents/package.json?ref=main',
        PROXY + 'https://api.github.com/repos/' + REPO + '/contents/package.json?ref=main',
      ]);
      if (data && data.content) {
        const text = Buffer.from(data.content, 'base64').toString('utf8');
        const v = (text.match(/"version":\s*"([^"]+)"/) || [])[1];
        if (v) return v;
      }
    } catch (e) {
      // 读不到就算了
    }

    // 再兜一层：直接读原始文件
    try {
      const { data } = await firstOk([
        'https://raw.githubusercontent.com/' + REPO + '/main/package.json',
        PROXY + 'https://raw.githubusercontent.com/' + REPO + '/main/package.json',
      ]);
      const v = (String(data && data.version || '').match(/^(\d+\.\d+\.\d+)/) || [])[1];
      if (v) return v;
    } catch (e) {}

    return '';
  }

  async function load() {
    let release = null;

    try {
      const { data } = await firstOk([
        'https://api.github.com/repos/' + REPO + '/releases/latest',
        PROXY + 'https://api.github.com/repos/' + REPO + '/releases/latest',
      ]);
      release = data;
    } catch (releaseError) {
      // release 拿不到，至少把仓库里的版本号读出来，能提示「有新版本」就行
      const version = await versionFromRepo();
      if (!version) throw releaseError;
      return {
        current: CURRENT,
        latest: version,
        stamp: '',
        hasUpdate: isNewer(version, CURRENT),
        notes: '',
        publishedAt: '',
        apkUrl: '',
        pageUrl: 'https://github.com/' + REPO + '/releases',
        degraded: true,
      };
    }

    const tag = String(release.tag_name || '');
    const notes = String(release.body || '');
    // release 的 tag 是 apk-20261118-0415 这种时间戳，版本号优先从正文「版本 x.y.z」里取，
    // 其次读仓库里的 package.json，最后才退回 tag
    let version = '';
    const matched = notes.match(/版本\s*(\d+\.\d+\.\d+)/)
      || String(release.name || '').match(/(\d+\.\d+\.\d+)/);
    if (matched) {
      version = matched[1];
    } else {
      version = await versionFromRepo();
    }
    if (!version) version = tag.replace(/^v/i, '');

    const direct = pickAsset(release);

    return {
      current: CURRENT,
      latest: version,
      stamp: tag,
      hasUpdate: isNewer(version, CURRENT),
      notes: notes.trim(),
      publishedAt: release.published_at || '',
      apkUrl: proxied(direct),
      apkUrlDirect: direct,
      pageUrl: release.html_url || ('https://github.com/' + REPO + '/releases'),
    };
  }

  app.get('/api/update', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const force = String(req.query.refresh || '') === '1';
    if (!force && cache && Date.now() - cacheAt < CACHE_MS) {
      return res.json(cache);
    }
    try {
      const data = await load();
      cache = data;
      cacheAt = Date.now();
      res.json(data);
    } catch (err) {
      // 网络不通也把当前版本告诉前端，别让页面卡在「检查中」
      res.json({
        current: CURRENT,
        latest: '',
        hasUpdate: false,
        notes: '',
        apkUrl: '',
        pageUrl: 'https://github.com/' + REPO + '/releases',
        error: err.status === 404 ? err.message : '连不上 GitHub，过一会儿再试',
        detail: String(req.query.debug || '') === '1'
          ? String(err.message || '').slice(0, 300)
          : '',
      });
    }
  });
};
