// The open card. A card opens where it lies: its top-left corner stays put, the title stays where the eye already is, and
// the card unfolds across its neighbours. Nothing behind it moves.
window.Open = (function () {
  var K = Kinds.KINDS, W = World;
  var host, inner, scrim, openId = null, sourceEl = null, keyed = false;
  var motion = null, progress = null, generation = 0;
  var REST = '.o-meta, .o-note, .o-parts, .o-facts, .o-ledger, .o-row';
  var OLDER = '.o-signal:not(.is-latest)';

  function saySince(d, now) {
    var h = (now - d) / 36e5;
    if (h < 1) return Math.max(1, Math.round(h * 60)) + ' min ago';
    if (h < 24) return Math.round(h) + 'h ago';
    var days = Math.round(h / 24);
    return days === 1 ? 'Yesterday' : days + ' days ago';
  }

  function drawSignals(e, now) {
    var kind = K[e.kind];
    return '<ol class="o-signals">' + e.signals.map(function (s, i) {
      var r = Card.sayReason(kind, s);
      var latest = i === e.signals.length - 1;
      return '<li class="o-signal' + (latest ? ' is-latest' : '') + ' tone-' + r.tone + '"><span class="o-dot"></span>' +
        '<span class="o-text">' + Card.esc(r.text) + (s.note ? '<q>' + Card.esc(s.note) + '</q>' : '') + '</span>' +
        '<time>' + saySince(s.at, now) + '</time></li>';
    }).join('') + '</ol>';
  }

  function drawLedger(e) {
    var flows = Card.readWorkflows(e);
    if (e.task) {
      return '<div class="o-ledger"><button class="o-row" data-act="go"><span class="o-label">See it on Work</span><span class="o-says">' + (e.task.by === 'you' ? 'You took this on.' : Card.esc(e.task.by) + ' is working on it.') + ' The Task carries the same link.</span><kbd>G</kbd></button></div>';
    }
    var rows = flows.map(function (w, i) {
      return '<button class="o-row' + (i === 0 ? ' is-first' : '') + '" data-act="hand-to" data-i="' + i + '"><span class="o-label">' + Crew.face(w.name, { pose: 'idle', size: 22 }) + Card.esc(w.name) + '</span><span class="o-says">' + Card.esc(w.says) + '</span><kbd>' + (flows.length === 1 ? 'H' : i + 1) + '</kbd></button>';
    }).join('');
    return '<div class="o-ledger">' + rows +
      '<button class="o-row" data-act="take"><span class="o-label">' + Card.drawPerson('you', 22) + 'Take it on myself</span><span class="o-says">Creates a Task with no run.</span><kbd>T</kbd></button>' +
      '<button class="o-row o-row--quiet" data-act="dismiss"><span class="o-label">Dismiss</span><span class="o-says">Takes it off your Inbox. ' + Card.esc(K[e.kind].plugin.name) + ' is not told.</span><kbd>E</kbd></button>' +
      '</div>';
  }

  function drawOpen(e) {
    var now = App.state.now, kind = K[e.kind], f = e.fields;
    var status = kind.status && kind.status[f.state];
    var who = kind.person && W.PEOPLE[f[kind.person]];
    var id = Card.fill(kind.identifier, f), ctx = Card.fill(kind.context, f);
    return '<div class="o-head">' +
      '<div class="c-mark">' + Card.drawMark(kind.plugin) + '</div>' +
      '<h2 class="o-title">' + Card.esc(e.title) + '</h2>' +
      '<button class="icon-btn icon-btn--sm o-close" data-close title="Close (Esc)">' + Crew.icon('close', 13) + '</button>' +
      '<div class="o-meta"><span>' + Card.esc(kind.noun) + '</span>' + [id, ctx].filter(Boolean).map(function (x) { return '<i>·</i><span>' + Card.esc(x) + '</span>'; }).join('') + (who ? '<i>·</i><span>' + Card.esc(who.name) + '</span>' : '') + '</div>' +
      '</div>' +
      (e.signals.length ? '<section class="o-sec">' + drawSignals(e, now) + '</section>' : '') +
      '<div class="o-facts">' + (status ? '<span class="o-status">' + Card.drawShape(status, 15) + Card.esc(status.word) + '</span>' : '') + Card.drawFacts(kind, f) + '<button class="o-source" data-source>Open in ' + Card.esc(kind.plugin.name) + ' ' + Crew.icon('external', 12) + '</button></div>' +
      drawLedger(e);
  }

  function drawOpenPlaque(c) {
    var flows = K['hercule/cluster'].workflows.noticed;
    var head = c.task ? drawLedger(c) : null;
    return '<div class="o-head o-head--plaque">' +
      '<div class="c-mark">' + Crew.face('Hercule', { pose: 'idle', size: 24, look: App.HERCULE }) + '</div>' +
      '<h2 class="o-title">' + Card.esc(c.title) + '</h2>' +
      '<button class="icon-btn icon-btn--sm o-close" data-close title="Close (Esc)">' + Crew.icon('close', 13) + '</button>' +
      '<div class="o-meta"><span>Noticed by Hercule</span><i>·</i><span>' + Card.esc(c.figures) + '</span></div></div>' +
      '<p class="o-note">' + Card.esc(c.detail) + '</p>' +
      '<ol class="o-parts">' + c.parts.map(function (p) { return '<li>' + Card.drawMark(p.plugin, 15) + '<span>' + Card.esc(p.title) + '</span><small>' + Card.esc(p.fact) + '</small></li>'; }).join('') + '</ol>' +
      (head || '<div class="o-ledger">' + flows.map(function (w, i) {
        return '<button class="o-row' + (i === 0 ? ' is-first' : '') + '" data-act="hand-to" data-i="' + i + '"><span class="o-label">' + Crew.face(w.name, { pose: 'idle', size: 22 }) + Card.esc(w.name) + '</span><span class="o-says">' + Card.esc(w.says) + '</span><kbd>' + (i + 1) + '</kbd></button>';
      }).join('') +
      '<button class="o-row" data-act="take"><span class="o-label">' + Card.drawPerson('you', 22) + 'Take it on myself</span><span class="o-says">Creates a Task with no run.</span><kbd>T</kbd></button>' +
      '<button class="o-row o-row--quiet" data-act="dismiss"><span class="o-label">Back to Intake</span><span class="o-says">Hercule should not have raised this.</span><kbd>E</kbd></button></div>');
  }

  /** Fades the veil in. It starts from nothing, so it always arrives rather than cuts. */
  function showVeil() {
    scrim.hidden = false;
    void scrim.offsetWidth;
    scrim.classList.add('is-on');
  }

  /** Fades the veil out, and takes it away once it has gone. */
  function hideVeil() {
    if (Tray.isOpen()) return;
    scrim.classList.remove('is-on');
    var gone = function () { if (!scrim.classList.contains('is-on')) scrim.hidden = true; };
    if (Motion.isReduced()) gone(); else setTimeout(gone, 370);
  }

  /** Returns where the sheet starts: the part of the card that can be seen where it lies. */
  function readFrom(el) {
    var r = el.getBoundingClientRect();
    var shown = el._plan ? el._plan.show : r.height;
    return { left: r.left, top: r.top, width: r.width, height: Math.min(r.height, shown) };
  }

  /** Draws one frame of the sheet, at `t` from where the card lies (0) to where it stands open (1). */
  function drawFrame(t) {
    if (!motion) return;
    var f = motion.from, to = motion.to, u = 1 - t;
    var left = f.left + (to.left - f.left) * t, top = f.top + (to.top - f.top) * t;
    host.style.left = left + 'px';
    host.style.top = top + 'px';
    host.style.width = f.width + (to.width - f.width) * t + 'px';
    host.style.height = f.height + (to.height - f.height) * t + 'px';
    host.style.borderRadius = 12 + 4 * t + 'px';
    inner.style.transform = 'translate(' + (to.left - left) + 'px,' + (to.top - top) + 'px)';
    motion.parts.forEach(function (p) {
      p.el.style.transform = 'translate(' + p.dx * u + 'px,' + p.dy * u + 'px) scale(' + (1 + (p.scale - 1) * u) + ')';
    });
    // What is not the same object arrives once the title and the line have nearly landed, so nothing prints over them.
    if (!motion.closing && !motion.restShown && t > 0.8) {
      motion.restShown = true;
      [].forEach.call(inner.querySelectorAll(REST), function (el, i) {
        el.style.opacity = '';
        el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 240, delay: i * 18, fill: 'backwards', easing: 'cubic-bezier(.22,.9,.24,1)' });
      });
      [].forEach.call(inner.querySelectorAll(OLDER), function (el) {
        el.style.opacity = '';
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      });
    }
    // Near home the card itself comes back under the sheet, so the last frames dissolve into it rather than cut.
    if (motion.closing && t < 0.02 && !motion.isHome) {
      motion.isHome = true;
      restoreSource();
      host.style.transition = 'opacity 80ms linear';
      host.style.opacity = '0';
      if (motion.then) { var then = motion.then; motion.then = null; then(); }
    }
  }

  /** Puts the card back in its place at once, with no fade of its own. */
  function restoreSource() {
    if (!sourceEl) return;
    var el = sourceEl;
    el.style.transition = 'none';
    el.classList.remove('is-source');
    void el.offsetWidth;
    el.style.transition = '';
  }

  /** Opens a card where it lies. Its corner stays put, and the title and mark grow from where they are. */
  function show(id, anchor, byKeyboard) {
    var e = App.findEntity(id);
    if (!e) return;
    // Asked to open the card that is folding home: it turns round from where it is, keeping its speed.
    if (motion && motion.closing && motion.id === id && !motion.isHome) {
      motion.closing = false;
      motion.then = null;
      openId = id;
      App.state.open = id;
      host.classList.remove('is-closing');
      showVeil();
      progress.to(1, 'travel');
      [].forEach.call(inner.querySelectorAll(REST + ', ' + OLDER), function (el) { el.style.opacity = ''; el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' }); });
      motion.restShown = true;
      return;
    }
    if (openId || motion) finish();
    Pointer.setHover(null);
    Pointer.unpeek();
    if (App.els()[id]) Pointer.clearFresh(App.els()[id]);
    var plaque = e.kind === 'hercule/cluster';
    sourceEl = anchor || (plaque ? document.querySelector('.plaque[data-id="' + id + '"]') : App.els()[id]);
    openId = id;
    keyed = !!byKeyboard;
    var from = readFrom(sourceEl);
    var main = document.getElementById('main').getBoundingClientRect();
    host.className = 'open' + (plaque ? ' open--plaque' : ' paper-' + K[e.kind].paper);
    host.innerHTML = '<div class="open-in">' + (plaque ? drawOpenPlaque(e) : drawOpen(e)) + '</div>';
    inner = host.firstChild;
    host.hidden = false;
    host.style.cssText = 'left:0;top:0;width:auto;height:auto';
    var w = Math.min(Math.max(520, Math.round(from.width)), innerWidth - 32);
    inner.style.width = w + 'px';
    var h = inner.offsetHeight;
    var left = Math.max(main.left + 16, Math.min(from.left - 1, main.right - w - 16));
    var top = Math.max(main.top + 12, Math.min(from.top, innerHeight - h - 16));
    var to = { left: left, top: top, width: w, height: h };
    host.setAttribute('aria-label', K[e.kind].noun + ': ' + e.title);
    showVeil();
    sourceEl.classList.add('is-source');
    App.state.open = id;
    motion = { id: id, gen: ++generation, from: from, to: to, parts: [], closing: false, isHome: false, then: null };
    host.style.left = to.left + 'px';
    host.style.top = to.top + 'px';
    host.style.width = to.width + 'px';
    host.style.height = to.height + 'px';
    motion.parts = measureParts(sourceEl);
    // Focus goes to the sheet, not to a move: Enter must never start an agent by accident.
    host.tabIndex = -1;
    if (Motion.isReduced()) { drawFrame(1); host.focus({ preventScroll: true }); return; }
    drawFrame(0);
    // Each opening has its own spring. One left over from an earlier opening must never touch this sheet.
    var gen = motion.gen;
    progress = Motion.value(0, function (t) { if (motion && motion.gen === gen) drawFrame(t); });
    [].forEach.call(inner.querySelectorAll(REST + ', ' + OLDER), function (el) { el.style.opacity = '0'; });
    // The moves take no pointer until the sheet has stopped: the second click of a double click must never start an agent.
    host.classList.add('is-arming');
    setTimeout(function () { host.classList.remove('is-arming'); }, 420);
    progress.to(1, 'travel');
    host.focus({ preventScroll: true });
  }

  /** Returns the parts of the sheet that are the same objects as parts of the card: the title, the mark and the latest line. */
  function measureParts(source) {
    var parts = [];
    [['.c-title, .pl-title', '.o-title'], ['.c-mark, .pl-marks', '.c-mark'], ['.c-line', '.o-signal.is-latest']].forEach(function (pair) {
      var a = source.querySelector(pair[0]), b = inner.querySelector(pair[1]);
      if (!a || !b || !a.getClientRects().length) return;
      b.style.transform = '';
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      var scale = pair[1] === '.o-title' ? parseFloat(getComputedStyle(a).fontSize) / parseFloat(getComputedStyle(b).fontSize) : 1;
      b.style.transformOrigin = '0 0';
      parts.push({ el: b, dx: ra.left - rb.left, dy: ra.top - rb.top, scale: scale });
    });
    return parts;
  }

  /**
   * Moves the open card to another card without leaving the place: the sheet stays where it stands, the words change, and the
   * height follows. A walk through a stack keeps one place on the screen.
   */
  function walk(id) {
    var e = App.findEntity(id);
    if (!e || !openId) return;
    var plaque = e.kind === 'hercule/cluster';
    if (sourceEl) restoreSource();
    keyed = true;
    sourceEl = plaque ? document.querySelector('.plaque[data-id="' + id + '"]') : App.els()[id];
    sourceEl.classList.add('is-source');
    var down = readOrder(id) > readOrder(openId);
    openId = id;
    App.state.open = id;
    host.className = 'open' + (plaque ? ' open--plaque' : ' paper-' + K[e.kind].paper);
    inner.innerHTML = plaque ? drawOpenPlaque(e) : drawOpen(e);
    var h = inner.offsetHeight;
    motion.to.height = h;
    motion.from = readFrom(sourceEl);
    // A walk holds its place, unless a taller card would run off the window. The sheet's new size follows on a transition.
    motion.to.top = Math.max(document.getElementById('main').getBoundingClientRect().top + 12, Math.min(motion.to.top, innerHeight - h - 16));
    host.classList.add('is-walking');
    host.style.top = motion.to.top + 'px';
    host.style.height = h + 'px';
    host.setAttribute('aria-label', K[e.kind].noun + ': ' + e.title);
    motion.id = id;
    motion.parts = measureParts(sourceEl);
    Motion.animate(inner, [{ opacity: 0.2, transform: 'translateY(' + (down ? 8 : -8) + 'px)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.22,.9,.24,1)' });
    Landing.announce(Card.sayCard(e));
    host.focus({ preventScroll: true });
  }

  function readOrder(id) { var e = App.findEntity(id); return App.state.entities.indexOf(e); }

  /** Puts focus on the first move, for H when several workflows fit: the choice is shown, not made. */
  function focusFirstMove() {
    var first = host.querySelector('.o-row');
    if (first) first.focus({ preventScroll: true });
  }

  /** Ends whatever the sheet is doing, at once. */
  function finish() {
    host.hidden = true;
    host.style.opacity = '';
    host.style.transition = '';
    restoreSource();
    if (motion && motion.then) motion.then();
    motion = null;
    progress = null;
    openId = null;
    App.state.open = null;
  }

  /**
   * Folds the card back into its place. It is the opening played backwards, from wherever it is. `then` runs as the card
   * reaches home, so a move made from the open card plays on the card itself.
   */
  function hide(instant, then) {
    if (!openId) return;
    var src = sourceEl, id = openId, wasKeyed = keyed;
    openId = null;
    App.state.open = null;
    hideVeil();
    // The card may have left the page while the sheet was open. Then there is nowhere to fold to, and the sheet only fades.
    var hasHome = src && src.isConnected && src.getClientRects().length > 0;
    if (!hasHome && !instant && !Motion.isReduced()) {
      var fading = motion;
      host.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-out' }).finished.then(function () { if (motion === fading) finish(); if (then) then(); });
      refocus(src, id, wasKeyed);
      return;
    }
    if (instant || Motion.isReduced() || !progress) {
      if (motion) motion.then = then || null;
      finish();
      refocus(src, id, wasKeyed);
      return;
    }
    motion.closing = true;
    motion.then = then || null;
    // The card may have moved since the sheet opened, so it folds back to where the card lies now.
    if (src && src.isConnected) { motion.from = readFrom(src); motion.parts = measureParts(src); }
    host.classList.remove('is-walking');
    // Only the arrivals are cancelled, before the class is set, so the fade of the rest can run.
    host.getAnimations({ subtree: true }).forEach(function (a) { if (!(a instanceof CSSTransition)) a.cancel(); });
    void host.offsetWidth;
    host.classList.add('is-closing');
    var gen = motion.gen;
    progress.to(0, 'travel', function () { if (motion && motion.gen === gen) finish(); });
    refocus(src, id, wasKeyed);
  }

  /** Gives focus back to the card. The ring and the peek come back only for someone working by keyboard. */
  function refocus(src, id, wasKeyed) {
    if (src && src.isConnected && src.closest('#tray')) src.focus({ preventScroll: true });
    else if (wasKeyed && App.findEntity(id)) Keys.focus(id);
    else if (src && src.isConnected) Keys.focusQuietly(src);
  }

  /** Draws the open card again when something lands on it. */
  function refresh() {
    var e = openId && App.findEntity(openId);
    if (!e || e.kind === 'hercule/cluster') return;
    var top = inner.scrollTop;
    inner.innerHTML = drawOpen(e);
    inner.scrollTop = top;
    var h = inner.offsetHeight;
    motion.to.height = h;
    motion.to.top = Math.max(document.getElementById('main').getBoundingClientRect().top + 12, Math.min(motion.to.top, innerHeight - h - 16));
    host.style.top = motion.to.top + 'px';
    host.style.height = h + 'px';
    host.focus({ preventScroll: true });
  }

  function isFromTray() { return !!(sourceEl && sourceEl.closest && sourceEl.closest('#tray')); }

  function isOpen() { return !!openId; }
  function current() { return openId; }

  /** Runs a move from the open card: the card folds home first, and the move plays on the card where it lies. */
  function act(btn) {
    var id = openId;
    var e = App.findEntity(id);
    var a = btn.dataset.act;
    hide(false, function () {
      if (a === 'hand-to') Moves.hand(e, Card.readWorkflows(e)[Number(btn.dataset.i)]);
      else Moves.perform(a, id, btn);
    });
  }

  function start() {
    host = document.getElementById('open');
    scrim = document.getElementById('scrim');
    scrim.addEventListener('click', function () { if (openId && !host.classList.contains('is-arming')) hide(); });
    host.addEventListener('click', function (ev) {
      if (ev.target.closest('[data-close]')) { hide(); return; }
      var b = ev.target.closest('[data-act]');
      if (b) act(b);
    });
  }

  return { show: show, hide: hide, walk: walk, refresh: refresh, isFromTray: isFromTray, focusFirstMove: focusFirstMove, isOpen: isOpen, current: current, act: act, start: start };
})();
