// The Inbox: state, and drawing the page from it. Moves, keys, the open card and the scenes live in their own files and go through
// the methods here. Two shapes of card say how much attention a thing deserves: the lasting work lies wide, in rich cards under the
// places it is part of, and the small requests lie in a narrow column of compact cards.
window.App = (function () {
  var K = Kinds.KINDS, W = World;
  var params = new URLSearchParams(location.search);

  var state = { scene: 'morning', now: W.NOW, entities: [], clusters: [], open: null, page: 'inbox', mode: 'cards', stale: null, grouping: 'home', order: 'oldest', showParked: false, filters: [] };
  var els = {};        // card elements by entity id
  var blocks = {};     // the block of each place by id, kept so a place keeps its element through a redraw
  var page;
  var waiting = [];    // new cards held back while the pointer is in their part of the page
  var seenRank = {};   // the order of the work as first drawn, so nothing changes place during a visit

  function findEntity(id) { return state.clusters.filter(function (c) { return c.id === id; })[0] || Relations.find(id); }
  function isRich(e) { return K[e.kind].card === 'rich'; }

  /** Returns what the page shows: everything that concerns the person and has not settled. */
  function readLying() { return state.entities.filter(function (e) { return e.concern && !e.settled && !e.dismissed; }); }

  /** Returns how many things wait on the clock. It is the number the sidebar shows. */
  function countOverdue() { return readLying().filter(function (e) { return !e.task && K[e.kind].pace === 'fast'; }).length; }

  /** Returns how many things are left anywhere on the page. */
  function countLeft() { return waiting.length + readLying().filter(function (e) { return !e.task; }).length + state.clusters.filter(function (c) { return !c.task; }).length; }

  /** Returns the card of an entity, making it the first time. */
  function readCard(e, place) {
    if (!els[e.id]) els[e.id] = Card.createCard(e, { now: state.now, place: place });
    return els[e.id];
  }

  /** Writes the sheet tucked under a card, with the things that ride on it, or takes it away when there are none. */
  function drawParts(card, parts, host) {
    var sheet = host.querySelector(':scope > .tucked');
    if (!parts.length) { if (sheet) sheet.remove(); return; }
    if (!sheet) { sheet = document.createElement('div'); sheet.className = 'tucked'; host.appendChild(sheet); }
    sheet.innerHTML = parts.map(function (p) { return Card.drawPart(p, { now: state.now }); }).join('');
  }

  /** Writes the quiet lines under a thing: references found in text, which join nothing by themselves, and peers it does not ride on. */
  function drawHint(bundle, host) {
    var e = bundle.lead;
    [].forEach.call(host.querySelectorAll(':scope > .hint'), function (x) { x.remove(); });
    Relations.readHints(e).forEach(function (h) {
      var word = Relations.isMentioner(h, e) ? 'Mentions ' : 'Mentioned in ';
      host.insertAdjacentHTML('beforeend', '<button class="hint" data-hint="' + e.id + '" data-other="' + h.other.id + '" tabindex="-1" title="' + Card.esc(Relations.sayClaim(h.claim)) + '">' + Crew.icon('link', 12) + '<span>' + word + Card.esc(Card.sayReference(h.other)) + '</span><b>Link them</b></button>');
    });
    (bundle.peers || []).forEach(function (l) {
      host.insertAdjacentHTML('beforeend', '<button class="hint" data-peer="' + l.other.id + '" tabindex="-1" title="' + Card.esc(Relations.sayClaim(l.claim)) + '">' + Crew.icon('link', 12) + '<span>Linked to ' + Card.esc(Card.sayReference(l.other)) + '</span></button>');
    });
  }

  /** Returns the wrapper of a card and what rides on it. */
  function readBundle(bundle, place) {
    var card = readCard(bundle.lead, place);
    if (card._place !== place) {
      card._place = place;
      var context = card.querySelector('.c-context');
      if (context) context.outerHTML = Card.drawContext(bundle.lead, { now: state.now, place: place });
    }
    var host = card.parentNode && card.parentNode.classList.contains('bundle') ? card.parentNode : document.createElement('div');
    host.className = 'bundle';
    if (card.parentNode !== host) host.appendChild(card);
    drawParts(card, bundle.parts, host);
    drawHint(bundle, host);
    return host;
  }

  /** Returns whether a bundle passes the filters. A bundle shows when its lead or a part does, so a thing is never torn from what it rides on. */
  function passesFilters(b) {
    var things = [b.lead].concat(b.parts.filter(function (p) { return p.rides; }).map(function (p) { return p.e; }));
    return state.filters.every(function (f) {
      return things.some(function (e) {
        if (f.facet === 'owner') return Card.isMine(e) === (f.value === 'mine') && !!e.concern;
        return Relations.readAncestors(e).some(function (p) { return p.id === f.value; });
      });
    });
  }

  /** Returns the groupings the wide side offers: the usual homes, every kind of place above what lies there, and status. */
  function readGroupings() {
    var nouns = {}, rows = readLying().filter(isRich);
    rows.forEach(function (e) {
      var seen = {};
      // A thing that is itself work, such as a parent ticket, is not a level to group by.
      Relations.readAncestors(e).forEach(function (p) { if (!p.concern) seen[K[p.kind].noun] = true; });
      Object.keys(seen).forEach(function (n) { nouns[n] = (nouns[n] || 0) + 1; });
    });
    // A level that most rows have nothing to do with would only say "not in any", so it is not offered.
    var useful = Object.keys(nouns).filter(function (n) { return nouns[n] * 2 >= rows.length; });
    return [['home', 'Place']].concat(useful.map(function (n) { return [n, n]; })).concat([['status', 'Status']]);
  }

  /** Returns the places a thing shows under for the grouping in use. It shows under each of them, and is still counted once. */
  function readPlaces(e) {
    if (state.grouping === 'home') return Relations.readHomes(e);
    if (state.grouping === 'status') {
      var status = K[e.kind].status && K[e.kind].status[e.fields.state];
      var byTone = { bad: 0, attention: 1, active: 2, quiet: 3, good: 4 };
      return [{ id: 'status-' + (status ? status.word : 'none'), title: status ? status.word : 'No status', isPlain: true, rank: status ? byTone[status.tone] * 100 + Object.keys(K[e.kind].status).indexOf(e.fields.state) : 9000 }];
    }
    return Relations.readAncestors(e).filter(function (p) { return K[p.kind].noun === state.grouping; });
  }

  /** Returns how far along the source says a place is. Nothing is worked out from the cards on this page. */
  function drawProgress(place) {
    if (!place.progress) return '';
    var p = place.progress, share = Math.round((p.done / p.total) * 100);
    return '<div class="b-progress" role="img" aria-label="' + p.done + ' of ' + p.total + ' done"><i style="width:' + share + '%"></i></div><span class="b-count">' + p.done + ' of ' + p.total + '</span>';
  }

  /** Returns the head of a block: the place, how it stands, how far along the source says it is, and what it in turn is part of. */
  function drawBlockHead(place) {
    if (place.isPlain) return '<header class="b-head b-head--plain"><h3 class="b-title">' + Card.esc(place.title) + '</h3></header>';
    var kind = K[place.kind];
    var above = Relations.readParents(place);
    return '<header class="b-head"><button class="b-open" data-id="' + place.id + '" tabindex="-1"><span class="b-mark">' + Card.drawMark(kind.plugin, 16) + '</span><h3 class="b-title">' + Card.esc(place.title) + '</h3></button>' +
      Card.drawStatus(place, 15) + '<span class="b-end">' + drawProgress(place) + (place.fields.target ? '<span class="b-target">' + Card.esc(place.fields.target) + '</span>' : '') + '</span>' +
      (above.length ? '<p class="b-above">' + above.map(function (p) { return Card.esc(p.title); }).join('<i>·</i>') + '</p>' : '') + '</header>';
  }

  /** Orders the places: what is in trouble first, then what is due soonest, and places with no date last. */
  function rankPlace(place) {
    if (place.rank !== undefined) return place.rank;
    var kind = K[place.kind], status = kind.status && kind.status[place.fields.state];
    var trouble = { bad: 0, attention: 1 }[status && status.tone];
    var days = place.fields.targetAt ? Math.round((place.fields.targetAt - state.now) / 864e5) : 500;
    return (trouble === undefined ? 2 : trouble) * 1000 + days;
  }

  /** Orders the work of a block: what has a part asking first, then by how far along it is. */
  function rankWork(b) {
    if (seenRank[b.lead.id] === undefined) seenRank[b.lead.id] = computeRank(b);
    return seenRank[b.lead.id];
  }

  function computeRank(b) {
    var asks = b.parts.some(function (p) { return p.rides && p.e.concern && !p.e.task; }) ? 0 : 1;
    var kind = K[b.lead.kind], states = kind.status ? Object.keys(kind.status) : [];
    return asks * 100 - states.indexOf(b.lead.fields.state);
  }

  /** Draws the wide side: the lasting work, by place, each block with its sections when the kind declares them. */
  function drawWork(bundles) {
    var host = page.querySelector('#work');
    var byPlace = {}, order = [];
    bundles.forEach(function (b) {
      var places = readPlaces(b.lead);
      if (!places.length) places = [{ id: 'elsewhere', title: state.grouping === 'home' ? 'Elsewhere' : 'Not in any ' + state.grouping.toLowerCase(), isPlain: true, rank: 90000 }];
      places.forEach(function (p, i) {
        if (!byPlace[p.id]) { byPlace[p.id] = { place: p, work: [] }; order.push(p.id); }
        byPlace[p.id].work.push({ b: b, also: places.filter(function (x) { return x !== p; }), echo: i > 0 ? 1 : 0 });
      });
    });
    var sorted = order.map(function (id) { return byPlace[id]; }).sort(function (a, c) { return rankPlace(a.place) - rankPlace(c.place); });
    var seen = {};
    sorted.forEach(function (entry) {
      var id = entry.place.id;
      seen[id] = true;
      var block = blocks[id];
      if (!block) {
        block = blocks[id] = document.createElement('section');
        block.className = 'block';
        block.dataset.place = id;
        block.innerHTML = '<i class="card-stock"></i>';
      }
      var head = block.querySelector(':scope > .b-head');
      if (head) head.remove();
      block.firstChild.insertAdjacentHTML('afterend', drawBlockHead(entry.place));
      var grid = block.querySelector(':scope > .b-work');
      if (!grid) { grid = document.createElement('div'); grid.className = 'b-work'; block.appendChild(grid); }
      entry.work.sort(function (a, c) { return (a.echo - c.echo) || rankWork(a.b) - rankWork(c.b); }).forEach(function (w) {
        // The same thing under a second place is a plain pointer, so it is never two cards to act on.
        if (w.echo) { grid.insertAdjacentHTML('beforeend', '<button class="echo" data-id="' + w.b.lead.id + '" tabindex="-1"><span class="c-rail">' + Card.drawStatus(w.b.lead, 15) + '</span><span class="echo-t">' + Card.esc(w.b.lead.title) + '</span><small>Also in ' + Card.esc(w.also[0].title) + '</small></button>'); return; }
        grid.appendChild(readBundle(w.b, entry.place));
      });
      host.appendChild(block);
    });
    Object.keys(blocks).forEach(function (id) { if (!seen[id]) { blocks[id].remove(); } });
    [].forEach.call(host.querySelectorAll('.echo'), function (x, i, all) {
      // Pointers are drawn fresh each time, so an older copy of the same pointer goes.
      var twin = [].filter.call(all, function (y) { return y !== x && y.dataset.id === x.dataset.id && y.parentNode === x.parentNode; })[0];
      if (twin && [].indexOf.call(all, twin) > i) x.remove();
    });
  }

  /** Draws the narrow column: the small requests, oldest first or by the place they belong to. */
  function drawRequests(bundles) {
    var host = page.querySelector('#requests');
    var sorted = bundles.slice().sort(function (a, c) { return a.lead.since - c.lead.since; });
    if (state.order === 'mine') sorted.sort(function (a, c) { return Card.isMine(c.lead) - Card.isMine(a.lead); });
    var label = null;
    [].forEach.call(host.querySelectorAll('.r-label'), function (l) { l.remove(); });
    if (state.order === 'place') sorted.sort(function (a, c) { return readPlaceName(a.lead).localeCompare(readPlaceName(c.lead)); });
    sorted.forEach(function (b) {
      var name = readPlaceName(b.lead);
      if (state.order === 'place' && name !== label) { label = name; host.insertAdjacentHTML('beforeend', '<h3 class="r-label">' + Card.esc(name) + '</h3>'); }
      host.appendChild(readBundle(b, null));
    });
  }

  function readPlaceName(e) { return (Relations.readHomes(e)[0] || { title: 'Elsewhere' }).title; }

  /** Draws the things that settled, inside a disclosure at the foot of the column. They open in place. */
  function drawParked() {
    var host = page.querySelector('#parked');
    var list = state.entities.filter(function (e) { return e.concern && e.settled && !e.dismissed && !(e.task && e.task.by === 'you'); });
    host.hidden = !list.length;
    host.querySelector('[data-parked]').innerHTML = '<i class="chev"></i><span>With someone else</span><small>' + list.length + '</small>';
    host.querySelector('[data-parked]').setAttribute('aria-expanded', state.showParked);
    host.classList.toggle('is-open', state.showParked);
    var cards = host.querySelector('.parked-cards');
    cards.innerHTML = '';
    if (state.showParked) list.forEach(function (e) { cards.appendChild(Card.createCard(e, { now: state.now })); });
  }

  /** Draws both sides from state, and removes what no longer lies on the page. */
  function placeCards() {
    // A grouping whose level has emptied gives way to the usual one, so the control never reads blank.
    if (!readGroupings().some(function (g) { return g[0] === state.grouping; })) state.grouping = 'home';
    var scroller = page, top = scroller.scrollTop;
    var bundles = Relations.buildBundles(readLying()).filter(passesFilters);
    var work = bundles.filter(function (b) { return isRich(b.lead); });
    var requests = bundles.filter(function (b) { return !isRich(b.lead); });
    var wanted = {};
    bundles.forEach(function (b) { wanted[b.lead.id] = true; });
    Object.keys(els).forEach(function (id) {
      if (wanted[id]) return;
      var host = els[id].parentNode;
      if (host && host.classList.contains('bundle') && !els[id].classList.contains('is-leaving')) host.remove();
      delete els[id];
    });
    [].forEach.call(page.querySelectorAll('.echo'), function (x) { x.remove(); });
    drawWork(work);
    drawRequests(requests);
    drawParked();
    Toolbar.draw();
    drawClear(work, requests);
    Nav.setCount('inbox', countOverdue());
    page.querySelector('[data-count="requests"]').textContent = requests.filter(function (b) { return !b.lead.task; }).length || '';
    page.dataset.by = state.grouping;
    var entry = page.querySelector('.plaque, .card');
    if (entry) entry.tabIndex = 0;
    // Redrawing a sheet can drop the focus inside it, and a browser then scrolls to the top. Neither may show.
    scroller.scrollTop = top;
    Keys.remark();
  }

  /** Raises a small sunrise in the column once no request is left, so finishing them is marked even though lasting work never ends. */
  function drawClear(work, requests) {
    var host = page.querySelector('#clear');
    // A filter hides things, it does not finish them, so the sunrise reads what is really left.
    var empty = !Relations.buildBundles(readLying()).some(function (b) { return !isRich(b.lead); }) && !waiting.length;
    var none = page.querySelector('.r-none');
    none.hidden = empty || requests.length > 0;
    host.hidden = !empty;
    if (empty && !host.innerHTML) host.innerHTML = Scenes.drawSunrise('zero zero--small');
    if (!empty) host.innerHTML = '';
    var nothing = page.querySelector('.work-empty');
    nothing.hidden = work.length > 0;
    nothing.textContent = state.filters.length ? 'Nothing here matches this filter.' : 'Nothing ongoing concerns you.';
  }

  /** Draws the page around the cards. */
  function drawFrame() {
    page.dataset.mode = 'cards';
    els = {}; blocks = {}; seenRank = {};
    page.innerHTML =
      '<div class="ib-wide">' +
        '<h2 class="sr">Hercule noticed</h2><div class="noticed" id="noticed" role="list"></div>' +
        '<header class="sec"><h2>Ongoing</h2></header>' +
        '<div id="work"></div><p class="work-empty" hidden>Nothing ongoing concerns you.</p>' +
      '</div>' +
      '<aside class="ib-narrow" aria-label="Requests">' +
        '<header class="sec"><h2>Requests</h2><span class="sec-n" data-count="requests"></span><label class="sec-pick"><select data-order aria-label="Order"><option value="oldest">Oldest first</option><option value="mine">Mine first</option><option value="place">By place</option></select></label></header>' +
        '<div id="requests" role="list"></div><p class="r-none" hidden>Nothing here matches this filter.</p><div id="clear" hidden></div>' +
        '<section class="parked" id="parked" hidden><button class="parked-t" data-parked></button><div class="parked-cards"></div></section>' +
      '</aside>';
    page.querySelector('[data-order]').value = state.order;
  }

  /** Draws what Hercule noticed. He stands behind the top edge, as a colleague does on Work: he is handing you something, not raising an alarm. */
  function drawNoticed() {
    var host = document.getElementById('noticed');
    if (!host) return;
    host.setAttribute('aria-label', 'Hercule noticed');
    host.innerHTML = '<span class="card-holder" title="Hercule noticed"><span class="card-head">' + Crew.peek('Hercule', { pose: 'idle', size: 30, crop: 34 }) + '</span></span>' +
      '<span class="card-paws" style="--hue:var(--hue-' + Crew.lookFor('Hercule').hue + ')"><i></i><i></i></span><i class="card-stock"></i>' + state.clusters.map(Card.drawPlaque).join('');
    host.hidden = !state.clusters.length;
    var was = Keys.current();
    if (Keys.isUsingKeys() && was && host.querySelector('[data-id="' + was + '"]')) Keys.focus(was);
  }

  /** Lays the page out again. Everything moves from wherever it is on screen, so a change in the middle of another bends its path. */
  function layOut(still, stagger) {
    if (state.mode !== 'cards') return;
    if (still) { placeCards(); return; }
    var moving = [].slice.call(page.querySelectorAll('.bundle, .block, .sec, .parked'));
    Motion.flip(moving, placeCards, { spring: 'hand', stagger: stagger });
    [].forEach.call(page.querySelectorAll('.bundle, .block'), function (b) { if (moving.indexOf(b) < 0 && !Motion.isReduced()) Motion.body(b).set({ o: 0, y: 8 }).to({ o: 1, y: 0 }, 'hand'); });
  }

  /** Redraws a card in place, and what rides on it. */
  function redrawCard(e) {
    var el = els[e.id];
    if (!el) { layOut(true); return; }
    var keep = ['is-hover', 'is-focus', 'is-source', 'is-lifted', 'is-landed', 'is-leaving'].filter(function (c) { return el.classList.contains(c); });
    el.className = Card.cardClasses(e);
    keep.forEach(function (c) { el.classList.add(c); });
    Card.redrawBody(el, e, { now: state.now, place: el._place });
    el.setAttribute('aria-label', Card.sayCard(e));
  }

  /** Lets every card someone holds settle. It runs when you come back, never while you watch. */
  function settle() {
    state.entities.forEach(function (e) { if (e.task || e.quiet) e.settled = true; });
    state.clusters = state.clusters.filter(function (c) { return !c.task; });
  }

  /** Draws the page again from state, after another view held it. */
  function redraw() {
    state.mode = 'cards';
    drawFrame();
    drawNoticed();
    placeCards();
    drawNotice();
    checkZero();
  }

  /** Redraws what Hercule noticed after it changed, and lets the page glide. */
  function reflowNoticed() {
    Motion.flip([].slice.call(page.querySelectorAll('.sec, .block')), drawNoticed, { spring: 'travel' });
  }

  /** Shows the empty Inbox once nothing is left at all. */
  function checkZero() {
    if (state.mode !== 'cards' || countLeft()) return false;
    settle();
    Scenes.showZero();
    return true;
  }

  /** Brings a new thing onto the page. While the pointer rests on a card it waits, so nothing moves under the hand. */
  function arrive(e) {
    if (state.entities.indexOf(e) >= 0 || state.entities.some(function (x) { return x.id === e.id; }) || waiting.some(function (x) { return x.id === e.id; })) return false;
    Relations.note(e);
    if (state.mode === 'zero') {
      state.entities.push(e);
      redraw();
      Motion.animate(page, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
      return true;
    }
    if (state.mode !== 'cards') { state.entities.push(e); return true; }
    if (Pointer.readHover()) { waiting.push(e); return false; }
    state.entities.push(e);
    layOut();
    return true;
  }

  /** Lets in what waited for the pointer, once it has left the cards. */
  function releaseArrivals() {
    if (!waiting.length || state.mode !== 'cards') return;
    var came = waiting;
    waiting = [];
    state.entities = state.entities.concat(came);
    layOut();
    came.forEach(function (e) { if (els[e.id]) Landing.settleArrival(els[e.id]); });
  }

  /** Loads a scene. */
  function load(scene) {
    waiting = [];
    state.entities = scene.entities;
    state.clusters = scene.clusters;
    state.now = scene.now || W.NOW;
    state.scene = scene.name;
    state.isLive = scene.name === 'morning' || (scene.name === 'zero' && state.isLive);
    state.mode = scene.mode || 'cards';
    state.notice = scene.notice || null;
    state.grouping = 'home';
    state.filters = [];
    state.order = 'oldest';
    state.showParked = false;
    Relations.load(state.entities, W.readContexts(), W.readRelations());
    page.dataset.scene = scene.name;
    page.dataset.mode = state.mode;
    if (scene.draw) { scene.draw(page); Nav.setCount('inbox', countOverdue()); return; }
    drawFrame();
    drawNoticed();
    placeCards();
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
    window.addEventListener('resize', function () { Open.fit(); });
    document.addEventListener('change', function (ev) {
      if (ev.target.matches('[data-order]')) { state.order = ev.target.value; layOut(); }
    });
    document.addEventListener('click', function (ev) {
      if (ev.target.closest('[data-parked]')) { state.showParked = !state.showParked; drawParked(); }
    });
    Scenes.play(params.get('scene') || 'morning');
  }

  return {
    state: state, readGroupings: readGroupings, els: function () { return els; }, findEntity: findEntity, isRich: isRich, readLying: readLying, countOverdue: countOverdue, countLeft: countLeft,
    releaseArrivals: releaseArrivals, layOut: layOut, redraw: redraw, redrawCard: redrawCard, drawNoticed: drawNoticed, reflowNoticed: reflowNoticed, checkZero: checkZero, arrive: arrive, load: load, settle: settle, drawNotice: drawNotice,
    forgetEl: function (id) { delete els[id]; }, start: start,
  };
})();
