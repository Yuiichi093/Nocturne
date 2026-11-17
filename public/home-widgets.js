(function () {
  const notificationsEl = document.getElementById('homeNotifications');
  const memoEl = document.getElementById('homeMemoList');

  if (!notificationsEl || !memoEl) return;

  function escapeHtml(text) {
    return String(text || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  const defaultTasks = [
    '整理一下角色人设',
    '写一段剧场剧情',
    '备份一次数据'
  ];

  function loadMemo() {
    let tasks = [];

    try {
      tasks = JSON.parse(
        localStorage.getItem('nocturne-home-memo') || '[]'
      );
    } catch (e) {
      tasks = [];
    }

    if (!Array.isArray(tasks) || tasks.length !== 3) {
      tasks = defaultTasks.map((text) => ({ text, done: false }));
    }

    return tasks;
  }

  function saveMemo(tasks) {
    localStorage.setItem('nocturne-home-memo', JSON.stringify(tasks));
  }

  function renderMemo() {
    const tasks = loadMemo();

    memoEl.innerHTML = tasks.map((task, index) => `
      <div class="home-memo-item ${task.done ? 'done' : ''}">
        <input type="checkbox" data-memo-index="${index}" ${task.done ? 'checked' : ''}>
        <span contenteditable="true" data-memo-text="${index}">${escapeHtml(task.text)}</span>
      </div>
    `).join('');
  }

  memoEl.addEventListener('focusout', (event) => {
    const span = event.target.closest('[data-memo-text]');
    if (!span) return;

    const tasks = loadMemo();
    const index = Number(span.dataset.memoText);
    if (!tasks[index]) return;

    const text = span.textContent.trim();
    if (!text) {
      span.textContent = tasks[index].text;
      return;
    }

    tasks[index].text = text;
    saveMemo(tasks);
  });

  memoEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.target.blur();
    }
  });

  memoEl.addEventListener('change', (event) => {
    const input = event.target.closest('[data-memo-index]');
    if (!input) return;

    const tasks = loadMemo();
    const index = Number(input.dataset.memoIndex);

    if (!tasks[index]) return;

    tasks[index].done = input.checked;
    saveMemo(tasks);
    renderMemo();
  });

  async function loadNotifications() {
    try {
      const [chatsRes, momentsRes, scriptsRes] = await Promise.all([
        fetch('/api/chats'),
        fetch('/api/moments'),
        fetch('/api/theater/scripts')
      ]);

      const chats = await chatsRes.json();
      const moments = await momentsRes.json();
      const scripts = await scriptsRes.json();

      const items = [];

      if (chats[0]) {
        items.push({
          title: '消息',
          text: chats[0].name + '：' +
            (chats[0].last_content || chats[0].last_message_preview || '还没有聊天')
        });
      }

      if (moments[0]) {
        items.push({
          title: '朋友圈',
          text: (moments[0].character_name || '角色') + '：' +
            (moments[0].content || '')
        });
      }

      if (scripts[0]) {
        items.push({
          title: '剧场',
          text: '剧本「' + scripts[0].title + '」' +
            (scripts[0].subtitle ? ' · ' + scripts[0].subtitle : '')
        });
      }

      if (!items.length) {
        notificationsEl.innerHTML =
          '<div class="home-empty">暂无通知。</div>';
        return;
      }

      notificationsEl.innerHTML = items.slice(0, 3).map((item) => `
        <div class="home-note-item">
          <span class="home-note-dot"></span>
          <span><strong>${escapeHtml(item.title)}</strong> · ${escapeHtml(item.text)}</span>
        </div>
      `).join('');
    } catch (error) {
      notificationsEl.innerHTML =
        '<div class="home-empty">通知加载失败。</div>';
    }
  }

  renderMemo();
  loadNotifications();
})();
