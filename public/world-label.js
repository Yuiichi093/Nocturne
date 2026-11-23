// 首页左上角那行世界名：显示当前世界，点一下进世界观页。
//
// 血泪史：
//  1) 原来只给文字挂 click，行高十几像素，手指按下去经常按空，表现就是「点不开」。
//     现在整块都做成可点区域。
//  2) 原来先 await 拿世界名、拿到了才绑 click，那个请求一慢，这行名字整个会话都点不动。
//     现在先绑事件，名字晚点再填。
(function () {
  const el = document.getElementById('worldName');
  if (!el) return;

  el.style.cursor = 'pointer';
  el.style.display = 'inline-block';
  el.style.padding = '6px 10px 6px 0';
  el.style.margin = '-6px 0';
  el.title = '切换世界观';

  function openWorlds() {
    location.assign('/worlds.html');
  }

  el.addEventListener('click', openWorlds);

  fetch('/api/worlds/active')
    .then((response) => (response.ok ? response.json() : null))
    .then((world) => {
      if (world && world.name) {
        el.textContent = world.name + ' ›';
      }
    })
    .catch(() => {});
})();
