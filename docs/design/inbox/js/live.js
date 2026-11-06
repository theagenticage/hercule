// Signals arriving while you look. In the real app these come from the live connection; here a short script plays them.
window.Live = (function () {
  var W = World;
  var script = [
    { to: 'pr-6238', s: function () { return W.signal('commented', 0.02, 'omar-haddad', null, 'Should the retry wait for the gateway\'s own timeout?'); } },
    { to: 'pr-6266', s: function () { var x = W.signal('checksFailed', 0.01); x.state = 'failing'; return x; } },
    { to: 'mail-1', s: function () { return W.signal('replied', 0.01, 'felix-marsh', null, 'Thursday works for the depots.'); } },
    { to: 'pr-6204', s: function () { return W.signal('commented', 0.01, 'theo-brandt'); } },
    { to: 'ln-OPS-47', s: function () { return W.signal('moved', 0.01, null, 'Todo'); } },
    { to: 'se-1', s: function () { return W.signal('cameBack', 0.01); } },
    { arrive: function () { return { id: 'pr-6270', kind: 'github/pull-request', concern: 'reviewRequested', title: 'Show the delivery window on the order page', since: W.hoursAgo(0.02), fields: { number: 6270, repo: 'storefront-web', author: 'ines-carvalho', state: 'running', diff: [64, 8], files: 3 }, signals: [W.signal('reviewRequested', 0.02, 'ines-carvalho')], task: null, project: 'storefront-web' }; } },
  ];
  // Something Hercule notices later in the morning, once the plate has room for it.
  var LATER = { id: 'c-scanners', kind: 'hercule/cluster', title: 'Depot scanners drop off at night', why: 'Twelve reports, one firmware version', sources: ['slack', 'sentry'], figures: '12 reports · 3 depots', detail: 'Three depots report scanners going offline between two and four. Every report names the same firmware.', parts: [], since: W.hoursAgo(0.05), signals: [], fields: {}, concern: 'noticed' };
  var i = 0, timer = 0, noticedLater = false;

  /** Plays the next signal of the script. Returns false once the script has run out. */
  function next() {
    if (!App.state.isLive) return false;
    if (!noticedLater && App.state.mode === 'stacks' && App.state.clusters.length < 3) {
      noticedLater = true;
      App.state.clusters.push(Object.assign({}, LATER));
      App.reflowNoticed();
      // Hercule looks up over the edge. It is the only time he moves.
      var head = document.querySelector('.noticed .card-holder');
      if (head) Motion.knock(head, -130);
      Landing.announce('Hercule noticed: ' + LATER.title);
      return true;
    }
    var away = App.state.mode !== 'stacks' && App.state.mode !== 'zero';
    var step = script[i % script.length];
    i++;
    if (away && !step.arrive) return false;
    if (step.arrive) {
      var e = step.arrive();
      if (App.findEntity(e.id)) return false;
      // Something new while you are elsewhere: one small dot on the Inbox row, and nothing louder.
      if (away) { App.state.entities.push(e); Nav.setNew(true); Nav.setCount('inbox', App.countOverdue()); Landing.announce('New in your Inbox: ' + e.title); return true; }
      if (!App.arrive(e)) return true;
      Landing.settleArrival(App.els()[e.id]);
      return true;
    }
    var target = App.findEntity(step.to);
    if (!target || target.settled) return next();
    Landing.land(target, step.s());
    return true;
  }

  function loop() {
    timer = setTimeout(function () {
      if (!document.hidden && !Open.isOpen()) next();
      loop();
    }, 11000);
  }
  function start() {
    if (new URLSearchParams(location.search).get('live') === '0') return;
    timer = setTimeout(function () { next(); loop(); }, 7000);
  }
  return { start: start, next: next };
})();
