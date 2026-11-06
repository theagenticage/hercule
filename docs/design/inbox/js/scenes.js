// The states of the Inbox, each reachable by ?scene=. They exist so that every state can be opened and photographed.
window.Scenes = (function () {
  var W = World;
  var K = Kinds.KINDS;
  var ONLY = ['pr-6238', 'pr-6252', 'pr-6204', 'mail-1', 'pr-6195', 'ln-OPS-47', 'ln-SHOP-360', 'qs-1'];

  function morning() { return { name: 'morning', entities: W.buildEntities(), clusters: W.CLUSTERS.slice() }; }

  var defs = {
    morning: morning,
    light: function () {
      return { name: 'light', entities: W.buildEntities().filter(function (e) { return ONLY.indexOf(e.id) >= 0; }), clusters: W.CLUSTERS.slice(0, 1) };
    },
    volume: function () { return { name: 'volume', entities: W.buildVolume(), clusters: W.CLUSTERS.slice() }; },
    handed: function () {
      var s = morning();
      ['pr-6204', 'pr-6213', 'pr-6241'].forEach(function (id, i) {
        var e = s.entities.filter(function (x) { return x.id === id; })[0];
        e.task = { by: i === 1 ? 'you' : 'Agent review' };
      });
      return s;
    },
    edge: function () {
      var s = morning();
      var e = s.entities.filter(function (x) { return x.id === 'pr-6209'; })[0];
      e.title = 'Split the basket summary into smaller components so that the delivery estimate, the loyalty points and the multi-buy savings can each be tested on their own without mounting the whole checkout';
      var f = s.entities.filter(function (x) { return x.id === 'se-1'; })[0];
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
      s.notice = Crew.brand('github', 13) + ' <b>GitHub stopped answering 12 minutes ago.</b> Its cards may be out of date. <a data-reconnect>Reconnect</a>';
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

  var list = [['morning', 'A morning'], ['light', 'A light day'], ['volume', '300 cards'], ['handed', 'Some handed on'], ['edge', 'Long and huge'], ['loading', 'Loading'], ['offline', 'Offline'], ['error', 'GitHub failing'], ['zero', 'Inbox zero'], ['firstrun', 'First run']];

  /** Returns the rays of the sunrise behind the empty Inbox's numeral. */
  function drawRays() {
    var out = '', cx = 360, cy = 250, n = 41;
    for (var i = 0; i < n; i++) {
      var a = Math.PI * (i / (n - 1));
      var long = i % 2 === 0;
      var r0 = 96, r1 = long ? 232 : 176;
      var x0 = cx - Math.cos(a) * r0, y0 = cy - Math.sin(a) * r0, x1 = cx - Math.cos(a) * r1, y1 = cy - Math.sin(a) * r1;
      var d = Math.abs(i - (n - 1) / 2);
      out += '<line class="ray" style="--d:' + (d * 26) + 'ms" x1="' + x0.toFixed(1) + '" y1="' + y0.toFixed(1) + '" x2="' + x1.toFixed(1) + '" y2="' + y1.toFixed(1) + '"/>';
    }
    return out;
  }

  function drawZero(page) {
    var rest = App.state.entities;
    var handed = rest.filter(function (e) { return e.task && e.task.by !== 'you'; }).length;
    var mine = rest.filter(function (e) { return e.task && e.task.by === 'you'; }).length;
    var line = handed || mine
      ? [handed ? handed + ' with agents' : '', mine ? mine + ' with you' : ''].filter(Boolean).join(' · ') + '. Their Tasks are on Work.'
      : 'Hercule is watching. Anything that concerns you will land here.';
    page.innerHTML = '<div class="zero"><svg class="zero-sun" viewBox="0 0 720 262" aria-hidden="true">' + drawRays() + '<line class="ray-h" x1="60" y1="250.5" x2="660" y2="250.5"/></svg>' +
      '<div class="zero-n" aria-hidden="true">0</div><h2 class="zero-t">Nothing out there needs you.</h2><p class="zero-s">' + line + '</p></div>';
  }

  function showZero() {
    var entities = App.state.entities;
    App.load({ name: 'zero', entities: entities, clusters: [], mode: 'zero', draw: drawZero });
  }

  function drawFirstRun(page) {
    var sources = [['github', 'GitHub', 'Pull requests and reviews', null], ['linear', 'Linear', 'Issues assigned to you', 277], ['gmail', 'Gmail', 'Threads that ask something of you', 25]];
    var ghost = function (n, h) { var s = ''; for (var i = 0; i < n; i++) s += '<i class="fr-card" style="height:' + h + 'px"></i>'; return s; };
    page.innerHTML = '<div class="fr"><div class="fr-ghosts" aria-hidden="true">' +
      '<div><h3>To review</h3>' + ghost(3, 76) + '</div><div><h3>To answer</h3>' + ghost(2, 76) + '<h3 style="margin-top:18px">To finish</h3>' + ghost(1, 76) + '</div><div><h3>On the shelf</h3>' + ghost(4, 44) + '</div></div>' +
      '<div class="fr-panel"><div class="fr-logo">' + Crew.logo(44) + '</div><h2 class="fr-t">This is where the outside world reaches you.</h2>' +
      '<p class="fr-s">Connect what you work in. Pull requests, tickets and threads that concern you land here as cards, each with its history inside it.</p>' +
      '<div class="fr-list">' + sources.map(function (s) {
        return '<button class="fr-row">' + Card.drawMark({ name: s[1], mark: s[0], hue: s[3] }, 22) + '<span><b>' + s[1] + '</b><small>' + s[2] + '</small></span><span class="btn btn--sm">Connect</span></button>';
      }).join('') + '</div></div></div>';
  }

  /** Returns the card of something raised from Intake. */
  function raisedEntity(r) {
    var kinds = { sentry: 'sentry/issue', slack: 'slack/thread' };
    var kind = kinds[r.mark] || 'sentry/issue';
    if (kind === 'slack/thread') return { id: 'raised-' + r.id, kind: kind, concern: 'mentioned', title: r.title, since: W.hoursAgo(3), fields: { from: 'kofi-mensah', channel: r.ref, replies: r.n }, signals: [W.signal('mentioned', 3, 'kofi-mensah')], task: null, project: null };
    return { id: 'raised-' + r.id, kind: kind, concern: 'assigned', title: r.title, since: W.hoursAgo(1), fields: { key: r.ref, project: 'checkout-api', state: 'unresolved', events: r.n, users: 3 }, signals: [W.signal('assigned', 1)], task: null, project: 'checkout-api' };
  }

  function play(name) {
    App.load((defs[name] || defs.morning)());
    if (name === 'loading') Skeleton.run();
  }
  return { play: play, defs: defs, list: list, showZero: showZero, raisedEntity: raisedEntity };
})();
