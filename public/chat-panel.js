(function () {
  'use strict';

  // 输入框上方那套面板：＋（旁白/重新生成/图片）、表情包。
  // 拆成单独文件，chat.js 里只留聊天本身。

  const $ = (id) => document.getElementById(id);
  const chat = () => window.__nocturneChat || null;

  function characterId() {
    const api = chat();
    return api ? api.characterId : new URLSearchParams(location.search).get('character');
  }

  function escapeHtml(text) {
    return String(text || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  // ---- 面板开关 ----
  const SHEETS = ['chatPlusSheet', 'chatRegenSheet', 'chatImageSheet', 'chatStickerSheet'];

  function closeSheets() {
    SHEETS.forEach((id) => {
      const sheet = $(id);
      if (sheet) sheet.classList.remove('open');
    });
    const backdrop = $('chatSheetBackdrop');
    if (backdrop) backdrop.classList.remove('open');
  }

  function openSheet(id) {
    closeSheets();
    const sheet = $(id);
    if (!sheet) return;
    sheet.classList.add('open');
    const backdrop = $('chatSheetBackdrop');
    if (backdrop) backdrop.classList.add('open');
  }

  document.querySelectorAll('[data-chat-close]').forEach((button) => {
    button.addEventListener('click', closeSheets);
  });

  const chatBackdrop = $('chatSheetBackdrop');
  if (chatBackdrop) chatBackdrop.addEventListener('click', closeSheets);

  // ---- ＋ 面板 ----
  const plusBtn = $('plusBtn');
  if (plusBtn) {
    plusBtn.addEventListener('click', () => openSheet('chatPlusSheet'));
  }

  const plusNarration = $('plusNarration');
  if (plusNarration) {
    plusNarration.addEventListener('click', () => {
      closeSheets();
      const api = chat();
      if (api && api.openNarration) api.openNarration();
    });
  }

  const plusImage = $('plusImage');
  if (plusImage) {
    plusImage.addEventListener('click', () => openSheet('chatImageSheet'));
  }

  // ---- 图片 ----
  const imageFromAlbum = $('imageFromAlbum');
  const chatImageInput = $('chatImageInput');

  if (imageFromAlbum && chatImageInput) {
    imageFromAlbum.addEventListener('click', () => chatImageInput.click());

    chatImageInput.addEventListener('change', async () => {
      const file = chatImageInput.files && chatImageInput.files[0];
      if (!file) return;

      closeSheets();

      try {
        const url = await uploadImage(file);
        await sendImage(url);
      } catch (error) {
        alert('发图失败：' + error.message);
      } finally {
        chatImageInput.value = '';
      }
    });
  }

  async function uploadImage(file) {
    const form = new FormData();
    form.append('image', file);

    const response = await fetch('/api/upload', { method: 'POST', body: form });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || '上传失败');
    }

    return data.url;
  }

  async function sendImage(url) {
    const api = chat();
    if (!api) return;

    const input = $('messageInput');
    const content = input ? input.value.trim() : '';
    if (input) input.value = '';

    api.sending = true;

    try {
      await api.send(content, '', url);
    } catch (error) {
      alert('发送失败：' + error.message);
    } finally {
      api.sending = false;
    }
  }

  const imageGenerateBtn = $('imageGenerateBtn');
  if (imageGenerateBtn) {
    imageGenerateBtn.addEventListener('click', async () => {
      const promptInput = $('chatImagePrompt');
      const prompt = promptInput ? promptInput.value.trim() : '';

      if (!prompt) {
        alert('先写一句画面描述');
        return;
      }

      const original = imageGenerateBtn.textContent;
      imageGenerateBtn.disabled = true;
      imageGenerateBtn.textContent = '画图中…';

      try {
        const response = await fetch('/api/generate-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, character_id: characterId() })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(data.error || '生成失败');
        }

        if (promptInput) promptInput.value = '';
        closeSheets();
        await sendImage(data.url);
      } catch (error) {
        alert('生成失败：' + error.message);
      } finally {
        imageGenerateBtn.disabled = false;
        imageGenerateBtn.textContent = original;
      }
    });
  }

  // ---- 重新生成：一次给三份预览，挑一个 ----
  const regenList = $('chatRegenList');
  const regenTip = $('chatRegenTip');
  const regenReroll = $('chatRegenReroll');
  let regenTargetId = 0;

  function lastCharacterBubble() {
    const bubbles = Array.from(
      document.querySelectorAll('.message-row.character .bubble[data-message-id]')
    );

    return bubbles[bubbles.length - 1] || null;
  }

  const plusRegenerate = $('plusRegenerate');
  if (plusRegenerate) {
    plusRegenerate.addEventListener('click', () => {
      const bubble = lastCharacterBubble();

      if (!bubble) {
        alert('还没有角色消息可以重新生成');
        return;
      }

      regenTargetId = Number(bubble.dataset.messageId);
      openSheet('chatRegenSheet');
      loadCandidates();
    });
  }

  if (regenReroll) {
    regenReroll.addEventListener('click', loadCandidates);
  }

  async function loadCandidates() {
    if (!regenTargetId) return;

    if (regenTip) regenTip.textContent = '正在写三份…可能要等十几秒';
    if (regenList) {
      regenList.innerHTML =
        '<div class="regen-card">生成中，请稍等…</div>';
    }
    if (regenReroll) regenReroll.disabled = true;

    try {
      const response = await fetch(
        '/api/characters/' + characterId() + '/reply',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            regenerate_message_id: regenTargetId,
            candidates: 3
          })
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || '生成失败');
      }

      const candidates = data.candidates || [];

      if (!candidates.length) {
        throw new Error('没有拿到内容');
      }

      if (regenTip) regenTip.textContent = '点一条就用它替换最后一句。';

      regenList.innerHTML = candidates.map((item, index) => {
        const narration = item.narration
          ? '<span class="regen-narration">' + escapeHtml(item.narration) + '</span>'
          : '';

        return `
          <button class="regen-card" data-variant="${item.variant_id}" type="button">
            ${narration}${escapeHtml(item.content || '')}
          </button>
        `;
      }).join('');
    } catch (error) {
      if (regenTip) regenTip.textContent = '生成失败：' + error.message;
      if (regenList) regenList.innerHTML = '';
    } finally {
      if (regenReroll) regenReroll.disabled = false;
    }
  }

  if (regenList) {
    regenList.addEventListener('click', async (event) => {
      const card = event.target.closest('[data-variant]');
      if (!card) return;

      card.disabled = true;

      try {
        const response = await fetch(
          '/api/messages/' + regenTargetId + '/variant',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              variant_id: Number(card.dataset.variant)
            })
          }
        );

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(data.error || '替换失败');
        }

        closeSheets();
        const api = chat();
        if (api) await api.reload();
      } catch (error) {
        card.disabled = false;
        alert('替换失败：' + error.message);
      }
    });
  }

  // ---- 表情包 ----
  const stickerBtn = $('stickerBtn');
  const stickerGrid = $('chatStickerGrid');
  const stickerFileInput = $('stickerFileInput');
  const stickerAddBtn = $('stickerAddBtn');
  const stickerManageBtn = $('stickerManageBtn');
  let stickers = [];
  let stickerManaging = false;

  if (stickerBtn) {
    stickerBtn.addEventListener('click', () => {
      stickerManaging = false;
      openSheet('chatStickerSheet');
      loadStickers();
    });
  }

  async function loadStickers() {
    if (!stickerGrid) return;

    stickerGrid.innerHTML = '<div class="sticker-empty">加载中…</div>';

    try {
      const response = await fetch(
        '/api/characters/' + characterId() + '/stickers'
      );
      const list = await response.json();

      stickers = Array.isArray(list) ? list : [];
      renderStickers();
    } catch (error) {
      stickerGrid.innerHTML =
        '<div class="sticker-empty">加载失败：' + escapeHtml(error.message) + '</div>';
    }
  }

  function renderStickers() {
    if (!stickerGrid) return;

    if (!stickers.length) {
      stickerGrid.innerHTML =
        '<div class="sticker-empty">还没有表情。点下面「添加」，传一张图再写一句它是什么意思。</div>';
      return;
    }

    stickerGrid.innerHTML = stickers.map((sticker) => `
      <button class="sticker-item" data-sticker="${sticker.id}" type="button">
        <img src="${escapeHtml(sticker.image_url)}" alt="${escapeHtml(sticker.meaning || '')}">
        ${sticker.meaning
          ? '<span class="sticker-meaning">' + escapeHtml(sticker.meaning) + '</span>'
          : ''}
        ${stickerManaging
          ? '<span class="sticker-del" data-sticker-del="' + sticker.id + '">×</span>'
          : ''}
      </button>
    `).join('');
  }

  if (stickerManageBtn) {
    stickerManageBtn.addEventListener('click', () => {
      stickerManaging = !stickerManaging;
      stickerManageBtn.textContent = stickerManaging
        ? '改意思'
        : '管理';
      renderStickers();
    });
  }

  if (stickerGrid) {
    stickerGrid.addEventListener('click', async (event) => {
      const del = event.target.closest('[data-sticker-del]');
      const meaningEdit = stickerManaging && !del
        ? event.target.closest('[data-sticker]')
        : null;

      if (del) {
        event.stopPropagation();

        if (!confirm('删掉这个表情？')) return;

        try {
          await fetch('/api/stickers/' + del.dataset.stickerDel, { method: 'DELETE' });
          await loadStickers();
        } catch (error) {
          alert('删除失败：' + error.message);
        }

        return;
      }

      if (meaningEdit) {
        const sticker = stickers.find(
          (item) => Number(item.id) === Number(meaningEdit.dataset.sticker)
        );

        if (!sticker) return;

        const meaning = prompt('这个表情是什么意思？角色会按这句话理解它。', sticker.meaning || '');

        if (meaning === null) return;

        try {
          await fetch('/api/stickers/' + sticker.id, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ meaning: meaning.trim() })
          });
          await loadStickers();
        } catch (error) {
          alert('保存失败：' + error.message);
        }

        return;
      }

      const tile = event.target.closest('[data-sticker]');
      if (!tile) return;

      const sticker = stickers.find(
        (item) => Number(item.id) === Number(tile.dataset.sticker)
      );

      if (!sticker) return;

      closeSheets();
      const api = chat();
      if (api && api.sendSticker) await api.sendSticker(sticker);
    });
  }

  if (stickerAddBtn && stickerFileInput) {
    stickerAddBtn.addEventListener('click', () => stickerFileInput.click());

    stickerFileInput.addEventListener('change', async () => {
      const file = stickerFileInput.files && stickerFileInput.files[0];
      if (!file) return;

      const original = stickerAddBtn.textContent;
      stickerAddBtn.disabled = true;
      stickerAddBtn.textContent = '上传中…';

      try {
        const url = await uploadImage(file);
        const meaning = prompt('这个表情是什么意思？比如「笑到打滚」「委屈巴巴」', '');

        if (meaning === null) {
          stickerFileInput.value = '';
          return;
        }

        const response = await fetch(
          '/api/characters/' + characterId() + '/stickers',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_url: url, meaning: meaning.trim() })
          }
        );

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(data.error || '保存失败');
        }

        await loadStickers();
      } catch (error) {
        alert('添加失败：' + error.message);
      } finally {
        stickerAddBtn.disabled = false;
        stickerAddBtn.textContent = original;
        stickerFileInput.value = '';
      }
    });
  }
})();
