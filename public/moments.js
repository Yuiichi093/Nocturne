(function () {
  'use strict';

  const root = document.getElementById('momentsRoot');
  if (!root) return;

  const $ = (id) => document.getElementById(id);

  let moments = [];
  let userPersona = null;
  let localProfile = null;
  let coverUrl = '';
  let characters = [];
  let activeMoment = null;
  let editingMoment = null;
  let composerMode = 'text';
  let composerImage = '';
  let notices = [];

  // 上次看过提醒的时间点（本地记，不上报服务器）
  const NOTICE_SEEN_KEY = 'nocturne-moments-seen';

  function noticeSeenAt() {
    return Number(localStorage.getItem(NOTICE_SEEN_KEY) || 0);
  }

  function markNoticesRead() {
    try {
      localStorage.setItem(NOTICE_SEEN_KEY, String(Date.now()));
    } catch (e) {}

    renderNoticeBadge();
  }

  function unreadNotices() {
    const seen = noticeSeenAt();

    return notices.filter((item) => {
      const date = parseDate(item.created_at);
      return date ? date.getTime() > seen : false;
    });
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

  function timeAgo(value) {
    const date = parseDate(value);
    if (!date) return '';

    const diff = Math.max(0, Date.now() - date.getTime()) / 1000;

    if (diff < 10) return '刚刚';
    if (diff < 60) return Math.floor(diff) + '秒前';
    if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
    if (diff < 604800) return Math.floor(diff / 86400) + '天前';

    return (date.getMonth() + 1) + '月' + date.getDate() + '日';
  }

  function getDisplayUser() {
    const local = localProfile || {};

    return {
      name: local.name || (userPersona && userPersona.name) || '我',
      avatar: local.avatar || (userPersona && userPersona.avatar) || '',
      signature: local.bio ||
        (userPersona && (userPersona.bio || userPersona.persona)) ||
        '写一句签名'
    };
  }

  function renderShell() {
    root.innerHTML = `
      <div class="moments-root">
        <section class="moments-cover" id="momentsCover">
          <div class="moments-cover-actions">
            <button id="momentsPlusBtn" type="button">＋</button>
          </div>

          <div class="moments-user">
            <div class="moments-user-avatar" id="momentsUserAvatar">我</div>
            <div class="moments-user-info">
              <h2 id="momentsUserName">我</h2>
              <p id="momentsUserSignature">写一句签名</p>
            </div>
          </div>
        </section>

        <button class="moments-unread" id="momentsUnreadBar" type="button" hidden></button>

        <div class="moments-feed" id="momentsFeed"></div>
      </div>

      <input type="file" id="momentsCoverInput" accept="image/*" hidden>
      <input type="file" id="momentsImageInput" accept="image/*" hidden>

      <div class="moment-sheet-backdrop" id="momentBackdrop"></div>

      <section class="moment-sheet" id="momentAddSheet">
        <div class="moment-sheet-handle"></div>
        <h2>发表</h2>

        <div class="ms-group">
          <button class="ms-row" id="momentAddText" type="button">
            <span class="ms-title">写点什么</span>
            <span class="ms-chevron">›</span>
          </button>

          <button class="ms-row" id="momentAddImage" type="button">
            <span class="ms-title">发张照片</span>
            <span class="ms-chevron">›</span>
          </button>

          <button class="ms-row" id="momentAddAi" type="button">
            <span class="ms-title">让角色自己发
              <span class="ms-sub">挑一个角色，让它写一条</span>
            </span>
            <span class="ms-chevron">›</span>
          </button>
        </div>

        <div class="ms-group">
          <button class="ms-row" id="momentAddAuto" type="button">
            <span class="ms-title">自动发布设置</span>
            <span class="ms-chevron">›</span>
          </button>
        </div>

        <button class="ms-cancel" data-close-sheet type="button">取消</button>
      </section>

      <section class="moment-sheet" id="momentAiSheet">
        <div class="moment-sheet-handle"></div>
        <h2>让角色自己发</h2>
        <div class="moment-character-list" id="momentCharacterList">加载中...</div>
        <button class="moment-sheet-btn ghost" data-close-sheet type="button">关闭</button>
      </section>

      <section class="moment-sheet" id="momentComposerSheet">
        <div class="moment-sheet-handle"></div>
        <h2 id="momentComposerTitle">发表文字</h2>

        <div class="ms-identity">
          <label for="momentComposerIdentity">以谁的身份发</label>
          <select id="momentComposerIdentity"></select>
        </div>

        <textarea id="momentComposeText" placeholder="这一刻的想法..."></textarea>
        <div class="moment-compose-preview" id="momentComposePreview"></div>
        <div class="moment-sheet-actions">
          <button class="moment-sheet-btn ghost" id="momentPickImage" type="button">图片</button>
          <button class="moment-sheet-btn" id="momentPublish" type="button">发表</button>
        </div>
        <button class="moment-sheet-btn ghost" data-close-sheet type="button">取消</button>
      </section>

      <section class="moment-sheet" id="momentActionSheet">
        <div class="moment-sheet-handle"></div>
        <h2>动态操作</h2>
        <button class="moment-sheet-btn" id="momentEditBtn" type="button">编辑</button>
        <button class="moment-sheet-btn danger" id="momentDeleteBtn" type="button">删除</button>
        <button class="moment-sheet-btn ghost" data-close-sheet type="button">取消</button>
      </section>

      <section class="moment-sheet" id="momentSocialSheet">
        <div class="moment-sheet-handle"></div>
        <h2>互动</h2>
        <button class="moment-sheet-btn" id="momentLikeBtn" type="button">赞</button>
        <button class="moment-sheet-btn" id="momentAiCommentBtn" type="button">让角色来评论</button>
        <div class="moment-comments" id="momentSocialComments"></div>
        <div class="moment-comment-input">
          <input id="momentCommentInput" placeholder="评论">
          <button id="momentCommentSend" type="button">发送</button>
        </div>
        <button class="moment-sheet-btn ghost" data-close-sheet type="button">关闭</button>
      </section>

      <section class="moment-sheet" id="momentAutoSheet">
        <div class="moment-sheet-handle"></div>
        <h2>朋友圈自动发布</h2>
        <label class="moment-auto-row">
          <input type="checkbox" id="momentAutoEnabled">
          <span>让角色自己发朋友圈</span>
        </label>
        <label class="moment-auto-row">
          <span>每隔</span>
          <input type="number" id="momentAutoInterval" min="1" max="72" step="1">
          <span>小时发一条</span>
        </label>
        <label class="moment-auto-row">
          <input type="checkbox" id="momentAutoComments">
          <span>发完后让别的角色来评论</span>
        </label>
        <div class="moment-sheet-actions">
          <button class="moment-sheet-btn" id="momentAutoSave" type="button">保存</button>
        </div>
        <button class="moment-sheet-btn ghost" data-close-sheet type="button">关闭</button>
      </section>

      <section class="moment-sheet" id="momentNoticeSheet">
        <div class="moment-sheet-handle"></div>
        <h2>消息</h2>
        <div class="moment-notice-list" id="momentNoticeList"></div>
        <button class="moment-sheet-btn ghost" data-close-sheet type="button">关闭</button>
      </section>

      <section class="moment-sheet" id="momentEditSheet">
        <div class="moment-sheet-handle"></div>
        <h2>编辑动态</h2>
        <textarea id="momentEditText" placeholder="修改内容"></textarea>
        <div class="moment-sheet-actions">
          <button class="moment-sheet-btn ghost" data-close-sheet type="button">取消</button>
          <button class="moment-sheet-btn" id="momentEditSave" type="button">保存</button>
        </div>
      </section>
    `;
  }

  function renderHeader() {
    const avatar = $('momentsUserAvatar');
    const name = $('momentsUserName');
    const signature = $('momentsUserSignature');
    const user = getDisplayUser();

    name.textContent = user.name;
    signature.textContent = user.signature.slice(0, 50);

    if (user.avatar) {
      avatar.innerHTML =
        '<img src="' + escapeHtml(user.avatar) + '" alt="">';
    } else {
      avatar.textContent = String(user.name || '我').slice(0, 1);
    }

    applyCover();
  }

  // 封面单独画，别等用户信息和动态都拿到才画
  function applyCover() {
    const cover = $('momentsCover');
    if (!cover) return;

    if (coverUrl) {
      cover.style.backgroundImage = 'url("' + coverUrl + '")';
    } else {
      cover.style.backgroundImage = '';
    }
  }

  function renderFeed() {
    const feed = $('momentsFeed');

    if (!moments.length) {
      feed.innerHTML = '<div class="moments-empty">还没有朋友圈。点右上角 ＋ 发一条，或者让角色自己发。</div>';
      return;
    }

    feed.innerHTML = moments.map((row) => {
      const avatar = row.character_avatar
        ? '<img src="' + escapeHtml(row.character_avatar) + '" alt="">'
        : escapeHtml(String(row.character_name || '?').slice(0, 1));

      const images = Array.isArray(row.images) ? row.images : [];
      const imagesHtml = images.length
        ? `<div class="moment-images ${images.length === 1 ? 'single' : ''}">
            ${images.map((url) => `
              <img class="moment-image" src="${escapeHtml(url)}" alt="">
            `).join('')}
          </div>`
        : '';

      const likes = Array.isArray(row.likes) ? row.likes : [];
      const comments = Array.isArray(row.comments) ? row.comments : [];

      const likesHtml = likes.length
        ? `<div class="moment-likes">♥ <strong>${likes.map(escapeHtml).join('、')}</strong></div>`
        : '';

      const commentsHtml = comments.length
        ? `<div class="moment-comments">
            ${comments.map(renderComment).join('')}
          </div>`
        : '';

      return `
        <article class="moment-card" data-moment-id="${row.id}">
          <div class="moment-head">
            <div class="moment-avatar">${avatar}</div>
            <div>
              <div class="moment-name">${escapeHtml(row.character_name || '角色')}</div>
              <div class="moment-sub">${escapeHtml(row.author_type === 'user' ? '我' : '角色动态')}</div>
            </div>
          </div>

          <div class="moment-content">${escapeHtml(row.content || '')}</div>
          ${imagesHtml}

          <div class="moment-footer">
            <span class="moment-time">${timeAgo(row.created_at)}</span>
            <button class="moment-dots" data-dots="${row.id}" type="button">··</button>
          </div>

          ${likesHtml}
          ${commentsHtml}
        </article>
      `;
    }).join('');
  }

  function renderNoticeBadge() {
    const unread = unreadNotices().length;

    const bar = $('momentsUnreadBar');
    if (bar) {
      if (unread > 0) {
        bar.hidden = false;
        bar.textContent = unread > 99 ? '99+ 条新消息' : unread + ' 条新消息';
      } else {
        bar.hidden = true;
      }
    }

    const tabBadge = document.getElementById('momentsTabBadge');
    if (tabBadge) {
      if (unread > 0) {
        tabBadge.hidden = false;
        tabBadge.textContent = unread > 99 ? '99+' : String(unread);
      } else {
        tabBadge.hidden = true;
      }
    }
  }

  async function loadNotifications() {
    try {
      const response = await fetch('/api/moments/notifications');
      const list = await response.json();

      if (Array.isArray(list)) notices = list;
    } catch (e) {
      notices = [];
    }

    renderNoticeBadge();
  }

  function renderNoticeList() {
    const box = $('momentNoticeList');
    if (!box) return;

    if (!notices.length) {
      box.innerHTML = '<div class="moments-empty">还没有人回复你的朋友圈。</div>';
      return;
    }

    box.innerHTML = notices.map((item) => {
      const avatar = item.author_avatar
        ? '<img src="' + escapeHtml(item.author_avatar) + '" alt="">'
        : escapeHtml(String(item.author_name || '?').slice(0, 1));

      return `
        <button class="moment-notice-row" data-notice-moment="${item.moment_id}" type="button">
          <div class="moment-avatar">${avatar}</div>
          <div class="moment-notice-body">
            <div class="moment-notice-name">${escapeHtml(item.author_name || '角色')}</div>
            <div class="moment-notice-text">${escapeHtml(item.content || '')}</div>
            <div class="moment-notice-sub">回复了你的动态 · ${escapeHtml(timeAgo(item.created_at))}</div>
          </div>
        </button>
      `;
    }).join('');
  }

  // 每个请求单独兜底：以前是 Promise.all 一把抓，任何一个接口抽风
  // （比如 /api/personas 返回 {error}）都会整段跳到 catch，
  // renderHeader() 根本不执行，已经显示的封面就被卡住或者被弹回去。
  function safeJson(url) {
    return fetch(url)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
  }

  async function loadAll() {
    // 谁先回来谁先画：封面、用户信息、动态互不等待。
    // 以前是一把 Promise.all，任何一个接口慢或者报错，
    // 整页就停在「我 / 写一句签名」的默认样子，看着像功能坏了。
    const settingsReq = safeJson('/api/moments/settings');
    const profileReq = safeJson('/api/profile');
    const personasReq = safeJson('/api/personas');
    const momentsReq = safeJson('/api/moments');

    const settings = await settingsReq;
    if (settings && typeof settings.cover === 'string') {
      coverUrl = settings.cover;
    }
    applyCover();

    const profileData = await profileReq;
    if (profileData && !profileData.error) localProfile = profileData;
    renderHeader();

    const personasData = await personasReq;
    if (Array.isArray(personasData)) {
      userPersona = personasData.find((item) => Number(item.is_default) === 1) ||
        personasData[0] ||
        null;
      renderHeader();
    }

    const momentsData = await momentsReq;
    if (Array.isArray(momentsData)) {
      moments = momentsData;
      renderFeed();
    } else {
      const feed = $('momentsFeed');
      if (feed) {
        feed.innerHTML =
          '<div class="moments-empty">动态加载失败，下拉或者重进这一页再试试。</div>';
      }
    }

    await loadNotifications();
  }

  function openSheet(id) {
    closeSheets();
    const sheet = $(id);
    if (!sheet) return;
    sheet.classList.add('open');
    $('momentBackdrop').classList.add('open');
  }

  function closeSheets() {
    document.querySelectorAll('.moment-sheet.open').forEach((sheet) => {
      sheet.classList.remove('open');
    });
    $('momentBackdrop').classList.remove('open');
  }

  function findMoment(id) {
    return moments.find((item) => Number(item.id) === Number(id)) || null;
  }

  function renderComment(comment) {
    const avatar = comment && comment.character_avatar
      ? `<img class="moment-comment-avatar" src="${escapeHtml(comment.character_avatar)}" alt="">`
      : '';
    return `<div class="moment-comment">${avatar}<div class="moment-comment-body"><b>${escapeHtml(comment.author_name)}</b>：${escapeHtml(comment.content)}</div></div>`;
  }

  renderShell();

  async function ensureCharacters() {
    if (characters.length) return characters;

    try {
      const response = await fetch('/api/characters');
      const list = await response.json();

      if (Array.isArray(list)) characters = list;
    } catch (e) {
      characters = [];
    }

    return characters;
  }

  function fillComposerIdentities() {
    const select = $('momentComposerIdentity');
    if (!select) return;

    const options = ['<option value="me">我自己</option>']
      .concat(characters.map((row) => '<option value="' + row.id + '">'
        + escapeHtml(row.name || ('角色 ' + row.id)) + '</option>'));

    select.innerHTML = options.join('');
  }

  async function openComposer(mode) {
    composerMode = mode === 'image' ? 'image' : 'text';
    composerImage = '';

    await ensureCharacters();
    fillComposerIdentities();

    $('momentComposerTitle').textContent =
      composerMode === 'image' ? '发表图片' : '发表文字';

    $('momentComposeText').value = '';
    $('momentComposePreview').innerHTML = '';
    openSheet('momentComposerSheet');

    if (composerMode === 'image') {
      setTimeout(() => $('momentsImageInput').click(), 50);
    }
  }

  // 先让浏览器试着解一次：解不出来的图（比如 HEIC）在这里就报错，
  // 而不是悄悄传上去、之后背景一直不换。
  function ensureDecodable(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();

      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve();
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('这张图读不出来（可能是 HEIC），换 JPG 或 PNG 试试'));
      };

      img.src = url;
    });
  }

  async function uploadImage(file, cropAspect, skipCrop) {
    let uploadFile = file;

    if (!skipCrop && typeof window.openImageCropper === 'function') {
      uploadFile = await window.openImageCropper(file, cropAspect);
    }

    const formData = new FormData();
    formData.append('image', uploadFile, 'image.jpg');

    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || '上传失败');
    }

    return data.url;
  }

  function openSocialSheet(moment) {
    activeMoment = moment;
    updateSocialSheet();
    openSheet('momentSocialSheet');
  }

  function updateSocialSheet() {
    if (!activeMoment) return;

    $('momentLikeBtn').textContent = activeMoment.liked ? '取消赞' : '赞';

    const comments = Array.isArray(activeMoment.comments)
      ? activeMoment.comments
      : [];

    $('momentSocialComments').innerHTML = comments.length
      ? comments.map(renderComment).join('')
      : '<div class="moment-comment">还没有评论。</div>';
  }

  function openActionSheet(moment) {
    activeMoment = moment;
    openSheet('momentActionSheet');
  }

  async function loadCharacters() {
    const list = $('momentCharacterList');

    try {
      const response = await fetch('/api/characters');
      characters = await response.json();

      if (!characters.length) {
        list.innerHTML =
          '<div class="moments-empty">还没有角色。先去“我的 → 人设管理”创建角色。</div>';
        return;
      }

      list.innerHTML = characters.map((row) => {
        const avatar = row.avatar
          ? '<img src="' + escapeHtml(row.avatar) + '" alt="">'
          : escapeHtml(String(row.name || '?').slice(0, 1));

        return `
          <button class="moment-character-row" data-character-id="${row.id}" type="button">
            <div class="moment-avatar">${avatar}</div>
            <div>
              <div class="moment-name">${escapeHtml(row.name)}</div>
              <div class="moment-sub">${escapeHtml(row.handle || '')}</div>
            </div>
          </button>
        `;
      }).join('');
    } catch (error) {
      list.textContent = '加载失败：' + error.message;
    }
  }

  async function generateMoment(characterId) {
    if (!characterId) return;

    try {
      $('momentCharacterList').innerHTML =
        '<div class="moments-empty">生成中，请稍等...</div>';

      const response = await fetch('/api/moments/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id: characterId })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '生成失败');
      }

      closeSheets();
      await loadAll();
    } catch (error) {
      alert('生成失败：' + error.message);
      await loadCharacters();
    }
  }

  $('momentsCover').addEventListener('click', (event) => {
    if (event.target.closest('.moments-cover-actions')) return;
    $('momentsCoverInput').click();
  });

  $('momentsCoverInput').addEventListener('change', async () => {
    const file = $('momentsCoverInput').files &&
      $('momentsCoverInput').files[0];

    if (!file) return;

    try {
      await ensureDecodable(file);
      const url = await uploadImage(file, NaN, true);

      const response = await fetch('/api/moments/cover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cover: url })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '保存背景失败');
      }

      coverUrl = url;
      renderHeader();
    } catch (error) {
      alert('上传背景失败：' + error.message);
    }

    $('momentsCoverInput').value = '';
  });

  $('momentsPlusBtn').addEventListener('click', () => {
    openSheet('momentAddSheet');
  });

  $('momentAddImage').addEventListener('click', () => {
    openComposer('image');
  });

  $('momentAddText').addEventListener('click', () => {
    openComposer('text');
  });

  $('momentAddAi').addEventListener('click', () => {
    openSheet('momentAiSheet');
    loadCharacters();
  });

  $('momentAddAuto').addEventListener('click', async () => {
    openSheet('momentAutoSheet');

    try {
      const response = await fetch('/api/moments/auto-settings');
      const data = await response.json();
      $('momentAutoEnabled').checked = !!data.enabled;
      $('momentAutoInterval').value = data.interval_hours || 6;
      $('momentAutoComments').checked = data.auto_comments !== false;
    } catch (error) {
      alert('读取设置失败：' + error.message);
    }
  });

  $('momentAutoSave').addEventListener('click', async () => {
    const button = $('momentAutoSave');
    button.disabled = true;

    try {
      const response = await fetch('/api/moments/auto-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: $('momentAutoEnabled').checked,
          interval_hours: Number($('momentAutoInterval').value) || 6,
          auto_comments: $('momentAutoComments').checked
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存失败');
      closeSheets();
      alert('已保存。角色会在后台自己发朋友圈了。');
    } catch (error) {
      alert('保存失败：' + error.message);
    } finally {
      button.disabled = false;
    }
  });

  $('momentCharacterList').addEventListener('click', (event) => {
    const row = event.target.closest('[data-character-id]');
    if (!row) return;
    generateMoment(Number(row.dataset.characterId));
  });

  $('momentPickImage').addEventListener('click', () => {
    $('momentsImageInput').click();
  });

  $('momentsImageInput').addEventListener('change', async () => {
    const file = $('momentsImageInput').files &&
      $('momentsImageInput').files[0];

    if (!file) return;

    try {
      $('momentComposePreview').innerHTML =
        '<div class="moments-empty">图片上传中...</div>';

      const url = await uploadImage(file, NaN);
      composerImage = url;

      $('momentComposePreview').innerHTML =
        '<img src="' + escapeHtml(url) + '" alt="">';
    } catch (error) {
      $('momentComposePreview').innerHTML = '';
      alert('上传图片失败：' + error.message);
    }

    $('momentsImageInput').value = '';
  });

  $('momentPublish').addEventListener('click', async () => {
    const text = $('momentComposeText').value.trim();

    if (!text && !composerImage) {
      alert('写点内容或选一张图片');
      return;
    }

    try {
      $('momentPublish').textContent = '发表中...';
      $('momentPublish').disabled = true;

      // 可以选择以某个角色的身份发
      const identity = $('momentComposerIdentity')
        ? $('momentComposerIdentity').value
        : 'me';

      const isUser = identity === 'me';
      const user = getDisplayUser();

      const payload = {
        content: text || '分享图片',
        images: composerImage ? [composerImage] : []
      };

      if (isUser) {
        payload.author_type = 'user';
        payload.author_name = user.name;
        payload.author_avatar = user.avatar;
      } else {
        payload.author_type = 'character';
        payload.character_id = Number(identity);
      }

      const response = await fetch('/api/moments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '发表失败');
      }

      closeSheets();
      await loadAll();
    } catch (error) {
      alert('发表失败：' + error.message);
    } finally {
      $('momentPublish').textContent = '发表';
      $('momentPublish').disabled = false;
    }
  });

  let feedLongPressTimer = null;

  $('momentsFeed').addEventListener('pointerdown', (event) => {
    const card = event.target.closest('.moment-card');
    if (!card || event.target.closest('.moment-dots')) return;

    feedLongPressTimer = setTimeout(() => {
      const moment = findMoment(card.dataset.momentId);
      if (moment) openActionSheet(moment);
    }, 650);
  });

  ['pointerup', 'pointercancel', 'pointermove'].forEach((name) => {
    $('momentsFeed').addEventListener(name, () => {
      clearTimeout(feedLongPressTimer);
    });
  });

  $('momentsFeed').addEventListener('click', (event) => {
    const dots = event.target.closest('[data-dots]');
    if (!dots) return;

    const moment = findMoment(dots.dataset.dots);
    if (moment) openSocialSheet(moment);
  });

  $('momentLikeBtn').addEventListener('click', async () => {
    if (!activeMoment) return;

    try {
      const response = await fetch(
        '/api/moments/' + activeMoment.id + '/like',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_name: '我' })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '点赞失败');
      }

      activeMoment.liked = data.liked;
      activeMoment.likes = data.likes;

      await loadAll();
      activeMoment = findMoment(activeMoment.id);
      updateSocialSheet();
    } catch (error) {
      alert('点赞失败：' + error.message);
    }
  });

  $('momentCommentSend').addEventListener('click', async () => {
    if (!activeMoment) return;

    const content = $('momentCommentInput').value.trim();
    if (!content) return;

    try {
      const response = await fetch(
        '/api/moments/' + activeMoment.id + '/comments',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            author_name: getDisplayUser().name,
            content
          })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '评论失败');
      }

      $('momentCommentInput').value = '';
      await loadAll();
      activeMoment = findMoment(activeMoment.id);
      updateSocialSheet();
    } catch (error) {
      alert('评论失败：' + error.message);
    }
  });

  $('momentAiCommentBtn').addEventListener('click', async () => {
    if (!activeMoment) return;

    const button = $('momentAiCommentBtn');
    const original = button.textContent;
    button.disabled = true;
    button.textContent = '角色正在评论…';

    try {
      const response = await fetch('/api/moments/' + activeMoment.id + '/comments/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 2 })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '生成失败');

      await loadAll();
      activeMoment = findMoment(activeMoment.id) || activeMoment;
      updateSocialSheet();

      if (data.skipped) alert(data.skipped);
    } catch (error) {
      alert('角色评论失败：' + error.message);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  });

  $('momentEditBtn').addEventListener('click', () => {
    if (!activeMoment) return;

    editingMoment = activeMoment;
    $('momentEditText').value = activeMoment.content || '';
    openSheet('momentEditSheet');
  });

  $('momentEditSave').addEventListener('click', async () => {
    if (!editingMoment) return;

    const content = $('momentEditText').value.trim();
    if (!content) return;

    try {
      const response = await fetch('/api/moments/' + editingMoment.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '保存失败');
      }

      closeSheets();
      await loadAll();
    } catch (error) {
      alert('保存失败：' + error.message);
    }
  });

  $('momentDeleteBtn').addEventListener('click', async () => {
    if (!activeMoment) return;
    if (!confirm('删除这条朋友圈？')) return;

    try {
      const response = await fetch('/api/moments/' + activeMoment.id, {
        method: 'DELETE'
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '删除失败');
      }

      closeSheets();
      await loadAll();
    } catch (error) {
      alert('删除失败：' + error.message);
    }
  });

  $('momentsUnreadBar').addEventListener('click', () => {
    markNoticesRead();
    renderNoticeList();
    openSheet('momentNoticeSheet');
  });

  $('momentNoticeList').addEventListener('click', (event) => {
    const row = event.target.closest('[data-notice-moment]');
    if (!row) return;

    const moment = findMoment(row.dataset.noticeMoment);
    closeSheets();

    if (moment) {
      setTimeout(() => openSocialSheet(moment), 150);
    }
  });

  document.querySelectorAll('[data-close-sheet]').forEach((button) => {
    button.addEventListener('click', closeSheets);
  });

  $('momentBackdrop').addEventListener('click', closeSheets);

  window.addEventListener('focus', loadAll);

  setInterval(() => {
    if (!document.hidden) loadAll();
  }, 60000);

  loadAll();
})();
