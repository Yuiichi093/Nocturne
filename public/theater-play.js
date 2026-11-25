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
  let currentOptions = [];      // 最新一步当前这一版的选项（点选项推进剧情用）
  let stepVersions = {};        // narrationId -> 该步骤的全部选项版本（options/all 一次拿全）
  let stepIndex = {};           // narrationId -> 该步骤正在看第几版（0 起）
  let optionVersions = [];      // 最新一步的版本数组（兼容老逻辑：换一批 / 撤回）
  let optionVersionIndex = 0;
  let optionNarrationId = 0;    // 最新一段旁白（⟲ 换一批只作用于它）
  let latestStepKey = '';
  let latestNarrationId = 0;
  let lastOptionsRowId = 0;
  let cardElements = {};        // narrationId -> 卡片 DOM，翻页/重绘用
  let sending = false;
  let drawing = false;
  let expandedHiddenImages = {};  // 已隐藏的插画临时展开看一眼（不落库）

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

  // 一次拿全会话所有步骤的选项版本，存成 { narrationId: [versions] }。
  // 之后切步骤、翻版本都不再发请求；接口挂了就退回每条消息自带的 meta.options。
  async function loadStepVersions(preserveIndex) {
    let groups = [];

    try {
      const response = await fetch(
        '/api/theater/sessions/' + sessionId + '/options/all'
      );

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        groups = Array.isArray(data.groups) ? data.groups : [];
      }
    } catch (error) {
      groups = [];
    }

    const nextVersions = {};
    const nextIndex = {};

    groups.forEach((group) => {
      const narrationId = Number(group.narration_id) || 0;
      const list = Array.isArray(group.versions) ? group.versions : [];

      if (!narrationId || !list.length) return;

      const key = String(narrationId);
      nextVersions[key] = list;

      const old = preserveIndex ? Number(stepIndex[key]) : NaN;
      nextIndex[key] =
        Number.isInteger(old) && old >= 0 && old < list.length
          ? old
          : list.length - 1;
    });

    stepVersions = nextVersions;
    stepIndex = nextIndex;
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

    await loadStepVersions(false);

    // 编辑保存后回到改过的那一版（跨步骤找这一版属于哪段旁白）
    if (keepVersionId) {
      Object.keys(stepVersions).forEach((key) => {
        const index = stepVersions[key].findIndex(
          (version) => Number(version.id) === Number(keepVersionId)
        );

        if (index >= 0) stepIndex[key] = index;
      });
    }

    renderStory();
    return true;
  }

  // 每一步的当前版本；没有版本数据时用消息里自带的 meta.options 兜底
  function versionsOfStep(key, metaOptions, fallbackId) {
    const stored = stepVersions[String(key)];

    if (stored && stored.length) return stored;

    return [{
      id: Number(fallbackId) || 0,
      options: Array.isArray(metaOptions) ? metaOptions : [],
      version: 1,
      created_at: '',
      source: '',
      edited_at: ''
    }];
  }

  function stepIndexOf(key, total) {
    const k = String(key);
    let index = Number(stepIndex[k]);

    if (!Number.isInteger(index) || index < 0 || index >= total) {
      index = Math.max(total - 1, 0);
    }

    stepIndex[k] = index;
    return index;
  }

  // ---------- 插画消息：隐藏 / 显示 / 删除 ----------
  function imageMetaOf(message) {
    try {
      const meta = message && message.meta_json ? JSON.parse(message.meta_json) : {};
      return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
    } catch (e) {
      return {};
    }
  }

  function imageActionButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'image-action';
    button.textContent = label;
    button.addEventListener('click', (event) => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      onClick();
    });
    return button;
  }

  function showImageActionError(block, message) {
    if (!block) return;
    const note = document.createElement('div');
    note.className = 'image-note image-note-inline';
    note.textContent = '没操作成功：' + (message || '再试一次');
    block.appendChild(note);
    setTimeout(() => {
      if (note.parentNode) note.parentNode.removeChild(note);
    }, 6000);
  }

  async function setImageHidden(message, hidden, block) {
    const id = Number(message.id);

    try {
      const response = await fetch(
        '/api/theater/messages/' + id + (hidden ? '/hide' : '/unhide'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: Number(sessionId) })
        }
      );
      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.ok) {
        throw new Error((data && data.error) || '操作失败');
      }

      // 用后端回来的 meta_json，保持一致；没有就按本地算一份
      if (data.message && data.message.meta_json) {
        message.meta_json = data.message.meta_json;
      } else {
        const meta = imageMetaOf(message);
        if (hidden) meta.hidden = true; else delete meta.hidden;
        message.meta_json = JSON.stringify(meta);
      }

      delete expandedHiddenImages[id];
      repaintStory();
    } catch (error) {
      showImageActionError(block, error.message);
    }
  }

  async function deleteSceneImage(message, block) {
    if (!confirm('删除这张插画？删了就找不回来了')) return;

    const id = Number(message.id);

    try {
      const response = await fetch('/api/theater/messages/' + id, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: Number(sessionId) })
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.ok) {
        throw new Error((data && data.error) || '删除失败');
      }

      messages = messages.filter((item) => Number(item.id) !== id);
      delete expandedHiddenImages[id];
      repaintStory();
    } catch (error) {
      showImageActionError(block, error.message);
    }
  }

  function buildImageToolbar(message, block) {
    const hidden = imageMetaOf(message).hidden === true;
    const toolbar = document.createElement('div');
    toolbar.className = 'image-actions';

    toolbar.appendChild(imageActionButton(hidden ? '👁 显示' : '👁 隐藏', () => {
      setImageHidden(message, !hidden, block);
    }));
    toolbar.appendChild(imageActionButton('🗑 删除', () => {
      deleteSceneImage(message, block);
    }));

    return toolbar;
  }

  // 一张插画：正常时图 + 描述 + 右上角两个小胶囊；
  // 隐藏后整块收成一行灰字，点一下展开看一眼，再点收起。
  function buildImageBlock(message) {
    const meta = imageMetaOf(message);
    const hidden = meta.hidden === true;
    const id = Number(message.id);
    const expanded = hidden && expandedHiddenImages[id] === true;

    if (!hidden && !message.image_url && !message.content) return null;

    const block = document.createElement('div');
    block.className = 'image-block';
    block.dataset.messageId = String(id);

    if (hidden) block.classList.add('image-block-hidden');

    if (hidden && !expanded) {
      const line = document.createElement('button');
      line.type = 'button';
      line.className = 'image-hidden-line';
      line.textContent = '这张插画已隐藏';
      line.addEventListener('click', () => {
        expandedHiddenImages[id] = true;
        repaintStory();
      });
      block.appendChild(line);
      return block;
    }

    if (hidden && expanded) {
      const line = document.createElement('button');
      line.type = 'button';
      line.className = 'image-hidden-line image-hidden-line-expanded';
      line.textContent = '这张插画已隐藏（点一下收起）';
      line.addEventListener('click', () => {
        delete expandedHiddenImages[id];
        repaintStory();
      });
      block.appendChild(line);
    }

    if (message.image_url) {
      const card = document.createElement('figure');
      card.className = 'scene-image';

      const image = document.createElement('img');
      image.src = String(message.image_url);
      image.alt = message.content || '插画';
      image.loading = 'lazy';
      image.dataset.sceneImage = String(message.image_url);

      // 加载失败时别留一块黑，直接说清楚，并给个重试的入口
      image.addEventListener('error', () => {
        card.classList.add('scene-image-broken');

        if (card.querySelector('.scene-image-error')) return;

        const hint = document.createElement('div');
        hint.className = 'scene-image-error';
        hint.textContent = '这张图打不开（可能是文件坏了或格式不对）。删掉重画一张就行';
        card.insertBefore(hint, image);
      });

      card.appendChild(image);

      if (message.content) {
        const caption = document.createElement('figcaption');
        caption.textContent = message.content;
        card.appendChild(caption);
      }

      card.appendChild(buildImageToolbar(message, block));
      block.appendChild(card);

      // 有参考图但没套上：如实说一句，别让她以为设定图生效了
      if (meta.with_reference === false && meta.reference_error) {
        const note = document.createElement('div');
        note.className = 'image-note image-note-inline';
        note.textContent = '这次没套上参考图：' + describeImageError(meta.reference_error);
        block.appendChild(note);
      } else if (Number(meta.reference_count) === 0) {
        // 压根没有参考图可用：把原因说具体，别只写「都没挂」
        const note = document.createElement('div');
        note.className = 'image-note image-note-inline';
        note.textContent = describeMissingReferences(meta.reference_missing);
        block.appendChild(note);
      } else if (Number(meta.reference_count) > 0) {
        const note = document.createElement('div');
        note.className = 'image-note image-note-inline';
        note.textContent = '参考图用了 ' + Number(meta.reference_count) + ' 张';
        block.appendChild(note);
      }
    } else if (message.content) {
      const text = document.createElement('div');
      text.className = 'image-note';
      text.textContent = message.content;
      block.appendChild(text);

      const toolbar = buildImageToolbar(message, block);
      toolbar.classList.add('image-actions-plain');
      block.appendChild(toolbar);
    }

    return block;
  }

  // 每个 role='options' 的消息都渲染成完整卡片（历史步骤也带胶囊 / ✎ / 🗑 / 开分支）；
  // 同一段旁白的多版只画一张卡，显示 stepIndex 指定的那一版。
  function renderStory(options) {
    const story = $('story');
    story.innerHTML = '';
    currentOptions = [];
    cardElements = {};

    if (!messages.length) {
      const empty = document.createElement('div');
      empty.className = 'narration-block';
      empty.textContent = '故事还没有开始。';
      story.appendChild(empty);
      return;
    }

    // 先按位置把每条 options 行归到它前面的那段旁白。
    // 不能信 meta.narration_id：分支会话是复制来的，里面的 id 还是原会话的。
    const representativeOfStep = {};
    const narrationIdOfRow = {};
    let currentNarration = 0;
    let lastOptionRow = 0;

    messages.forEach((message) => {
      if (message.role === 'narration') {
        currentNarration = Number(message.id) || 0;
        return;
      }

      if (message.role !== 'options') return;

      const rowId = Number(message.id);
      narrationIdOfRow[rowId] = currentNarration;
      lastOptionRow = rowId;

      const key = currentNarration ? String(currentNarration) : String(rowId);
      representativeOfStep[key] = message;
    });

    latestNarrationId = narrationIdOfRow[lastOptionRow] || 0;
    latestStepKey = latestNarrationId
      ? String(latestNarrationId)
      : String(lastOptionRow);
    lastOptionsRowId = lastOptionRow;

    messages.forEach((message) => {
      if (message.role === 'narration') {
        const block = document.createElement('div');
        block.className = 'narration-block';
        block.textContent = message.content || '';
        story.appendChild(block);
        return;
      }

      // 生图接口插入的插画消息：图片 + 画面描述 + 隐藏/删除
      if (message.role === 'narrator') {
        const block = buildImageBlock(message);

        if (block) story.appendChild(block);
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
        const rowId = Number(message.id);
        const narrationId = narrationIdOfRow[rowId] || 0;
        const key = narrationId ? String(narrationId) : String(rowId);
        const representative = representativeOfStep[key];

        // 同一段旁白只在它最后一行 options 的位置画一张卡，旧版本行不再单独出卡
        if (!representative || Number(representative.id) !== rowId) return;

        buildOptionsCard(story, key, narrationId, message);
      }
    });

    // 初次渲染 / 追加剧情后贴底；就地重绘（编辑、删除）不走这里，省得把用户拽走
    if (!(options && options.noScroll)) scrollToBottom();
  }

  function makeStepButton(text, action, key, title, id) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = title;
    button.dataset.stepAction = action;
    button.dataset.stepKey = String(key);
    button.className = action === 'prev' || action === 'next'
      ? 'options-pager-arrow'
      : 'options-icon';
    if (id) button.id = id;
    return button;
  }

  // 头部按钮：小符号 + 说明字（花雪一反馈光有符号认不出）
  function makeActionButton(icon, text, action, key, title, id) {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = title;
    button.dataset.stepAction = action;
    button.dataset.stepKey = String(key);
    button.className = 'options-action';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'options-action-icon';
    iconSpan.textContent = icon;

    const textSpan = document.createElement('span');
    textSpan.className = 'options-action-text';
    textSpan.textContent = text;

    button.appendChild(iconSpan);
    button.appendChild(textSpan);
    button._label = textSpan;

    if (id) button.id = id;
    return button;
  }

  function buildOptionsCard(story, key, narrationId, message) {
    const meta = parseJson(message.meta_json, {});
    const versions = versionsOfStep(key, meta.options, message.id);
    const isLatest = key === latestStepKey;

    const card = document.createElement('div');
    card.className = 'options-card' + (isLatest ? '' : ' is-history');
    card.dataset.stepCard = String(key);
    card.dataset.narrationId = String(narrationId || 0);
    card.dataset.stepOptionsId = String(message.id);

    card._step = {
      key: String(key),
      narrationId: Number(narrationId) || 0,
      versions,
      isLatest,
      activeId: 0
    };
    card._refs = {};

    // 版本翻页条：‹ 3/5 ›（只有一版时整条隐藏）
    const pager = document.createElement('div');
    pager.className = 'options-pager';

    const prev = makeStepButton('‹', 'prev', key, '上一版选项', isLatest ? 'optionsPrevBtn' : '');
    const label = document.createElement('span');
    label.className = 'options-pager-label';
    if (isLatest) label.id = 'optionsPagerLabel';
    const next = makeStepButton('›', 'next', key, '下一版选项', isLatest ? 'optionsNextBtn' : '');

    pager.appendChild(prev);
    pager.appendChild(label);
    pager.appendChild(next);
    if (isLatest) pager.id = 'optionsPager';
    card._refs.pager = pager;
    card._refs.prev = prev;
    card._refs.next = next;
    card._refs.label = label;
    card.appendChild(pager);

    // 头部：标题 + 操作按钮（撤回 / 换一批只有最新一步才有）
    const head = document.createElement('div');
    head.className = 'options-head';

    const heading = document.createElement('h2');
    heading.textContent = isLatest ? '下一步' : '当时的选项';

    const actions = document.createElement('div');
    actions.className = 'options-head-actions';

    if (isLatest) {
      const rollback = makeActionButton('↩', '撤回', 'rollback', key, '撤回上一步', 'rollbackBtn');
      const regenerate = makeActionButton('⟲', '换一批', 'regenerate', key, '换一批选项', 'regenerateBtn');
      const rewrite = makeActionButton('↻', '重写这段', 'rewrite', key, '把这段旁白和选项一起重写', 'rewriteSegmentBtn');
      actions.appendChild(rollback);
      actions.appendChild(regenerate);
      actions.appendChild(rewrite);
      card._refs.rollback = rollback;
      card._refs.regenerate = regenerate;
      card._refs.rewrite = rewrite;
    }

    const edit = makeActionButton('✎', '改选项', 'edit', key, '编辑这一版', isLatest ? 'editOptionsBtn' : '');
    const remove = makeActionButton('🗑', '删选项', 'delete', key, '删除这一版', isLatest ? 'deleteOptionsBtn' : '');
    actions.appendChild(edit);
    actions.appendChild(remove);

    card._refs.edit = edit;
    card._refs.delete = remove;

    head.appendChild(heading);
    head.appendChild(actions);
    card.appendChild(head);

    const list = document.createElement('div');
    list.className = 'options-list';
    if (isLatest) list.id = 'optionsList';
    card._refs.list = list;
    card.appendChild(list);

    // 自定义行动 / 剧情走向只属于「下一步」，历史卡片不重复给
    if (isLatest) {
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
    }

    // 旧步骤点选项时在这里出一行小字，不弹 alert
    const hint = document.createElement('div');
    hint.className = 'options-hint';
    hint.hidden = true;
    card._refs.hint = hint;
    card.appendChild(hint);

    const branch = makeStepButton(
      '从这一版开分支',
      'branch',
      key,
      '从正在看的这一版创建分支',
      isLatest ? 'branchFromVersionBtn' : ''
    );
    branch.className = 'option-branch';
    card._refs.branch = branch;
    card.appendChild(branch);

    story.appendChild(card);
    cardElements[String(key)] = card;

    syncStepCard(key);
  }

  // 把某一步当前版本铺到卡片上：翻页、编辑、删除后都只走这里，不发请求
  function syncStepCard(key) {
    const card = cardElements[String(key)];

    if (!card || !card._step || !card._refs) return;

    const step = card._step;
    const refs = card._refs;
    const total = step.versions.length;
    const index = stepIndexOf(key, total);
    const active = step.versions[index] || null;
    const options = active && Array.isArray(active.options) ? active.options : [];

    step.activeId = active ? Number(active.id) : 0;

    refs.list.innerHTML = '';

    options.forEach((option, optionIndex) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'option-item';
      button.dataset.optionIndex = String(optionIndex);
      button.dataset.stepKey = String(key);
      button.textContent = String(option);

      // 旧步骤不能直接选，只能从这一版开分支
      if (!step.isLatest) {
        button.classList.add('is-locked');
        button.title = '以前的进度，不能直接选';
      }

      refs.list.appendChild(button);
    });

    refs.hint.hidden = true;

    refs.pager.hidden = total <= 1;
    refs.label.textContent = (index + 1) + '/' + Math.max(total, 1);
    refs.prev.disabled = index <= 0;
    refs.next.disabled = index >= total - 1;

    refs.edit.disabled = false;
    refs.delete.disabled = total <= 1;
    refs.delete.title = total <= 1
      ? '这段只有一版选项，删了就没了'
      : '删除这一版';

    if (refs.rollback) refs.rollback.disabled = false;
    if (refs.regenerate) refs.regenerate.disabled = false;

    if (refs.rewrite) {
      refs.rewrite.disabled = false;
      refs.rewrite._label.textContent = '重写这段';
    }

    // 最新一步继续复用老变量（换一批 / 撤回）
    if (step.isLatest) {
      latestStepKey = String(key);
      optionVersions = step.versions;
      optionVersionIndex = index;
      optionNarrationId = step.narrationId || latestNarrationId;
      currentOptions = options.slice();
    }
  }

  function showStepHint(key) {
    const card = cardElements[String(key)];

    if (!card || !card._refs) return;

    card._refs.hint.hidden = false;
    card._refs.hint.textContent = '这是以前的进度，要往前走请从这一版开分支';
  }

  function stepStepVersion(key, delta) {
    const card = cardElements[String(key)];

    if (!card || !card._step) return;

    const total = card._step.versions.length;
    const index = Number(stepIndex[String(key)]);
    const nextIndex = index + delta;

    if (!Number.isInteger(index) || nextIndex < 0 || nextIndex >= total) return;

    stepIndex[String(key)] = nextIndex;
    syncStepCard(key);
  }

  // 兼容老入口（只翻最新一步）
  function stepOptionVersion(delta) {
    if (!latestStepKey) return;
    stepStepVersion(latestStepKey, delta);
  }

  // 就地重绘（编辑 / 删除之后）：保留滚动位置，不整页 reload
  function repaintStory() {
    const story = $('story');
    const storyTop = story ? story.scrollTop : 0;
    const scroller = document.scrollingElement || document.documentElement;
    const pageTop = scroller ? scroller.scrollTop : 0;

    renderStory({ noScroll: true });

    if (story) story.scrollTop = storyTop;
    if (scroller) scroller.scrollTop = pageTop;
  }

  async function refreshStepVersions() {
    await loadStepVersions(true);
    repaintStory();
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

    // 出图常常要几十秒，给她一个「先去玩」的口子，别让她干等
    const skip = document.createElement('button');
    skip.className = 'image-note image-note-inline draw-background';
    skip.type = 'button';
    skip.id = 'drawBackgroundBtn';
    skip.textContent = '先去玩，画好了自己贴上来 →';
    skip.addEventListener('click', () => {
      continuePlayingWhileDrawing();
    });

    block.appendChild(skip);
    $('story').appendChild(block);
    scrollToBottom();
  }

  // 点了「先去玩」：把弹窗收掉，画还在后台跑，出图会自己贴到剧情里
  function continuePlayingWhileDrawing() {
    if (!drawing) return;

    hideDrawing();
    closeSheets();
    $('drawStatus').textContent = '';

    const block = document.createElement('div');
    block.className = 'image-note image-note-inline';
    block.id = 'drawingNotice';
    block.textContent = '还在画，画好了会自己贴上来；可以先接着玩';
    $('story').appendChild(block);
    scrollToBottom();
  }

  function hideDrawing() {
    const block = document.getElementById('drawingBlock');
    if (block) block.remove();
  }

  function dropDrawingNotice() {
    const notice = document.getElementById('drawingNotice');
    if (notice) notice.remove();
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

  // 把接口的原始错误（可能是 JSON 串）压成一句人话
  // 没有参考图时，把原因说得具体点：是哪张身份卡、还是根本没找到这张卡
  function describeMissingReferences(missing) {
    const info = missing || {};
    const name = String(info.identity_name || '').trim();

    if (!name) {
      return '这次没有参考图：上帝视角进入，没有身份卡，角色卡也没挂设定图';
    }

    if (info.identity_card_found === false) {
      return '这次没有参考图：剧本里没找到叫「' + name + '」的身份卡（可能改名了），角色卡也没挂设定图';
    }

    return '这次没有参考图：身份卡「' + name + '」和剧本里其他卡、角色卡都没挂设定图';
  }

  function describeImageError(raw) {
    const text = String(raw || '').trim();

    if (!text) return '';

    // 可能是「image：{json}；image[]：{json}」这种两次尝试拼起来的，
    // 每段单独压一下，重复的原因只留一条
    const parts = text.split('；').map((part) => {
      const mark = part.indexOf('：');
      const body = mark > 0 ? part.slice(mark + 1) : part;

      return describeOneImageError(body);
    }).filter(Boolean);

    if (!parts.length) return text.slice(0, 200);

    const unique = [];

    parts.forEach((part) => {
      if (!unique.includes(part)) unique.push(part);
    });

    return unique.join('；').slice(0, 200);
  }

  function describeOneImageError(raw) {
    const text = String(raw || '').trim();

    if (!text) return '';

    if (text[0] === '{' || text[0] === '[') {
      try {
        const data = JSON.parse(text);
        const picked = pickErrorText(data, 0);

        if (picked) return picked.slice(0, 200);
      } catch (e) {}
    }

    return text.slice(0, 200);
  }

  function pickErrorText(data, depth) {
    if (!data || depth > 3) return '';

    if (typeof data === 'string') return data;

    if (typeof data !== 'object') return '';

    const direct = data.message || data.detail || data.error_description;

    if (typeof direct === 'string' && direct.trim()) return direct.trim();

    if (typeof data.error === 'string' && data.error.trim()) return data.error.trim();

    return pickErrorText(data.error, depth + 1);
  }

  // 审核拦截单独给人话，别把裸 JSON 怼给她
  function friendlyImageError(message) {
    const raw = String(message || '');

    if (/insufficient[ _]account[ _]balance|insufficient_quota|exceeded your current quota|余额不足/i.test(raw)) {
      return '生图那个中转站说你账户余额不够了（insufficient account balance），去那边充值后再画。' +
        '充完这一单重画就行，剧情不受影响';
    }

    if (/(invalid|incorrect)[ _]api[ _]key|unauthorized|401/i.test(raw)) {
      return '生图模型的 API Key 好像不对或者过期了（' + raw.slice(0, 60) + '），去「模型设置」里检查一下';
    }

    if (/rate[ _]limit|too many requests|429/i.test(raw)) {
      return '画得太快，被中转站限流了（rate limit），等一两分钟再试';
    }

    if (/model[ _]not[ _]found|does not exist|no such model|not available/i.test(raw)) {
      return '这家中转不认这个模型名（' + raw.slice(0, 60) + '），去「模型设置」里换个名字';
    }

    if (/content[ _]policy|safety system|moderation_blocked/i.test(raw)) {
      const code = /moderation_blocked/i.test(raw)
        ? 'moderation_blocked'
        : (/safety system/i.test(raw) ? 'safety system' : 'content policy');

      return '这张图被内容审核拦下了，换个说法再试' +
        '（少写身体/年龄/暴力细节），或者换个尺寸/模型（' + code + '）';
    }

    return describeImageError(raw) || raw;
  }

  // 上一次是兜底描述跑出来的话，把那句原样留着，下次可以直接复用
  let lastFallbackPrompt = '';

  // 生成时按秒走得动的计时器：一直停在「正在画…」最容易让人以为卡死了
  let drawTimer = null;

  function startDrawStatus() {
    const status = $('drawStatus');
    const startedAt = Date.now();

    stopDrawStatus();
    status.textContent = '正在画…0 秒';

    drawTimer = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      const hint = seconds > 60
        ? '（超一分钟了，这一单排在服务商那边，通常还能等到）'
        : seconds > 25
          ? '（还在等服务商返回）'
          : '';

      status.textContent = '正在画…' + seconds + ' 秒' + hint;
    }, 1000);
  }

  function stopDrawStatus() {
    if (drawTimer) {
      clearInterval(drawTimer);
      drawTimer = null;
    }
  }

  async function generateSceneImage(options) {
    if (drawing) return;

    const background = Boolean(options && options.background);

    drawing = true;

    const button = $('drawGenerate');
    const original = button.textContent;
    const promptInput = $('drawPrompt');
    const sizeInput = $('drawSize');
    const typedPrompt = promptInput ? promptInput.value.trim() : '';

    // 上一次是「兜底描述」跑的：这次直接拿那句描述，省掉先让模型写一遍的开销
    let reusePrompt = '';

    if (!typedPrompt && lastFallbackPrompt) {
      const answer = confirm('上一次等太久，是因为自动写画面描述超时了。\n这次直接用上次那段描述来画？\n\n' + lastFallbackPrompt.slice(0, 80) + '…');

      if (answer) reusePrompt = lastFallbackPrompt;
    }

    button.disabled = true;
    button.textContent = background ? '继续画…' : '画图中…';
    $('drawStatus').classList.remove('error');
    startDrawStatus();

    // 后台接着画的时候不要把「正在画…」塞进剧情区，
    // 不然上面那次续写成功一刷新，占位块就留在中间不走了
    if (!background) showDrawing();

    try {
      const response = await fetch(
        '/api/theater/sessions/' + sessionId + '/image',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: reusePrompt || typedPrompt,
            size: sizeInput ? sizeInput.value : '1024x1024'
          })
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || '生成失败');
      }

      // 兜底跑的就把那句描述记下来，下次可以复用
      if (data.auto_prompted && data.auto_prompt_error) {
        lastFallbackPrompt = String(data.prompt || '').trim();
      } else {
        lastFallbackPrompt = '';
      }

      if (promptInput) promptInput.value = '';

      hideDrawing();
      dropDrawingNotice();
      closeSheets();
      await loadMessages();
    } catch (error) {
      hideDrawing();
      dropDrawingNotice();

      // 她可能早就不看弹窗了：后台画失败就安静收场，别拦着玩
      if (!background) {
        $('drawStatus').classList.add('error');
        $('drawStatus').textContent = '生成失败：' + friendlyImageError(error.message);
      }

    } finally {
      stopDrawStatus();
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
  // 换一批选项：只给最新一步追加版本，历史步骤不动
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

  // 整段重写：先删最后一段旁白 + 这一步所有选项版本，再走一次自然续写。
  // 生成中把卡片头部按钮全禁掉、按钮文字显示「重写中…」。
  async function rewriteSegment() {
    if (sending) return;

    const confirmed = confirm('把这一段旁白和它的选项一起重写？');
    if (!confirmed) return;

    sending = true;

    const card = cardElements[latestStepKey];
    const refs = card && card._refs;

    if (refs) {
      ['rollback', 'regenerate', 'rewrite', 'edit', 'delete'].forEach((action) => {
        const button = refs[action];
        if (button) button.disabled = true;
      });

      if (refs.rewrite && refs.rewrite._label) {
        refs.rewrite._label.textContent = '重写中…';
      }
    }

    showTyping();

    try {
      const response = await fetch(
        '/api/theater/sessions/' + sessionId + '/rewrite-last',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || '重写失败');
      }

      if (data.needs_next) {
        // 复用自然续写这条路径；不写 user 消息
        await sendAction('', { force: true });
      } else {
        await loadMessages();
      }
    } catch (error) {
      alert('重写失败：' + error.message);
    } finally {
      hideTyping();
      sending = false;

      if (latestStepKey && cardElements[latestStepKey]) {
        syncStepCard(latestStepKey);
      }
    }
  }

  let editingOptionsId = 0;
  let editingStepKey = '';

  // 取某一步正在显示的那一版（不传 key 就当最新一步，兼容老入口）
  function activeVersionOfStep(key) {
    const target = key == null || key === '' ? latestStepKey : String(key);
    const card = cardElements[target];

    if (!card || !card._step) return { card: null, active: null, key: target };

    const versions = card._step.versions;
    const index = stepIndexOf(target, versions.length);

    return { card, active: versions[index] || null, key: target };
  }

  function editOptionsVersion(key) {
    const { active } = activeVersionOfStep(key);

    if (!active) return;

    editingOptionsId = Number(active.id);
    editingStepKey = String(key == null || key === '' ? latestStepKey : key);

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

      // 就地重绘再拉一次版本，别整页 reload；停在刚改的那一版
      if (editingStepKey && cardElements[editingStepKey]) {
        const versions = cardElements[editingStepKey]._step.versions;
        const index = versions.findIndex(
          (version) => Number(version.id) === Number(savedId)
        );

        if (index >= 0) stepIndex[editingStepKey] = index;
      }

      await refreshStepVersions();
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

  async function deleteOptionsVersion(key) {
    if (sending) return;

    const { card, active, key: target } = activeVersionOfStep(key);

    if (!active || !card || card._step.versions.length <= 1) return;

    if (!confirm('删掉这一版选项？其他版本还在。')) return;

    sending = true;

    if (card._refs && card._refs.delete) card._refs.delete.disabled = true;

    try {
      const response = await fetch('/api/theater/options/' + active.id, {
        method: 'DELETE'
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || '删除失败');
      }

      await refreshStepVersions();

      // 删的是最后一版时，index 会自动夹到新的最后一版
      if (Number(stepIndex[target]) >= (cardElements[target] && cardElements[target]._step.versions.length || 0)) {
        delete stepIndex[target];
      }
    } catch (error) {
      alert('删除失败：' + error.message);
    } finally {
      sending = false;
    }
  }

  // 从某一步正在看的这一版开分支（历史步骤也能开）
  async function branchFromVersion(key) {
    if (sending) return;

    const { card, active } = activeVersionOfStep(key);

    if (!card || !active) return;

    const narrationId = Number(card._step.narrationId) || 0;

    if (!narrationId) {
      showStepHint(card._step.key);
      return;
    }

    sending = true;

    const button = card._refs && card._refs.branch;
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
            narration_id: narrationId,
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

      if (button) {
        button.disabled = false;
        button.textContent = '从这一版开分支';
      }
    }
  }

  async function sendAction(action, options) {
    // 重写流程里先占住 sending 再复用这条自然续写，所以给一个 force 口子
    if (sending && !(options && options.force)) return;

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

    // 历史步骤的卡片按钮都带 data-step-action，一张卡一套
    const stepButton = event.target.closest('[data-step-action]');

    if (stepButton) {
      const action = stepButton.dataset.stepAction;
      const stepKey = stepButton.dataset.stepKey;

      if (action === 'prev') {
        stepStepVersion(stepKey, -1);
      } else if (action === 'next') {
        stepStepVersion(stepKey, 1);
      } else if (action === 'rollback') {
        rollbackStep();
      } else if (action === 'regenerate') {
        regenerateOptions();
      } else if (action === 'rewrite') {
        rewriteSegment();
      } else if (action === 'edit') {
        editOptionsVersion(stepKey);
      } else if (action === 'delete') {
        deleteOptionsVersion(stepKey);
      } else if (action === 'branch') {
        branchFromVersion(stepKey);
      }

      return;
    }

    const option = event.target.closest('[data-option-index]');

    if (option) {
      const stepKey = option.dataset.stepKey;
      const card = cardElements[stepKey];

      if (!card || !card._step) return;

      // 以前的进度不能直接选，只给一行小字
      if (!card._step.isLatest) {
        showStepHint(stepKey);
        return;
      }

      const index = Number(option.dataset.optionIndex);
      const versions = card._step.versions;
      const active = versions[Number(stepIndex[stepKey])] || null;
      const options = active && Array.isArray(active.options) ? active.options : [];
      const text = options[index];

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
