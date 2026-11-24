(function () {
  if (!window.Cropper) {
    console.warn('Cropper 未加载');
    return;
  }

  const style = document.createElement('style');
  style.textContent = `
    .crop-backdrop {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 18px;
      background: rgba(0, 0, 0, .55);
    }

    .crop-backdrop.open { display: flex; }

    .crop-modal {
      width: min(100%, 360px);
      padding: 16px;
      border: 1px solid rgba(0, 0, 0, .1);
      border-radius: 26px;
      background: var(--bg, #f7f7f7);
      color: var(--ink, #111);
      box-shadow: 0 20px 60px rgba(0, 0, 0, .3);
    }

    .crop-modal h2 {
      margin: 0 0 12px;
      font-size: 16px;
      font-weight: 600;
    }

    .crop-stage {
      width: 100%;
      aspect-ratio: 1;
      overflow: hidden;
      border-radius: 20px;
      background: #111;
    }

    .crop-stage img {
      display: block;
      max-width: 100%;
    }

    .crop-actions {
      display: flex;
      gap: 8px;
      margin-top: 14px;
    }

    .crop-actions button {
      flex: 1;
      padding: 12px;
      border: 1px solid var(--ink, #111);
      border-radius: 15px;
      background: var(--ink, #111);
      color: var(--bg, #f7f7f7);
      font: inherit;
    }

    .crop-actions button.ghost {
      background: transparent;
      color: var(--ink, #111);
    }
  `;
  document.head.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'crop-backdrop';
  backdrop.innerHTML = `
    <div class="crop-modal">
      <h2>裁剪头像</h2>
      <div class="crop-stage">
        <img id="cropImage" alt="">
      </div>
      <div class="crop-actions">
        <button class="ghost" id="cropCancel" type="button">取消</button>
        <button id="cropConfirm" type="button">确定</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const image = backdrop.querySelector('#cropImage');
  let cropper = null;
  let currentUrlField = null;
  let objectUrl = null;

  function close() {
    backdrop.classList.remove('open');

    if (cropper) {
      cropper.destroy();
      cropper = null;
    }

    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }

    image.removeAttribute('src');
  }

  function open(file, urlFieldId) {
    currentUrlField = urlFieldId;

    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }

    objectUrl = URL.createObjectURL(file);
    backdrop.classList.add('open');

    image.onload = () => {
      if (cropper) cropper.destroy();

      cropper = new Cropper(image, {
        aspectRatio: 1,
        viewMode: 1,
        autoCropArea: 1,
        background: false,
        movable: true,
        zoomable: true,
        cropBoxResizable: false,
        cropBoxMovable: false,
        toggleDragModeOnDblclick: false
      });
    };

    image.src = objectUrl;
  }

  backdrop.querySelector('#cropCancel').addEventListener('click', close);

  backdrop.querySelector('#cropConfirm').addEventListener('click', () => {
    if (!cropper || !currentUrlField) return;

    const canvas = cropper.getCroppedCanvas({
      width: 512,
      height: 512
    });

    canvas.toBlob(async (blob) => {
      if (!blob) return;

      try {
        if (typeof window.uploadImage !== 'function') {
          throw new Error('uploadImage 不可用');
        }

        const url = await window.uploadImage(blob);
        document.getElementById(currentUrlField).value = url;
        close();
      } catch (error) {
        alert('上传失败：' + error.message);
      }
    }, 'image/jpeg', 0.92);
  });

  function replaceInput(inputId, urlFieldId) {
    const old = document.getElementById(inputId);
    if (!old) return;

    const clone = old.cloneNode(true);
    old.replaceWith(clone);

    clone.addEventListener('change', () => {
      const file = clone.files && clone.files[0];
      if (!file) return;

      open(file, urlFieldId);
      clone.value = '';
    });
  }

  replaceInput('pAvatarFile', 'pAvatar');
  replaceInput('cAvatarFile', 'cAvatar');
})();
