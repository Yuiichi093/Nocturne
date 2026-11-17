// Nocturne 的 service worker：只把「外壳」缓存起来，接口一律走网络。
//
// 踩过的坑：
//  1) 缓存里放 '/' 很危险——未登录时 '/' 会 302 到 /login.html，如果照着
//     response 缓存，登录页就被当成首页存进去了，之后打开 App 看到的是登不进去的登录页。
//     所以只缓存「200、没被重定向、不是登录页」的导航响应。
//  2) 离线兜底必须一定返回一个 Response。之前 caches.match 找不到就是 undefined，
//     respondWith(undefined) 会抛 TypeError，WebView 直接一片白。
const VERSION = 'nocturne-v2';
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
      fetch(request)
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

  // 静态资源：缓存优先，后台顺手更新
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          if (cacheable(response)) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => hit || offlineResponse());
      return hit || network;
    })
  );
});
