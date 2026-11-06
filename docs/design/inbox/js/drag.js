// Pick a card up and hand it to a colleague. Lifting a card raises a rail of those who can take it; the card leans into the
// pointer, and near a target it is pulled in. Letting go anywhere else sends it home.
window.Drag = (function () {
  var START = 6;       // px of travel before a press turns into a drag
  var REACH = 96;      // px around a target where its pull begins
  var rail, ghost = null, source = null, entity = null, targets = [], pressed = null;
  var grip = { x: 0, y: 0 }, active = null, last = 0, cancelled = false, fling = { x: 0, y: 0 }, rest = 0;

  function drawRail(e) {
    var flows = Card.readWorkflows(e);
    var who = flows.map(function (w, i) {
      return '<button class="rail-t" data-target="hand" data-i="' + i + '">' + Crew.face(w.name, { pose: 'idle', size: 40 }) + '<span>' + Card.esc(w.name) + '</span></button>';
    }).join('');
    rail.innerHTML = who +
      '<button class="rail-t" data-target="take">' + Card.drawPerson('you', 40) + '<span>Take it on</span></button>' +
      '<i class="rail-rule"></i>' +
      '<button class="rail-t rail-t--plain" data-target="dismiss"><i class="rail-x">' + Crew.icon('close', 18) + '</i><span>Dismiss</span></button>';
  }

  function begin(ev) {
    var card = pressed.card;
    entity = App.findEntity(card.dataset.id);
    source = card;
    Pointer.setHover(null);
    Pointer.unpeek();
    var r = card.getBoundingClientRect();
    var whole = card._full || r.height;
    ghost = card.cloneNode(true);
    ghost.classList.add('ghost', 'is-whole');
    ghost.classList.remove('is-hover', 'is-focus', 'is-peek');
    ghost.dataset.level = 'full';
    ghost.style.cssText = 'width:' + r.width + 'px;height:' + (card._plan ? card._plan.show : r.height) + 'px;left:0;top:0;right:auto;z-index:80';
    document.body.appendChild(ghost);
    void ghost.offsetHeight;
    ghost.style.height = whole + 'px';
    grip = { x: pressed.x - r.left, y: pressed.y - r.top };
    last = r.left;
    Motion.body(ghost).set({ x: r.left, y: r.top, s: 1 });
    source.classList.add('is-lifted');
    document.documentElement.dataset.dragging = '1';
    drawRail(entity);
    rail.hidden = false;
    targets = [].map.call(rail.querySelectorAll('.rail-t'), function (t) { return { el: t, r: null }; });
    targets.forEach(function (t, i) { t.el.style.setProperty('--i', i); });
    // The rail is measured where it will rest, because it rises as it appears.
    rail.style.transition = 'none';
    rail.style.transform = 'translate(-50%, 0)';
    targets.forEach(function (t) { t.r = t.el.getBoundingClientRect(); });
    rail.style.transform = '';
    void rail.offsetWidth;
    rail.style.transition = '';
    rail.classList.add('is-on');
  }

  /** Puts the ghost under the pointer this frame, one to one. Only its scale and its lean ride a spring. */
  function place(x, y) {
    var b = Motion.body(ghost);
    var lean = Motion.isReduced() ? 0 : Math.max(-3.5, Math.min(3.5, (x - last) * 0.28));
    last = x;
    b.follow(x, y);
    // follow leaves a speed behind, for a throw. While carried the card goes exactly where the pointer is.
    fling = { x: b.speed.x, y: b.speed.y };
    b.speed.x = 0;
    b.speed.y = 0;
    b.to({ r: lean, s: active ? 0.62 : 1.03, l: 1 }, 'hand');
    clearTimeout(rest);
    rest = setTimeout(function () { if (ghost) Motion.body(ghost).to({ r: 0 }, 'hand'); }, 48);
  }

  function track(ev) {
    var x = ev.clientX - grip.x, y = ev.clientY - grip.y;
    var best = null, dist = REACH;
    targets.forEach(function (t) {
      if (!t.r) return;
      var cx = t.r.left + t.r.width / 2, cy = t.r.top + t.r.height / 2;
      var d = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      if (d < dist) { dist = d; best = t; }
    });
    if (best !== active) {
      if (active) active.el.classList.remove('is-near');
      active = best;
      if (active) active.el.classList.add('is-near');
    }
    if (active) {
      var pull = 1 - dist / REACH, w = ghost.offsetWidth, h = ghost.offsetHeight;
      var cx = active.r.left + active.r.width / 2 - w / 2, cy = active.r.top + active.r.height / 2 - h / 2;
      var k = pull * pull * (3 - 2 * pull);
      place(x + (cx - x) * k, y + (cy - y) * k);
    } else place(x, y);
  }

  function finish(cancel) {
    delete document.documentElement.dataset.dragging;
    var g = ghost, s = source, e = entity, t = active;
    ghost = null; source = null; entity = null; active = null; pressed = null;
    var chosen = t && !cancel;
    if (t) t.el.classList.remove('is-near');
    // The rail stays long enough for the card to be seen to arrive, and only then goes.
    setTimeout(function () { rail.classList.remove('is-on'); }, chosen ? 340 : 0);
    setTimeout(function () { if (!rail.classList.contains('is-on')) rail.hidden = true; }, chosen ? 720 : 380);
    var body = Motion.body(g);
    var home = s.getBoundingClientRect();
    if (chosen) Motion.animate(t.el.firstElementChild, [{ transform: 'scale(1.16)' }, { transform: 'scale(1.26)', offset: 0.4 }, { transform: 'scale(1)' }], { duration: 340, easing: 'ease-out' });
    // A card dropped on Dismiss leaves from the rail. Going home first would be the gesture backwards.
    if (chosen && t.el.dataset.target === 'dismiss') {
      body.to({ s: 0.3, o: 0 }, 'hand', { done: function () { g.remove(); } });
      s.classList.remove('is-lifted');
      Moves.dismiss(e, true);
      return;
    }
    // One object, one place: the card goes home, and what was chosen comes to it there.
    g.style.height = (s._plan ? s._plan.show : home.height) + 'px';
    var land = function () {
      // The real card takes over from the ghost in mid-air, so the chain plays on something that can be seen.
      var box = g.getBoundingClientRect(), b = Motion.body(g);
      g.remove();
      s.style.transition = 'none';
      s.classList.remove('is-lifted');
      var rest = s.getBoundingClientRect();
      var card = Motion.body(s);
      card.set({ x: box.left - rest.left, y: box.top - rest.top, s: b.value.s });
      card.speed.x = b.speed.x;
      card.speed.y = b.speed.y;
      var z = s.style.zIndex;
      s.style.zIndex = 400;
      card.to({ x: 0, y: 0, s: 1 }, 'travel', { done: function () { s.style.zIndex = z; s.style.transition = ''; } });
      var what = t.el.dataset.target;
      if (what === 'hand') Moves.hand(e, Card.readWorkflows(e)[Number(t.el.dataset.i)]);
      else Moves.perform(what, e.id);
    };
    // The chain starts as the card comes in to land, so a drop is answered at once.
    if (chosen) setTimeout(land, 200);
    body.speed.x = fling.x;
    body.speed.y = fling.y;
    clearTimeout(rest);
    body.to({ x: home.left, y: home.top, s: 1, r: 0, l: 0 }, 'travel', { done: function () {
      if (chosen) return;
      g.remove();
      s.style.transition = 'none';
      s.classList.remove('is-lifted');
      void s.offsetWidth;
      s.style.transition = '';
    } });
  }

  function start() {
    rail = document.getElementById('rail');
    var page = document.getElementById('page');
    page.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0 || ev.target.closest('[data-act], .is-pile')) return;
      var card = ev.target.closest('.card');
      if (!card || card.dataset.height === 'flat') return;
      pressed = { card: card, x: ev.clientX, y: ev.clientY };
    });
    window.addEventListener('pointermove', function (ev) {
      if (!pressed) return;
      if (!ghost && Math.hypot(ev.clientX - pressed.x, ev.clientY - pressed.y) > START) begin(ev);
      if (ghost) track(ev);
    });
    window.addEventListener('pointerup', function (ev) {
      if (ghost) { finish(false); swallowClick(); }
      if (cancelled) { cancelled = false; swallowClick(); }
      pressed = null;
    });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && ghost) { ev.stopPropagation(); finish(true); cancelled = true; } }, true);
  }

  /** Stops the click that ends a drag from opening the card. */
  function swallowClick(ms) {
    var stop = function (ev) { ev.stopPropagation(); ev.preventDefault(); window.removeEventListener('click', stop, true); };
    window.addEventListener('click', stop, true);
    setTimeout(function () { window.removeEventListener('click', stop, true); }, ms || 50);
  }

  return { start: start };
})();
