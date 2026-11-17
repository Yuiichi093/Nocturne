// 统一的返回逻辑。
//
// 血泪史：
//   第一版 history.length > 1 ? history.back() : 首页 —— 历史栈是空的时候什么都不发生，点了没反应。
//   第二版 看 document.referrer 是否同源 —— 有的手机浏览器压根不发 referrer，
//          于是永远走"回上一级"那支，永远回首页。
//   现在这版谁都不靠：在 sessionStorage 里自己记一份"页面序列 + 当前位置"，
//   跟浏览器历史互不相干。点返回就是把指针往回挪一格。
//   浏览器自带的前进/后退也能认出来（当前地址在序列里就对齐指针），不会被搞乱。
(function () {
  'use strict';

  var KEY = 'nocturne-nav-v2';
  var MAX = 40;

  var PARENTS = {
    '/worldbook.html': '/worlds.html',
    '/theater-play.html': '/theater.html',
    '/theater-identity.html': '/theater.html'
  };

  function here() {
    try {
      return location.pathname + location.search;
    } catch (e) {
      return '/';
    }
  }

  function queryValue(search, name) {
    var parts = String(search || '').replace(/^\?/, '').split('&');

    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');

      if (decodeURIComponent(kv[0] || '') === name) {
        return decodeURIComponent(kv[1] || '');
      }
    }

    return '';
  }

  function parentFor(path, search) {
    if (path === '/chat.html') {
      var id = queryValue(search, 'character');
      return id ? '/character.html?id=' + encodeURIComponent(id) : '/';
    }

    return PARENTS[path] || '/';
  }

  function load() {
    try {
      var raw = sessionStorage.getItem(KEY);
      var data = raw ? JSON.parse(raw) : null;

      if (
        data &&
        Object.prototype.toString.call(data.list) === '[object Array]' &&
        typeof data.index === 'number'
      ) {
        return { list: data.list, index: data.index };
      }
    } catch (e) {}

    return { list: [], index: -1 };
  }

  function save(data) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {}
  }

  // 防连点：一次点击只退一格
  var lastRun = 0;

  var goBack = function () {
    var now = Date.now();

    if (now - lastRun < 400) return;

    lastRun = now;

    var current = here();
    var data = load();
    var target = '';

    // 序列里还有上一页就去上一页
    if (data.index > 0 && data.list.length) {
      data.index = data.index - 1;
      target = data.list[data.index] || '';
      save(data);
    }

    // 没有上一页，或者上一页就是自己：按页面层级回
    if (!target || target === current) {
      target = parentFor(location.pathname, location.search);

      // 用层级兜底说明前面没有记录了，把序列重置成当前目标，
      // 免得之后在两页之间来回弹
      save({ list: [target], index: 0 });
    }

    try {
      location.href = target;
    } catch (e) {
      try {
        location.href = '/';
      } catch (e2) {}
    }
  };

  window.nocturneBack = goBack;

  // —— 页面加载时把当前地址记进序列 ——
  try {
    var current = here();
    var data = load();
    var pos = data.list.indexOf(current);
    var changed = false;

    if (pos >= 0) {
      // 已经在序列里：说明是后退/前进回来的，把指针对齐就行
      if (data.index !== pos) {
        data.index = pos;
        changed = true;
      }
    } else {
      // 新页面：截掉当前位置之后的分支，追加到末尾
      var base = data.index >= 0 ? data.index + 1 : 0;

      data.list = data.list.slice(0, base);
      data.list.push(current);
      data.index = data.list.length - 1;
      changed = true;

      if (data.list.length > MAX) {
        var drop = data.list.length - MAX;

        data.list = data.list.slice(drop);
        data.index -= drop;
      }
    }

    if (changed || data.index < 0) save(data);
  } catch (e) {}

  // 兜底：哪一页的返回按钮忘了写 onclick 也能点
  try {
    var bindBackButtons = function () {
      var nodes = document.querySelectorAll('.back, [data-back]');

      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];

        if (node.getAttribute('onclick')) continue;

        node.addEventListener('click', function (event) {
          if (event && event.preventDefault) event.preventDefault();
          goBack();
        });
      }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bindBackButtons);
    } else {
      bindBackButtons();
    }
  } catch (e) {}
})();
