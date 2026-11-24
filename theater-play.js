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
  let optionVersions = [];      // 当前这段旁白的全部选项版本
  let optionVersionIndex = 0;   // 正在看第几版（0 起）
  let optionNarrationId = 0;    // 这些版本属于哪段旁白
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

  // 长会话里真正滚动的是 document（.story 自己没有 overflow），
  // 两处都拨到底，重进旧会话才不会停在最上面。
  function scrollToBottom() {
    const story = $('story');

    if (story) story.scrollTop = story.scrollHeight;

    const scroller = document.scrollingElement || document.documentElement;

    if (scroller) scroller.scrollTop = scroller.scrollHeight;

    // 有些老 WebView 只认 window.scrollTo，两处都拨一下才稳
    if (typeof window.scrollTo === 'function') {
      const body = document.body;
      window.scrollTo(0, scroller ? scroller.scrollHeight : (body ? body.scrollHeight : 0));
    }
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

    // 初次进来时字体/图片还没把高度撑开，补两次滚动：一帧后 + 250ms；
    // 只在这里补，之后追加消息走 scrollToBottom() 就够了
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(scrollToBottom);
    }

    setTimeout(scrollToBottom, 250);

    return true;
  }

  async function loadMessages(keepVersionId) {
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

    optionVersions = [];
    optionVersionIndex = 0;
    optionNarrationId = 0;

    // 最后一批选项属于哪段旁白，就去把那段旁白的所有版本拿回来（一次请求，翻页不再发）
    let lastOptions = null;

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'options') {
        lastOptions = messages[i];
        break;
      }
    }

    if (lastOptions) {
      const lastOptionsMeta = parseJson(lastOptions.meta_json, {});

      // 优先按位置找（最后一段旁白的 id）。分支会话是从别的会话复制过来的，
      // meta 里的 narration_id 还是原会话的 id，照着用会查不到，翻页和「换一批」都会失灵。
      let narrationId = 0;

      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === 'narration') {
          narrationId = Number(messages[i].id);
          break;
        }
      }

      if (!narrationId) {
        narrationId = Number(lastOptionsMeta.narration_id) || 0;
      }

      if (narrationId) {
        optionNarrationId = narrationId;

        try {
          const versionResponse = await fetch(
            '/api/theater/sessions/' + sessionId +
            '/options?narration_id=' + narrationId
          );

          if (versionResponse.ok) {
            const versionData = await versionResponse.json();

            if (versionData && Array.isArray(versionData.versions)) {
              optionVersions = versionData.versions;
            }
          }
        } catch (error) {
          // 版本接口挂了别挡住剧情，下面会用消息里那一条兜底
        }
      }

      const keepIndex = optionVersions.findIndex(
        (version) => Number(version.id) === Number(keepVersionId)
      );

      optionVersionIndex = keepIndex >= 0
        ? keepIndex
        : Math.max(optionVersions.length - 1, 0);
    }

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

        // 版本接口没回数据（老数据 / 断网）时，用消息里自带的这一批兜底
        if (!optionVersions.length) {
          optionVersions = [{
            id: Number(message.id),
            options: Array.isArray(meta.options) ? meta.options : [],
            version: Number(meta.version) || 1,
            source: String(meta.source || '')
          }];
          optionVersionIndex = 0;
        }

        if (optionVersionIndex >= optionVersions.length) {
          optionVersionIndex = optionVersions.length - 1;
        }

        const card = document.createElement('div');
        card.className = 'options-card';

        // 版本翻页条：‹ 3/5 ›（只有一版时整条隐藏）
        const pager = document.createElement('div');
        pager.className = 'options-pager';
        pager.id = 'optionsPager';

        const prevButton = document.createElement('button');
        prevButton.id = 'optionsPrevBtn';
        prevButton.className = 'options-pager-arrow';
        prevButton.type = 'button';
        prevButton.title = '上一版选项';
        prevButton.textContent = '‹';

        const pagerLabel = document.createElement('span');
        pagerLabel.id = 'optionsPagerLabel';
        pagerLabel.className = 'options-pager-label';

        const nextButton = document.createElement('button');
        nextButton.id = 'optionsNextBtn';
        nextButton.className = 'options-pager-arrow';
        nextButton.type = 'button';
        nextButton.title = '下一版选项';
        nextButton.textContent = '›';

        pager.appendChild(prevButton);
        pager.appendChild(pagerLabel);
        pager.appendChild(nextButton);
        card.appendChild(pager);

        const head = document.createElement('div');
        head.className = 'options-head';

        const heading = document.createElement('h2');
        heading.textContent = '下一步';

        const actions = document.createElement('div');
        actions.className = 'options-head-actions';

        [
          { id: 'rollbackBtn', title: '撤回上一步', text: '↩' },
          { id: 'regenerateBtn', title: '换一批选项', text: '⟲' },
          { id: 'editOptionsBtn', title: '编辑这一版', text: '✎' },
          { id: 'deleteOptionsBtn', title: '删除这一版', text: '🗑' }
        ].forEach((def) => {
          const button = document.createElement('button');
          button.id = def.id;
          button.type = 'button';
          button.title = def.title;
          button.textContent = def.text;
          actions.appendChild(button);
        });

        head.appendChild(heading);
        head.appendChild(actions);
        card.appendChild(head);

        const list = document.createElement('div');
        list.className = 'options-list';
        list.id = 'optionsList';
        card.appendChild(list);

        const customButton = document.createElement('button');
        customButton.className = 'option-custom';
        customButton.id = 'customActionBtn';
        customButton.type = 'button';
        customButton.textContent = '自定义行动';
        card.appendChild(customButton);

        const directionButton = document.createElement('button');
        directionButton.className = 'option-custom ghost' + (getDirection() ? ' has-value' : '');
        directionButton.id = 'directionChipBtn';
        directionButton.type = 'button';
        directionButton.textContent = getDirection()
          ? '剧情走向：已设置（点击修改）'
          : '设置剧情走向';
        card.appendChild(directionButton);

        const branchButton = document.createElement('button');
        branchButton.className = 'option-branch';
        branchButton.id = 'branchFromVersionBtn';
        branchButton.type = 'button';
        branchButton.textContent = '从这一版开分支';
        card.appendChild(branchButton);

        story.appendChild(card);
        syncOptionsView();
      }
    });

    scrollToBottom();
  }

  // 把当前这一版选项铺到卡片上：翻页、编辑、删除后都只走这里，不发请求
  function syncOptionsView() {
    const list = $('optionsList');
    if (!list) return;

    const total = optionVersions.length;
    const active = optionVersions[optionVersionIndex] || null;

    list.innerHTML = '';
    currentOptions = active && Array.isArray(active.options)
      ? active.options.slice()
      : [];

    currentOptions.forEach((option, index) => {
      const button = document.createElement('button');
      button.className = 'option-item';
      button.type = 'button';
      button.dataset.optionIndex = String(index);
      button.textContent = String(option);
      list.appendChild(button);
    });

    const pager = $('optionsPager');
    const prev = $('optionsPrevBtn');
    const next = $('optionsNextBtn');
    const label = $('optionsPagerLabel');
    const deleteButton = $('deleteOptionsBtn');

    if (pager) pager.hidden = total <= 1;
    if (label) label.textContent = (optionVersionIndex + 1) + '/' + Math.max(total, 1);
    if (prev) prev.disabled = optionVersionIndex <= 0;
    if (next) next.disabled = optionVersionIndex >= total - 1;
    if (deleteButton) deleteButton.disabled = total <= 1;
  }

  function stepOptionVersion(delta) {
    if (!optionVersions.length) return;

    const nextIndex = optionVersionIndex + delta;

    if (nextIndex < 0 || nextIndex >= optionVersions.length) return;

    optionVersionIndex = nextIndex;
    syncOptionsView();
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
        <button class="sheet-btn ghost" id="chapterPrevBranchBtn" type="button">从以前的进度创建分支</button>
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

  // 换一批选项：只重新生成选项，旁白不动，旧版本留着
  async function regenerateOptions() {
    if (sending || !optionNarrationId) return;

    sending = true;

    const button = $('regenerateBtn');
    if (button) button.disabled = true;

    showTyping();

    try {
      const response = await fetch(
        '/api/theater/sessions/' + sessionId + '/options',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ narration_id: optionNarrationId })
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || '换一批失败');
      }

      await loadMessages();
    } catch (error) {
      alert('换一批选项失败：' + error.message);
    } finally {
      hideTyping();
      sending = false;

      const again = $('regenerateBtn');
      if (again) again.disabled = false;
    }
  }

  let editingOptionsId = 0;

  function editOptionsVersion() {
    const active = optionVersions[optionVersionIndex];
    if (!active) return;

    editingOptionsId = Number(active.id);

    const textarea = $('optionsEditText');
    if (textarea) {
      textarea.value = (Array.isArray(active.options) ? active.options : []).join('\n');
    }

    const status = $('optionsEditStatus');
    if (status) {
      status.hidden = true;
      status.textContent = '';
      status.classList.remove('error');
    }

    const save = $('optionsEditSave');
    if (save) save.disabled = false;

    openSheet('optionsEditSheet');
  }

  async function saveOptionsEdit() {
    if (sending || !editingOptionsId) return;

    const textarea = $('optionsEditText');
    const status = $('optionsEditStatus');
    const save = $('optionsEditSave');

    const lines = String(textarea && textarea.value ? textarea.value : '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length < 2 || lines.length > 6) {
      if (status) {
        status.hidden = false;
        status.textContent = '保留 2 到 6 条选项';
        status.classList.add('error');
      }
      return;
    }

    sending = true;
    if (save) save.disabled = true;

    const savedId = editingOptionsId;

    try {
      const response = await fetch('/api/theater/options/' + savedId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ options: lines })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || '保存失败');
      }

      closeSheets();
      await loadMessages(savedId);
    } catch (error) {
      if (status) {
        status.hidden = false;
        status.textContent = '保存失败：' + error.message;
        status.classList.add('error');
      }
    } finally {
      sending = false;
      if (save) save.disabled = false;
    }
  }

  async function deleteOptionsVersion() {
    if (sending) return;

    const active = optionVersions[optionVersionIndex];
    if (!active || optionVersions.length <= 1) return;

    if (!confirm('删掉这一版选项？其他版本还在。')) return;

    sending = true;

    const button = $('deleteOptionsBtn');
    if (button) button.disabled = true;

    try {
      const response = await fetch('/api/theater/options/' + active.id, {
        method: 'DELETE'
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || '删除失败');
      }

      await loadMessages();
    } catch (error) {
      alert('删除失败：' + error.message);
    } finally {
      sending = false;

      const again = $('deleteOptionsBtn');
      if (again) again.disabled = optionVersions.length <= 1;
    }
  }

  // 从正在看的这一版选项开分支
  async function branchFromVersion() {
    if (sending) return;

    const active = optionVersions[optionVersionIndex];

    if (!active || !optionNarrationId) return;

    sending = true;

    const button = $('branchFromVersionBtn');
    if (button) {
      button.disabled = true;
      button.textContent = '正在创建分支…';
    }

    try {
      const response = await fetch(
        '/api/theater/sessions/' + sessionId + '/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            narration_id: optionNarrationId,
            options_id: Number(active.id),
            title: (session && session.title ? session.title : '剧情') + ' · 分支'
          })
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || '创建分支失败');
      }

      if (data.session && data.session.id) {
        location.href = '/theater-play.html?session=' + data.session.id;
        return;
      }

      throw new Error('新分支没有创建成功');
    } catch (error) {
      alert('创建分支失败：' + error.message);
      sending = false;

      const again = $('branchFromVersionBtn');
      if (again) {
        again.disabled = false;
        again.textContent = '从这一版开分支';
      }
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

  // 撤回上一步：删掉刚刚这一步，回到上一次的选项重选
  async function rollbackStep() {
    if (sending) return;

    if (!confirm('撤回这一步？这段剧情会被删掉，回到上一步的选项。')) return;

    sending = true;

    const button = $('rollbackBtn');
    if (button) button.disabled = true;

    try {
      const response = await fetch(
        '/api/theater/sessions/' + sessionId + '/rollback',
        { method: 'POST' }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || '撤回失败');
      }

      await loadMessages();
    } catch (error) {
      alert('撤回失败：' + error.message);
    } finally {
      sending = false;

      const again = $('rollbackBtn');
      if (again) again.disabled = false;
    }
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

    if (event.target.closest('#optionsPrevBtn')) {
      stepOptionVersion(-1);
      return;
    }

    if (event.target.closest('#optionsNextBtn')) {
      stepOptionVersion(1);
      return;
    }

    if (event.target.closest('#rollbackBtn')) {
      rollbackStep();
      return;
    }

    if (event.target.closest('#regenerateBtn')) {
      regenerateOptions();
      return;
    }

    if (event.target.closest('#editOptionsBtn')) {
      editOptionsVersion();
      return;
    }

    if (event.target.closest('#deleteOptionsBtn')) {
      deleteOptionsVersion();
      return;
    }

    if (event.target.closest('#branchFromVersionBtn')) {
      branchFromVersion();
      return;
    }

    if (event.target.closest('#directionChipBtn')) {
      $('directionText').value = getDirection();
      openSheet('directionSheet');
      return;
    }

    if (event.target.closest('#customActionBtn')) {
      openSheet('actionSheet');
    }
  });

  $('continueBtn').addEventListener('click', () => {
    sendAction('');
  });

  $('optionsEditSave').addEventListener('click', saveOptionsEdit);

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

  async function createBranch(upTo) {
    const upToId = Number(upTo) || 0;
    const payload = upToId > 0
      ? { up_to_message_id: upToId, title: (session.title || '剧情') + ' · 分支' }
      : {};

    try {
      const response = await fetch(
        '/api/theater/sessions/' + sessionId + '/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
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

  // 从以前的进度开分支：先拉一份步骤列表，点哪一步就从哪一步开
  async function openHistoryBranch() {
    const list = $('historyBranchList');
    const status = $('historyBranchStatus');

    list.textContent = '正在加载…';
    status.textContent = '';
    status.classList.remove('error');
    status.hidden = true;

    openSheet('historyBranchSheet');

    let steps = [];

    try {
      const response = await fetch(
        '/api/theater/sessions/' + sessionId + '/history?limit=40'
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || '加载不了历史进度');
      }

      steps = Array.isArray(data.steps) ? data.steps : [];
    } catch (error) {
      list.textContent = '';
      status.classList.add('error');
      status.hidden = false;
      status.textContent = '加载失败：' + error.message;
      return;
    }

    if (!steps.length) {
      list.textContent = '还没有可以开分支的进度。';
      return;
    }

    list.innerHTML = '';

    steps
      .slice()
      .reverse()
      .forEach((step) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'history-step';
        row.dataset.branchUpTo = String(
          Number(step.options_id) || Number(step.narration_id) || 0
        );

        const title = document.createElement('div');
        title.className = 'history-step-title';
        title.textContent = '第 ' + (Number(step.index) + 1) + ' 步';

        const preview = document.createElement('div');
        preview.className = 'history-step-sub';
        preview.textContent = step.preview || '（这一段没有预览文字）';

        row.appendChild(title);
        row.appendChild(preview);
        list.appendChild(row);
      });
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

    if (event.target.id === 'chapterPrevBranchBtn') {
      openHistoryBranch();
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

  $('historyBranchList').addEventListener('click', (event) => {
    const row = event.target.closest('[data-branch-up-to]');
    if (!row) return;

    const upTo = Number(row.dataset.branchUpTo);
    if (!upTo) return;

    createBranch(upTo);
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
