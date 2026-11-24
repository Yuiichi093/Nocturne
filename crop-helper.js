(function () {
  if (!window.Cropper) {
    window.openImageCropper = async function (file) {
      return file;
    };
    return;
  }

  const style = document.createElement('style');
  style.textContent = `
    .crop-helper-backdrop {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 18px;
      background: rgba(0,0,0,.55);
    }

    .crop-helper-backdrop.open {
      display: flex;
    }

    .crop-helper-modal {
      width: min(100%, 380px);
      padding: 16px;
      border-radius: 26px;
      background: var(--bg, #f7f7f7);
      color: var(--ink, #111);
      box-shadow: 0 20px 60px rgba(0,0,0,.3);
    }

    .crop-helper-modal h2 {
      margin: 0 0 12px;
      font-size: 16px;
      font-weight: 600;
    }

    .crop-helper-stage {
      width: 100%;
      height: 320px;
      overflow: hidden;
      border-radius: 18px;
      background: #111;
    }

    .crop-helper-stage img {
      display: block;
      max-width: 100%;
    }

    .crop-helper-actions {
      display: flex;
      gap: 8px;
      margin-top: 14px;
    }

    .crop-helper-actions button {
      flex: 1;
      padding: 12px;
      border: 1px solid var(--ink, #111);
      border-radius: 15px;
      background: var(--ink, #111);
      color: var(--bg, #f7f7f7);
      font: inherit;
    }

    .crop-helper-actions button.ghost {
      background: transparent;
      color: var(--ink, #111);
    }
  `;
  document.head.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'crop-helper-backdrop';
  backdrop.innerHTML = `
    <div class="crop-helper-modal">
      <h2>裁剪图片</h2>
      <div class="crop-helper-stage">
        <img id="cropHelperImage" alt="">
      </div>
      <div class="crop-helper-actions">
        <button class="ghost" id="cropHelperCancel" type="button">取消</button>
        <button id="cropHelperConfirm" type="button">确定</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const image = backdrop.querySelector('#cropHelperImage');
  let cropper = null;
  let objectUrl = null;
  let resolvePromise = null;
  let rejectPromise = null;

  function cleanup() {
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

  function closeWith(result, error) {
    cleanup();

    if (error) {
      if (rejectPromise) rejectPromise(error);
    } else if (resolvePromise) {
      resolvePromise(result);
    }

    resolvePromise = null;
    rejectPromise = null;
  }

  backdrop.querySelector('#cropHelperCancel').addEventListener('click', () => {
    closeWith(null, new Error('已取消裁剪'));
  });

  backdrop.querySelector('#cropHelperConfirm').addEventListener('click', () => {
    if (!cropper) return;

    const canvas = cropper.getCroppedCanvas({
      maxWidth: 1600,
      maxHeight: 1600,
      imageSmoothingQuality: 'high'
    });

    canvas.toBlob((blob) => {
      if (!blob) {
        closeWith(null, new Error('裁剪失败'));
        return;
      }
      closeWith(blob, null);
    }, 'image/jpeg', 0.92);
  });

  window.openImageCropper = function (file, aspectRatio) {
    return new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;

      objectUrl = URL.createObjectURL(file);
      backdrop.classList.add('open');

      image.onload = () => {
        if (cropper) cropper.destroy();

        cropper = new Cropper(image, {
          aspectRatio: Number.isFinite(aspectRatio) ? aspectRatio : NaN,
          viewMode: 1,
          autoCropArea: 0.9,
          background: false,
          movable: true,
          zoomable: true,
          cropBoxMovable: true,
          cropBoxResizable: true,
          toggleDragModeOnDblclick: false
        });
      };

      image.src = objectUrl;
    });
  };
})();
