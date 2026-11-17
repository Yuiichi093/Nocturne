(function () {
  function updateClock() {
    const clock = document.getElementById('clock');
    const date = document.getElementById('date');

    if (!clock || !date) return;

    const now = new Date();

    clock.textContent = now.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit'
    });

    date.textContent = now.toLocaleDateString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      weekday: 'short'
    });
  }

  updateClock();

  setInterval(updateClock, 1000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) updateClock();
  });
})();
