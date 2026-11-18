// Nocturne 的 service worker：只把「外壳」缓存起来，接口一律走网络。
//
// 踩过的坑：
//  1) 缓存里放 '/' 很危险——未登录时 '/' 会 302 到 /login.html，如果照着
//     response 缓存，登录页就被当成首页存进去了，之后打开 App 看到的是登不进去的登录页。
//     所以只缓存「200、没被重定向、不是登录页」的导航响应。
//  2) 离线兜底必须一定返回一个 Response。之前 caches.match 找不到就是 undefined，
//     respondWith(undefined) 会抛 TypeError，WebView 直接一片白。
const VERSION = 'nocturne-v4';
const OFFLINE_URL = '/offline.html';
const SHELL = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  OFFLINE_URL,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function offlineResponse() {
  return caches.match(OFFLINE_URL).then((hit) => hit || new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;'
      + 'font:15px -apple-system,sans-serif;background:#f7f7f7;color:#8e8e93">Nocturne 没有连上服务</body>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  ));
}

// 冷启动时 node 服务还没监听上，直接回退缓存会画出一个「能看见、但接口全挂」的页面。
// 先给网络几次机会（约 3 秒），实在连不上再退回缓存/离线页。
const NAV_RETRY_DELAYS = [400, 800, 1600];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchWithRetry(request, attempt = 0) {
  return fetch(request).catch((error) => {
    if (attempt >= NAV_RETRY_DELAYS.length) throw error;
    return sleep(NAV_RETRY_DELAYS[attempt]).then(() => fetchWithRetry(request, attempt + 1));
  });
}

function cacheable(response) {
  return response && response.ok && !response.redirected && response.type === 'basic';
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  // 接口、上传、备份这些别掺和，缓存了会出事
  if (/^\/(api|uploads)\//.test(url.pathname)) {
    return;
  }

  // 页面：先网络，失败回退离线页
  if (request.mode === 'navigate') {
    event.respondWith(
      fetchWithRetry(request)
        .then((response) => {
          const isLogin = url.pathname === '/login.html';
          if (!isLogin && cacheable(response)) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || offlineResponse()))
    );
    return;
  }

  // 静态资源：先网络，拿到就顺手更新缓存；断网时回退缓存。
  // 以前是「缓存优先」，结果装上新 APK 后 WebView 还在跑上一版 JS，
  // 页面上就会出现「改了没反应」的怪事，所以改成网络优先。
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (cacheable(response)) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || offlineResponse()))
  );
});
