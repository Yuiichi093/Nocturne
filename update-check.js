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

  const noteMore = document.getElementById('updateNoteMore');
  let apkUrl = '';
  let fullNotes = '';
  let briefNotes = '';

  // GitHub 的 release 正文就是 CHANGELOG，一版一版堆得很长。
  // 这里只提炼「最新一版」的几行，剩下的折起来，别把设置页撑成一片灰字。
  function tidyLine(line) {
    return String(line)
      .replace(/^\s*#{1,6}\s*/, '')
      .replace(/^-\s+/, '· ')
      .replace(/\*\*/g, '')
      .trim();
  }

  function pickLatest(raw) {
    const text = String(raw || '').replace(/\r/g, '').trim();
    if (!text) return { brief: '', full: '' };

    const lines = text.split('\n');
    const firstHeading = lines.findIndex((line) => /^#{1,6}\s/.test(line));

    if (firstHeading < 0) {
      const brief = lines.map(tidyLine).filter(Boolean).slice(0, 6).join('\n');
      return { brief, full: lines.map(tidyLine).filter(Boolean).join('\n') };
    }

    const start = lines[firstHeading].startsWith('##') ? firstHeading + 1 : firstHeading;
    const section = [];

    for (let i = start; i < lines.length; i += 1) {
      if (/^##\s/.test(lines[i])) break;
      section.push(lines[i]);
    }

    const brief = section.map(tidyLine).filter(Boolean).slice(0, 5).join('\n');
    const full = lines.map(tidyLine).filter(Boolean).join('\n');

    return { brief, full };
  }

  function showNotes(raw) {
    const picked = pickLatest(raw);
    fullNotes = picked.full;
    briefNotes = picked.brief;
    noteText.textContent = picked.brief;
    noteText.classList.remove('expanded');

    if (noteMore) {
      const longEnough = picked.full.length > picked.brief.length + 40 || picked.brief.split('\n').length >= 5;
      noteMore.hidden = !longEnough;
      noteMore.textContent = '展开全部更新';
    }
  }

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
        if (notes) showNotes(notes);
        else noteText.textContent = '有新版本可以更新。';
        box.hidden = false;
        dlBtn.hidden = false;
        setStatus('发现新版本 ' + data.latest);
        dlBtn.textContent = apkUrl ? '下载 ' + data.latest + ' 安装包' : '去发布页看看';
        return;
      }
      setStatus('已经是最新版本了');
      dlBtn.hidden = true;
      if (notes) {
        showNotes(notes);
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

  if (noteMore) {
    noteMore.addEventListener('click', () => {
      const expanded = noteText.classList.toggle('expanded');
      noteText.textContent = expanded ? fullNotes : briefNotes;
      noteMore.textContent = expanded ? '收起' : '展开全部更新';
    });
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
