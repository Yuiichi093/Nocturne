(function () {
  const list = document.getElementById('chatList');
  const search = document.getElementById('chatSearch');

  if (!list) return;

  let rows = [];

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
    const date = new Date(normalized.endsWith('Z') ? normalized : normalized + 'Z');
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatTime(value) {
    const date = parseDate(value);
    if (!date) return '';

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diff = Math.round((today - day) / 86400000);

    if (diff === 0) {
      return date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    if (diff === 1) return '昨天';

    if (diff > 1 && diff < 7) {
      return '周' + '日一二三四五六'[date.getDay()];
    }

    return String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0');
  }

  function render() {
    const keyword = (search && search.value || '').trim().toLowerCase();

    const filtered = rows.filter((row) => {
      if (!keyword) return true;
      return String(row.name || '').toLowerCase().includes(keyword) ||
        String(row.handle || '').toLowerCase().includes(keyword);
    });

    if (!filtered.length) {
      list.innerHTML = '<div class="chat-empty">还没有角色。先去「我的 → 人设管理」创建角色。</div>';
      return;
    }

    list.innerHTML = filtered.map((row) => {
      const avatar = row.avatar
        ? `<img src="${escapeHtml(row.avatar)}" alt="">`
        : escapeHtml(String(row.name || '?').slice(0, 1));

      const preview = row.last_content ||
        row.opening_line ||
        '还没有聊天';

      const time = formatTime(row.last_time || row.created_at);
      const pinned = Number(row.is_pinned) === 1;

      return `
        <div class="chat-row ${pinned ? 'pinned' : ''}" data-character="${row.id}">
          <div class="chat-avatar">${avatar}</div>
          <div class="chat-main">
            <div class="chat-name">
              ${escapeHtml(row.name)}
              ${pinned ? '<span class="pin-label">置顶</span>' : ''}
            </div>
            <div class="chat-preview">${escapeHtml(preview)}</div>
          </div>
          <div class="chat-side">
            <div class="chat-time">${escapeHtml(time)}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  async function loadChats() {
    try {
      const response = await fetch('/api/chats');

      if (!response.ok) {
        throw new Error(response.status === 401 ? '要重新登录' : '服务器返回 ' + response.status);
      }

      const data = await response.json();

      // 接口出错时返回的是 { error: "…" }，直接当数组用会炸
      rows = Array.isArray(data) ? data : [];
      render();

      if (!Array.isArray(data)) {
        list.innerHTML =
          '<div class="chat-empty">加载失败：' +
          escapeHtml((data && data.error) || '返回的数据不对') +
          '</div>';
      }
    } catch (error) {
      const isNetwork = /Failed to fetch|NetworkError|Load failed/i.test(error.message || '');
      list.innerHTML =
        '<div class="chat-empty">' +
        (isNetwork
          ? '连不上 App 里的服务，可能还在启动。'
          : '加载失败：') +
        '<button type="button" class="ghost-btn" id="chatsRetry">重试</button>' +
        '</div>';

      const retry = document.getElementById('chatsRetry');
      if (retry) {
        retry.addEventListener('click', () => {
          list.innerHTML = '<div class="chat-empty">加载中…</div>';
          loadChats();
        });
      }

      if (isNetwork) {
        console.warn('[消息] ' + error.message);
      }
    }
  }

  list.addEventListener('click', (event) => {
    const row = event.target.closest('[data-character]');
    if (row) {
      location.href = '/chat.html?character=' + row.dataset.character;
    }
  });

  if (search) {
    search.addEventListener('input', render);
  }

  window.addEventListener('focus', loadChats);
  loadChats();
})();
