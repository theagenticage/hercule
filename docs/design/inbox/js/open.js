// The open card. A card opens where it lies: its top-left corner stays put, the title stays where the eye already is, and
// the card unfolds across its neighbours. Nothing behind it moves.
window.Open = (function () {
  var K = Kinds.KINDS, W = World;
  var host, inner, scrim, openId = null, sourceEl = null, keyed = false;
  var motion = null, progress = null, generation = 0;
  var REST = '.o-meta, .o-note, .o-parts, .o-facts, .o-places, .o-progress, .o-links, .o-ledger, .o-row';
  var OLDER = '.o-signal:not(.is-latest)';

  function saySince(d, now) {
    var h = (now - d) / 36e5;
    if (h < 1) return Math.max(1, Math.round(h * 60)) + ' min ago';
    if (h < 24) return Math.round(h) + 'h ago';
    var days = Math.round(h / 24);
    return days === 1 ? 'Yesterday' : days + ' days ago';
  }

  /**
   * Returns the timeline: what happened to this thing, with what happened to the things linked to it woven in, each with its logo,
   * so a ticket and its pull request read as one history.
   */
  function drawSignals(e, now) {
    var mine = e.signals.map(function (s) { return { s: s, e: e }; });
    var linked = [].concat.apply([], Relations.readConfirmed(e).filter(function (l) { return l.other; }).map(function (l) { return l.other.signals.map(function (s) { return { s: s, e: l.other }; }); }));
    var all = mine.concat(linked).sort(function (a, b) { return a.s.at - b.s.at; });
    var latest = all[all.length - 1];
    return '<ol class="o-signals">' + all.map(function (x) {
      var r = Card.sayReason(K[x.e.kind], x.s);
      var other = x.e !== e;
      return '<li class="o-signal' + (x === latest ? ' is-latest' : '') + (other ? ' is-linked' : '') + ' tone-' + r.tone + '">' + (other ? '<span class="o-from" title="' + Card.esc(x.e.title) + '">' + Card.drawMark(K[x.e.kind].plugin, 12) + '</span>' : '<span class="o-dot"></span>') +
        '<span class="o-text">' + Card.esc(r.text) + (other ? ' <small>' + Card.esc(Card.fill(K[x.e.kind].identifier, x.e.fields)) + '</small>' : '') + (x.s.note ? '<q>' + Card.esc(x.s.note) + '</q>' : '') + '</span>' +
        '<time>' + saySince(x.s.at, now) + '</time></li>';
    }).join('') + '</ol>';
  }

  /** Returns where a thing sits: every place above it, on every path, each once, with its level and how it stands. */
  function drawPlaces(e) {
    var above = Relations.readAncestors(e);
    if (!above.length) return '';
    return '<section class="o-sec o-links"><h3 class="o-h">Part of</h3><ul>' + above.map(function (p) {
      var kind = K[p.kind], status = kind.status && kind.status[p.fields.state];
      return '<li class="o-link"><button class="o-link-go" data-walk="' + p.id + '">' + Card.drawMark(kind.plugin, 14) + '<span class="o-link-t">' + Card.esc(p.title) + '</span><span class="o-link-s">' + Card.esc(kind.noun) + (status ? ' · ' + Card.esc(status.word) : '') + (p.fields.target ? ' · ' + Card.esc(p.fields.target) : '') + '</span></button></li>';
    }).join('') + '</ul></section>';
  }

  /** Returns how far along the source says this place is, when it says. */
  function drawReported(e) {
    if (!e.progress) return '';
    var p = e.progress;
    return '<div class="o-progress"><div class="b-progress" role="img" aria-label="' + p.done + ' of ' + p.total + ' done"><i style="width:' + Math.round((p.done / p.total) * 100) + '%"></i></div><span>' + p.done + ' of ' + p.total + ' done, as reported by ' + Card.esc(K[e.kind].plugin.name) + '</span></div>';
  }

  /** Returns one linked thing as a row. Who claims the link stays quiet until the row is reached for. */
  function drawLinkRow(l) {
    if (!l.other) return '<li class="o-link o-link--closed">' + Crew.icon('lock', 13) + '<span class="o-link-t">' + Card.esc(Relations.sayRestricted(l.claim)) + '</span><small class="o-claim">' + Card.esc(Relations.sayClaim(l.claim)) + '</small></li>';
    var kind = K[l.other.kind], status = kind.status && kind.status[l.other.fields.state];
    return '<li class="o-link"><button class="o-link-go" data-walk="' + l.other.id + '">' + Card.drawMark(kind.plugin, 14) + '<span class="o-link-t">' + Card.esc(l.other.title) + '</span>' +
      (status ? '<span class="o-link-s">' + Card.drawShape(status, 13) + Card.esc(status.word) + '</span>' : '') + '</button><small class="o-claim">' + Card.esc(Relations.sayClaim(l.claim)) + '</small>' +
      (l.claim.type === 'person' ? '<button class="o-unlink" data-unlink="' + l.otherId + '" title="Remove this link. The source is not told.">' + Crew.icon('close', 12) + '</button>' : '') + '</li>';
  }

  /** Returns what this thing links to, the hints found in text, and the way to link something by hand. */
  function drawLinks(e) {
    var firm = Relations.readConfirmed(e), hints = Relations.readHints(e);
    return '<section class="o-sec o-links"><h3 class="o-h">Linked</h3>' + (firm.length ? '<ul>' + firm.map(drawLinkRow).join('') + '</ul>' : '') +
      (hints.length ? '<ul class="o-hints">' + hints.map(function (h) {
        return '<li class="o-link o-link--hint"><span class="o-link-go">' + Crew.icon('link', 13) + '<span class="o-link-t">' + Card.esc(h.other.title) + '</span></span><small class="o-why">' + Card.esc(Relations.sayClaim(h.claim)) + '</small><button class="btn btn--sm" data-confirm="' + h.otherId + '">Link</button></li>';
      }).join('') + '</ul>' : '') +
      '<div class="o-add"><input class="o-find" data-find placeholder="Link something: search by title or number" aria-label="Link something"><ul class="o-found" data-found hidden></ul></div></section>';
  }

  /** Returns one thing that concerns the person, as a row of a place's details. */
  function drawYours(c) {
    var kind = K[c.kind], status = kind.status && kind.status[c.fields.state];
    return '<li class="o-link"><button class="o-link-go" data-walk="' + c.id + '">' + Card.drawMark(kind.plugin, 14) + '<span class="o-link-t">' + Card.esc(c.title) + '</span>' + (status ? '<span class="o-link-s">' + Card.drawShape(status, 13) + Card.esc(status.word) + '</span>' : '') + '</button></li>';
  }

  /** Returns the bigger picture under a place: the places inside it with how they stand, and under each what concerns the person. */
  function drawConcerns(e) {
    var inner = Relations.readChildPlaces(e), shown = {};
    var rows = inner.map(function (p) {
      var mine = Relations.readChildren(p);
      mine.forEach(function (c) { shown[c.id] = true; });
      var status = K[p.kind].status && K[p.kind].status[p.fields.state];
      return '<li class="o-inner"><button class="o-inner-go" data-walk="' + p.id + '"><span class="o-inner-t">' + Card.esc(p.title) + '</span>' + (status ? '<span class="o-link-s">' + Card.drawShape(status, 13) + Card.esc(status.word) + '</span>' : '') +
        (p.progress ? '<span class="o-inner-n">' + p.progress.done + ' of ' + p.progress.total + '</span>' : '') + (p.fields.target ? '<span class="o-inner-n">' + Card.esc(p.fields.target) + '</span>' : '') + '</button>' +
        (mine.length ? '<ul>' + mine.map(drawYours).join('') + '</ul>' : '') + '</li>';
    });
    var rest = Relations.readChildren(e).filter(function (c) { return !shown[c.id]; });
    if (!rows.length && !rest.length) return '';
    return '<section class="o-sec o-links"><h3 class="o-h">Yours here</h3><ul>' + rows.join('') + rest.map(drawYours).join('') + '</ul></section>';
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
      '<button class="o-row" data-act="take"><span class="o-label">' + Card.drawPerson('you', 22) + 'Take it</span><span class="o-says">You do it. No agent runs.</span><kbd>T</kbd></button>' +
      '<button class="o-row o-row--quiet" data-act="dismiss"><span class="o-label">Dismiss</span><span class="o-says">Takes it off your Inbox. ' + Card.esc(K[e.kind].plugin.name) + ' is not told.</span><kbd>E</kbd></button>' +
      '</div>';
  }

  function drawOpen(e) {
    var now = App.state.now, kind = K[e.kind], f = e.fields;
    var status = kind.status && kind.status[f.state];
    var who = kind.person && W.PEOPLE[f[kind.person]];
    var id = Card.fill(kind.identifier, f);
    var isPlace = !e.concern && kind.pace === 'context';
    return '<div class="o-head">' +
      '<div class="c-mark">' + Card.drawMark(kind.plugin) + '</div>' +
      '<h2 class="o-title">' + Card.esc(e.title) + '</h2>' +
      '<button class="icon-btn icon-btn--sm o-close" data-close title="Close (Esc)">' + Crew.icon('close', 13) + '</button>' +
      '<div class="o-meta"><span>' + Card.esc(kind.noun) + '</span>' + (id ? '<i>·</i><span>' + Card.esc(id) + '</span>' : '') + (who ? '<i>·</i><span>' + Card.esc(who.name) + '</span>' : '') + '</div>' +
      '</div>' +
      (e.about ? '<p class="o-note">' + Card.esc(e.about) + '</p>' : '') +
      '<div class="o-facts">' + (status ? '<span class="o-status">' + Card.drawShape(status, 15) + Card.esc(status.word) + '</span>' : '') + Card.drawFacts(kind, f) + '<button class="o-source" data-source>Open in ' + Card.esc(kind.plugin.name) + ' ' + Crew.icon('external', 12) + '</button></div>' +
      drawReported(e) +
      (e.signals.length ? '<section class="o-sec">' + drawSignals(e, now) + '</section>' : '') +
      (isPlace ? drawConcerns(e) : '') + drawPlaces(e) + (isPlace ? '' : drawLinks(e)) +
      (isPlace ? '' : drawLedger(e));
  }

  function drawOpenPlaque(c) {
    var flows = K['hercule/cluster'].workflows.noticed;
    var head = c.task ? drawLedger(c) : null;
    return '<div class="o-head o-head--plaque">' +
      '<div class="c-mark">' + Crew.face('Hercule', { pose: 'idle', size: 24 }) + '</div>' +
      '<h2 class="o-title">' + Card.esc(c.title) + '</h2>' +
      '<button class="icon-btn icon-btn--sm o-close" data-close title="Close (Esc)">' + Crew.icon('close', 13) + '</button>' +
      '<div class="o-meta"><span>Noticed by Hercule</span><i>·</i><span>' + Card.esc(c.figures) + '</span></div></div>' +
      '<p class="o-note">' + Card.esc(c.detail) + '</p>' +
      '<ol class="o-parts">' + c.parts.map(function (p) { return '<li>' + Card.drawMark(p.plugin, 15) + '<span>' + Card.esc(p.title) + '</span><small>' + Card.esc(p.fact) + '</small></li>'; }).join('') + '</ol>' +
      (head || '<div class="o-ledger">' + flows.map(function (w, i) {
        return '<button class="o-row' + (i === 0 ? ' is-first' : '') + '" data-act="hand-to" data-i="' + i + '"><span class="o-label">' + Crew.face(w.name, { pose: 'idle', size: 22 }) + Card.esc(w.name) + '</span><span class="o-says">' + Card.esc(w.says) + '</span><kbd>' + (i + 1) + '</kbd></button>';
      }).join('') +
      '<button class="o-row" data-act="take"><span class="o-label">' + Card.drawPerson('you', 22) + 'Take it</span><span class="o-says">You do it. No agent runs.</span><kbd>T</kbd></button>' +
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
    scrim.classList.remove('is-on');
    var gone = function () { if (!scrim.classList.contains('is-on')) scrim.hidden = true; };
    if (Motion.isReduced()) gone(); else setTimeout(gone, 370);
  }

  /** Returns where the sheet starts: the part of the card that can be seen where it lies. */
  function readFrom(el) {
    var r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
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
      if (p.waits) p.el.style.opacity = Math.max(0, Math.min(1, (t - 0.2) / 0.25));
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
    if (anchor && anchor.dataset.id) Pointer.clearFresh(anchor);
    var plaque = e.kind === 'hercule/cluster';
    sourceEl = anchor || document.querySelector('#page [data-id="' + id + '"]');
    openId = id;
    keyed = !!byKeyboard;
    var from = readFrom(sourceEl);
    var main = document.getElementById('main').getBoundingClientRect();
    host.className = 'open' + (plaque ? ' open--plaque' : '');
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
    [['.c-title, .pl-title, .p-title, .b-title', '.o-title'], ['.c-mark, .pl-marks, .p-mark, .b-mark', '.c-mark'], ['.c-context, .c-under', '.o-signal.is-latest']].forEach(function (pair) {
      var a = source.querySelector(pair[0]), b = inner.querySelector(pair[1]);
      if (!a || !b || !a.getClientRects().length) return;
      b.style.transform = '';
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      var scale = pair[1] === '.o-title' ? parseFloat(getComputedStyle(a).fontSize) / parseFloat(getComputedStyle(b).fontSize) : 1;
      b.style.transformOrigin = '0 0';
      parts.push({ el: b, dx: ra.left - rb.left, dy: ra.top - rb.top, scale: scale });
    });
    // A title that wraps in the sheet starts over the line under it, so that line waits until the title has made room.
    var title = source.querySelector('.c-title, .pl-title, .p-title, .b-title'), sheetTitle = inner.querySelector('.o-title');
    if (title && sheetTitle && sheetTitle.offsetHeight > title.offsetHeight * 1.4) parts.filter(function (p) { return p.el.classList.contains('o-signal'); }).forEach(function (p) { p.waits = true; });
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
    sourceEl = document.querySelector('#page [data-id="' + id + '"]');
    if (sourceEl) sourceEl.classList.add('is-source');
    var down = readOrder(id) > readOrder(openId);
    openId = id;
    App.state.open = id;
    host.className = 'open' + (plaque ? ' open--plaque' : '');
    inner.innerHTML = plaque ? drawOpenPlaque(e) : drawOpen(e);
    var h = inner.offsetHeight;
    motion.to.height = h;
    if (sourceEl) motion.from = readFrom(sourceEl);
    // A walk holds its place, unless a taller card would run off the window. The sheet's new size follows on a transition.
    motion.to.top = Math.max(document.getElementById('main').getBoundingClientRect().top + 12, Math.min(motion.to.top, innerHeight - h - 16));
    host.classList.add('is-walking');
    host.style.top = motion.to.top + 'px';
    host.style.height = h + 'px';
    host.setAttribute('aria-label', K[e.kind].noun + ': ' + e.title);
    motion.id = id;
    motion.parts = sourceEl ? measureParts(sourceEl) : [];
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
    if (wasKeyed && App.findEntity(id)) Keys.focus(id);
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

  /** Lists what a person might link this card to, as they type. Anything already linked is left out. */
  function drawFound(input) {
    var words = input.value.trim().toLowerCase(), list = host.querySelector('[data-found]');
    var e = App.findEntity(openId);
    var linked = Relations.readLinks(e).map(function (l) { return l.otherId; });
    var found = !words ? [] : App.state.entities.filter(function (x) {
      return x !== e && linked.indexOf(x.id) < 0 && (x.title + ' ' + Card.fill(K[x.kind].identifier, x.fields)).toLowerCase().indexOf(words) >= 0;
    }).slice(0, 5);
    list.hidden = !found.length;
    list.innerHTML = found.map(function (x) {
      return '<li><button class="o-link-go" data-pick="' + x.id + '">' + Card.drawMark(K[x.kind].plugin, 14) + '<span class="o-link-t">' + Card.esc(x.title) + '</span><small>' + Card.esc(Card.fill(K[x.kind].identifier, x.fields)) + '</small></button></li>';
    }).join('');
  }

  function start() {
    host = document.getElementById('open');
    scrim = document.getElementById('scrim');
    scrim.addEventListener('click', function () { if (openId && !host.classList.contains('is-arming')) hide(); });
    host.addEventListener('click', function (ev) {
      if (ev.target.closest('[data-close]')) { hide(); return; }
      var to = ev.target.closest('[data-walk]');
      if (to) { walk(to.dataset.walk); return; }
      var e = App.findEntity(openId);
      var yes = ev.target.closest('[data-confirm], [data-pick]');
      if (yes) { Moves.link(e, App.findEntity(yes.dataset.confirm || yes.dataset.pick)); return; }
      var off = ev.target.closest('[data-unlink]');
      if (off) { Moves.unlink(e, off.dataset.unlink); return; }
      var b = ev.target.closest('[data-act]');
      if (b) act(b);
    });
    host.addEventListener('input', function (ev) { if (ev.target.matches('[data-find]')) drawFound(ev.target); });
  }

  return { show: show, hide: hide, walk: walk, refresh: refresh, focusFirstMove: focusFirstMove, isOpen: isOpen, current: current, act: act, start: start };
})();
