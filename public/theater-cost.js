(function () {
  'use strict';

  // 剧场的「省 token」设置：精简剧情记忆开关 + 带多少步剧情。
  // 读写都走 /api/settings/ui（字段 theater_lean / theater_context_limit）。
  // 后端还没上线这两个字段时，GET 里没有它们 → 按默认值（开、20 步）渲染，不报错。
  // 存不上就把界面退回原样，在面板里写一行小字，不弹 alert。

  const CONTEXT_LIMITS = [12, 20, 40];
  const DEFAULTS = { theater_lean: '1', theater_context_limit: 20 };

  const button = document.getElementById('costBtn');
  const sheet = document.getElementById('costSheet');
  const backdrop = document.getElementById('sheetBackdrop');
  const toggle = document.getElementById('theaterLeanToggle');
  const select = document.getElementById('theaterContextSelect');
  const status = document.getElementById('costStatus');

  if (!button || !sheet || !toggle || !select) return;

  let settings = Object.assign({}, DEFAULTS);
  let saving = false;
  let statusTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function normalize(raw) {
    const source = raw || {};
    const limit = Number(source.theater_context_limit);
    const lean = String(source.theater_lean);

    return {
      // 脏值 / 缺字段一律回默认：精简开、20 步
      theater_lean: lean === '0' || lean === '1' ? lean : '1',
      theater_context_limit: CONTEXT_LIMITS.indexOf(limit) >= 0 ? limit : 20
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
  }

  function paint(next) {
    settings = normalize(next);
    toggle.checked = settings.theater_lean === '1';
    select.value = String(settings.theater_context_limit);
  }

  async function load() {
    try {
      const response = await fetch('/api/settings/ui');
      const data = await response.json().catch(() => ({}));

      if (!response.ok) throw new Error((data && data.error) || '设置读取失败');

      paint(data && data.settings);
    } catch (error) {
      // 读不到就用默认值，页面照常能用
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
      const response = await fetch('/api/settings/ui', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error((data && data.error) || '保存失败');
      }

      paint(Object.assign({}, previous, patch, data && data.settings));
      setStatus(successText || '已保存');
      statusTimer = setTimeout(function () {
        statusTimer = null;
        if (!saving) setStatus('');
      }, 1600);
    } catch (error) {
      paint(previous);
      setStatus(
        '没存上：' + ((error && error.message) || '网络不给力') + '，已退回原来的设置',
        true
      );
    } finally {
      setBusy(false);
    }
  }

  // 打开面板：关掉其它弹层，再打开自己（关闭交给页面里已有的 [data-close] / 背景点击）
  function openCostSheet() {
    document.querySelectorAll('.sheet.open').forEach(function (item) {
      item.classList.remove('open');
    });

    sheet.classList.add('open');

    if (backdrop) backdrop.classList.add('open');
  }

  button.addEventListener('click', openCostSheet);

  toggle.addEventListener('change', function () {
    persist({ theater_lean: toggle.checked ? '1' : '0' }, '已保存');
  });

  select.addEventListener('change', function () {
    const limit = Number(select.value);

    persist(
      { theater_context_limit: CONTEXT_LIMITS.indexOf(limit) >= 0 ? limit : 20 },
      '已保存'
    );
  });

  paint(DEFAULTS);
  load();

  // 给排查用：当前页面上生效的值
  window.__nocturneTheaterCost = {
    get settings() {
      return Object.assign({}, settings);
    }
  };
})();
