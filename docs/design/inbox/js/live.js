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
  var i = 0, timer = 0;

  /** Plays the next signal of the script. Returns false once the script has run out. */
  function next() {
    if (App.state.mode !== 'stacks' || App.state.scene !== 'morning') return false;
    var step = script[i % script.length];
    i++;
    if (step.arrive) {
      var e = step.arrive();
      if (App.findEntity(e.id)) return next();
      App.state.entities.push(e);
      App.layOut();
      var el = App.els()[e.id];
      if (el) {
        el.classList.remove('is-new');
        Motion.body(el).set({ y: 18, o: 0 }).to({ y: 0, o: 1 }, 'drop');
      }
      return true;
    }
    var target = App.findEntity(step.to);
    if (!target || target.leaving || target.settled) return next();
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
