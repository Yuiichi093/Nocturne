(function () {
  'use strict';

  // 省 token 设置：lean_mode 开关 + context_limit（带多少条历史）。
  // 读写都走 ui-settings.js 暴露的 window.__nocturneUiSettings，
  // 这里只负责渲染 / 改完立刻存 / 存失败把界面退回去并在面板里写一行小字（不弹 alert）。
  // 后端还没加这两个字段时，GET 回来没有它们 → 这里按默认值（关、40 条）渲染，不报错。

  const CONTEXT_LIMITS = [12, 20, 28, 40];
  const DEFAULTS = { lean_mode: '0', context_limit: 40 };

  const toggle = document.getElementById('leanModeToggle');
  const hint = document.getElementById('leanModeHint');
  const select = document.getElementById('contextLimitSelect');
  const status = document.getElementById('leanStatus');
  const presetBtn = document.getElementById('leanPresetBtn');

  // 老版本页面（或者别的页面）没有这块就什么都不用做
  if (!toggle || !select) return;

  const api = window.__nocturneUiSettings;

  let settings = Object.assign({}, DEFAULTS);
  let saving = false;
  let statusTimer = null;

  function normalize(raw) {
    const source = raw || {};
    const limit = Number(source.context_limit);

    return {
      lean_mode: String(source.lean_mode) === '1' ? '1' : '0',
      context_limit: CONTEXT_LIMITS.indexOf(limit) >= 0 ? limit : 40
    };
  }

  function setStatus(message, isError) {
    if (!status) return;

    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }

    status.textContent = message || '';
    status.classList.toggle('error', Boolean(isError));
    status.hidden = !message;
  }

  function setBusy(value) {
    saving = Boolean(value);
    toggle.disabled = saving;
    select.disabled = saving;
    if (presetBtn) presetBtn.disabled = saving;
  }

  function paint(next) {
    settings = normalize(next);
    toggle.checked = settings.lean_mode === '1';
    select.value = String(settings.context_limit);

    if (hint) {
      hint.hidden = !toggle.checked;
    }
  }

  async function load() {
    if (!api) {
      paint(DEFAULTS);
      return;
    }

    try {
      paint(await api.load());
    } catch (error) {
      // load() 自己已经兜过底了，这里再兜一层，页面永远能渲染出来
      paint(DEFAULTS);
    }
  }

  async function persist(patch, successText) {
    if (saving) return;

    const previous = settings;

    // 先改界面（点了就得有反馈），存不上再退回去
    paint(Object.assign({}, previous, patch));
    setStatus('保存中…');
    setBusy(true);

    try {
      if (!api) {
        throw new Error('页面没加载设置模块');
      }

      const next = await api.save(patch);
      paint(Object.assign({}, previous, patch, next));
      setStatus(successText || '已保存');
      statusTimer = setTimeout(function () {
        statusTimer = null;
        if (!saving) setStatus('');
      }, 1500);
    } catch (error) {
      paint(previous);
      setStatus('没存上：' + ((error && error.message) || '网络不给力') + '，已退回原来的设置', true);
    } finally {
      setBusy(false);
    }
  }

  if (presetBtn) {
    presetBtn.addEventListener('click', function () {
      persist({ context_limit: 12, lean_mode: '1' }, '已切到最省');
    });
  }

  toggle.addEventListener('change', function () {
    persist({ lean_mode: toggle.checked ? '1' : '0' });
  });

  select.addEventListener('change', function () {
    const limit = Number(select.value);
    persist({ context_limit: CONTEXT_LIMITS.indexOf(limit) >= 0 ? limit : 40 });
  });

  paint(DEFAULTS);
  load();

  // 给别的脚本/排查用：当前页面上生效的省 token 设置
  window.__nocturneLeanSettings = {
    get settings() {
      return Object.assign({}, settings);
    }
  };
})();
