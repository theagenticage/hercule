// The small dock for a reviewer: switch the theme, jump to a state, land a signal. It is not part of the product.
window.Director = (function () {
  var THEMES = [['whitehaven', 'Whitehaven'], ['styles', 'Styles'], ['orient-express', 'Orient Express'], ['nile', 'Nile'], ['end-house', 'End House'], ['blue-train', 'Blue Train']];
  // What the story page's buttons can ask of a framed window.
  var SIGNALS = {
    partComment: ['pr-6238', function () { return World.signal('commented', 0.02, 'omar-haddad', null, 'Should the retry wait for the gateway?'); }],
    comment: ['pr-6213', function () { return World.signal('commented', 0.02, 'omar-haddad', null, 'Should the unit price round before tax?'); }],
    fail: ['pr-6266', function () { var s = World.signal('checksFailed', 0.01); s.state = 'failing'; return s; }],
    mail: ['mail-1', function () { return World.signal('replied', 0.01, 'felix-marsh', null, 'Thursday works for the depots.'); }],
  };
  function listen() {
    window.addEventListener('message', function (ev) {
      var m = ev.data || {};
      if (m.land) Landing.land(App.findEntity(SIGNALS[m.land][0]), SIGNALS[m.land][1]());
      if (m.hand) Moves.hand(App.findEntity(m.hand));
      if (m.take) Moves.take(App.findEntity(m.take));
      if (m.link) Moves.link(App.findEntity(m.link[0]), App.findEntity(m.link[1]));
      if (m.undo) Moves.undo();
    });
  }

  function start() {
    var params = new URLSearchParams(location.search);
    listen();
    if (params.get('open')) setTimeout(function () { Open.show(params.get('open')); }, 300);
    if (params.get('view')) Pages.setView(params.get('view'));
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
