(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const characterId = params.get('character');
  const $ = (id) => document.getElementById(id);

  if (!characterId) {
    location.href = '/';
    return;
  }

  let character = null;
  let messageRows = [];
  let personas = [];
  let editMessageId = null;
  let sending = false;

  // ---- DOM 引用 --------------------------------------------------------
  // 原先缺失这几行，submit 处理器却引用了它们。'use strict' 下访问未声明
  // 变量会抛 ReferenceError，导致 chat.js 的发送逻辑从未真正生效，
  // 后来只能靠 chat-send-fix.js 克隆替换表单来绕过 —— 现已合并回来。
  const messageInputEl = $('messageInput');
  const narrationInputEl = $('narrationInput');
  const narrationWrapEl = $('narrationWrap');
  const narrationToggleEl = $('narrationToggle');
  const sendButtonEl = document.querySelector('#composer button[type="submit"]');

  function updateSendLabel() {
    if (!sendButtonEl) return;
    if (sending) {
      sendButtonEl.textContent = '发送中…';
      return;
    }
    const hasNarration = Boolean(narrationInputEl && narrationInputEl.value.trim());
    sendButtonEl.textContent = hasNarration ? '合并发送' : '发送';
  }

  function closeNarration() {
    if (narrationWrapEl) narrationWrapEl.classList.remove('open');
    if (narrationToggleEl) narrationToggleEl.classList.remove('active');
    document.body.classList.remove('narration-open');
  }

  if (narrationToggleEl && narrationWrapEl) {
    narrationToggleEl.addEventListener('click', () => {
      const open = narrationWrapEl.classList.toggle('open');
      narrationToggleEl.classList.toggle('active', open);
      document.body.classList.toggle('narration-open', open);
      if (open && narrationInputEl) narrationInputEl.focus();
      updateSendLabel();
    });
  }

  if (narrationInputEl) {
    narrationInputEl.addEventListener('input', updateSendLabel);
  }

  const showMetaKey = 'nocturne-show-meta';
  const bubbleColorKey = 'nocturne-bubble-' + characterId;

  let colors = {
    user: '#E6E0EF',
    char: '#ffffff'
  };

  try {
    colors = Object.assign(
      colors,
      JSON.parse(localStorage.getItem(bubbleColorKey) || '{}')
    );
  } catch (e) {}

  if (colors.user === '#95ec69') {
    colors.user = '#E6E0EF';
  }

  function escapeHtml(text) {
    return String(text || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function parseDate(value) {
    if (!value) return null;
    const normalized = String(value).replace(' ', 'T');
    const date = new Date(
      normalized.endsWith('Z') ? normalized : normalized + 'Z'
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDateSeparator(date) {
    if (!date) return '';

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diff = Math.round((today - day) / 86400000);
    const time = date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    if (diff === 0) return '今天 ' + time;
    if (diff === 1) return '昨天 ' + time;

    return date.getFullYear() + '年' +
      (date.getMonth() + 1) + '月' +
      date.getDate() + '日';
  }

  function formatBubbleTime(value) {
    const date = parseDate(value);
    if (!date) return '';
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  }

  function contrastColor(hex) {
    const value = String(hex || '').replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(value)) return '#111111';

    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    return luminance > 0.55 ? '#111111' : '#ffffff';
  }

  function applyBubbleColors() {
    document.documentElement.style.setProperty('--user-bubble', colors.user);
    document.documentElement.style.setProperty('--char-bubble', colors.char);
    document.documentElement.style.setProperty(
      '--user-text',
      contrastColor(colors.user)
    );
    document.documentElement.style.setProperty(
      '--char-text',
      contrastColor(colors.char)
    );
  }

  function parseMeta(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function formatMeta(meta) {
    if (!meta) return '';

    const usage = meta.usage || {};
    const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
    const total = usage.total_tokens ?? (Number(input) + Number(output));

    return [
      meta.provider || '',
      meta.model || '',
      '输入 ' + input,
      '输出 ' + output,
      '总计 ' + total + ' tokens',
      '上下文命中 ' + (meta.context_messages || 0) + ' 条',
      '世界书命中 ' + (meta.worldbook_hits || 0) + ' 条',
      (meta.latency_ms || 0) + 'ms'
    ].filter(Boolean).join(' · ');
  }

  function getUserPersona() {
    if (!character) return null;

    const byId = personas.find(
      (item) => Number(item.id) === Number(character.user_persona_id)
    );

    return byId ||
      personas.find((item) => Number(item.is_default) === 1) ||
      null;
  }

  function addDateSeparator(date) {
    const el = document.createElement('div');
    el.className = 'date-separator';
    el.textContent = formatDateSeparator(date);
    $('messages').appendChild(el);
  }

  function addMessage(row, localOnly) {
    const rowEl = document.createElement('div');
    rowEl.className = 'message-row ' + row.role;

    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';

    if (row.narration) {
      const narrationEl = document.createElement('div');
      narrationEl.className = 'message-narration';
      narrationEl.textContent = row.narration;

      if (!localOnly && row.id) {
        narrationEl.dataset.messageId = row.id;
      }

      contentEl.appendChild(narrationEl);
    }

    if (row.sticker_url) {
      const stickerWrap = document.createElement('div');
      stickerWrap.className = 'message-sticker';

      const stickerImg = document.createElement('img');
      stickerImg.src = String(row.sticker_url);
      stickerImg.alt = row.sticker_meaning || '表情';
      stickerImg.loading = 'lazy';

      stickerWrap.appendChild(stickerImg);
      contentEl.appendChild(stickerWrap);
    }

    if (row.image_url) {
      const imageWrap = document.createElement('div');
      imageWrap.className = 'message-image';

      const image = document.createElement('img');
      image.src = String(row.image_url);
      image.alt = '图片';
      image.loading = 'lazy';

      imageWrap.appendChild(image);
      contentEl.appendChild(imageWrap);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (!localOnly && row.id) {
      bubble.dataset.messageId = row.id;
    }

    const text = document.createElement('span');
    text.textContent = row.content || '';
    bubble.appendChild(text);

    if (!row.content && !row.sticker_url) {
      bubble.style.display = 'none';
    }

    contentEl.appendChild(bubble);

    if (row.role === 'user' || row.role === 'character') {
      const timeEl = document.createElement('div');
      timeEl.className = 'message-time';
      timeEl.textContent = formatBubbleTime(row.created_at);
      contentEl.appendChild(timeEl);
    }

    const showMeta = localStorage.getItem(showMetaKey) === '1';
    const meta = parseMeta(row.meta_json);

    if (showMeta && meta) {
      const metaEl = document.createElement('div');
      metaEl.className = 'message-meta';
      metaEl.textContent = formatMeta(meta);
      contentEl.appendChild(metaEl);
    }

    if (row.role === 'character' || row.role === 'user') {
      const persona = getUserPersona();
      const avatar = document.createElement('div');
      avatar.className = 'msg-avatar';

      const url = row.role === 'character'
        ? (character && character.avatar)
        : (persona && persona.avatar);

      if (url) {
        avatar.innerHTML = '<img src="' + escapeHtml(url) + '" alt="">';
      } else {
        avatar.textContent = row.role === 'character'
          ? String((character && character.name) || '?').slice(0, 1)
          : String((persona && persona.name) || '我').slice(0, 1);
      }

      if (row.role === 'character') {
        rowEl.appendChild(avatar);
        rowEl.appendChild(contentEl);
      } else {
        rowEl.appendChild(contentEl);
        rowEl.appendChild(avatar);
      }
    } else {
      rowEl.appendChild(contentEl);
    }

    $('messages').appendChild(rowEl);
  }

  function addSystemNote(text) {
    const row = document.createElement('div');
    row.className = 'message-row system';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;

    row.appendChild(bubble);
    $('messages').appendChild(row);
  }

  // 加载失败时的可重试提示：本地服务被回收、接口 500 都走这里。
  // 不留白，也不弹 alert（alert 会打断输入）。
  function showLoadError(message, onRetry) {
    const box = $('messages');
    if (!box) return;
    box.innerHTML = '';

    // 标题栏还停在「加载中...」的话一并收尾，别一半失败一半加载中
    const nameEl = $('chatName');
    if (nameEl && nameEl.textContent === '加载中...') {
      nameEl.textContent = '加载失败';
    }

    const row = document.createElement('div');
    row.className = 'message-row system';
    row.style.cssText =
      'display:block;padding:28px 16px;text-align:center;' +
      'color:#8a8a8a;font-size:14px;line-height:1.9;';

    const text = document.createElement('div');
    text.textContent = '加载失败：' + (message || '连不上服务') + '。';
    row.appendChild(text);

    if (typeof onRetry === 'function') {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '重试';
      button.style.cssText =
        'margin-top:10px;padding:6px 18px;border:0;border-radius:999px;' +
        'background:#111;color:#fff;font:inherit;font-size:13px;';
      button.addEventListener('click', () => {
        button.disabled = true;
        button.textContent = '重试中…';
        Promise.resolve()
          .then(onRetry)
          .catch((error) => showLoadError(error && error.message, onRetry));
      });
      row.appendChild(button);
    }

    box.appendChild(row);
  }

  function scrollToBottom() {
    $('messages').scrollTop = $('messages').scrollHeight;
  }

  function renderMessages() {
    $('messages').innerHTML = '';

    if (!messageRows.length) {
      if (character && character.opening_line) {
        addMessage({
          role: 'character',
          content: character.opening_line,
          created_at: ''
        }, true);
      } else {
        addSystemNote('还没有聊天记录。发一条消息开始吧。');
      }

      scrollToBottom();
      return;
    }

    let lastDay = '';

    messageRows.forEach((row) => {
      const date = parseDate(row.created_at);
      const dayKey = date ? date.toDateString() : '';

      if (dayKey && dayKey !== lastDay) {
        addDateSeparator(date);
        lastDay = dayKey;
      }

      addMessage(row, false);
    });

    scrollToBottom();
  }

  async function loadCharacter() {
    let data;

    try {
      const response = await fetch('/api/characters/' + characterId);

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));

        if (response.status === 404) {
          // 角色真的不存在：回首页才是对的
          alert(body.error || '角色不存在');
          location.href = '/';
          return false;
        }

        throw new Error(body.error || '角色加载失败');
      }

      data = await response.json();
    } catch (error) {
      // 断网 / 服务没起来：留在当前页，给出可重试的提示
      showLoadError(error.message, boot);
      return false;
    }

    character = data;

    $('chatName').textContent = character.name;

    updateHeaderSub();
    updateMenu();
    document.title = 'Nocturne · ' + character.name;

    return true;
  }

  function updateHeaderSub() {
    if (!character) return;

    const persona = personas.find(
      (item) => Number(item.id) === Number(character.user_persona_id)
    );

    $('headerSub').textContent = persona
      ? '用户人设：' + persona.name
      : '用户人设：默认 / 未绑定';
  }

  async function loadPersonas() {
    try {
      const response = await fetch('/api/personas');

      if (!response.ok) {
        throw new Error('人设列表加载失败');
      }

      const list = await response.json();
      personas = Array.isArray(list) ? list : [];
    } catch (error) {
      // 人设只是下拉选项，加载失败不该拖垮聊天记录
      personas = [];
      console.warn('人设加载失败：' + error.message);
    }

    fillPersonaSelect();
    updateHeaderSub();
  }

  function fillPersonaSelect() {
    const select = $('personaSelect');
    if (!select) return;

    select.innerHTML =
      '<option value="0">不绑定，使用默认用户人设</option>';

    if (!Array.isArray(personas)) personas = [];

    personas.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent =
        item.name + (item.is_default ? '（默认）' : '');
      select.appendChild(option);
    });

    select.value = String(character ? character.user_persona_id || 0 : 0);
  }

  async function loadMessages() {
    let rows;

    try {
      const response = await fetch(
        '/api/characters/' + characterId + '/messages'
      );

      if (!response.ok) {
        throw new Error('聊天记录加载失败');
      }

      rows = await response.json();
    } catch (error) {
      messageRows = [];
      showLoadError(error.message, loadMessages);
      return false;
    }

    messageRows = Array.isArray(rows) ? rows : [];
    renderMessages();
    return true;
  }

  // 记录“对方正在输入…”出现前的副标题，用于恢复
  let headerSubBackup = null;

  function showTyping() {
    const row = document.createElement('div');
    row.className = 'message-row character';
    row.id = 'typingRow';

    const content = document.createElement('div');
    content.className = 'message-content';

    const bubble = document.createElement('div');
    bubble.className = 'bubble typing-bubble';
    bubble.innerHTML = '<i></i><i></i><i></i>';

    content.appendChild(bubble);
    row.appendChild(content);
    $('messages').appendChild(row);
    scrollToBottom();

    // 头部副标题显示“对方正在输入…”
    const headerSub = $('headerSub');
    if (headerSub) {
      if (headerSubBackup === null) {
        headerSubBackup = headerSub.textContent;
      }
      headerSub.textContent = '对方正在输入…';
    }
  }

  function hideTyping() {
    const row = document.getElementById('typingRow');
    if (row) row.remove();

    const headerSub = $('headerSub');
    if (headerSub && headerSubBackup !== null) {
      headerSub.textContent = headerSubBackup;
      headerSubBackup = null;
    }
  }

  async function sendSticker(sticker) {
    if (!sticker) return;

    addMessage({
      role: 'user',
      content: '',
      sticker_url: sticker.image_url,
      sticker_meaning: sticker.meaning || '',
      created_at: new Date().toISOString()
    }, true);

    scrollToBottom();
    showTyping();

    try {
      const saveResponse = await fetch(
        '/api/characters/' + characterId + '/messages',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            role: 'user',
            content: '',
            sticker_id: sticker.id
          })
        }
      );

      if (!saveResponse.ok) {
        throw new Error('表情发送失败');
      }

      const response = await fetch(
        '/api/characters/' + characterId + '/reply',
        { method: 'POST' }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error((data && data.error) || '回复失败');
      }

      await loadMessages();
    } catch (error) {
      await loadMessages().catch(() => {});
      addSystemNote('回复失败：' + error.message);
    } finally {
      hideTyping();
      scrollToBottom();
    }
  }

  async function sendMessage(content, narration, imageUrl) {
    // 1) 乐观渲染：消息立刻出现在界面上，不用等网络
    addMessage({
      role: 'user',
      content,
      narration,
      image_url: imageUrl || '',
      created_at: new Date().toISOString()
    }, true);
    scrollToBottom();
    showTyping();

    // 2) 落库
    let saved;
    try {
      const messageResponse = await fetch(
        '/api/characters/' + characterId + '/messages',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            role: 'user',
            content,
            narration,
            image_url: imageUrl || ''
          })
        }
      );
      saved = await messageResponse.json().catch(() => ({}));
      if (!messageResponse.ok) {
        throw new Error((saved && saved.error) || '消息保存失败');
      }
    } catch (error) {
      hideTyping();
      await loadMessages().catch(() => {});
      throw error;
    }

    // 3) 等待角色回复（慢请求），期间一直显示 typing
    try {
      const response = await fetch(
        '/api/characters/' + characterId + '/reply',
        { method: 'POST' }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((data && data.error) || '回复失败');
      }

      // 发了图片但他没能看清：明说一句，别让她以为角色高冷
      if (data.image_note) {
        addSystemNote(data.image_note);
      }

      await loadMessages();
    } catch (error) {
      // 关键：不整页刷新（旧版 location.reload() 会白屏并丢失滚动位置）
      await loadMessages().catch(() => {});
      addSystemNote('回复失败：' + error.message);
      scrollToBottom();
      throw error;
    } finally {
      hideTyping();
    }
  }
  $('composer').addEventListener('submit', async (event) => {
    event.preventDefault();

    if (sending) return;

    const input = $('messageInput');
    const content = input.value.trim();
    const narration = narrationInputEl ? narrationInputEl.value.trim() : '';

    if (!content && !narration) return;

    input.value = '';
    if (narrationInputEl) narrationInputEl.value = '';

    if (narrationWrapEl) narrationWrapEl.classList.remove('open');
    document.body.classList.remove('narration-open');

    if (narrationToggleEl) narrationToggleEl.classList.remove('active');
    updateSendLabel();
    sending = true;

    try {
      await sendMessage(content, narration);
    } catch (error) {
      // 失败时把刚清空的输入还回去，别让用户白打一遍字
      if (messageInputEl && !messageInputEl.value) {
        messageInputEl.value = content;
      }
      if (narrationInputEl && !narrationInputEl.value && narration) {
        narrationInputEl.value = narration;
      }
      alert('发送失败：' + error.message);
    } finally {
      sending = false;
      updateSendLabel();
    }
  });

  let longPressTimer = null;

  $('messages').addEventListener('pointerdown', (event) => {
    const target = event.target.closest('.bubble[data-message-id], .message-narration[data-message-id]');
    if (!target) return;

    longPressTimer = setTimeout(() => {
      openEdit(Number(target.dataset.messageId));
    }, 650);
  });

  ['pointerup', 'pointercancel', 'pointermove'].forEach((name) => {
    $('messages').addEventListener(name, () => {
      clearTimeout(longPressTimer);
    });
  });

  function openEdit(id) {
    const message = messageRows.find(
      (item) => Number(item.id) === Number(id)
    );

    if (!message || message.role === 'system') return;

    editMessageId = Number(id);
    $('editNarration').value = message.narration || '';
    $('editText').value = message.content || '';
    $('editRewrite').style.display =
      message.role === 'character' ? 'block' : 'none';
    $('editModal').classList.add('open');
  }

  function closeEdit() {
    editMessageId = null;
    $('editModal').classList.remove('open');
    $('editNarration').value = '';
    $('editText').value = '';
  }

  $('editCancel').addEventListener('click', closeEdit);

  $('editSave').addEventListener('click', async () => {
    const content = $('editText').value.trim();
    const narration = $('editNarration').value.trim();

    if ((!content && !narration) || !editMessageId) return;

    try {
      const response = await fetch(
        '/api/messages/' + editMessageId,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, narration })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '保存失败');
      }

      closeEdit();
      await loadMessages();
    } catch (error) {
      alert('保存失败：' + error.message);
    }
  });

  $('editRewrite').addEventListener('click', async () => {
    if (!editMessageId) return;

    const target = messageRows.find(
      (item) => Number(item.id) === Number(editMessageId)
    );

    if (!target || target.role !== 'character') return;

    const id = editMessageId;
    closeEdit();
    sending = true;
    showTyping();

    try {
      const response = await fetch(
        '/api/characters/' + characterId + '/reply',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ regenerate_message_id: id })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '重写失败');
      }

      await loadMessages();
    } catch (error) {
      alert('重写失败：' + error.message);
    } finally {
      hideTyping();
      sending = false;
    }
  });

  $('editDelete').addEventListener('click', async () => {
    if (!editMessageId) return;
    if (!confirm('删除这条消息？')) return;

    try {
      const response = await fetch('/api/messages/' + editMessageId, {
        method: 'DELETE'
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '删除失败');
      }

      closeEdit();
      await loadMessages();
    } catch (error) {
      alert('删除失败：' + error.message);
    }
  });

  function openMenu() {
    updateMenu();
    $('menuSheet').classList.add('open');
    $('menuBackdrop').classList.add('open');
  }

  function closeMenu() {
    $('menuSheet').classList.remove('open');
    $('menuBackdrop').classList.remove('open');
  }

  function updateMenu() {
    if (!character) return;

    $('pinToggle').textContent = Number(character.is_pinned)
      ? '取消置顶角色'
      : '置顶角色';

    $('showMetaToggle').checked =
      localStorage.getItem(showMetaKey) === '1';

    $('userColorPicker').value = colors.user;
    $('userColorText').value = colors.user;
    $('charColorPicker').value = colors.char;
    $('charColorText').value = colors.char;

    if (personas.length) {
      $('personaSelect').value =
        String(character.user_persona_id || 0);
    }
  }

  $('moreBtn').addEventListener('click', openMenu);
  $('closeMenu').addEventListener('click', closeMenu);
  $('menuBackdrop').addEventListener('click', closeMenu);

  $('headerTitle').addEventListener('click', () => {
    if (characterId) {
      location.href = '/character.html?id=' + characterId;
    }
  });

  // 点聊天里角色那一侧的头像，进角色主页
  $('messages').addEventListener('click', (event) => {
    const avatar = event.target.closest('.message-row.character .msg-avatar');

    if (avatar) {
      location.href = '/character.html?id=' + characterId;
    }
  });

  $('pinToggle').addEventListener('click', async () => {
    try {
      const next = !Number(character.is_pinned);

      const response = await fetch(
        '/api/characters/' + characterId + '/settings',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_pinned: next })
        }
      );

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '设置失败');
      }

      character.is_pinned = data.is_pinned;
      updateMenu();
    } catch (error) {
      alert('设置失败：' + error.message);
    }
  });

  $('personaSelect').addEventListener('change', async () => {
    const value = Number($('personaSelect').value || 0);

    try {
      const response = await fetch(
        '/api/characters/' + characterId + '/settings',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_persona_id: value })
        }
      );

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '设置失败');
      }

      character.user_persona_id = data.user_persona_id;
      updateHeaderSub();
      updateMenu();
    } catch (error) {
      alert('绑定失败：' + error.message);
    }
  });

  $('showMetaToggle').addEventListener('change', () => {
    localStorage.setItem(
      showMetaKey,
      $('showMetaToggle').checked ? '1' : '0'
    );
    renderMessages();
  });

  function saveColors() {
    localStorage.setItem(
      bubbleColorKey,
      JSON.stringify(colors)
    );
    applyBubbleColors();
  }

  $('userColorPicker').addEventListener('input', () => {
    colors.user = $('userColorPicker').value;
    $('userColorText').value = colors.user;
    saveColors();
  });

  $('userColorText').addEventListener('input', () => {
    const value = $('userColorText').value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      colors.user = value;
      $('userColorPicker').value = value;
      saveColors();
    }
  });

  $('charColorPicker').addEventListener('input', () => {
    colors.char = $('charColorPicker').value;
    $('charColorText').value = colors.char;
    saveColors();
  });

  $('charColorText').addEventListener('input', () => {
    const value = $('charColorText').value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      colors.char = value;
      $('charColorPicker').value = value;
      saveColors();
    }
  });

  $('backBtn').addEventListener('click', () => {
    window.nocturneBack();
  });

  document.documentElement.dataset.theme =
    localStorage.getItem('saudade-theme') || 'light';

  applyBubbleColors();

  // 供 chat-actions.js 做软刷新，避免 location.reload() 整页重载
  window.__nocturneChat = {
    reload: loadMessages,
    send: sendMessage,
    sendSticker,
    get messages() {
      return messageRows;
    },
    get character() {
      return character;
    },
    get characterId() {
      return characterId;
    },
    openNarration() {
      if (!narrationWrapEl) return;
      narrationWrapEl.classList.add('open');
      if (narrationToggleEl) narrationToggleEl.classList.add('active');
      document.body.classList.add('narration-open');
      if (narrationInputEl) narrationInputEl.focus();
      updateSendLabel();
    },
    get sending() {
      return sending;
    },
    set sending(value) {
      sending = Boolean(value);
      updateSendLabel();
    },
    closeNarration
  };

  // 启动链：角色 → 人设 → 消息。每一步都自带兜底，任何一步失败都不能
  // 让后面的步骤被吞掉（之前 personas 一出错，聊天记录就永远不加载）。
  async function boot() {
    const characterReady = await loadCharacter();
    if (!characterReady) return;

    await loadPersonas();
    await loadMessages();
  }

  boot().catch((error) => {
    showLoadError(error && error.message, boot);
  });
})();
