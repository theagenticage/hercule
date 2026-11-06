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
  var COLUMNS = [['review'], ['answer', 'finish'], ['shelf']];
  var HEAD = 30;       // a stack's heading, with the space under it
  var BETWEEN = 16;    // the space between two stacks of one column
  var FOOT = 26;       // the line under a stack that counts what settled

  var state = { scene: 'morning', now: W.NOW, entities: [], clusters: [], dim: null, open: null, page: 'inbox', offline: false, stale: null };
  var els = {};        // card elements by entity id
  var measured = {};   // whole heights by entity id, for the current width
  var page, sum, navCount;

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

  /** Returns the items a stack draws: its cards, with a tab before each group when the stack groups. */
  function buildItems(name, lying) {
    if (name !== 'shelf') return lying.map(function (e) { return { e: e }; });
    var groups = {}, order = [], items = [];
    lying.forEach(function (e) {
      var g = e.project || 'Elsewhere';
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(e);
    });
    order.forEach(function (g) {
      items.push({ tab: 30, label: g, count: groups[g].filter(function (e) { return !e.leaving; }).length });
      groups[g].forEach(function (e) { items.push({ e: e }); });
    });
    return items;
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

  function saySummary() {
    var waiting = state.entities.filter(function (e) { return !e.settled && !e.task && !e.leaving && K[e.kind].pace === 'fast' && e.concern !== 'opened' && e.concern !== 'assigned'; }).sort(function (a, b) { return a.since - b.since; });
    var first = waiting[0];
    var who = first && (first.fields.author || first.fields.from);
    var words = ['', 'one thing', 'two things', 'three things', 'four things'];
    var n = state.clusters.length;
    var parts = [];
    if (first && who && who !== 'you') parts.push('<b>' + W.PEOPLE[who].short + '</b> has waited longest.');
    if (n) parts.push('Hercule noticed ' + (words[n] || n + ' things') + '.');
    return parts.join(' ');
  }

  /** Returns how many cards are past the patience their kind declares. It is the number the sidebar shows. */
  function countOverdue() {
    var over = state.entities.filter(function (e) {
      return !e.settled && !e.task && !e.leaving && K[e.kind].pace === 'fast' && (state.now - e.since) / 36e5 >= K[e.kind].patience;
    }).length;
    return over + state.clusters.length;
  }

  function drawBar() {
    sum.innerHTML = saySummary();
    var seen = {};
    state.entities.forEach(function (e) { if (!e.settled) seen[K[e.kind].plugin.mark] = K[e.kind].plugin; });
    var marks = Object.keys(seen);
    document.getElementById('sources').innerHTML = marks.map(function (m) {
      return '<button class="ib-src' + (state.dim === m ? ' is-on' : '') + '" data-dim="' + m + '" title="Show only ' + seen[m].name + '" aria-pressed="' + (state.dim === m) + '">' + Card.drawMark(seen[m], 15) + '</button>';
    }).join('');
    Nav.setCount('inbox', countOverdue());
  }

  function drawFrame() {
    page.innerHTML =
      '<div class="noticed" id="noticed"></div>' +
      COLUMNS.map(function (names) {
        return '<div class="col">' + names.map(function (n) {
          return '<section class="stack-wrap" data-wrap="' + n + '" aria-label="' + STACKS[n].title + '">' +
            '<h2 class="stack-h"><span>' + STACKS[n].title + '</span><small data-count="' + n + '"></small></h2>' +
            '<div class="stack" data-stack="' + n + '"></div>' +
            '<button class="stack-foot" data-foot="' + n + '" hidden></button></section>';
        }).join('') + '</div>';
      }).join('');
  }

  function drawNoticed() {
    var host = document.getElementById('noticed');
    host.innerHTML = state.clusters.slice(0, 3).map(Card.drawPlaque).join('');
    host.hidden = !state.clusters.length;
    document.querySelector('.ib-page').classList.toggle('no-noticed', !state.clusters.length);
  }

  /** Lays every stack out again. Cards move by their transform alone, so each one glides to its new place. */
  function layOut() {
    COLUMNS.forEach(function (names, ci) {
      var col = page.querySelectorAll('.col')[ci];
      var depth = col.clientHeight - names.length * HEAD - (names.length - 1) * BETWEEN;
      var built = names.map(function (n) {
        var host = page.querySelector('[data-stack="' + n + '"]');
        var parts = readStackEntities(n);
        var items = buildItems(n, parts.lying);
        var kept = {};
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
          var e = it.e, el = els[e.id];
          if (!el) {
            el = els[e.id] = Card.createCard(e, readCtx(n));
            el.classList.add('is-new');
            host.appendChild(el);
          }
          if (el.parentNode !== host) host.appendChild(el);
          var m = Stacks.METRICS[K[e.kind].density];
          it.el = el; it.full = measureWhole(el, e); it.two = m.two; it.one = m.one; it.gap = m.gap;
        });
        tabs.forEach(function (t) { if (!kept[t.dataset.tab]) t.remove(); });
        var whole = items.reduce(function (a, m) { return a + (m.tab ? m.tab : m.full + m.gap); }, 0);
        var firstCard = items[0] && items[0].tab ? 1 : 0;
        var least = items.reduce(function (a, m, j) { return a + (m.tab ? m.tab : j === firstCard ? m.full : m.one); }, 0);
        var footNeeded = parts.settled.length ? FOOT : 0;
        return { name: n, host: host, items: items, parts: parts, whole: whole + footNeeded, least: least + footNeeded, foot: footNeeded };
      });
      var depths = Stacks.shareDepth(built, depth);
      var leftover = depth - depths.reduce(function (a, b) { return a + b; }, 0);
      built.forEach(function (b, bi) {
        var d = depths[bi] - b.foot;
        var plan = Stacks.layOut(b.items, d);
        // A stack that is not the last of its column closes up on what follows; the last takes what is left.
        var isLast = bi === built.length - 1;
        var used = plan.used;
        var height = isLast ? d + leftover : Math.min(d, used);
        if (!isLast) leftover += d - height;
        b.host.parentNode.style.height = height + HEAD + b.foot + 'px';
        b.host.dataset.depth = height;
        var shown = plan.items.length;
        b.items.forEach(function (it, i) {
          var p = plan.items[i];
          var el = it.el;
          if (!p) { el.style.display = 'none'; el._plan = null; return; }
          el.style.display = '';
          var next = b.items[i + 1];
          var endOfRun = i === shown - 1 || (next && next.tab);
          el._plan = p;
          el.style.zIndex = i + 1;
          el.style.transform = 'translate3d(0,' + p.y + 'px,0)';
          if (it.tab) return;
          el._rest = p.level === 'full' || !endOfRun ? it.full : p.show;
          el._full = it.full;
          if (!el.classList.contains('is-peek')) el.style.height = el._rest + 'px';
          el.classList.toggle('is-whole', p.level === 'full');
          el.dataset.level = p.level;
          el.classList.toggle('is-run-end', !!endOfRun);
        });
        var lying = b.parts.lying.filter(function (e) { return !e.leaving; }).length;
        page.querySelector('[data-count="' + b.name + '"]').textContent = lying || '';
        drawFoot(b, plan);
        drawEmpty(b, lying);
      });
    });
    drawBar();
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
    var pile = b.host.querySelector('.pile');
    if (plan.folded) {
      if (!pile) { pile = document.createElement('button'); pile.className = 'pile'; b.host.appendChild(pile); }
      pile.innerHTML = '<span class="pile-edges"></span><span class="pile-n">' + plan.folded + ' newer</span>';
      pile.style.transform = 'translate3d(0,' + (plan.used + 4) + 'px,0)';
      pile.dataset.pile = b.name;
    } else if (pile) pile.remove();
  }

  /** Redraws one card's insides after its entity changed, keeping the element so its place and motion carry on. */
  function redrawCard(e) {
    var el = els[e.id];
    if (!el) return;
    var keep = ['is-whole', 'is-peek', 'is-hover', 'is-focus', 'is-run-end'].filter(function (c) { return el.classList.contains(c); });
    el.className = Card.cardClasses(e);
    keep.forEach(function (c) { el.classList.add(c); });
    el.innerHTML = Card.drawCardBody(e, readCtx(readStack(e)));
    delete measured[e.id];
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

  /** Clears the page and draws a scene from scratch. */
  function load(scene) {
    state.entities = scene.entities;
    state.clusters = scene.clusters;
    state.now = scene.now || W.NOW;
    state.scene = scene.name;
    state.dim = null;
    els = {}; measured = {};
    document.querySelector('.ib-page').dataset.scene = scene.name;
    drawFrame();
    drawNoticed();
    if (scene.page) { page.dataset.mode = scene.page; }
    layOut();
  }

  function start() {
    page = document.getElementById('page');
    sum = document.getElementById('sum');
    var timer;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { measured = {}; layOut(); }, 60);
    });
    document.addEventListener('click', function (ev) {
      var d = ev.target.closest('[data-dim]');
      if (d) setDim(d.dataset.dim);
    });
    Scenes.play(params.get('scene') || 'morning');
    document.fonts.ready.then(function () { measured = {}; layOut(); });
  }

  return {
    state: state, els: function () { return els; }, STACKS: STACKS, COLUMNS: COLUMNS, findEntity: findEntity, readStack: readStack, readStackEntities: readStackEntities, layOut: layOut, redrawCard: redrawCard, drawNoticed: drawNoticed, drawBar: drawBar,
    load: load, setDim: setDim, start: start, measured: function () { return measured; }, removeEl: function (id) { if (els[id]) { els[id].remove(); delete els[id]; } },
  };
})();
