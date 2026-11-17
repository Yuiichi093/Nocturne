(function () {
  const content = document.querySelector('.home-content');
  if (!content) return;

  const profile = content.querySelector('[data-home-card="profile"]');
  const notifications = content.querySelector('[data-home-card="notifications"]');
  const memo = content.querySelector('[data-home-card="memo"]');
  const imageLayer = document.getElementById('homeImageLayer');
  const widgets = content.querySelector('.home-widgets');

  if (!profile || !notifications || !memo) return;

  let imagesKey = 'nocturne-home-images';
  let orderKey = 'nocturne-home-order';
  let activeWorldId = null;

  let images = [];
  let order = [];
  let addRatio = '1-1';
  let dragItem = null;
  let longPressTimer = null;
  let banner = null;
  let fileInput = null;
  let addBackdrop = null;
  let addSheet = null;

  images = [];
  order = [];

  const flow = document.createElement('div');
  flow.className = 'home-flow';
  content.appendChild(flow);

  if (imageLayer) imageLayer.remove();
  if (widgets) widgets.remove();

  profile.dataset.flowId = 'profile';
  notifications.dataset.flowId = 'notifications';
  memo.dataset.flowId = 'memo';

  function saveImages() {
    localStorage.setItem(imagesKey, JSON.stringify(images));
  }

  function saveOrder() {
    order = Array.from(flow.children)
      .map((el) => el.dataset.flowId)
      .filter(Boolean);

    localStorage.setItem(orderKey, JSON.stringify(order));
  }

  function normalizeOrder() {
    const ids = [
      'profile',
      ...images.map((img) => 'image:' + img.id),
      'notifications',
      'memo'
    ];

    order = order.filter((id) => ids.includes(id));

    ids.forEach((id) => {
      if (order.includes(id)) return;

      if (id.startsWith('image:')) {
        const index = order.indexOf('notifications');
        if (index >= 0) {
          order.splice(index, 0, id);
        } else {
          order.push(id);
        }
      } else {
        order.push(id);
      }
    });
  }

  function createImageElement(item) {
    const el = document.createElement('div');
    el.className =
      'home-flow-item home-flow-image ratio-' + (item.ratio || '1-1');
    el.dataset.flowId = 'image:' + item.id;

    const img = document.createElement('img');
    img.alt = '';
    img.src = item.url;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'home-flow-delete';
    deleteBtn.type = 'button';
    deleteBtn.dataset.deleteImage = item.id;
    deleteBtn.textContent = '×';

    el.appendChild(img);
    el.appendChild(deleteBtn);
    return el;
  }

  function render() {
    normalizeOrder();

    const map = new Map();
    map.set('profile', profile);
    map.set('notifications', notifications);
    map.set('memo', memo);

    images.forEach((item) => {
      let el = flow.querySelector(
        '[data-flow-id="image:' + item.id + '"]'
      );

      if (!el) {
        el = createImageElement(item);
      } else {
        el.className =
          'home-flow-item home-flow-image ratio-' + (item.ratio || '1-1');
        const img = el.querySelector('img');
        if (img) img.src = item.url;
      }

      map.set('image:' + item.id, el);
    });

    flow.innerHTML = '';

    order.forEach((id) => {
      const el = map.get(id);
      if (!el) return;
      el.classList.add('home-flow-item');
      flow.appendChild(el);
    });
  }

  function showBanner() {
    if (banner) return;

    banner = document.createElement('div');
    banner.className = 'layout-banner';
    banner.innerHTML = `
      <span>布局模式：拖动换顺序</span>
      <button id="flowAddImageBtn" type="button">添加图片</button>
      <button class="primary" id="flowDoneBtn" type="button">完成</button>
    `;

    document.body.appendChild(banner);

    banner.querySelector('#flowAddImageBtn').addEventListener('click', openAddSheet);
    banner.querySelector('#flowDoneBtn').addEventListener('click', exitLayout);
  }

  function hideBanner() {
    if (banner) {
      banner.remove();
      banner = null;
    }
  }

  function enterLayout() {
    document.body.classList.add('layout-mode');
    showBanner();
  }

  function exitLayout() {
    document.body.classList.remove('layout-mode');
    hideBanner();
    saveOrder();
  }

  function startDrag(item, event) {
    dragItem = item;
    item.classList.add('dragging');
    item.style.pointerEvents = 'none';
    event.preventDefault();
  }

  flow.addEventListener('pointerdown', (event) => {
    const item = event.target.closest('.home-flow-item');
    if (!item) return;
    if (event.target.closest('input, button, a, label, [contenteditable]')) return;

    if (document.body.classList.contains('layout-mode')) {
      startDrag(item, event);
      return;
    }

    longPressTimer = setTimeout(() => {
      enterLayout();
      startDrag(item, event);
    }, 600);
  });

  ['pointerup', 'pointercancel', 'pointermove'].forEach((name) => {
    flow.addEventListener(name, () => {
      if (!document.body.classList.contains('layout-mode')) {
        clearTimeout(longPressTimer);
      }
    });
  });

  window.addEventListener('pointermove', (event) => {
    if (!dragItem) return;

    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target) return;

    const targetItem = target.closest('.home-flow-item');
    if (!targetItem || targetItem === dragItem) return;

    const rect = targetItem.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;

    flow.insertBefore(
      dragItem,
      before ? targetItem : targetItem.nextSibling
    );

    event.preventDefault();
  }, { passive: false });

  window.addEventListener('pointerup', () => {
    if (!dragItem) return;
    dragItem.classList.remove('dragging');
    dragItem.style.pointerEvents = '';
    dragItem = null;
    saveOrder();
  });

  window.addEventListener('pointercancel', () => {
    if (!dragItem) return;
    dragItem.classList.remove('dragging');
    dragItem.style.pointerEvents = '';
    dragItem = null;
    saveOrder();
  });

  flow.addEventListener('click', (event) => {
    const button = event.target.closest('[data-delete-image]');
    if (!button) return;

    event.stopPropagation();

    if (!confirm('删除这张图片？')) return;

    const id = 'image:' + button.dataset.deleteImage;
    images = images.filter((item) => 'image:' + item.id !== id);
    order = order.filter((item) => item !== id);
    saveImages();
    saveOrder();
    render();
  });

  async function uploadImage(file) {
    const formData = new FormData();
    formData.append('image', file, 'image.jpg');

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

  function aspectRatioFor(ratio) {
    if (ratio === '2-1') return 2;
    if (ratio === '1-2') return 1 / 2;
    return 1;
  }

  function addImage(url, ratio) {
    const id = Date.now() + '-' + Math.random().toString(16).slice(2);

    images.push({ id, url, ratio });

    const index = order.indexOf('notifications');
    const imageId = 'image:' + id;

    if (index >= 0) {
      order.splice(index, 0, imageId);
    } else {
      order.push(imageId);
    }

    saveImages();
    saveOrder();
    render();
  }

  function ensureFileInput() {
    if (fileInput) return;

    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.hidden = true;
    document.body.appendChild(fileInput);

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;

      try {
        const cropped = await window.openImageCropper(
          file,
          aspectRatioFor(addRatio)
        );
        const url = await uploadImage(cropped);
        addImage(url, addRatio);
        closeAddSheet();
      } catch (error) {
        alert('上传失败：' + error.message);
      }

      fileInput.value = '';
    });
  }

  function ensureAddSheet() {
    if (addSheet) return;

    addBackdrop = document.createElement('div');
    addBackdrop.className = 'home-bg-sheet-backdrop';

    addSheet = document.createElement('div');
    addSheet.className = 'home-bg-sheet';
    addSheet.innerHTML = `
      <div class="home-bg-sheet-handle"></div>
      <h2>添加图片</h2>
      <label>比例</label>
      <div class="home-image-ratio-list">
        <button data-add-ratio="1-2" type="button">竖版 1:2</button>
        <button data-add-ratio="2-1" type="button">横版 2:1</button>
        <button data-add-ratio="2-2" type="button">方形 2:2</button>
        <button data-add-ratio="1-1" class="active" type="button">方形 1:1</button>
      </div>
      <div class="home-bg-sheet-actions">
        <button id="homeFlowAddPick" type="button">选择图片并裁剪</button>
        <button class="ghost" id="homeFlowAddCancel" type="button">取消</button>
      </div>
    `;

    document.body.appendChild(addBackdrop);
    document.body.appendChild(addSheet);

    addBackdrop.addEventListener('click', closeAddSheet);
    addSheet.querySelector('#homeFlowAddCancel').addEventListener('click', closeAddSheet);

    addSheet.querySelectorAll('[data-add-ratio]').forEach((button) => {
      button.addEventListener('click', () => {
        addRatio = button.dataset.addRatio;
        addSheet.querySelectorAll('[data-add-ratio]').forEach((item) => {
          item.classList.toggle('active', item === button);
        });
      });
    });

    addSheet.querySelector('#homeFlowAddPick').addEventListener('click', () => {
      ensureFileInput();
      fileInput.click();
    });
  }

  function openAddSheet() {
    ensureAddSheet();
    addBackdrop.classList.add('open');
    addSheet.classList.add('open');
  }

  function closeAddSheet() {
    if (!addBackdrop) return;
    addBackdrop.classList.remove('open');
    addSheet.classList.remove('open');
  }

  async function initHomeFlow() {
    try {
      const response = await fetch('/api/worlds/active');
      const world = await response.json();
      activeWorldId = response.ok ? world.id : 'default';
    } catch (e) {
      activeWorldId = 'default';
    }

    imagesKey = 'nocturne-home-' + activeWorldId + '-images';
    orderKey = 'nocturne-home-' + activeWorldId + '-order';

    // 第一次升级时，把旧的全局首页数据迁移到当前世界
    const oldImages = localStorage.getItem('nocturne-home-images');
    const oldOrder = localStorage.getItem('nocturne-home-order');

    if (!localStorage.getItem(imagesKey) && oldImages) {
      localStorage.setItem(imagesKey, oldImages);
    }

    if (!localStorage.getItem(orderKey) && oldOrder) {
      localStorage.setItem(orderKey, oldOrder);
    }

    try {
      images = JSON.parse(localStorage.getItem(imagesKey) || '[]');
    } catch (e) {
      images = [];
    }

    try {
      order = JSON.parse(localStorage.getItem(orderKey) || '[]');
    } catch (e) {
      order = [];
    }

    render();
  }

  initHomeFlow();
})();
