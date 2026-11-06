// The states of the Inbox, each reachable by ?scene=. They exist so that every state can be opened and photographed.
window.Scenes = (function () {
  var W = World;
  var K = Kinds.KINDS;
  var ONLY = ['ln-SHOP-371', 'pr-6238', 'se-1', 'pr-6252', 'pr-6204', 'mail-1', 'ln-OPS-47', 'ln-SHOP-360', 'qs-1'];

  /** Returns fresh copies of what Hercule noticed, so a scene never inherits moves from the last one. */
  function readClusters() { return W.CLUSTERS.map(function (c) { return Object.assign({}, c); }); }

  function morning() { return { name: 'morning', entities: W.buildEntities(), clusters: readClusters() }; }

  var defs = {
    morning: morning,
    light: function () {
      return { name: 'light', entities: W.buildEntities().filter(function (e) { return ONLY.indexOf(e.id) >= 0; }), clusters: readClusters().slice(0, 1) };
    },
    volume: function () { return { name: 'volume', entities: W.buildVolume(), clusters: readClusters() }; },
    handed: function () {
      var s = morning();
      ['ln-OPS-44', 'pr-6209', 'ln-SHOP-342'].forEach(function (id, i) {
        var e = s.entities.filter(function (x) { return x.id === id; })[0];
        e.task = { by: i === 1 ? 'you' : 'Agent review' };
      });
      return s;
    },
    edge: function () {
      var s = morning();
      var e = s.entities.filter(function (x) { return x.id === 'pr-6209'; })[0];
      e.title = 'Split the basket summary into smaller components so that the delivery estimate, the loyalty points and the multi-buy savings can each be tested on their own without mounting the whole checkout';
      var f = s.entities.filter(function (x) { return x.id === 'se-2'; })[0];
      f.fields.events = 1284093;
      f.fields.users = 48211;
      return s;
    },
    offline: function () {
      var s = morning();
      s.name = 'offline';
      s.notice = '<span class="notice-dot"></span><b>Offline.</b> What you see is from 08:12. Nothing is lost; moves wait until you are back.';
      return s;
    },
    error: function () {
      var s = morning();
      s.name = 'error';
      var failing = K[W.FAILING_KIND].plugin;
      s.notice = Card.drawMark(failing, 13) + ' <b>' + failing.name + ' stopped answering 12 minutes ago.</b> Its cards may be out of date. <button class="ib-fix" data-reconnect>Reconnect</button>';
      return s;
    },
  };

  defs.zero = function () { return { name: 'zero', entities: [], clusters: [], mode: 'zero', draw: drawZero }; };
  defs.firstrun = function () { return { name: 'firstrun', entities: [], clusters: [], mode: 'firstrun', draw: drawFirstRun }; };
  defs.loading = function () {
    var s = morning();
    s.name = 'loading';
    return s;
  };

  var list = [['morning', 'A morning'], ['light', 'A light day'], ['volume', '300 cards'], ['handed', 'Some handed on'], ['edge', 'Long and huge'], ['loading', 'Loading'], ['offline', 'Offline'], ['error', 'A failing source'], ['zero', 'Inbox zero'], ['firstrun', 'First run']];

  /** Returns the rays of the sunrise behind the empty Inbox's numeral. */
  function drawRays() {
    var out = '', cx = 360, cy = 250, n = 31;
    for (var i = 0; i < n; i++) {
      var a = Math.PI * (i / (n - 1));
      var long = i % 2 === 0;
      var r0 = 136, r1 = long ? 236 : 192;
      var x0 = cx - Math.cos(a) * r0, y0 = cy - Math.sin(a) * r0, x1 = cx - Math.cos(a) * r1, y1 = cy - Math.sin(a) * r1;
      var d = Math.abs(i - (n - 1) / 2);
      out += '<line class="ray" pathLength="1" style="--d:' + (d * 26) + 'ms" x1="' + x0.toFixed(1) + '" y1="' + y0.toFixed(1) + '" x2="' + x1.toFixed(1) + '" y2="' + y1.toFixed(1) + '"/>';
    }
    return out;
  }

  /** Returns the sunrise and the words under it, saying where the things that left have gone. */
  function drawSunrise(className) {
    var rest = App.state.entities;
    var handed = rest.filter(function (e) { return e.task && e.task.by !== 'you'; }).length;
    var mine = rest.filter(function (e) { return e.task && e.task.by === 'you'; }).length;
    var line = handed || mine
      ? [handed ? handed + ' with agents' : '', mine ? mine + ' with you' : ''].filter(Boolean).join(' · ') + '. Their Tasks are on Work.'
      : 'Anything from outside that concerns you will land here.';
    var small = className.indexOf('small') >= 0;
    if (small) return '<div class="' + className + '"><svg class="zero-sun" viewBox="0 0 720 262" aria-hidden="true">' + drawRays() + '<line class="ray-h" x1="60" y1="250" x2="660" y2="250"/></svg><div class="zero-n" aria-hidden="true">' + Crew.face('Hercule', { pose: 'idle', size: 52 }) + '</div><p class="zero-s">No requests left.</p></div>';
    return '<div class="' + className + '"><svg class="zero-sun" viewBox="0 0 720 262" aria-hidden="true">' + drawRays() + '<line class="ray-h" x1="60" y1="250" x2="660" y2="250"/></svg>' +
      '<div class="zero-n" aria-hidden="true">' + Crew.face('Hercule', { pose: 'idle', size: 96 }) + '</div><h2 class="zero-t">All clear.</h2><p class="zero-s">' + line + '</p></div>';
  }

  function drawZero(page) { page.innerHTML = drawSunrise('zero'); }

  /** Lets the page go quiet, then brings up the sunrise. */
  function showZero() {
    var page = document.getElementById('page');
    Motion.animate(page, [{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-out' }).then(function () {
      // An Undo during the fade brought a card back, so the page stays.
      if (App.countLeft()) return;
      App.load({ name: 'zero', entities: App.state.entities, clusters: [], mode: 'zero', draw: drawZero });
      Landing.announce('All clear. Nothing from outside needs you.');
      document.getElementById('main').focus({ preventScroll: true });
    });
  }

  /** Draws the first run on the page itself: the stacks stand ready, and each first card asks to be connected. */
  function drawFirstRun(page) {
    var connect = function (kind) {
      return '<button class="fr-card">' + Card.drawMark(kind.plugin, 20) + '<div><b>' + Card.esc(kind.plugin.name) + '</b><small>' + Card.esc(kind.connect) + '</small></div><span class="fr-go">Connect ' + Crew.icon('arrow', 12) + '</span></button>';
    };
    // Each kind asks to be connected on the side where its cards will lie.
    var offered = Object.keys(K).map(function (id) { return K[id]; }).filter(function (k) { return k.connect; });
    var ofShape = function (card) { return offered.filter(function (k) { return k.card === card; }).map(connect).join(''); };
    // On a first run nothing has happened yet, so the sidebar says so too.
    var waitingNow = document.querySelector('.side-scroll .side-sec');
    if (waitingNow) waitingNow.hidden = true;
    document.querySelector('.side-sum').textContent = 'Nothing running';
    page.innerHTML = '<div class="ib-wide"><div class="noticed"><span class="card-holder"><span class="card-head">' + Crew.peek('Hercule', { pose: 'idle', size: 30, crop: 34 }) + '</span></span><span class="card-paws" style="--hue:var(--hue-' + Crew.lookFor('Hercule').hue + ')"><i></i><i></i></span><i class="card-stock"></i>' +
      '<p class="fr-welcome">This is where the outside world reaches you.<small>Connect what you work in. What concerns you lands here as cards, each with its history inside it.</small></p></div>' +
      '<header class="sec"><h2>Ongoing</h2></header><div class="fr-grid">' + ofShape('rich') + '</div></div>' +
      '<aside class="ib-narrow"><header class="sec"><h2>Requests</h2></header><div class="fr-list">' + ofShape('compact') + '</div></aside>';
  }

  function play(name) {
    Nav.draw();
    Moves.reset();
    if (window.Pages && Pages.current() !== 'inbox') Pages.setView('inbox', true);
    Open.hide(true);
    Menu.hide();
    Toolbar.close();
    Keys.clear();
    App.load((defs[name] || defs.morning)());
    if (name === 'loading') Skeleton.run();
  }
  return { play: play, defs: defs, list: list, showZero: showZero, drawSunrise: drawSunrise };
})();
