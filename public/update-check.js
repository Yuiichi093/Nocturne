// 设置页里的「检查更新」：问服务端 GitHub 上的最新版本，有新版就给下载按钮
(function () {
  const curEl = document.getElementById('currentVersion');
  const btn = document.getElementById('checkUpdateBtn');
  const status = document.getElementById('updateStatus');
  const box = document.getElementById('updateNoteBox');
  const noteText = document.getElementById('updateNoteText');
  const dlBtn = document.getElementById('downloadUpdateBtn');
  if (!curEl || !btn || !box) {
    return;
  }

  let apkUrl = '';

  function setStatus(text) {
    if (status) {
      status.textContent = text || '';
    }
  }

  async function check(manual) {
    btn.disabled = true;
    btn.textContent = '检查中…';
    setStatus('');
    try {
      const res = await fetch('/api/update' + (manual ? '?refresh=1&debug=1' : ''), {
        cache: 'no-store',
      });
      const data = await res.json();
      if (data.current) {
        curEl.textContent = data.current;
      }
      if (data.error) {
        // 手动检查时把服务端的具体原因也露出来，方便定位是 DNS、超时还是被挡
        setStatus(data.error + (data.detail ? '（' + data.detail.slice(0, 90) + '）' : ''));
        box.hidden = true;
        return;
      }
      apkUrl = data.apkUrl || '';
      const notes = (data.notes || '').trim();
      if (data.hasUpdate) {
        noteText.textContent = notes || '有新版本可以更新。';
        box.hidden = false;
        dlBtn.hidden = false;
        setStatus('发现新版本 ' + data.latest);
        dlBtn.textContent = apkUrl ? '下载 ' + data.latest + ' 安装包' : '去发布页看看';
        return;
      }
      setStatus('已经是最新版本了');
      dlBtn.hidden = true;
      if (notes) {
        noteText.textContent = notes;
        box.hidden = false;
      } else {
        box.hidden = true;
      }
    } catch (e) {
      setStatus('检查失败，网络可能不太通');
      box.hidden = true;
    } finally {
      btn.disabled = false;
      btn.textContent = '检查更新';
    }
  }

  btn.addEventListener('click', () => check(true));

  dlBtn.addEventListener('click', () => {
    if (!apkUrl) {
      window.open('https://github.com/Yuiichi093/Nocturne/releases', '_blank');
      return;
    }
    // 安卓壳里交给系统下载器，下载完点通知就能装
    if (window.NocturneAndroid && typeof window.NocturneAndroid.downloadApk === 'function') {
      window.NocturneAndroid.downloadApk(apkUrl);
      setStatus('已开始下载，装完在通知栏点一下');
      return;
    }
    window.open(apkUrl, '_blank');
  });

  check(false);
})();
