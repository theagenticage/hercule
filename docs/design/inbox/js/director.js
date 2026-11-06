// The small dock for a reviewer: switch the theme, jump to a state, land a signal. It is not part of the product.
window.Director = (function () {
  var THEMES = [['whitehaven', 'Whitehaven'], ['styles', 'Styles'], ['orient-express', 'Orient Express'], ['nile', 'Nile'], ['end-house', 'End House'], ['blue-train', 'Blue Train']];
  function start() {
    var params = new URLSearchParams(location.search);
    if (params.get('dock') === '0') return;
    var dock = document.createElement('aside');
    dock.className = 'dock';
    dock.innerHTML =
      '<button class="dock-btn" data-signal title="Land a signal on a card (.)">Land a signal</button>' +
      '<select data-scene title="Jump to a state">' + Scenes.list.map(function (s) { return '<option value="' + s[0] + '">' + s[1] + '</option>'; }).join('') + '</select>' +
      '<select data-theme-pick title="Theme">' + THEMES.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('') + '</select>';
    document.body.appendChild(dock);
    var pick = dock.querySelector('[data-theme-pick]'), scene = dock.querySelector('[data-scene]');
    pick.value = document.documentElement.dataset.theme;
    scene.value = App.state.scene;
    pick.addEventListener('change', function () { document.documentElement.dataset.theme = pick.value; pick.blur(); });
    scene.addEventListener('change', function () { Scenes.play(scene.value); scene.blur(); });
    dock.querySelector('[data-signal]').addEventListener('click', function () { Live.next(); });
    document.addEventListener('keydown', function (ev) { if (ev.key === '.') Live.next(); });
  }
  return { start: start };
})();
