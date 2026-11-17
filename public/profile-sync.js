(function () {
  let currentProfile = {
    name: '你的名字',
    handle: '@your_handle',
    bio: '在这里写一句你的签名。',
    location: 'Saudade',
    avatar: '',
    bg: ''
  };

  function $(id) {
    return document.getElementById(id);
  }

  // 本地缓存：返回首页时先用上次的资料立即渲染，
  // 避免先闪一下“你的名字 / @your_handle”再被接口数据覆盖。
  // 每个世界各存一份，否则切世界回首页会先闪出上一个世界的名字和头像。
  function profileCacheKey() {
    const worldId = localStorage.getItem('nocturne-active-world-id');
    return 'nocturne-profile-cache-' + (worldId || 'default');
  }

  function readProfileCache() {
    try {
      const raw = localStorage.getItem(profileCacheKey());
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeProfileCache() {
    try {
      localStorage.setItem(profileCacheKey(), JSON.stringify(currentProfile));
    } catch (e) {}
  }


  function updateUI() {
    const name = $('profileName');
    const handle = $('profileHandle');
    const bio = $('profileBio');
    const location = $('profileLocation');
    const avatar = $('profileAvatar');
    const fallback = $('avatarFallback');

    if (name) name.textContent = currentProfile.name || '你的名字';
    if (handle) handle.textContent = currentProfile.handle || '@your_handle';
    if (bio) bio.textContent = currentProfile.bio || '在这里写一句你的签名。';
    if (location) location.textContent = currentProfile.location || 'Saudade';

    if (avatar && fallback) {
      if (currentProfile.avatar) {
        avatar.src = currentProfile.avatar;
        avatar.style.display = 'block';
        fallback.style.display = 'none';
      } else {
        avatar.style.display = 'none';
        fallback.style.display = 'grid';
        fallback.textContent = String(currentProfile.name || 'S').slice(0, 1);
      }
    }

    const inputs = {
      inputName: currentProfile.name || '',
      inputHandle: currentProfile.handle || '',
      inputBio: currentProfile.bio || '',
      inputLocation: currentProfile.location || ''
    };

    Object.keys(inputs).forEach((id) => {
      const el = $(id);
      if (el) el.value = inputs[id];
    });

    if (currentProfile.bg) {
      document.documentElement.style.setProperty(
        '--home-bg',
        'url("' + currentProfile.bg + '")'
      );
    } else {
      document.documentElement.style.removeProperty('--home-bg');
    }
  }

  async function loadProfile() {
    try {
      const response = await fetch('/api/profile');
      const data = await response.json();
      if (response.ok) {
        currentProfile = Object.assign(currentProfile, data);
        writeProfileCache();
      }
    } catch (e) {}

    updateUI();
  }

  async function saveProfile(payload) {
    const response = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '保存失败');
    currentProfile = Object.assign(currentProfile, data.profile);
    writeProfileCache();
    updateUI();
  }

  async function uploadImage(file, cropAspect) {
    let uploadFile = file;

    if (cropAspect !== null && typeof window.openImageCropper === 'function') {
      uploadFile = await window.openImageCropper(file, cropAspect);
    }

    const formData = new FormData();
    formData.append('image', uploadFile, 'image.jpg');

    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '上传失败');
    return data.url;
  }

  function bindProfileButtons() {
    const saveBtn = $('saveProfile');
    if (saveBtn) {
      const clone = saveBtn.cloneNode(true);
      saveBtn.replaceWith(clone);

      clone.addEventListener('click', async () => {
        const payload = {
          name: $('inputName') ? $('inputName').value.trim() : currentProfile.name,
          handle: $('inputHandle') ? $('inputHandle').value.trim() : currentProfile.handle,
          bio: $('inputBio') ? $('inputBio').value.trim() : currentProfile.bio,
          location: $('inputLocation') ? $('inputLocation').value.trim() : currentProfile.location,
          avatar: currentProfile.avatar,
          bg: currentProfile.bg
        };

        try {
          clone.textContent = '保存中...';
          await saveProfile(payload);
          clone.textContent = '已保存';
          setTimeout(() => { clone.textContent = '保存资料'; }, 1200);
        } catch (error) {
          alert('保存失败：' + error.message);
          clone.textContent = '保存资料';
        }
      });
    }

    const bgBtn = $('uploadBgBtn');
    const bgInput = $('bgInput');
    if (bgBtn && bgInput) {
      const newBtn = bgBtn.cloneNode(true);
      const newInput = bgInput.cloneNode(true);
      bgBtn.replaceWith(newBtn);
      bgInput.replaceWith(newInput);

      newBtn.addEventListener('click', () => newInput.click());

      newInput.addEventListener('change', async () => {
        const file = newInput.files && newInput.files[0];
        if (!file) return;

        try {
          const url = await uploadImage(file, null);
          await saveProfile(Object.assign({}, currentProfile, { bg: url }));
        } catch (error) {
          alert('上传背景失败：' + error.message);
        }

        newInput.value = '';
      });
    }

    const avatarBtn = $('uploadAvatarBtn');
    const avatarInput = $('avatarInput');
    if (avatarBtn && avatarInput) {
      const newBtn = avatarBtn.cloneNode(true);
      const newInput = avatarInput.cloneNode(true);
      avatarBtn.replaceWith(newBtn);
      avatarInput.replaceWith(newInput);

      newBtn.addEventListener('click', () => newInput.click());

      newInput.addEventListener('change', async () => {
        const file = newInput.files && newInput.files[0];
        if (!file) return;

        try {
          const url = await uploadImage(file, 1);
          await saveProfile(Object.assign({}, currentProfile, { avatar: url }));
        } catch (error) {
          alert('上传头像失败：' + error.message);
        }

        newInput.value = '';
      });
    }
  }

  function init() {
    bindProfileButtons();
    loadProfile();
  }

  // 关键：先用本地缓存同步渲染一次，页面一出现就是真实资料，
  // 不再有“先显示默认值、等一会儿才恢复”的闪烁。
  const cachedProfile = readProfileCache();
  if (cachedProfile) {
    currentProfile = Object.assign(currentProfile, cachedProfile);
  }
  updateUI();

  // 原来这里是 window load 之后再 setTimeout 500 毫秒才初始化，
  // 那半秒正是首页显示默认资料的时间。脚本在 body 末尾，DOM 已就绪，直接开始。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
