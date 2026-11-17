(async function () {
  const el = document.getElementById('worldName');
  if (!el) return;

  el.style.cursor = 'pointer';
  el.title = '切换世界观';

  try {
    const response = await fetch('/api/worlds/active');
    const world = await response.json();

    if (response.ok && world && world.name) {
      el.textContent = world.name + ' ›';
    }
  } catch (e) {}

  el.addEventListener('click', () => {
    location.href = '/worlds.html';
  });
})();
