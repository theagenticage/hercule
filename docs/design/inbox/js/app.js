// The Inbox: state, and drawing the page from it. Moves, keys, the open card and the scenes live in their own files
// and go through the methods here.
window.App = (function () {
  var K = Kinds.KINDS, W = World;
  var params = new URLSearchParams(location.search);

  var STACKS = {
    review: { title: 'To review', usual: 'reviewRequested', empty: 'Nobody is waiting for a review.' },
    answer: { title: 'To answer', usual: 'concern', empty: 'Nothing to answer.' },
    finish: { title: 'To finish', usual: null, empty: 'Nothing of yours needs a move.' },
    shelf: { title: 'On the shelf', usual: 'concern', empty: 'The shelf is clear.' },
  };
  // The three stacks on the clock stand side by side, so their counts read as one line that adds up to the sidebar's number, and
  // the shelf lies across the page under them. In a narrow window the stacks fall to two columns, then one, and share their depth.
  var LAYOUTS = { 3: [['review'], ['answer'], ['finish'], ['shelf']], 2: [['review', 'shelf'], ['answer', 'finish']], 1: [['review', 'answer', 'finish', 'shelf']] };
  function readColumns() {
    var w = document.getElementById('main').clientWidth;
    return LAYOUTS[w >= 900 ? 3 : w >= 620 ? 2 : 1];
  }
  var COLUMNS = LAYOUTS[3];
  var HERCULE = { hue: 'lime', shape: 'egg', acc: 'tache' };
  var HEAD = 64;       // a stack's heading, with the space under it, which a colleague's head rises into without touching the rule
  var CLOCK_DEPTH = 360; // how deep the stacks on the clock may go: three whole cards, the most a light day shows
  var visitDepth = 0;  // how deep they go on this visit: the deepest stack when the page was drawn, so the shelf sits close under it and stays
  var clockUsed = 0;   // the height of the deepest stack on the clock, as last laid out
  var SHELF_GAP = 20;  // the space above the shelf's heading
  var NOTICED_AIR = 32; // the margins of the noticed card, so the big counts under it have room
  var BETWEEN = 14;    // the space between two stacks of one column
  var FOOT = 26;       // the line under a stack that counts what settled

  var state = { scene: 'morning', now: W.NOW, entities: [], clusters: [], dim: null, open: null, page: 'inbox', offline: false, stale: null };
  var els = {};        // card elements by entity id
  var measured = {};   // whole heights by entity id, for the current width
  var page, hasDrawn = false;
  var waiting = [];    // new cards held back while the pointer is in their stack
  var offstage = [];   // cards a layout no longer wants, waiting to be sent off once the page has moved

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
      if (!streams[e.stream]) { streams[e.stream] = { pile: true, id: 'stream-' + e.stream, title: e.stream, members: [], since: e.since, kind: e.kind, note: '' }; out.push(streams[e.stream]); }
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

  /** Returns the shelf's line for a project: its newest news, or its first title when nothing has happened. */
  function sayProject(list) {
    var news = null;
    list.forEach(function (e) {
      var latest = e.signals[e.signals.length - 1];
      // "Omar commented" says nothing without its subject, so news from a person shows what it is about.
      if (latest && latest.key !== e.concern && (!news || latest.at > news.at)) news = { at: latest.at, text: latest.who ? e.title : Card.sayReason(K[e.kind], latest).text };
    });
    return news ? news.text : list[0].title;
  }

  /**
   * Returns the items a stack draws at this depth. On the clock: the oldest few, then a pile of the rest. Nothing on the shelf has
   * a clock, so there every project is one card, at any volume, and opens into the tray.
   */
  function buildItems(name, lying, depth, budget) {
    if (name === 'shelf') {
      var groups = {}, order = [];
      lying.forEach(function (e) {
        var g = e.project || 'Elsewhere';
        if (!groups[g]) { groups[g] = []; order.push(g); }
        groups[g].push(e);
      });
      return order.map(function (g) {
        var item = buildPile('fold-' + g, g, groups[g], sayProject(groups[g]));
        item.pile.isProject = true;
        return item;
      });
    }
    var stream = foldStreams(lying);
    // Cards someone holds keep their place and count, so handing a card on moves nothing. See turnOver for when they run out.
    // A stream stays in sight wherever it falls, because it is the one thing that can be cleared at a stroke.
    var streams = stream.slice(budget).filter(function (e) { return e.pile; });
    var kept = Math.max(1, budget - streams.length);
    var head = stream.slice(0, kept), rest = stream.slice(kept).filter(function (e) { return !e.pile; });
    // A pile of one is only a card in disguise.
    if (rest.length === 1) { head.push(rest.pop()); }
    var out = head.concat(streams.filter(function (x) { return head.indexOf(x) < 0; })).map(function (e) { return e.pile ? { pile: e } : { e: e }; });
    if (!rest.length) return out;
    var flat = [].concat.apply([], rest.map(function (e) { return e.members || [e]; }));
    out.push(buildPile('fold-' + name, 'more', flat, ''));
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

  /** Returns how many cards wait on the clock. It is the number the sidebar shows. */
  function countOverdue() {
    // The number you can check against the page: the Deco counts of the stacks on the clock, added up.
    return state.entities.filter(function (e) { return !e.settled && !e.task && K[e.kind].pace === 'fast'; }).length;
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
    // A filter on a source with nothing left would leave the page dim with no way out.
    if (state.dim && marks.indexOf(state.dim) < 0) { state.dim = null; applyDim(); }
    var host = document.getElementById('sources');
    // Only a change of sources redraws the buttons, so a pressed filter keeps its focus.
    if (host.dataset.marks !== marks.join()) {
      host.dataset.marks = marks.join();
      host.innerHTML = marks.map(function (m) {
        return '<button class="ib-src" data-dim="' + m + '" title="Show only ' + seen[m].name + '" aria-pressed="false">' + Card.drawMark(seen[m], 15) + '</button>';
      }).join('');
    }
    [].forEach.call(host.children, function (b) {
      var on = state.dim === b.dataset.dim;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on);
    });
    Nav.setCount('inbox', countOverdue());
  }

  /** Returns whether a column of the page is the shelf laid across it. */
  function isShelfRow(names) { return COLUMNS.length === 4 && names[0] === 'shelf'; }

  function drawFrame() {
    COLUMNS = readColumns();
    page.dataset.cols = Math.min(3, COLUMNS.length);
    page.innerHTML =
      '<h2 class="sr">Hercule noticed</h2><div class="noticed" id="noticed" role="list"></div>' +
      COLUMNS.map(function (names) {
        return '<div class="col' + (isShelfRow(names) ? ' col--shelf' : '') + '">' + names.map(function (n) {
          return '<section class="stack-wrap" data-wrap="' + n + '" aria-label="' + STACKS[n].title + '">' +
            '<h2 class="stack-h"><span class="stack-n" data-count="' + n + '"></span><span class="stack-t">' + STACKS[n].title + '</span></h2>' +
            '<div class="stack" data-stack="' + n + '" role="list" aria-label="' + STACKS[n].title + '"></div>' +
            '<button class="stack-foot" data-foot="' + n + '" hidden></button></section>';
        }).join('') + '</div>';
      }).join('');
  }

  /** Gives each noticed thing a column of the noticed card. It keeps that column, so one leaving never moves the others. */
  function assignSlots() {
    var used = {};
    state.clusters.forEach(function (c) {
      if (c.slot === undefined) return;
      if (used[c.slot]) c.slot = undefined; else used[c.slot] = true;
    });
    state.clusters.forEach(function (c) {
      if (c.slot !== undefined) return;
      // With all three columns taken, a thing waits for one to come free.
      for (var i = 0; i < 3; i++) if (!used[i]) { c.slot = i; used[i] = true; return; }
    });
  }

  function drawNoticed() {
    var host = document.getElementById('noticed');
    host.setAttribute('aria-label', 'Hercule noticed');
    assignSlots();
    // Hercule stands behind the top edge, as a colleague does on Work: he is handing you something, not raising an alarm.
    host.innerHTML = '<span class="card-holder" title="Hercule noticed"><span class="card-head">' + Crew.peek('Hercule', { pose: 'idle', size: 30, crop: 34, look: HERCULE }) + '</span></span>' +
      '<span class="card-paws" style="--hue:var(--hue-' + HERCULE.hue + ')"><i></i><i></i></span><i class="card-stock"></i>' + state.clusters.filter(function (c) { return c.slot !== undefined; }).map(Card.drawPlaque).join('');
    // The row stays when nothing is noticed, so the page never shifts under a resting pointer when something is.
    var wasEmpty = host.classList.contains('is-empty');
    host.classList.toggle('is-empty', !state.clusters.length);
    if (wasEmpty && state.clusters.length) Motion.animate(host, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
    // The card reaches only as far as the last thing on it, so one thing on a light day is not a long empty band.
    var reach = state.clusters.reduce(function (a, c) { return Math.max(a, c.slot === undefined ? 0 : c.slot + 1); }, 1);
    host.style.gridColumn = COLUMNS.length === 4 ? '1 / span ' + reach : '';
    var was = Keys.current();
    if (Keys.isUsingKeys() && was && host.querySelector('[data-id="' + was + '"]')) Keys.focus(was);
  }

  /**
   * Lays every stack out again. Each card's `top` says where it lies, and the motion kernel carries it there from wherever it
   * is on screen, so a change that comes in the middle of another simply bends the path.
   */
  function layOut(still, stagger) {
    if (state.mode !== 'stacks' || document.getElementById('main').classList.contains('is-holding')) return;
    if (still || !hasDrawn) {
      placeStacks();
      // The first drawing of a visit measures the deepest stack, and the shelf comes up under it for the rest of the visit.
      if (!visitDepth && COLUMNS.length === 4) { visitDepth = clockUsed + 12; placeStacks(); }
      flushOffstage(false);
      hasDrawn = true;
      return;
    }
    // A card being dealt is already on its own way, and must keep what it does on arrival.
    var moving = [].slice.call(page.querySelectorAll('.stack .card:not(.is-leaving):not(.is-dealing)')).filter(function (el) { return el._plan; });
    Motion.flip(moving.concat([].slice.call(page.querySelectorAll('.stack-h, .stack-foot:not([hidden])'))), placeStacks, { spring: 'hand', stagger: stagger });
    flushOffstage(true);
    dealFromPiles(stagger);
    if (state.dim) applyDim();
  }

  /**
   * Deals the cards that just came out of a pile. Each starts behind the pile, solid, and rises out of it to its place as the
   * last step of the ripple, and the pile gives a little: a stack feeding itself, not a list reflowing.
   */
  function dealFromPiles(stagger) {
    [].forEach.call(page.querySelectorAll('.stack .card.is-new'), function (el, i) {
      var pile = el.parentNode.querySelector('.card.is-pile');
      var from = pile && (pile._plan ? pile._plan.y : pile._wasY);
      if (from === undefined || from === null || !el._plan || Motion.isReduced()) return;
      el.classList.remove('is-new');
      // While it is dealt it is only as tall as its strip, so it never shows below the pile it comes out of.
      el.classList.add('is-dealing');
      el.style.height = el._plan.show + 'px';
      Motion.body(el).set({ y: from - el._plan.y }).to({ y: 0 }, 'hand', { delay: (stagger ? stagger(el) : 0) + i * 14, done: function () {
        el.classList.remove('is-dealing');
        if (el._rest && !el.classList.contains('is-peek')) el.style.height = el._rest + 'px';
      } });
      if (pile._plan) Motion.knock(pile, -60);
    });
  }

  /** Sends a card off the page: into the pile if the stack has one, down to the foot line if it settled, and away otherwise. */
  function sendOff(c, host) {
    var wasY = c._plan.y;
    c._plan = null;
    c.classList.remove('is-hover', 'is-focus');
    var isPile = c.classList.contains('is-pile');
    var pile = !isPile && host.querySelector('.card.is-pile:not(.is-folding)');
    var e = findEntity(c.dataset.id);
    var finish = function () { c.classList.remove('is-folding'); c.style.display = 'none'; Motion.body(c).clear(); };
    if (Motion.isReduced()) { finish(); return; }
    c.classList.add('is-folding');
    if (isPile) { c._wasY = wasY; Motion.body(c).to({ o: 0 }, 'hand', { done: finish }); return; }
    // A card that settled goes down to the foot line, never into the pile of what still waits.
    if (e && e.settled) { Motion.body(c).to({ y: 8, o: 0 }, 'hand', { done: finish }); return; }
    if (pile && pile._plan) {
      c.style.zIndex = Number(pile.style.zIndex) - 1;
      Motion.body(c).to({ y: pile._plan.y - wasY }, 'hand', { done: finish });
      return;
    }
    Motion.body(c).to({ y: 8, o: 0 }, 'travel', { done: finish });
  }

  function flushOffstage(animate) {
    var list = offstage;
    offstage = [];
    list.forEach(function (o) {
      if (animate) sendOff(o.c, o.host);
      else { o.c.style.display = 'none'; o.c._plan = null; }
    });
  }

  /**
   * Turns a stack over. When nothing in view waits any more and the pile holds more, the cards someone holds settle to the foot
   * line and the pile deals the next ones, so a stack can be worked through to its end. Returns whether it turned.
   */
  function turnOver(name) {
    var host = page.querySelector('[data-stack="' + name + '"]');
    var pile = host && host.querySelector('.card.is-pile');
    if (!pile || !pile._plan || state.mode !== 'stacks') return false;
    var shown = readStackEntities(name).lying.filter(function (e) { return els[e.id] && els[e.id]._plan; });
    if (!shown.length || shown.some(function (e) { return !e.task; })) return false;
    shown.forEach(function (e) { e.settled = true; });
    // The held cards go first, and the pile deals into the room they leave.
    layOut(false, function () { return 240; });
    return true;
  }

  function placeStacks() {
    clockUsed = 0;
    // In a narrow column the actions shed their faces, then Take it, so a sentence is never reduced to a letter or two.
    var column = page.querySelector('.col').clientWidth;
    if (column < 270) page.dataset.fit = 'least'; else if (column < 340) page.dataset.fit = 'less'; else delete page.dataset.fit;
    COLUMNS.forEach(function (names, ci) {
      var col = page.querySelectorAll('.col')[ci];
      // The last row of every column is kept for the foot line and the undo line, so neither ever covers a card.
      // Never less than a card and a pile per stack: in a very small window the page scrolls, and no card is ever out of reach.
      var noticed = document.getElementById('noticed');
      var room = page.clientHeight - 24 - (noticed ? noticed.offsetHeight + NOTICED_AIR : 0);
      var depth = Math.max(room - names.length * HEAD - (names.length - 1) * BETWEEN - FOOT, names.length * 220);
      // With the shelf across the page, the stacks keep one depth whatever they hold, so the shelf never moves on its own.
      if (COLUMNS.length === 4) {
        var projects = buildItems('shelf', readStackEntities('shelf').lying).length;
        depth = Math.max(220, Math.min(visitDepth || CLOCK_DEPTH, depth - HEAD - Stacks.measureShelfRows(projects) - SHELF_GAP - FOOT));
        page.style.setProperty('--clock-row', depth + HEAD + FOOT + 'px');
      }
      var clock = names.filter(function (n) { return n !== 'shelf'; });
      var budgets = {};
      var fits = Stacks.planBudgets(clock.map(function (n) {
        var parts = readStackEntities(n);
        return { count: foldStreams(parts.lying).length, cap: 2, lead: 106, foot: parts.settled.length && n !== names[names.length - 1] ? FOOT : 0 };
      }), clock.length === names.length ? depth : Math.floor(depth * 0.6));
      clock.forEach(function (n, i) { budgets[n] = fits[i]; });
      var built = names.map(function (n) {
        var host = page.querySelector('[data-stack="' + n + '"]');
        var parts = readStackEntities(n);
        var items = buildItems(n, parts.lying, depth, budgets[n]);
        host.parentNode.dataset.slow = n === 'shelf';
        items.forEach(function (it) {
          if (it.pile) {
            var pe = els[it.pile.id];
            if (!pe) { pe = els[it.pile.id] = drawStreamPile(it.pile); host.appendChild(pe); }
            if (pe.classList.contains('is-folding')) { pe.classList.remove('is-folding'); Motion.body(pe).clear(); }
            pe.querySelector('.c-title').textContent = it.pile.title;
            drawPileFace(pe, it.pile);
            pe._members = it.pile.members;
            var pileHeight = it.pile.isProject ? Stacks.PROJECT : Stacks.PILE;
            it.el = pe; it.full = pileHeight; it.strip = pileHeight; it.gap = 8; it.isPile = true;
            return;
          }
          var e = it.e, el = els[e.id];
          if (!el) {
            el = els[e.id] = Card.createCard(e, readCtx(n));
            el.classList.add('is-new');
            host.appendChild(el);
          }
          if (el.parentNode !== host) host.appendChild(el);
          if (el.classList.contains('is-folding')) { el.classList.remove('is-folding'); Motion.body(el).clear(); }
          // A card that comes back from a pile says what happened to it while it was out of sight.
          if (el.style.display === 'none') redrawCard(e);
          var m = Stacks.METRICS[K[e.kind].density];
          it.el = el; it.full = measureWhole(el, e); it.gap = m.gap;
          it.strip = m.strip;
        });
        var wanted = {};
        items.forEach(function (it) { if (it.pile) wanted[it.pile.id] = true; else if (it.e) wanted[it.e.id] = true; });
        [].forEach.call(host.querySelectorAll('.card:not(.is-leaving):not(.is-folding)'), function (c) {
          var id = c.dataset.id || c.dataset.pile;
          if (wanted[id]) return;
          if (c._plan) offstage.push({ c: c, host: host }); else c.style.display = 'none';
        });
        // A stack asks for the height of its cards as strips, and whole if they are few.
        var hasLead = n !== 'shelf';
        var whole = items.reduce(function (a, m) { return a + m.full + m.gap; }, 0);
        var strips = items.reduce(function (a, m, j) { return a + (hasLead && j === 0 ? m.full + 12 : m.strip); }, 0);
        var hasPile = items.some(function (m) { return m.isPile; });
        var fewEnough = hasLead && !hasPile && items.filter(function (m) { return !m.tab; }).length <= 3;
        var footNeeded = parts.settled.length && n !== names[names.length - 1] ? FOOT : 0;
        return { name: n, host: host, items: items, parts: parts, hasLead: hasLead, asks: (fewEnough ? whole : strips) + footNeeded, foot: footNeeded };
      });
      var depths = Stacks.shareDepth(built, depth);
      var leftover = depth - depths.reduce(function (a, b) { return a + b; }, 0);
      built.forEach(function (b, bi) {
        var d = depths[bi] - b.foot;
        var plan = isShelfRow(names) ? Stacks.layOutShelfRow(b.items, b.host.clientWidth) : Stacks.layOut(b.items, b.hasLead ? d : 0, b.hasLead);
        // A stack that is not the last of its column closes up on what follows; the last takes what is left.
        var isLast = bi === built.length - 1;
        var used = plan.used;
        // A stack closes up on what it holds, so its foot line stays with it. Its depth for a peek is all the room below.
        var height = Math.max(used, b.parts.lying.length ? 0 : 30);
        if (b.hasLead) clockUsed = Math.max(clockUsed, height);
        leftover += d - height;
        b.host.parentNode.style.height = height + HEAD + (isLast ? FOOT : b.foot) + 'px';
        b.host.dataset.depth = height + (isLast ? leftover : 0);
        var shown = plan.items.length;
        b.items.forEach(function (it, i) {
          var p = plan.items[i];
          var el = it.el;
          if (!p) { el.style.display = 'none'; el._plan = null; return; }
          // A card coming back from a pile is dealt like a new one.
          if (el.style.display === 'none' && !it.pile) el.classList.add('is-new');
          el.style.display = '';
          var next = b.items[i + 1];
          var endOfRun = i === shown - 1;
          // A card hides behind those in front of it, and must never show past the last of them.
          var runEnd = plan.used;
          el._plan = p;
          el.style.zIndex = i + 1;
          el.style.top = p.y + 'px';
          el.style.left = p.x === undefined ? '' : p.x + 'px';
          el.style.width = p.w === undefined ? '' : p.w + 'px';
          el.style.setProperty('--shown', p.show + 'px');
          el._rest = p.level === 'full' ? it.full : Math.min(it.full, runEnd - p.y);
          if (it.pile) el._rest = p.show;
          el._full = it.full;
          if (!el.classList.contains('is-peek') && !el.classList.contains('is-dealing')) el.style.height = el._rest + 'px';
          var becomesWhole = p.level === 'full' && !el.classList.contains('is-whole') && hasDrawn;
          var becomesStrip = p.level !== 'full' && el.classList.contains('is-whole') && hasDrawn;
          el.classList.toggle('is-whole', p.level === 'full');
          el.dataset.level = p.level;
          // The next card stepping up to lead grows into its larger title, rather than jumping to it.
          if (becomesWhole) {
            var title = el.querySelector('.c-title');
            if (title) Motion.animate(title, [{ transform: 'scale(.867)', transformOrigin: '0 0' }, { transform: 'none', transformOrigin: '0 0' }], { duration: Motion.curve('hand').ms, easing: Motion.curve('hand').ease });
            var foot = el.querySelector('.c-foot');
            if (foot) Motion.animate(foot, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 240, delay: 100, fill: 'backwards', easing: 'cubic-bezier(.22,.9,.24,1)' });
          }
          // A whole card folding to a strip shrinks into its smaller title, so a busier day never cuts.
          if (becomesStrip && el.querySelector('.c-title')) Motion.animate(el.querySelector('.c-title'), [{ transform: 'scale(1.153)', transformOrigin: '0 0' }, { transform: 'none', transformOrigin: '0 0' }], { duration: Motion.curve('hand').ms, easing: Motion.curve('hand').ease });
          el.classList.toggle('is-run-end', !!endOfRun);
        });
        // The count says what still waits. A card someone holds stays in view, and no longer counts.
        var lying = b.parts.lying.filter(function (e) { return !e.task; }).length;
        var count = page.querySelector('[data-count="' + b.name + '"]');
        rollText(count, String(lying || ''), lying < Number(count.textContent));
        drawFoot(b, plan);
        drawEmpty(b, b.parts.lying.length);
      });
    });
    drawBar();
    // Anything back on the clock takes the sunrise away again.
    if (page.classList.contains('is-clock-clear') && countOnClock()) {
      page.classList.remove('is-clock-clear');
      var sun = page.querySelector('.zero--clock');
      if (sun) sun.remove();
    }
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

  /** Returns a pile: a card with the edges of the cards under it. What it says is written by drawPileFace. */
  function drawStreamPile(pile) {
    var el = document.createElement('div');
    el.className = 'card is-pile' + (pile.isProject ? ' is-project' : '');
    el.dataset.pile = pile.id;
    el.tabIndex = -1;
    el.setAttribute('role', 'listitem');
    var sheets = '<i class="pile-sheet" style="--n:3"></i><i class="pile-sheet" style="--n:2"></i><i class="pile-sheet" style="--n:1"></i><i class="card-stock"></i>';
    el.innerHTML = sheets + (pile.isProject
      ? '<div class="c-mark">' + Card.drawMark(K[pile.kind].plugin, 18) + '</div><h3 class="c-title"></h3><div class="pile-count"></div><div class="c-line"><span class="c-roll"></span></div>'
      : '<div class="c-mark"><span class="pile-n"></span></div><h3 class="c-title"></h3><div class="pile-facts"></div>');
    return el;
  }

  /** Returns the worst thing in a list of cards, as a shape and how many share it, or nothing when all is well. */
  function readWorst(members) {
    var rank = { bad: 2, you: 1 }, worst = null, count = 0;
    members.forEach(function (e) {
      var kind = K[e.kind], status = kind.status && kind.status[e.fields.state];
      if (!status || e.task || !rank[status.tone]) return;
      if (!worst || rank[status.tone] > rank[worst.tone]) { worst = status; count = 1; }
      else if (status.tone === worst.tone) count++;
    });
    return worst ? { status: worst, count: count } : null;
  }

  /** Writes what a pile says: how many it holds and, because a stack may fold things but never hide them, the worst inside and how fresh it is. */
  function drawPileFace(el, pile) {
    var n = pile.members.length;
    var hasNews = pile.members.some(function (e) { return e.fresh; });
    var dot = hasNews ? '<i class="c-fresh" title="New since you last looked"><span class="sr">New</span></i>' : '';
    if (pile.isProject) {
      el.querySelector('.c-title').textContent = pile.title;
      el.querySelector('.pile-count').textContent = n > 1 ? n : '';
      el.querySelector('.c-line').innerHTML = dot + '<span class="c-roll">' + Card.esc(pile.note) + '</span>';
    } else {
      var count = el.querySelector('.pile-n');
      rollText(count, String(n), n < Number(count.textContent));
      el.querySelector('.c-title').textContent = pile.title;
      var worst = readWorst(pile.members);
      var newest = pile.members.reduce(function (a, e) {
        var latest = e.signals[e.signals.length - 1];
        return Math.max(a, e.since, latest ? latest.at : 0);
      }, 0);
      el.querySelector('.pile-facts').innerHTML = dot + (worst ? '<span class="pile-worst">' + Card.drawShape(worst.status, 14) + worst.count + '</span>' : '') + '<span>newest ' + Card.sayWait(newest, state.now) + '</span>';
    }
    el.dataset.depth = n > 40 ? 3 : n > 8 ? 2 : n > 1 ? 1 : 0;
    el.setAttribute('aria-label', n + ' ' + pile.title);
  }

  /** Writes the line under a stack: what settled there, and how many cards folded away. */
  function drawFoot(b, plan) {
    var foot = page.querySelector('[data-foot="' + b.name + '"]');
    var groups = {};
    b.parts.settled.forEach(function (e) {
      var label = e.task ? 'on Work' : e.parked || 'gone quiet';
      groups[label] = (groups[label] || 0) + 1;
    });
    var words = Object.keys(groups).map(function (g) { return '<span><b>' + groups[g] + '</b> ' + g + '</span>'; });
    foot.hidden = !words.length;
    rollText(foot, words.join('<i>·</i>'));
    foot._members = b.parts.settled;
  }

  /** Redraws one card's insides after its entity changed, keeping the element so its place and motion carry on. */
  function redrawCard(e) {
    var el = els[e.id];
    if (!el) return;
    var keep = ['is-whole', 'is-peek', 'is-hover', 'is-focus', 'is-run-end', 'is-source', 'is-lifted', 'is-dim', 'is-under', 'is-landed', 'is-closing', 'is-folding', 'is-dealing', 'is-rising'].filter(function (c) { return el.classList.contains(c); });
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
    els = {}; measured = {}; hasDrawn = false; visitDepth = 0;
    page.dataset.mode = 'stacks';
    drawFrame();
    drawNoticed();
    layOut();
    drawNotice();
    applyDim();
    checkZero();
  }

  /** Redraws the noticed card after it changed, and lets the stacks glide to where the page now puts them. */
  function reflowNoticed() {
    var noticed = document.getElementById('noticed');
    var cols = [].slice.call(page.querySelectorAll('.col'));
    // The last thing leaving takes the whole noticed card with it: a copy fades where it stood while the columns rise.
    if (!noticed.classList.contains('is-empty') && !state.clusters.length && !Motion.isReduced()) {
      var main = document.getElementById('main').getBoundingClientRect(), r = noticed.getBoundingClientRect();
      var copy = noticed.cloneNode(true);
      copy.removeAttribute('id');
      copy.style.cssText = 'position:absolute;margin:0;z-index:5;left:' + (r.left - main.left) + 'px;top:' + (r.top - main.top) + 'px;width:' + r.width + 'px;display:flex';
      document.getElementById('main').appendChild(copy);
      copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease-out' }).finished.then(function () { copy.remove(); });
    }
    Motion.flip(cols, function () { drawNoticed(); placeStacks(); flushOffstage(false); }, { spring: 'travel' });
    drawBar();
  }

  /** Returns how many things still wait on the person: cards nobody holds, and what Hercule noticed. */
  function countLeft() {
    return waiting.length + state.entities.filter(function (e) { return !e.settled && !e.task; }).length + state.clusters.filter(function (c) { return !c.task; }).length;
  }

  /** Returns how many things want the person now: what waits on the clock, and what Hercule noticed. The shelf has no clock, so it does not count. */
  function countOnClock() {
    var onClock = function (e) { return readStack(e) !== 'shelf'; };
    return waiting.filter(onClock).length + state.entities.filter(function (e) { return !e.settled && !e.task && onClock(e); }).length + state.clusters.filter(function (c) { return !c.task; }).length;
  }

  /**
   * Shows the empty Inbox once nothing wants the person any more. With everything gone the page is the sunrise. With things still on
   * the shelf the sunrise stands over them, because clearing the clock is the moment worth marking, and the shelf is seldom empty.
   */
  function checkZero() {
    if (countOnClock() || state.mode !== 'stacks') return false;
    settle();
    if (!countLeft()) { Scenes.showZero(); return true; }
    if (COLUMNS.length === 4 && !page.classList.contains('is-clock-clear')) { layOut(true); Scenes.showClockClear(page); }
    return true;
  }

  /** Dims every card that does not come from the given plugin. Nothing moves, so the page keeps its shape. */
  function setDim(mark) {
    state.dim = state.dim === mark ? null : mark;
    applyDim();
    drawBar();
  }

  function applyDim() {
    Object.keys(els).forEach(function (id) {
      var members = els[id]._members || [findEntity(id)];
      var isOther = function (e) { return !!e && K[e.kind].plugin.mark !== state.dim; };
      els[id].classList.toggle('is-dim', !!(state.dim && members.every(isOther)));
    });
    document.querySelectorAll('.plaque').forEach(function (p) {
      var c = findEntity(p.dataset.id);
      p.classList.toggle('is-dim', !!(state.dim && c.sources.indexOf(state.dim) < 0));
    });
  }

  /**
   * Adds a new card to its stack. Nothing moves under the pointer by itself: while the pointer is in that stack the card waits,
   * the foot says so, and it joins when the pointer leaves.
   */
  function arrive(e) {
    var name = readStack(e);
    // The same thing never arrives twice, whether it lies on the page or still waits at a heading.
    if (findEntity(e.id) || waiting.some(function (x) { return x.id === e.id; })) return false;
    if (state.mode !== 'stacks') {
      state.entities.push(e);
      if (state.mode === 'zero') {
        state.mode = 'stacks';
        redraw();
        Motion.animate(page, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
      }
      return true;
    }
    // A column shares its depth, so the card waits while the pointer is anywhere in that column. Keys take no notice of a resting pointer.
    // An open tray holds its arrivals too, so what it shows and what its pile counts stay the same.
    if ((isPointerInColumnOf(name) && !Keys.isUsingKeys()) || Tray.isOpen()) {
      waiting.push(e);
      drawWaiting(name);
      return false;
    }
    state.entities.push(e);
    layOut();
    if (!els[e.id] || !els[e.id]._plan) knockPile(name);
    return true;
  }

  /** A card that arrives straight into a pile lands on it: the pile takes the knock and lights its rim. */
  function knockPile(name) {
    var pile = page.querySelector('[data-stack="' + name + '"] .card.is-pile');
    if (!pile) return;
    Motion.knock(pile, 145);
    pile.dataset.landed = 'plain';
    setTimeout(function () {
      pile.classList.add('is-landed');
      setTimeout(function () { pile.classList.remove('is-landed'); }, 1300);
    }, 200);
  }

  function isPointerInColumnOf(name) {
    var over = Pointer.stackUnderPointer();
    return !!over && COLUMNS.some(function (names) { return names.indexOf(over) >= 0 && names.indexOf(name) >= 0; });
  }

  /** Lets in what waited for a stack that has just run out, because nothing is left to keep steady. */
  function noteStackEmptied(name) {
    if (!readStackEntities(name).lying.length) releaseArrivals(null);
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
      if (stillOver && COLUMNS.some(function (c) { return c.indexOf(stillOver) >= 0 && c.indexOf(name) >= 0; })) { keep.push(e); return; }
      state.entities.push(e);
      names[name] = e;
    });
    if (!Object.keys(names).length) return;
    waiting = keep;
    layOut();
    Object.keys(names).forEach(function (n) {
      drawWaiting(n);
      if (els[names[n].id] && els[names[n].id]._plan) Landing.settleArrival(els[names[n].id]); else knockPile(n);
    });
  }

  /** Clears the page and draws a scene from scratch. */
  function load(scene) {
    waiting = [];
    state.entities = scene.entities;
    state.clusters = scene.clusters;
    state.now = scene.now || W.NOW;
    state.scene = scene.name;
    state.isLive = scene.name === 'morning' || (scene.name === 'zero' && state.isLive);
    state.dim = null;
    state.mode = scene.mode || 'stacks';
    state.notice = scene.notice || null;
    els = {}; measured = {}; hasDrawn = false; visitDepth = 0;
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
      visitDepth = 0;
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
    state: state, HERCULE: HERCULE, els: function () { return els; }, STACKS: STACKS, readColumns: function () { return COLUMNS; }, findEntity: findEntity, readStack: readStack, readStackEntities: readStackEntities, layOut: layOut, redrawCard: redrawCard, drawNoticed: drawNoticed, drawBar: drawBar,
    forgetMeasures: function () { measured = {}; }, turnOver: turnOver, noteStackEmptied: noteStackEmptied, load: load, setDim: setDim, drawNotice: drawNotice, settle: settle, redraw: redraw, reflowNoticed: reflowNoticed, checkZero: checkZero, countLeft: countLeft, countOnClock: countOnClock, countOverdue: countOverdue, start: start, measured: function () { return measured; }, forgetEl: function (id) { delete els[id]; }, arrive: arrive, releaseArrivals: releaseArrivals,
  };
})();
