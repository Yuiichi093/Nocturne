(function () {
  'use strict';

  // 「我的」页面里的用量卡片：今天/7 天/30 天花了多少、按来源分解、最近 20 次明细。
  // 接口：GET /api/usage/summary?days=1|7|30、GET /api/usage/logs?limit=20
  // 原则：读不到就好好说「用量还没法读出来」+ 重试；字段缺了跳过那一列，绝不让整页崩。
  // 全部 textContent，不 innerHTML、不 alert。

  const RANGE_LABELS = { 1: '今天', 7: '最近 7 天', 30: '最近 30 天' };

  const SOURCE_NAMES = {
    chat: '聊天',
    regenerate: '重新生成',
    suggest: '帮我想几句',
    moments: '朋友圈',
    theater: '剧场',
    image_prompt: '剧场画面描述'
  };

  const card = document.getElementById('usageCard');
  if (!card) return;

  const amountEl = document.getElementById('usageAmount');
  const subEl = document.getElementById('usageSub');
  const rangeEl = document.getElementById('usageRange');
  const sourcesEl = document.getElementById('usageSources');
  const logsToggle = document.getElementById('usageLogsToggle');
  const logsEl = document.getElementById('usageLogs');
  const errorEl = document.getElementById('usageError');
  const retryBtn = document.getElementById('usageRetry');

  let days = 1;
  let loading = false;
  let logsLoaded = false;

  function sourceName(source) {
    const key = String(source == null ? '' : source).trim();

    if (!key) {
      return '其他';
    }

    return SOURCE_NAMES[key] || key;
  }

  function money(value) {
    const number = Number(value);
    const safe = Number.isFinite(number) ? number : 0;

    // 一分钱以下的也老实显示 <¥0.01，别假装花了 0
    if (safe > 0 && safe < 0.01) {
      return '¥0.01 以下';
    }

    return '¥' + safe.toFixed(2);
  }

  function kilo(value) {
    const number = Number(value);
    const safe = Number.isFinite(number) ? number : 0;

    return (safe / 1000).toFixed(1);
  }

  function countText(value) {
    const number = Number(value);
    return String(Number.isFinite(number) ? number : 0);
  }

  function pick(obj, keys) {
    const source = obj || {};

    for (let i = 0; i < keys.length; i++) {
      const value = source[keys[i]];

      if (value !== undefined && value !== null && value !== '') {
        return value;
      }
    }

    return null;
  }

  function formatWhen(raw) {
    if (raw === null || raw === undefined || raw === '') {
      return '';
    }

    let date = null;

    if (typeof raw === 'number') {
      // 十位数当秒，十三位数当毫秒
      date = new Date(raw < 1e12 ? raw * 1000 : raw);
    } else {
      const text = String(raw);
      const asNumber = Number(text);

      if (text.length >= 9 && Number.isFinite(asNumber)) {
        date = new Date(asNumber < 1e12 ? asNumber * 1000 : asNumber);
      } else {
        // '2026-11-24 05:55:41' 在部分 WebView 上不认，先换成 ISO 样式
        date = new Date(text.indexOf('T') > 0 ? text : text.replace(' ', 'T'));
      }
    }

    if (!date || Number.isNaN(date.getTime())) {
      return String(raw);
    }

    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();

    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');

    if (sameDay) {
      return '今天 ' + hh + ':' + mm;
    }

    return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + hh + ':' + mm;
  }

  function setText(node, text) {
    if (node) node.textContent = text;
  }

  function clearChildren(node) {
    if (!node) return;

    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function setError(message) {
    setText(errorEl, message || '');
    if (errorEl) errorEl.hidden = !message;
    if (retryBtn) retryBtn.hidden = !message;
  }

  function updateChips() {
    if (!rangeEl) return;

    const chips = rangeEl.querySelectorAll('[data-usage-days]');

    for (let i = 0; i < chips.length; i++) {
      const chip = chips[i];
      const value = Number(chip.getAttribute('data-usage-days'));

      chip.classList.toggle('active', value === days);
      chip.setAttribute('aria-pressed', value === days ? 'true' : 'false');
      chip.disabled = loading;
    }
  }

  function renderSources(list) {
    if (!sourcesEl) return;

    clearChildren(sourcesEl);

    const rows = (Array.isArray(list) ? list : [])
      .filter((item) => item && (Number(item.calls) > 0 || Number(item.cost_yuan) > 0))
      .sort((a, b) => Number(b.cost_yuan || 0) - Number(a.cost_yuan || 0));

    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'usage-empty';
      empty.textContent = '这段时间还没花在什么地方。';
      sourcesEl.appendChild(empty);
      return;
    }

    rows.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'usage-source-row';
      row.setAttribute('data-usage-source', String(item.source || ''));

      const name = document.createElement('span');
      name.className = 'usage-source-name';
      name.textContent = sourceName(item.source);

      const meta = document.createElement('span');
      meta.className = 'usage-source-meta';
      meta.textContent = countText(item.calls) + ' 次 · ' + money(item.cost_yuan);

      row.appendChild(name);
      row.appendChild(meta);
      sourcesEl.appendChild(row);
    });
  }

  function renderSummary(data) {
    const total = (data && data.total) || {};

    setText(amountEl, (RANGE_LABELS[days] || '这段时间') + '花了 ' + money(total.cost_yuan));
    setText(subEl, countText(total.calls) + ' 次请求 · 输入 ' + kilo(total.input_tokens)
      + ' 千 / 输出 ' + kilo(total.output_tokens) + ' 千 token');
    renderSources(data && data.by_source);
  }

  function renderFail() {
    setText(amountEl, '—');
    setText(subEl, '');
    renderSources([]);
    if (sourcesEl) clearChildren(sourcesEl);
    setText(errorEl, '用量还没法读出来');
    if (errorEl) errorEl.hidden = false;
    if (retryBtn) retryBtn.hidden = false;
  }

  async function loadSummary() {
    if (loading) return;

    loading = true;
    updateChips();
    setError('');
    setText(subEl, '读取中…');

    try {
      const response = await fetch('/api/usage/summary?days=' + days, { credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));

      if (!response.ok || (data && data.ok === false)) {
        throw new Error((data && data.error) || '接口没回话');
      }

      renderSummary(data);
    } catch (error) {
      renderFail();
    } finally {
      loading = false;
      updateChips();
    }
  }

  function buildLogRow(item) {
    const row = document.createElement('div');
    row.className = 'usage-log-row';

    const top = document.createElement('div');
    top.className = 'usage-log-top';

    const source = document.createElement('span');
    source.className = 'usage-log-source';
    source.textContent = sourceName(pick(item, ['source']) || pick(item, ['kind']));

    const when = document.createElement('span');
    when.className = 'usage-log-meta';
    when.textContent = formatWhen(pick(item, ['at', 'created_at', 'time', 'ts', 'timestamp']));

    top.appendChild(source);
    top.appendChild(when);

    const meta = document.createElement('div');
    meta.className = 'usage-log-meta';

    const bits = [];
    const model = pick(item, ['model']);

    if (model) {
      bits.push(String(model));
    }

    const input = pick(item, ['input_tokens', 'prompt_tokens', 'input']);
    const output = pick(item, ['output_tokens', 'completion_tokens', 'output']);

    if (input !== null) {
      bits.push('输入 ' + kilo(input) + ' 千');
    }

    if (output !== null) {
      bits.push('输出 ' + kilo(output) + ' 千');
    }

    const cost = pick(item, ['cost_yuan', 'cost', 'cost_rmb', 'price']);

    if (cost !== null) {
      bits.push(money(cost));
    }

    meta.textContent = bits.join(' · ');

    row.appendChild(top);

    if (meta.textContent) {
      row.appendChild(meta);
    }

    return row;
  }

  async function loadLogs() {
    if (!logsEl) return;

    clearChildren(logsEl);

    const tip = document.createElement('p');
    tip.className = 'usage-empty';
    tip.textContent = '读取中…';
    logsEl.appendChild(tip);

    try {
      const response = await fetch('/api/usage/logs?limit=20', { credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));

      if (!response.ok || (data && data.ok === false)) {
        throw new Error((data && data.error) || '接口没回话');
      }

      let rows = [];

      if (Array.isArray(data)) {
        rows = data;
      } else if (Array.isArray(data.logs)) {
        rows = data.logs;
      } else if (Array.isArray(data.items)) {
        rows = data.items;
      } else if (Array.isArray(data.list)) {
        rows = data.list;
      } else if (Array.isArray(data.records)) {
        rows = data.records;
      }

      clearChildren(logsEl);

      if (rows.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'usage-empty';
        empty.textContent = '还没有明细。';
        logsEl.appendChild(empty);
        return;
      }

      rows.slice(0, 20).forEach((item) => {
        if (item && typeof item === 'object') {
          logsEl.appendChild(buildLogRow(item));
        }
      });

      if (!logsEl.firstChild) {
        const empty = document.createElement('p');
        empty.className = 'usage-empty';
        empty.textContent = '还没有明细。';
        logsEl.appendChild(empty);
      }
    } catch (error) {
      clearChildren(logsEl);

      const fail = document.createElement('p');
      fail.className = 'usage-empty';
      fail.textContent = '明细还没法读出来，等一下再点一次。';
      logsEl.appendChild(fail);
    }
  }

  function setLogsOpen(open) {
    if (!logsEl || !logsToggle) return;

    logsEl.hidden = !open;
    logsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    logsToggle.textContent = open ? '收起明细' : '看最近 20 次明细';

    if (open && !logsLoaded) {
      logsLoaded = true;
      loadLogs();
    }
  }

  if (rangeEl) {
    rangeEl.addEventListener('click', (event) => {
      const chip = event.target && event.target.closest ? event.target.closest('[data-usage-days]') : null;

      if (!chip) return;

      const next = Number(chip.getAttribute('data-usage-days'));

      if (!RANGE_LABELS[next] || next === days) return;

      days = next;
      updateChips();
      loadSummary();
    });
  }

  if (logsToggle) {
    logsToggle.addEventListener('click', () => {
      setLogsOpen(logsToggle.getAttribute('aria-expanded') !== 'true');
    });
  }

  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      loadSummary();

      if (logsToggle && logsToggle.getAttribute('aria-expanded') === 'true') {
        loadLogs();
      }
    });
  }

  updateChips();
  loadSummary();
})();
