(function () {
  'use strict';

  // 首页「自定义白框」：内容 + 对齐存 /api/settings/ui（home_note / home_note_align）。
  // 它同时是 home-flow 的一个条目（data-home-card="note"），长按进布局模式，
  // 布局模式里的 × 会派发 home-note-delete 事件到这里清空内容。

  const api = window.__nocturneUiSettings;

  const card = document.getElementById('homeNoteCard');
  if (!card || !api) return;

  const view = document.getElementById('homeNoteView');
  const textEl = document.getElementById('homeNoteText');
  const hint = document.getElementById('homeNoteHint');
  const editor = document.getElementById('homeNoteEdit');
  const input = document.getElementById('homeNoteInput');
  const saveBtn = document.getElementById('homeNoteSave');
  const cancelBtn = document.getElementById('homeNoteCancel');

  let note = '';
  let align = 'left';
  let saving = false;

  function inLayoutMode() {
    return document.body.classList.contains('layout-mode');
  }

  function render() {
    const hasNote = Boolean(note.trim());

    if (textEl) {
      textEl.textContent = note;
      textEl.style.textAlign = align;
    }

    if (view) view.hidden = !hasNote;
    if (hint) hint.hidden = hasNote;
    if (editor) editor.hidden = true;
    card.classList.toggle('has-note', hasNote);
  }

  function markAlign(next) {
    align = ['left', 'center', 'right'].indexOf(next) >= 0 ? next : 'left';

    card.querySelectorAll('[data-home-note-align]').forEach((button) => {
      button.classList.toggle('active', button.dataset.homeNoteAlign === align);
    });
  }

  function openEditor() {
    if (input) input.value = note;
    markAlign(align);

    if (view) view.hidden = true;
    if (hint) hint.hidden = true;
    if (editor) editor.hidden = false;
    if (input) input.focus();
  }

  function closeEditor() {
    render();
  }

  async function save() {
    if (saving) return;

    const nextNote = input ? input.value : '';
    const nextAlign = align;

    saving = true;
    if (saveBtn) saveBtn.disabled = true;

    try {
      const settings = await api.save({
        home_note: nextNote,
        home_note_align: nextAlign
      });

      note = settings.home_note || '';
      align = settings.home_note_align || 'left';
      render();
    } catch (error) {
      alert('保存失败：' + (error && error.message));
    } finally {
      saving = false;
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async function clearNote() {
    try {
      const settings = await api.save({ home_note: '' });
      note = settings.home_note || '';
      align = settings.home_note_align || align;
      render();
    } catch (error) {
      alert('删除失败：' + (error && error.message));
    }
  }

  // 点白框进编辑；布局模式里点它是在拖动排序，不要误开编辑框
  card.addEventListener('click', (event) => {
    if (inLayoutMode()) return;
    if (event.target.closest('button, textarea, input, a, label, [contenteditable]')) {
      return;
    }

    if (editor && !editor.hidden) return;

    openEditor();
  });

  card.querySelectorAll('[data-home-note-align]').forEach((button) => {
    button.addEventListener('click', () => {
      markAlign(button.dataset.homeNoteAlign);
    });
  });

  if (saveBtn) saveBtn.addEventListener('click', save);
  if (cancelBtn) cancelBtn.addEventListener('click', closeEditor);

  // 布局模式里的 × 由 home-flow.js 确认后派发过来
  card.addEventListener('home-note-delete', () => {
    if (!note.trim()) {
      render();
      return;
    }

    clearNote();
  });

  async function boot() {
    const settings = await api.load();
    note = settings.home_note || '';
    align = settings.home_note_align || 'left';
    render();
  }

  boot().catch((error) => {
    console.warn('首页白框读取失败：' + (error && error.message));
    render();
  });
})();
