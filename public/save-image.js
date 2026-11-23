// 长按图片 → 存到手机相册。
// 只有在 Nocturne 的安卓壳里才生效（壳注入了 window.NocturneAndroid）；
// 用浏览器打开时什么都不做，保留系统自己的长按菜单。
(function () {
  'use strict';

  var bridge = window.NocturneAndroid;

  // 壳里存完会回调这里；成功时壳自己弹提示，失败才需要在这里说一声
  window.__nocturneSaved = function (ok, message) {
    if (!ok) {
      alert(message || '保存失败');
    }
  };

  function canSave() {
    return !!(bridge && typeof bridge.saveImage === 'function');
  }

  function absolute(src) {
    try {
      return new URL(src, location.href).href;
    } catch (e) {
      return src;
    }
  }

  function saveImage(src) {
    if (!canSave() || !src) {
      return;
    }
    bridge.saveImage(absolute(src));
  }

  function offerSave(img) {
    var src = img.getAttribute('src') || '';
    if (!src) {
      return;
    }
    if (!canSave()) {
      return;
    }
    if (confirm('把这张图存进手机相册？')) {
      saveImage(src);
    }
  }

  // 电脑上右键
  document.addEventListener('contextmenu', function (event) {
    var node = event.target;
    if (!node || node.tagName !== 'IMG') {
      return;
    }
    if (!canSave()) {
      return;
    }
    event.preventDefault();
    offerSave(node);
  }, false);

  // 手机上长按（WebView 不一定派 contextmenu，自己掐时间）
  var timer = null;
  var startX = 0;
  var startY = 0;
  var pending = null;

  document.addEventListener('touchstart', function (event) {
    var node = event.target;
    if (!node || node.tagName !== 'IMG') {
      return;
    }
    pending = node;
    var touch = event.touches && event.touches[0];
    startX = touch ? touch.clientX : 0;
    startY = touch ? touch.clientY : 0;
    clearTimeout(timer);
    timer = setTimeout(function () {
      var img = pending;
      pending = null;
      if (img) {
        offerSave(img);
      }
    }, 550);
  }, { passive: true });

  document.addEventListener('touchmove', function (event) {
    if (!pending) {
      return;
    }
    var touch = event.touches && event.touches[0];
    if (!touch) {
      return;
    }
    if (Math.abs(touch.clientX - startX) > 12 || Math.abs(touch.clientY - startY) > 12) {
      clearTimeout(timer);
      pending = null;
    }
  }, { passive: true });

  document.addEventListener('touchend', function () {
    clearTimeout(timer);
    pending = null;
  }, { passive: true });

  // 给别的脚本留个入口
  window.NocturneSave = { save: saveImage, canSave: canSave };
})();
