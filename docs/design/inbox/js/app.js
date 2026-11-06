// The Inbox: state, and drawing the page from it. Moves, keys, the open card and the scenes live in their own files
// and go through the methods here.
window.App = (function () {
  var K = Kinds.KINDS, W = World;
  var params = new URLSearchParams(location.search);

  var STACKS = {
    review: { title: 'To review', usual: 'reviewRequested', empty: 'Nobody is waiting for a review.' },
    answer: { title: 'To answer', usual: null, empty: 'Nothing to answer.' },
    finish: { title: 'To finish', usual: null, empty: 'Nothing of yours needs a move.' },
    shelf: { title: 'On the shelf', usual: 'assigned', empty: 'The shelf is clear.' },
  };
  // Three columns where they fit, then two, then one. At high zoom the window is small, and the stacks still share their depth.
  var LAYOUTS = { 3: [['review'], ['answer', 'finish'], ['shelf']], 2: [['review'], ['answer', 'finish', 'shelf']], 1: [['review', 'answer', 'finish', 'shelf']] };
  function readColumns() {
    var w = document.getElementById('main').clientWidth;
    return LAYOUTS[w >= 900 ? 3 : w >= 620 ? 2 : 1];
  }
  var COLUMNS = LAYOUTS[3];
  var HEAD = 42;       // a stack's heading, with the space under it
  var BETWEEN = 14;    // the space between two stacks of one column
  var FOOT = 26;       // the line under a stack that counts what settled

  var state = { scene: 'morning', now: W.NOW, entities: [], clusters: [], dim: null, open: null, page: 'inbox', offline: false, stale: null };
  var els = {};        // card elements by entity id
  var measured = {};   // whole heights by entity id, for the current width
  var page, hasDrawn = false;
  var waiting = [];    // new cards held back while the pointer is in their stack

  function readStack(e) { return K[e.kind].stacks[e.concern]; }
  function findEntity(id) { return state.entities.filter(function (e) { return e.id === id; })[0] || state.clusters.filter(function (c) { return c.id === id; })[0]; }
  function readCtx(name) { return { now: state.now, usual: STACKS[name].usual }; }

  /** Returns the entities of one stack that still lie in it, oldest first, with what settled apart. */
  function readStackEntities(name) {
    var list = state.entities.filter(function (e) { return readStack(e) === name; });
    var lying = list.filter(function (e) { return !e.settled; });
    if (name !== 'shelf') lying.sort(function (a, b) { return a.since - b.since; });
    return { lying: lying, settled: list.filter(function (e) { return e.settled; }) };
  }

  /** Replaces the members of each stream by one pile at the place of its oldest member. */
  function foldStreams(list) {
    var streams = {}, out = [];
    list.forEach(function (e) {
      if (!e.stream) { out.push(e); return; }
      if (!streams[e.stream]) { streams[e.stream] = { pile: true, id: 'stream-' + e.stream, title: e.stream, members: [], since: e.since, kind: e.kind, note: 'One stream of like things' }; out.push(streams[e.stream]); }
      streams[e.stream].members.push(e);
    });
    return out;
  }

  /** Returns one folded pile of a group: `members` are the entities it holds. */
  function buildPile(id, title, members, note) {
    return { pile: { id: id, title: title, members: members, kind: members[0].kind, note: note || '' } };
  }

  /** Returns the value a kind groups by, for an entity. */
  function readGroup(e) { return e.fields[K[e.kind].group] || e.project || 'Elsewhere'; }

  /**
   * Returns the items a stack draws at this depth. On the clock: the oldest few that wait, then a pile of the rest. Cards someone
   * holds keep their place and do not count. On the shelf: projects with their strips, and past what fits the largest fold first.
   */
  function buildItems(name, lying, depth, sharesColumn) {
    var open = Stacks.METRICS.open, tight = Stacks.METRICS.tight;
    if (name === 'shelf') {
      var groups = {}, order = [], items = [];
      lying.forEach(function (e) {
        var g = e.project || 'Elsewhere';
        if (!groups[g]) { groups[g] = []; order.push(g); }
        groups[g].push(e);
      });
      var need = function (g) { return Stacks.TAB + groups[g].length * tight.strip; };
      var total = order.reduce(function (a, g) { return a + need(g); }, 0);
      var folded = {};
      order.slice().sort(function (a, b) { return groups[b].length - groups[a].length; }).forEach(function (g) {
        if (total <= depth || groups[g].length < 2) return;
        folded[g] = true;
        total += Stacks.PILE - need(g);
      });
      order.forEach(function (g) {
        var list = groups[g];
        if (folded[g]) { items.push(buildPile('fold-' + g, g, list, list[0].title)); return; }
        items.push({ tab: Stacks.TAB, label: g, count: list.length });
        list.forEach(function (e) { items.push({ e: e }); });
      });
      return items;
    }
    var stream = foldStreams(lying);
    var budget = 1 + Stacks.countStrips(depth, sharesColumn, 106);
    var head = [], rest = [], waitingShown = 0;
    stream.forEach(function (e) {
      if (e.task) { head.push(e); return; }
      if (waitingShown < budget) { head.push(e); waitingShown++; } else rest.push(e);
    });
    // A pile of one is only a card in disguise.
    if (rest.length === 1) { head.push(rest.pop()); }
    var out = head.map(function (e) { return e.pile ? { pile: e } : { e: e }; });
    if (!rest.length) return out;
    var flat = [].concat.apply([], rest.map(function (e) { return e.members || [e]; }));
    var byGroup = {};
    flat.forEach(function (e) { var g = readGroup(e); byGroup[g] = (byGroup[g] || 0) + 1; });
    var most = Object.keys(byGroup).sort(function (a, b) { return byGroup[b] - byGroup[a]; })[0];
    out.push(buildPile('fold-' + name, 'more ' + STACKS[name].title.toLowerCase(), flat, 'Most in ' + most));
    return out;
  }

  /** Returns the whole height of a card at the current column width. */
  function measureWhole(el, e) {
    if (measured[e.id]) return measured[e.id];
    var had = el.classList.contains('is-whole'), h = el.style.height;
    el.classList.add('is-whole');
    el.style.height = 'auto';
    var whole = el.offsetHeight + 10;
    el.style.height = h;
    if (!had) el.classList.remove('is-whole');
    measured[e.id] = whole;
    return whole;
  }

  /** Returns how many cards are past the patience their kind declares. It is the number the sidebar shows. */
  function countOverdue() {
    var over = state.entities.filter(function (e) {
      return !e.settled && !e.task && !e.leaving && K[e.kind].pace === 'fast' && (state.now - e.since) / 36e5 >= K[e.kind].patience;
    }).length;
    return over + state.clusters.length;
  }

  /** Changes a figure or a line with a small roll, in the direction it moved, so a change on the page can be seen to happen. */
  function rollText(el, html, down) {
    if (el.innerHTML === html) return;
    var had = el.innerHTML !== '';
    el.innerHTML = html;
    if (had) Motion.animate(el, [{ transform: 'translateY(' + (down ? -5 : 5) + 'px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 240, easing: 'cubic-bezier(.22,.9,.24,1)' });
  }

  function drawBar() {
    var seen = {};
    state.entities.forEach(function (e) { if (!e.settled) seen[K[e.kind].plugin.mark] = K[e.kind].plugin; });
    var marks = Object.keys(seen);
    document.getElementById('sources').innerHTML = marks.map(function (m) {
      return '<button class="ib-src' + (state.dim === m ? ' is-on' : '') + '" data-dim="' + m + '" title="Show only ' + seen[m].name + '" aria-pressed="' + (state.dim === m) + '">' + Card.drawMark(seen[m], 15) + '</button>';
    }).join('');
    Nav.setCount('inbox', countOverdue());
  }

  function drawFrame() {
    COLUMNS = readColumns();
    page.dataset.cols = COLUMNS.length;
    page.innerHTML =
      '<h2 class="sr">Hercule noticed</h2><div class="noticed" id="noticed" role="list"></div>' +
      COLUMNS.map(function (names) {
        return '<div class="col">' + names.map(function (n) {
          return '<section class="stack-wrap" data-wrap="' + n + '" aria-label="' + STACKS[n].title + '">' +
            '<h2 class="stack-h"><span class="stack-n" data-count="' + n + '"></span><span>' + STACKS[n].title + '</span></h2>' +
            '<div class="stack" data-stack="' + n + '" role="list" aria-label="' + STACKS[n].title + '"></div>' +
            '<button class="stack-foot" data-foot="' + n + '" hidden></button></section>';
        }).join('') + '</div>';
      }).join('');
  }

  function drawNoticed() {
    var host = document.getElementById('noticed');
    host.setAttribute('aria-label', 'Hercule noticed');
    host.innerHTML = '<div class="plate-crest" title="Hercule noticed">' + Crew.logo(30, { mono: true }) + '</div>' + state.clusters.slice(0, 3).map(Card.drawPlaque).join('');
    host.hidden = !state.clusters.length;
    document.querySelector('.ib-page').classList.toggle('no-noticed', !state.clusters.length);
  }

  /**
   * Lays every stack out again. Each card's `top` says where it lies, and the motion kernel carries it there from wherever it
   * is on screen, so a change that comes in the middle of another simply bends the path.
   */
  function layOut(still, stagger) {
    if (state.mode !== 'stacks' || document.getElementById('main').classList.contains('is-loading')) return;
    if (still || !hasDrawn) { placeStacks(); hasDrawn = true; return; }
    Motion.flip([].slice.call(page.querySelectorAll('.stack .card:not(.is-leaving), .stack .tab')).filter(function (el) { return el._plan; }), placeStacks, { spring: 'hand', stagger: stagger });
  }

  function placeStacks() {
    COLUMNS.forEach(function (names, ci) {
      var col = page.querySelectorAll('.col')[ci];
      // The last row of every column is kept for the foot line and the undo line, so neither ever covers a card.
      var depth = col.clientHeight - names.length * HEAD - (names.length - 1) * BETWEEN - FOOT;
      var built = names.map(function (n) {
        var host = page.querySelector('[data-stack="' + n + '"]');
        var parts = readStackEntities(n);
        var items = buildItems(n, parts.lying, depth, names.length > 1);
        var kept = {};
        host.parentNode.dataset.slow = n === 'shelf';
        var tabs = [].slice.call(host.querySelectorAll('.tab'));
        items.forEach(function (it) {
          if (it.tab) {
            var t = tabs.filter(function (x) { return x.dataset.tab === it.label; })[0];
            if (!t) { t = document.createElement('div'); t.className = 'tab'; t.dataset.tab = it.label; host.appendChild(t); }
            t.innerHTML = '<span>' + Card.esc(it.label) + '</span><small>' + it.count + '</small>';
            it.el = t;
            kept[it.label] = true;
            return;
          }
          if (it.pile) {
            var pe = els[it.pile.id];
            if (!pe) { pe = els[it.pile.id] = drawStreamPile(it.pile); host.appendChild(pe); }
            pe.querySelector('.c-title').textContent = it.pile.title;
            pe.querySelector('.pile-n').textContent = it.pile.members.length;
            pe.dataset.depth = it.pile.members.length > 40 ? 3 : it.pile.members.length > 8 ? 2 : 1;
            pe.setAttribute('aria-label', it.pile.members.length + ' ' + it.pile.title);
            pe.querySelector('.c-roll').textContent = it.pile.note;
            pe._members = it.pile.members;
            it.el = pe; it.full = Stacks.PILE; it.strip = Stacks.PILE; it.gap = 8; it.isPile = true;
            return;
          }
          var e = it.e, el = els[e.id];
          if (!el) {
            el = els[e.id] = Card.createCard(e, readCtx(n));
            el.classList.add('is-new');
            host.appendChild(el);
          }
          if (el.parentNode !== host) host.appendChild(el);
          var m = Stacks.METRICS[K[e.kind].density];
          var line = Card.describeLine(e, STACKS[n].usual);
          it.el = el; it.full = measureWhole(el, e); it.gap = m.gap;
          // On the shelf a strip is one line, unless something has happened.
          it.strip = m.news && (line.tone === 'usual') ? m.strip : m.news || m.strip;
        });
        tabs.forEach(function (t) { if (!kept[t.dataset.tab]) t.remove(); });
        var wanted = {};
        items.forEach(function (it) { if (it.pile) wanted[it.pile.id] = true; else if (it.e) wanted[it.e.id] = true; });
        [].forEach.call(host.querySelectorAll('.card:not(.is-leaving)'), function (c) {
          var id = c.dataset.id || c.dataset.pile;
          if (!wanted[id]) { c.style.display = 'none'; c._plan = null; }
        });
        // A stack asks for the height of its cards as strips, and whole if they are few.
        var hasLead = n !== 'shelf';
        var whole = items.reduce(function (a, m) { return a + (m.tab ? m.tab : m.full + m.gap); }, 0);
        var strips = items.reduce(function (a, m, j) { return a + (m.tab ? m.tab : hasLead && j === 0 ? m.full + 12 : m.strip); }, 0);
        var hasPile = items.some(function (m) { return m.isPile; });
        var fewEnough = !hasPile && items.filter(function (m) { return !m.tab; }).length <= (hasLead ? 3 : 4);
        var footNeeded = parts.settled.length && n !== names[names.length - 1] ? FOOT : 0;
        return { name: n, host: host, items: items, parts: parts, hasLead: hasLead, asks: (fewEnough ? whole : strips) + footNeeded, foot: footNeeded };
      });
      var depths = Stacks.shareDepth(built, depth);
      var leftover = depth - depths.reduce(function (a, b) { return a + b; }, 0);
      built.forEach(function (b, bi) {
        var d = depths[bi] - b.foot;
        var plan = Stacks.layOut(b.items, d, b.hasLead);
        // A stack that is not the last of its column closes up on what follows; the last takes what is left.
        var isLast = bi === built.length - 1;
        var used = plan.used;
        // A stack closes up on what it holds, so its foot line stays with it. Its depth for a peek is all the room below.
        var height = Math.min(d, used);
        leftover += d - height;
        b.host.parentNode.style.height = height + HEAD + (isLast ? FOOT : b.foot) + 'px';
        b.host.dataset.depth = height + (isLast ? leftover : 0);
        var shown = plan.items.length;
        b.items.forEach(function (it, i) {
          var p = plan.items[i];
          var el = it.el;
          if (!p) { el.style.display = 'none'; el._plan = null; return; }
          el.style.display = '';
          var next = b.items[i + 1];
          var endOfRun = i === shown - 1 || (next && next.tab);
          // A card hides behind those in front of it, and must never show past the last of them.
          var runEnd = plan.used;
          for (var j = i + 1; j < shown; j++) if (b.items[j].tab) { runEnd = plan.items[j].y; break; }
          el._plan = p;
          el.style.zIndex = i + 1;
          el.style.top = p.y + 'px';
          if (it.tab) return;
          el._rest = p.level === 'full' ? it.full : Math.min(it.full, runEnd - p.y);
          if (it.pile) el._rest = p.show;
          el._full = it.full;
          if (!el.classList.contains('is-peek')) el.style.height = el._rest + 'px';
          el.classList.toggle('is-whole', p.level === 'full');
          el.dataset.level = p.level;
          el.classList.toggle('is-run-end', !!endOfRun);
        });
        var lying = b.parts.lying.length;
        var count = page.querySelector('[data-count="' + b.name + '"]');
        rollText(count, String(lying || ''), lying < Number(count.textContent));
        drawFoot(b, plan);
        drawEmpty(b, lying);
      });
    });
    drawBar();
    // One stop for Tab: from there the arrow keys move through the page.
    var entry = page.querySelector('.plaque, .stack .card');
    if (entry) entry.tabIndex = 0;
    requestAnimationFrame(function () {
      page.querySelectorAll('.card.is-new').forEach(function (c) { c.classList.remove('is-new'); });
    });
  }

  function drawEmpty(b, lying) {
    var note = b.host.querySelector('.stack-empty');
    if (!lying && !note) {
      note = document.createElement('p');
      note.className = 'stack-empty';
      note.textContent = STACKS[b.name].empty;
      b.host.appendChild(note);
    }
    if (lying && note) note.remove();
  }

  /** Returns a stream's pile: one strip with the edges of the cards behind it, and how many there are. */
  function drawStreamPile(pile) {
    var el = document.createElement('div');
    el.className = 'card is-pile';
    el.dataset.pile = pile.id;
    el.tabIndex = -1;
    el.setAttribute('role', 'listitem');
    el.innerHTML = '<i class="pile-sheet" style="--n:3"></i><i class="pile-sheet" style="--n:2"></i><i class="pile-sheet" style="--n:1"></i><i class="card-stock"></i><div class="c-mark"><span class="pile-n"></span></div><h3 class="c-title"></h3><div class="c-line"><span class="c-roll"></span></div>';
    return el;
  }

  /** Writes the line under a stack: what settled there, and how many cards folded away. */
  function drawFoot(b, plan) {
    var foot = page.querySelector('[data-foot="' + b.name + '"]');
    var groups = {};
    b.parts.settled.forEach(function (e) {
      var label = e.task ? 'on Work' : e.parked || 'quiet';
      groups[label] = (groups[label] || 0) + 1;
    });
    var words = Object.keys(groups).map(function (g) { return '<span><b>' + groups[g] + '</b> ' + g + '</span>'; });
    foot.hidden = !words.length;
    foot.innerHTML = words.join('<i>·</i>');
    foot._members = b.parts.settled;
  }

  /** Redraws one card's insides after its entity changed, keeping the element so its place and motion carry on. */
  function redrawCard(e) {
    var el = els[e.id];
    if (!el) return;
    var keep = ['is-whole', 'is-peek', 'is-hover', 'is-focus', 'is-run-end'].filter(function (c) { return el.classList.contains(c); });
    el.className = Card.cardClasses(e);
    keep.forEach(function (c) { el.classList.add(c); });
    Card.redrawBody(el, e, readCtx(readStack(e)));
    el.setAttribute('aria-label', Card.sayCard(e));
    delete measured[e.id];
  }

  /** Lets every card someone holds settle at the foot of its stack. It runs when you come back, never while you watch. */
  function settle() {
    state.entities.forEach(function (e) { if (e.task || e.quiet) e.settled = true; });
    state.clusters = state.clusters.filter(function (c) { return !c.task; });
  }

  /** Draws the page again from state, after another view held it. */
  function redraw() {
    els = {}; measured = {}; hasDrawn = false;
    page.dataset.mode = 'stacks';
    drawFrame();
    drawNoticed();
    layOut();
    drawNotice();
    checkZero();
  }

  /** Returns how many things still wait on the person: cards nobody holds, and what Hercule noticed. */
  function countLeft() {
    return state.entities.filter(function (e) { return !e.settled && !e.task && !e.leaving; }).length + state.clusters.filter(function (c) { return !c.task; }).length;
  }

  /** Shows the empty Inbox once the last card has gone. */
  function checkZero() {
    if (countLeft() || state.mode !== 'stacks') return false;
    settle();
    Scenes.showZero();
    return true;
  }

  /** Dims every card that does not come from the given plugin. Nothing moves, so the page keeps its shape. */
  function setDim(mark) {
    state.dim = state.dim === mark ? null : mark;
    Object.keys(els).forEach(function (id) {
      var e = findEntity(id);
      els[id].classList.toggle('is-dim', !!(e && state.dim && K[e.kind].plugin.mark !== state.dim));
    });
    document.querySelectorAll('.plaque').forEach(function (p) {
      var c = findEntity(p.dataset.id);
      p.classList.toggle('is-dim', !!(state.dim && c.sources.indexOf(state.dim) < 0));
    });
    drawBar();
  }

  /**
   * Adds a new card to its stack. Nothing moves under the pointer by itself: while the pointer is in that stack the card waits,
   * the foot says so, and it joins when the pointer leaves.
   */
  function arrive(e) {
    var name = readStack(e);
    if (Pointer.stackUnderPointer() === name) {
      waiting.push(e);
      drawWaiting(name);
      return false;
    }
    state.entities.push(e);
    layOut();
    return true;
  }

  function drawWaiting(name) {
    var n = waiting.filter(function (e) { return readStack(e) === name; }).length;
    var wrap = page.querySelector('[data-wrap="' + name + '"]');
    if (!wrap) return;
    var note = wrap.querySelector('.stack-new');
    if (!n) { if (note) note.remove(); return; }
    if (!note) { note = document.createElement('span'); note.className = 'stack-new'; wrap.querySelector('.stack-h').appendChild(note); }
    note.textContent = n + ' new';
  }

  /** Lets in the cards that waited for the pointer to leave their stack. */
  function releaseArrivals(stillOver) {
    var keep = [];
    var names = {};
    waiting.forEach(function (e) {
      var name = readStack(e);
      if (name === stillOver) { keep.push(e); return; }
      state.entities.push(e);
      names[name] = true;
    });
    if (!Object.keys(names).length) return;
    waiting = keep;
    layOut();
    Object.keys(names).forEach(drawWaiting);
  }

  /** Clears the page and draws a scene from scratch. */
  function load(scene) {
    state.entities = scene.entities;
    state.clusters = scene.clusters;
    state.now = scene.now || W.NOW;
    state.scene = scene.name;
    state.dim = null;
    state.mode = scene.mode || 'stacks';
    state.notice = scene.notice || null;
    els = {}; measured = {}; hasDrawn = false;
    page.dataset.scene = scene.name;
    page.dataset.mode = state.mode;
    if (scene.draw) { scene.draw(page); drawBar(); return; }
    drawFrame();
    drawNoticed();
    layOut();
    drawNotice();
  }

  /** Writes the one line that tells the user when the picture may be out of date. Nothing here is silent. */
  function drawNotice() {
    var n = document.getElementById('notice');
    n.hidden = !state.notice;
    n.innerHTML = state.notice || '';
    if (state.notice) Landing.announce(n.textContent);
  }

  function start() {
    page = document.getElementById('page');
    var timer;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        measured = {};
        if (state.mode !== 'stacks') return;
        if (readColumns() !== COLUMNS) redraw(); else layOut(true);
      }, 60);
    });
    document.addEventListener('click', function (ev) {
      var d = ev.target.closest('[data-dim]');
      if (d) setDim(d.dataset.dim);
    });
    Scenes.play(params.get('scene') || 'morning');
    document.fonts.ready.then(function () { measured = {}; if (state.mode === 'stacks') layOut(true); });
  }

  return {
    state: state, els: function () { return els; }, STACKS: STACKS, readColumns: function () { return COLUMNS; }, findEntity: findEntity, readStack: readStack, readStackEntities: readStackEntities, layOut: layOut, redrawCard: redrawCard, drawNoticed: drawNoticed, drawBar: drawBar,
    load: load, setDim: setDim, drawNotice: drawNotice, settle: settle, redraw: redraw, checkZero: checkZero, countLeft: countLeft, countOverdue: countOverdue, start: start, measured: function () { return measured; }, forgetEl: function (id) { delete els[id]; }, arrive: arrive, releaseArrivals: releaseArrivals,
  };
})();
