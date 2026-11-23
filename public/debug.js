(function () {
  'use strict';

  const ENDPOINTS = [
    ['/api/update', '检查更新'],
    ['/api/profile', '资料'],
    ['/api/personas', '人设'],
    ['/api/worlds/active', '当前世界观'],
    ['/api/worlds', '世界观列表'],
    ['/api/moments', '朋友圈动态'],
    ['/api/moments/settings', '朋友圈设置'],
    ['/api/moments/notifications', '朋友圈通知']
  ];

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function brief(value) {
    let text;

    try {
      text = JSON.stringify(value);
    } catch (e) {
      text = String(value);
    }

    if (!text) text = String(value);
    return text.length > 220 ? text.slice(0, 220) + '…' : text;
  }

  async function loadEnv() {
    const rows = [];

    try {
      const res = await fetch('/api/update');
      const json = await res.json();
      rows.push(['安装包版本', json.current || '未知']);
    } catch (e) {
      rows.push(['安装包版本', '读不到']);
    }

    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      rows.push(['Service Worker', '已接管']);
    } else if (navigator.serviceWorker) {
      rows.push(['Service Worker', '未接管']);
    } else {
      rows.push(['Service Worker', '不支持']);
    }

    try {
      const keys = await caches.keys();
      rows.push(['缓存版本', keys.join(' / ') || '无']);
    } catch (e) {
      rows.push(['缓存版本', '读不到']);
    }

    try {
      const reg = await navigator.serviceWorker.getRegistration();
      rows.push(['SW 状态', reg ? (reg.active ? 'active' : '未激活') : '无注册']);
    } catch (e) {}

    rows.push(['UA', navigator.userAgent]);

    $('diagEnv').innerHTML = rows
      .map(
        ([key, value]) =>
          '<div class="diag-row"><div class="diag-head"><span>' +
          escapeHtml(key) +
          '</span></div><div class="diag-body">' +
          escapeHtml(value) +
          '</div></div>'
      )
      .join('');
  }

  async function loadEndpoints() {
    const box = $('diagList');
    box.textContent = '检测中…';

    const rows = [];

    for (const [url, label] of ENDPOINTS) {
      const started = Date.now();
      let status = '网络错误';
      let ok = false;
      let body = '';
      let data = null;

      try {
        const response = await fetch(url + (url.includes('?') ? '&' : '?') + 'diag=1', {
          headers: { Accept: 'application/json' }
        });
        status = response.status + ' ' + (response.statusText || '');
        ok = response.ok;
        const text = await response.text();
        body = text.slice(0, 400);

        try {
          data = JSON.parse(text);
        } catch (e) {}
      } catch (e) {
        status = '网络错误：' + (e.message || e);
      }

      rows.push({
        label: label,
        url: url,
        status: status,
        ok: ok,
        cost: Date.now() - started,
        body: data ? brief(data) : body
      });
    }

    box.innerHTML = rows
      .map(
        (row) =>
          '<div class="diag-row"><div class="diag-head"><span>' +
          escapeHtml(row.label) +
          '</span><span class="' +
          (row.ok ? 'diag-ok' : 'diag-bad') +
          '">' +
          escapeHtml(row.status) +
          ' · ' +
          row.cost +
          'ms</span></div><div class="diag-body">' +
          escapeHtml(row.url) +
          '<br>' +
          escapeHtml(row.body) +
          '</div></div>'
      )
      .join('');
  }

  function init() {
    loadEnv();
    loadEndpoints();

    $('diagRetry').addEventListener('click', () => {
      loadEnv();
      loadEndpoints();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
