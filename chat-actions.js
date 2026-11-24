(function () {
  const messagesEl = document.getElementById('messages');
  if (!messagesEl) return;

  const params = new URLSearchParams(location.search);
  const characterId = params.get('character');
  let navTimer = null;

  // 软刷新：优先让 chat.js 重新拉取消息并重绘，
  // 避免整页 location.reload() 造成的白屏和滚动位置丢失。
  async function softReload() {
    const api = window.__nocturneChat;
    if (api && typeof api.reload === 'function') {
      await api.reload();
      return;
    }
    location.reload();
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

  function formatTime(value) {
    const date = parseDate(value);
    if (!date) return '';
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  }

  function getLastCharacterBubble() {
    const bubbles = Array.from(
      document.querySelectorAll(
        '.message-row.character .bubble[data-message-id]'
      )
    );

    return bubbles[bubbles.length - 1] || null;
  }

  let regenerating = false;

  window.regenerateLast = async function () {
    if (regenerating) return;

    const bubble = getLastCharacterBubble();

    if (!bubble) {
      alert('还没有角色消息可以重新生成');
      return;
    }

    // 页面上没有 #refreshBtn（旧的独立刷新按钮已不存在），
    // 这里禁用真实存在的「换一批」按钮并加锁，防止连点重复请求。
    regenerating = true;
    const button = document.getElementById('chatRegenReroll');
    if (button) button.disabled = true;

    try {
      const response = await fetch(
        '/api/characters/' + characterId + '/reply',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            regenerate_message_id: Number(bubble.dataset.messageId)
          })
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || '重新生成失败');
      }

      await softReload();
    } catch (error) {
      alert(error && error.message === 'Failed to fetch'
        ? '连不上服务，请稍后再试'
        : '重新生成失败：' + error.message);
    } finally {
      regenerating = false;
      if (button) button.disabled = false;
    }
  };

  async function updateVariantNav() {
    const bubble = getLastCharacterBubble();
    if (!bubble) return;

    const content = bubble.closest('.message-content');
    if (!content) return;

    if (content.querySelector('.variant-nav')) return;

    try {
      const response = await fetch(
        '/api/messages/' + bubble.dataset.messageId + '/variants'
      );

      const data = await response.json();
      if (!response.ok) return;

      const total = (data.variants || []).length + 1;

      const nav = document.createElement('button');
      nav.type = 'button';
      nav.className = 'variant-nav';
      nav.innerHTML = `
        <span class="variant-arrow">‹</span>
        <span>${escapeHtml(formatTime(data.current.created_at))}</span>
        <span>${total}/${total}</span>
        <span>♡</span>
      `;

      nav.addEventListener('click', () => {
        openVariantSheet(bubble.dataset.messageId, data);
      });

      content.appendChild(nav);
    } catch (e) {}
  }

  function openVariantSheet(messageId, data) {
    const existing = document.getElementById('chatVariantSheet');
    if (existing) existing.remove();

    const existingBackdrop = document.getElementById('chatVariantBackdrop');
    if (existingBackdrop) existingBackdrop.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'variant-sheet-backdrop open';
    backdrop.id = 'chatVariantBackdrop';

    const sheet = document.createElement('div');
    sheet.className = 'variant-sheet open';
    sheet.id = 'chatVariantSheet';

    const variants = data.variants || [];

    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <h2>历史生成</h2>
      <button class="variant-item current" type="button">
        ${escapeHtml(data.current.content || '')}
      </button>
      ${variants.map((item) => `
        <button class="variant-item" data-variant-id="${item.id}" type="button">
          ${escapeHtml(item.content || '')}
        </button>
      `).join('') || '<div class="variant-item">还没有历史版本。</div>'}
      <button class="menu-btn ghost" id="variantCloseBtn" type="button">关闭</button>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);

    backdrop.addEventListener('click', closeVariantSheet);
    sheet.querySelector('#variantCloseBtn').addEventListener('click', closeVariantSheet);

    sheet.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-variant-id]');
      if (!button) return;

      try {
        const response = await fetch(
          '/api/messages/' + messageId + '/variant',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              variant_id: Number(button.dataset.variantId)
            })
          }
        );

        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || '切换失败');
        }

        await softReload();
      } catch (error) {
        alert('切换失败：' + error.message);
      }
    });
  }

  function closeVariantSheet() {
    const backdrop = document.getElementById('chatVariantBackdrop');
    const sheet = document.getElementById('chatVariantSheet');
    if (backdrop) backdrop.remove();
    if (sheet) sheet.remove();
  }

  const observer = new MutationObserver(() => {
    clearTimeout(navTimer);
    navTimer = setTimeout(updateVariantNav, 150);
  });

  observer.observe(messagesEl, {
    childList: true,
    subtree: true
  });

  setTimeout(updateVariantNav, 800);
})();
