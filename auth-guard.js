// 未登录守卫：任何页面里的同源请求如果返回 401，就把人送去登录页。
// 放在每个页面 <head> 最前面引入，平时什么都不做，只在 401 时生效。
(function () {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;

  var LOGIN_PATH = '/login.html';
  var AUTH_PREFIX = '/api/auth/';
  var redirecting = false;

  function isLoginPage() {
    return location.pathname === LOGIN_PATH || location.pathname === '/login';
  }

  function goLogin() {
    if (redirecting || isLoginPage()) return;
    redirecting = true;
    var next = location.pathname + location.search;
    location.replace(LOGIN_PATH + '?next=' + encodeURIComponent(next));
  }

  function sameOriginAndNotAuthApi(input) {
    var url = '';
    if (typeof input === 'string') {
      url = input;
    } else if (input && typeof input.url === 'string') {
      url = input.url;
    } else if (input && typeof input.toString === 'function') {
      url = input.toString();
    }

    try {
      var resolved = new URL(url, location.href);
      if (resolved.origin !== location.origin) return false;
      // 登录页自身的接口 401 是正常的（比如没登录查 /me），交给页面自己处理
      if (resolved.pathname.indexOf(AUTH_PREFIX) === 0) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  var originalFetch = window.fetch.bind(window);

  // 冷启动时 App 里的 node 服务还没监听上端口，而 Service Worker 会先拿缓存里的
  // 页面把界面画出来，这时候页面里的接口请求就是 "Failed to fetch"。
  // 所以同源的 GET 遇到网络层失败时先退避重试几次，别一上来就给用户看红字。
  // POST/PUT/DELETE 不重试——重复提交会把消息、动态发两遍。
  var RETRY_DELAYS = [400, 800, 1200, 1600];

  function methodOf(init) {
    var method = (init && init.method) || 'GET';
    return String(method).toUpperCase();
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function withRetry(input, init) {
    var method = methodOf(init);
    var canRetry = method === 'GET' || method === 'HEAD';
    var attempt = 0;

    function run() {
      return originalFetch(input, init).catch(function (error) {
        // 只有网络层错误（连不上）才重试；HTTP 4xx/5xx 是正常响应，不在这里
        var retriable = canRetry && attempt < RETRY_DELAYS.length;
        if (!retriable) throw error;
        var delay = RETRY_DELAYS[attempt];
        attempt += 1;
        return sleep(delay).then(run);
      });
    }

    return run();
  }

  window.fetch = function (input, init) {
    if (!sameOriginAndNotAuthApi(input) || isLoginPage()) {
      return originalFetch(input, init);
    }

    return withRetry(input, init).then(function (response) {
      if (response && response.status === 401) goLogin();
      return response;
    });
  };
})();
