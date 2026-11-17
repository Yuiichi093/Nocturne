(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const sessionId = params.get('session');
  const $ = (id) => document.getElementById(id);

  if (!sessionId) {
    location.href = '/theater.html';
    return;
  }

  let session = null;
  let script = null;
  let messages = [];
  let cast = [];
  let currentOptions = [];
  let sending = false;
  let drawing = false;

  // 剧情走向存在本地，换页面也不会丢
  const DIRECTION_KEY = 'theater-direction-' + sessionId;

  function getDirection() {
    try {
      return localStorage.getItem(DIRECTION_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function setDirection(value) {
    try {
      if (value) {
        localStorage.setItem(DIRECTION_KEY, value);
      } else {
        localStorage.removeItem(DIRECTION_KEY);
      }
    } catch (e) {}
  }

  function escapeHtml(text) {
    return String(text || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function parseJson(text, fallback) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return fallback;
    }
  }

  function findCast(id) {
    return cast.find((item) => Number(item.id) === Number(id)) || null;
  }

  function scrollToBottom() {
    $('story').scrollTop = $('story').scrollHeight;
  }

  // 加载失败时就地给提示 + 重试，别让页面永远停在「加载中...」
  function showStoryError(message, onRetry) {
    const story = $('story');
    if (story) {
      story.innerHTML = '';

      const box = document.createElement('div');
      box.className = 'narration-block';
      box.style.cssText = 'text-align:center;color:#8a8a8a;line-height:1.9;';
      box.textContent = '加载失败：' + (message || '连不上服务') + '。';

      if (typeof onRetry === 'function') {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '重试';
        button.style.cssText =
          'display:block;margin:12px auto 0;padding:6px 18px;border:0;' +
          'border-radius:999px;background:#111;color:#fff;font:inherit;font-size:13px;';
        button.addEventListener('click', () => {
          button.disabled = true;
          button.textContent = '重试中…';
          Promise.resolve()
            .then(onRetry)
            .catch((error) => showStoryError(error && error.message, onRetry));
        });
        box.appendChild(button);
      }

      story.appendChild(box);
    }

    const title = $('scriptTitle');
    if (title && title.textContent === '加载中...') {
      title.textContent = '加载失败';
    }
  }

  async function loadAll() {
    let data;

    try {
      const response = await fetch('/api/theater/sessions/' + sessionId);

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));

        if (response.status === 404) {
          // 会话真的不存在：回剧场列表是对的
          alert(body.error || '剧场会话不存在');
          location.href = '/theater.html';
          return false;
        }

        throw new Error(body.error || '剧场加载失败');
      }

      data = await response.json();
    } catch (error) {
      // 断网 / 服务被回收：留在当前页，给出可重试的提示
      showStoryError(error.message, loadAll);
      return false;
    }

    session = data.session;
    script = data.script;

    if (!session || !script) {
      showStoryError('这个剧本已经不在了', null);
      return false;
    }

    $('scriptTitle').textContent = script.title;
    $('scriptSubtitle').textContent = script.subtitle || '初始副本';
    document.title = 'Nocturne · ' + script.title;

    const castIds = Array.isArray(script.cast_ids)
      ? script.cast_ids.map(Number)
      : [];

    if (castIds.length) {
      try {
        const castResponse = await fetch('/api/characters');

        if (!castResponse.ok) {
          throw new Error('角色列表加载失败');
        }

        const allCharacters = await castResponse.json();

        cast = Array.isArray(allCharacters)
          ? allCharacters.filter((item) => castIds.includes(Number(item.id)))
          : [];
      } catch (error) {
        // 阵容只影响头像/名字显示，失败不该挡住剧情
        cast = [];
        console.warn('剧场阵容加载失败：' + error.message);
      }
    } else {
      cast = [];
    }

    await renderChapters();
    renderInfo();
    await loadMessages();
    return true;
  }

  async function loadMessages() {
    let rows;

    try {
      const response = await fetch(
        '/api/theater/sessions/' + sessionId + '/messages'
      );

      if (!response.ok) {
        throw new Error('剧情加载失败');
      }

      rows = await response.json();
    } catch (error) {
      messages = [];
      showStoryError(error.message, loadMessages);
      return false;
    }

    messages = Array.isArray(rows) ? rows : [];
    renderStory();
    return true;
  }

  function renderStory() {
    const story = $('story');
    story.innerHTML = '';
    currentOptions = [];

    let lastOptionsId = null;

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'options') {
        lastOptionsId = messages[i].id;
        break;
      }
    }

    if (!messages.length) {
      const empty = document.createElement('div');
      empty.className = 'narration-block';
      empty.textContent = '故事还没有开始。';
      story.appendChild(empty);
      return;
    }

    messages.forEach((message) => {
      if (message.role === 'narration') {
        const block = document.createElement('div');
        block.className = 'narration-block';
        block.textContent = message.content || '';
        story.appendChild(block);
        return;
      }

      // 生图接口插入的插画消息：图片 + 画面描述
      if (message.role === 'narrator') {
        const block = document.createElement('div');
        block.className = 'image-block';

        if (message.image_url) {
          const card = document.createElement('figure');
          card.className = 'scene-image';

          const image = document.createElement('img');
          image.src = String(message.image_url);
          image.alt = message.content || '插画';
          image.loading = 'lazy';
          image.dataset.sceneImage = String(message.image_url);
          card.appendChild(image);

          if (message.content) {
            const caption = document.createElement('figcaption');
            caption.textContent = message.content;
            card.appendChild(caption);
          }

          block.appendChild(card);
        } else if (message.content) {
          const text = document.createElement('div');
          text.className = 'image-note';
          text.textContent = message.content;
          block.appendChild(text);
        }

        if (block.childNodes.length) story.appendChild(block);
        return;
      }

      if (message.role === 'user') {
        const block = document.createElement('div');
        block.className = 'user-block';
        const bubble = document.createElement('div');
        bubble.className = 'user-bubble';
        bubble.textContent = message.content || '';
        block.appendChild(bubble);
        story.appendChild(block);
        return;
      }

      if (message.role === 'character') {
        const character = findCast(message.character_id);
        const block = document.createElement('div');
        block.className = 'character-block';

        const avatar = document.createElement('div');
        avatar.className = 'character-avatar';

        if (character && character.avatar) {
          avatar.innerHTML =
            '<img src="' + escapeHtml(character.avatar) + '" alt="">';
        } else {
          avatar.textContent = String(
            (character && character.name) || '角'
          ).slice(0, 1);
        }

        const bubble = document.createElement('div');
        bubble.className = 'character-bubble';
        bubble.textContent = message.content || '';

        block.appendChild(avatar);
        block.appendChild(bubble);
        story.appendChild(block);
        return;
      }

      if (message.role === 'dice') {
        const block = document.createElement('div');
        block.className = 'dice-block';
        block.textContent = message.content || '';
        story.appendChild(block);
        return;
      }

      if (message.role === 'options') {
        if (Number(message.id) !== Number(lastOptionsId)) return;

        const meta = parseJson(message.meta_json, {});
        const options = Array.isArray(meta.options) ? meta.options : [];
        currentOptions = options;

        const card = document.createElement('div');
        card.className = 'options-card';
        card.innerHTML = `
          <div class="options-head">
            <h2>下一步</h2>
            <div class="options-head-actions">
              <button id="regenerateBtn" type="button" title="重选这一步">⟲</button>
              <button id="refreshOptionsBtn" type="button" title="只换选项">↻</button>
              <button id="editOptionsBtn" type="button" title="自定义行动">✎</button>
            </div>
          </div>
          ${options.map((option, index) => `
            <button class="option-item" data-option-index="${index}" type="button">
              ${escapeHtml(option)}
            </button>
          `).join('')}
          <button class="option-custom" id="customActionBtn" type="button">
            自定义行动
          </button>
          <button class="option-custom ghost${getDirection() ? ' has-value' : ''}" id="directionChipBtn" type="button">
            ${getDirection() ? '剧情走向：已设置（点击修改）' : '设置剧情走向'}
          </button>
        `;

        story.appendChild(card);
      }
    });

    scrollToBottom();
  }

  function showTyping() {
    hideTyping();

    const block = document.createElement('div');
    block.className = 'character-block';
    block.id = 'typingBlock';

    const avatar = document.createElement('div');
    avatar.className = 'character-avatar';
    avatar.textContent = '…';

    const bubble = document.createElement('div');
    bubble.className = 'typing';
    bubble.innerHTML = '<i></i><i></i><i></i>';

    block.appendChild(avatar);
    block.appendChild(bubble);
    $('story').appendChild(block);
    scrollToBottom();
  }

  function hideTyping() {
    const block = document.getElementById('typingBlock');
    if (block) block.remove();
  }

  function showDrawing() {
    hideDrawing();

    const block = document.createElement('div');
    block.className = 'image-block';
    block.id = 'drawingBlock';

    const card = document.createElement('div');
    card.className = 'scene-image scene-image-skeleton';
    card.textContent = '正在画…';

    block.appendChild(card);
    $('story').appendChild(block);
    scrollToBottom();
  }

  function hideDrawing() {
    const block = document.getElementById('drawingBlock');
    if (block) block.remove();
  }

  function openImage(url) {
    if (!url) return;
    $('imageViewerImg').src = String(url);
    $('imageViewer').classList.add('open');
    $('imageViewer').setAttribute('aria-hidden', 'false');
  }

  function closeImage() {
    $('imageViewer').classList.remove('open');
    $('imageViewer').setAttribute('aria-hidden', 'true');
    $('imageViewerImg').removeAttribute('src');
  }

  function openDrawSheet() {
    if (drawing) return;
    $('drawStatus').textContent = '';
    openSheet('drawSheet');
  }

  async function generateSceneImage() {
    if (drawing) return;

    drawing = true;

    const button = $('drawGenerate');
    const original = button.textContent;
    const promptInput = $('drawPrompt');
    const sizeInput = $('drawSize');

    button.disabled = true;
    button.textContent = '画图中…';
    $('drawStatus').classList.remove('error');
    $('drawStatus').textContent = '正在画…';

    showDrawing();

    try {
      const response = await fetch(
        '/api/theater/sessions/' + sessionId + '/image',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: promptInput ? promptInput.value.trim() : '',
            size: sizeInput ? sizeInput.value : '1024x1024'
          })
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || '生成失败');
      }

      if (promptInput) promptInput.value = '';

      hideDrawing();
      closeSheets();
      await loadMessages();
    } catch (error) {
      hideDrawing();
      $('drawStatus').classList.add('error');
      $('drawStatus').textContent = '生成失败：' + error.message;
    } finally {
      drawing = false;
      button.disabled = false;
      button.textContent = original;
    }
  }

  async function renderChapters() {
    const box = $('chaptersContent');

    try {
      const response = await fetch(
        '/api/theater/scripts/' + script.id + '/sessions'
      );
      const rows = await response.json();

      if (!response.ok) {
        throw new Error(rows.error || '加载失败');
      }

      box.innerHTML = rows.map((row) => {
        const isCurrent = Number(row.id) === Number(sessionId);

        return `
          <div class="chapter-row${isCurrent ? ' current' : ''}">
            <div class="chapter-main" data-open-session="${row.id}">
              <div class="chapter-title">
                ${escapeHtml(row.title || '未命名剧情')}${isCurrent ? '（当前）' : ''}
              </div>
              <div class="chapter-sub">
                ${escapeHtml(row.identity_name || '')} · ${escapeHtml(String(row.updated_at || row.created_at || ''))}
              </div>
            </div>
            ${isCurrent ? '' : `<button class="chapter-del" data-del-session="${row.id}" type="button">删除</button>`}
          </div>
        `;
      }).join('') + `
        <button class="sheet-btn" id="chapterBranchBtn" type="button">从当前进度创建分支</button>
      `;
    } catch (error) {
      box.textContent = '加载失败：' + error.message;
    }
  }

  function renderInfo() {
    const castText = cast.length
      ? cast.map((item) => item.name).join('、')
      : '未设置参演角色';

    const godMode = String(session.identity_role || '') === '上帝视角';

    $('infoContent').textContent =
      '剧本：' + script.title + '\n' +
      '副标题：' + (script.subtitle || '无') + '\n\n' +
      (godMode
        ? '视角：上帝视角（不扮演角色，只旁观并替主角选择）\n\n'
        : '用户身份：' + session.identity_name + '，' +
          session.identity_role + '\n' +
          (session.identity_desc ? '身份描述：' + session.identity_desc + '\n\n' : '\n')) +
      '参演角色：' + castText + '\n\n' +
      '背景：' + (script.premise || '无') + '\n\n' +
      '规则：' + (script.rules || '无');
  }

  function openSheet(id) {
    closeSheets();
    const sheet = $(id);
    if (!sheet) return;
    sheet.classList.add('open');
    $('sheetBackdrop').classList.add('open');
  }

  function closeSheets() {
    document.querySelectorAll('.sheet.open').forEach((sheet) => {
      sheet.classList.remove('open');
    });
    $('sheetBackdrop').classList.remove('open');
  }

  async function refreshOptions() {
    if (sending) return;

    sending = true;
    showTyping();

    try {
      const response = await fetch(
        '/api/theater/sessions/' + sessionId + '/options/refresh',
        { method: 'POST' }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '刷新选项失败');
      }

      await loadMessages();
    } catch (error) {
      alert('刷新选项失败：' + error.message);
    } finally {
      hideTyping();
      sending = false;
    }
  }

  async function sendAction(action) {
    if (sending) return;

    sending = true;
    closeSheets();

    if (action) {
      const block = document.createElement('div');
      block.className = 'user-block';

      const bubble = document.createElement('div');
      bubble.className = 'user-bubble';
      bubble.textContent = action;

      block.appendChild(bubble);
      $('story').appendChild(block);
      scrollToBottom();
    }

    showTyping();

    try {
      const response = await fetch(
        '/api/theater/sessions/' + sessionId + '/next',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: action || '',
            direction: getDirection()
          })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '生成失败');
      }

      await loadMessages();
    } catch (error) {
      alert('生成失败：' + error.message);
    } finally {
      hideTyping();
      sending = false;
    }
  }

  async function regenerate() {
    if (sending) return;

    sending = true;
    showTyping();

    try {
      const response = await fetch(
        '/api/theater/sessions/' + sessionId + '/undo',
        { method: 'POST' }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '重选失败');
      }

      await loadMessages();
    } catch (error) {
      alert('重选失败：' + error.message);
      sending = false;
      hideTyping();
      return;
    }

    sending = false;
    hideTyping();
    await sendAction('');
  }

  $('story').addEventListener('click', (event) => {
    const sceneImage = event.target.closest('[data-scene-image]');

    if (sceneImage) {
      openImage(sceneImage.dataset.sceneImage);
      return;
    }

    const option = event.target.closest('[data-option-index]');

    if (option) {
      const index = Number(option.dataset.optionIndex);
      const text = currentOptions[index];
      if (text) sendAction(text);
      return;
    }

    if (event.target.closest('#regenerateBtn')) {
      regenerate();
      return;
    }

    if (event.target.closest('#refreshOptionsBtn')) {
      refreshOptions();
      return;
    }

    if (event.target.closest('#directionChipBtn')) {
      $('directionText').value = getDirection();
      openSheet('directionSheet');
      return;
    }

    if (event.target.closest('#customActionBtn') ||
        event.target.closest('#editOptionsBtn')) {
      openSheet('actionSheet');
    }
  });

  $('continueBtn').addEventListener('click', () => {
    sendAction('');
  });

  $('drawBtn').addEventListener('click', openDrawSheet);

  $('drawFromMoreBtn').addEventListener('click', openDrawSheet);

  $('drawGenerate').addEventListener('click', generateSceneImage);

  $('imageViewer').addEventListener('click', closeImage);

  $('diceFab').addEventListener('click', () => {
    openSheet('diceSheet');
  });

  $('moreBtn').addEventListener('click', () => {
    openSheet('moreSheet');
  });

  $('backBtn').addEventListener('click', () => {
    window.nocturneBack();
  });

  $('backTheater').addEventListener('click', () => {
    location.href = '/theater.html';
  });

  $('openAction').addEventListener('click', () => {
    openSheet('actionSheet');
  });

  $('sendAction').addEventListener('click', () => {
    const text = $('actionText').value.trim();
    if (!text) return;
    $('actionText').value = '';
    sendAction(text);
  });

  $('rollDice').addEventListener('click', async () => {
    const formula = $('diceFormula').value;
    const modifier = Number($('diceModifier').value || 0);
    const fullFormula = formula + (
      modifier > 0 ? '+' + modifier : modifier < 0 ? String(modifier) : ''
    );

    try {
      $('diceResult').textContent = '投掷中...';

      const response = await fetch(
        '/api/theater/sessions/' + sessionId + '/dice',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ formula: fullFormula })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '投掷失败');
      }

      $('diceResult').textContent =
        data.message.content + '\n' +
        '总点数：' + data.result.total;

      await loadMessages();
    } catch (error) {
      $('diceResult').textContent = '投掷失败：' + error.message;
    }
  });

  $('saveRewrite').addEventListener('click', async () => {
    const content = $('correctionText').value.trim();
    if (!content) return;

    try {
      $('saveRewrite').textContent = '重写中...';
      $('saveRewrite').disabled = true;

      const response = await fetch(
        '/api/theater/sessions/' + sessionId + '/rewrite',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '修正失败');
      }

      $('correctionText').value = '';
      closeSheets();

      if (data.needs_next) {
        await sendAction('');
      } else {
        await loadMessages();
      }
    } catch (error) {
      alert('修正失败：' + error.message);
    } finally {
      $('saveRewrite').textContent = '保存并重写';
      $('saveRewrite').disabled = false;
    }
  });

  async function createBranch() {
    try {
      const response = await fetch(
        '/api/theater/sessions/' + sessionId + '/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '创建分支失败');
      }

      location.href = '/theater-play.html?session=' + data.session.id;
    } catch (error) {
      alert('创建分支失败：' + error.message);
    }
  }

  async function deleteCurrentSession() {
    if (!confirm('确定删除当前剧情？删了就找不回来了。')) return;

    try {
      const response = await fetch(
        '/api/theater/sessions/' + sessionId,
        { method: 'DELETE' }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '删除失败');
      }

      location.href = '/theater.html';
    } catch (error) {
      alert('删除失败：' + error.message);
    }
  }

  $('directionBtn').addEventListener('click', () => {
    $('directionText').value = getDirection();
    openSheet('directionSheet');
  });

  $('saveDirection').addEventListener('click', () => {
    setDirection($('directionText').value.trim());
    closeSheets();
    renderStory();
  });

  $('branchSessionBtn').addEventListener('click', createBranch);
  $('deleteSessionBtn').addEventListener('click', deleteCurrentSession);

  $('chaptersContent').addEventListener('click', async (event) => {
    if (event.target.id === 'chapterBranchBtn') {
      createBranch();
      return;
    }

    const openRow = event.target.closest('[data-open-session]');
    if (openRow) {
      location.href = '/theater-play.html?session=' + openRow.dataset.openSession;
      return;
    }

    const delRow = event.target.closest('[data-del-session]');
    if (delRow) {
      if (!confirm('确定删除这个剧情？')) return;

      try {
        const response = await fetch(
          '/api/theater/sessions/' + delRow.dataset.delSession,
          { method: 'DELETE' }
        );
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || '删除失败');
        }

        await renderChapters();
      } catch (error) {
        alert('删除失败：' + error.message);
      }
    }
  });

  document.querySelectorAll('[data-panel]').forEach((button) => {
    button.addEventListener('click', () => {
      openSheet(button.dataset.panel + 'Sheet');

      if (button.dataset.panel === 'chapters') {
        renderChapters();
      }
    });
  });

  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', closeSheets);
  });

  $('sheetBackdrop').addEventListener('click', closeSheets);

  loadAll().catch((error) => {
    showStoryError(error && error.message, loadAll);
  });
})();
