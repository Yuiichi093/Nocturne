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

  window.fetch = function (input, init) {
    var responsePromise = originalFetch(input, init);

    if (!sameOriginAndNotAuthApi(input) || isLoginPage()) {
      return responsePromise;
    }

    return responsePromise.then(function (response) {
      if (response && response.status === 401) goLogin();
      return response;
    });
  };
})();
