(function () {
  'use strict';

  // 界面设置的读写（头像形状、首页白框…）。
  // 后端契约：GET /api/settings/ui → { settings: {...} }
  //           POST /api/settings/ui  { 只传要改的字段 } → { ok: true, settings: {...} }
  // 读失败就当默认值，绝不抛出去拖垮页面。

  const DEFAULTS = {
    avatar_shape: 'circle',
    home_note: '',
    home_note_align: 'left'
  };

  let cache = null;

  function normalize(settings) {
    const value = Object.assign({}, DEFAULTS, settings || {});

    if (value.avatar_shape !== 'square') {
      value.avatar_shape = 'circle';
    }

    if (['left', 'center', 'right'].indexOf(value.home_note_align) < 0) {
      value.home_note_align = 'left';
    }

    value.home_note = typeof value.home_note === 'string' ? value.home_note : '';

    return value;
  }

  async function load() {
    try {
      const response = await fetch('/api/settings/ui');
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error((data && data.error) || '设置读取失败');
      }

      cache = normalize(data && data.settings);
    } catch (error) {
      console.warn('界面设置读取失败：' + (error && error.message));
      cache = normalize(cache);
    }

    return cache;
  }

  async function save(patch) {
    const response = await fetch('/api/settings/ui', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch || {})
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error((data && data.error) || '保存失败');
    }

    // 服务端可能只回一部分，按「旧缓存 → 本次改动 → 服务端返回」的顺序合并
    const next = Object.assign({}, cache || DEFAULTS, patch || {});

    if (data && data.settings) {
      Object.assign(next, data.settings);
    }

    cache = normalize(next);

    return cache;
  }

  window.__nocturneUiSettings = {
    DEFAULTS,
    load,
    save,
    get settings() {
      return cache ? normalize(cache) : normalize(null);
    }
  };
})();
