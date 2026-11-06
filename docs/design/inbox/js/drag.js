// Pick a card up and hand it to a colleague. Lifting a card raises a rail of those who can take it; the card leans into the
// pointer, and near a target it is pulled in. Letting go anywhere else sends it home.
window.Drag = (function () {
  var START = 6;       // px of travel before a press turns into a drag
  var REACH = 96;      // px around a target where its pull begins
  var rail, ghost = null, source = null, entity = null, targets = [], pressed = null;
  var grip = { x: 0, y: 0 }, active = null, last = 0;

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
    rail.classList.remove('is-on');
    void rail.offsetWidth;
    rail.classList.add('is-on');
    targets.forEach(function (t, i) { t.el.style.setProperty('--i', i); });
    ghost.classList.add('is-rising');
    // The rail is measured at rest, because it rises as it appears.
    setTimeout(function () { targets.forEach(function (t) { t.r = t.el.getBoundingClientRect(); }); }, 380);
  }

  /** Puts the ghost under the pointer this frame, one to one, and leans it by its speed. Only scale and lean ride a spring. */
  function place(x, y) {
    var b = Motion.body(ghost);
    var lean = Math.max(-3.5, Math.min(3.5, (x - last) * 0.28));
    last = x;
    b.follow(x, y);
    b.to({ r: lean, s: active ? 0.62 : 1.03 }, 'hand');
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
      place(x + (cx - x) * (0.35 + pull * 0.65), y + (cy - y) * (0.35 + pull * 0.65));
    } else place(x, y);
  }

  function finish(cancel) {
    delete document.documentElement.dataset.dragging;
    var g = ghost, s = source, e = entity, t = active;
    ghost = null; source = null; entity = null; active = null; pressed = null;
    var chosen = t && !cancel;
    // The rail stays long enough for the card to be seen to arrive, and only then goes.
    setTimeout(function () { rail.classList.remove('is-on'); }, chosen ? 340 : 0);
    setTimeout(function () { if (!rail.classList.contains('is-on')) rail.hidden = true; }, chosen ? 720 : 380);
    var body = Motion.body(g);
    var home = s.getBoundingClientRect();
    if (chosen) Motion.animate(t.el.firstElementChild, [{ transform: 'scale(1.16)' }, { transform: 'scale(1.26)', offset: 0.4 }, { transform: 'scale(1)' }], { duration: 340, easing: 'ease-out' });
    // One object, one place: the card goes home, and what was chosen comes to it there.
    g.style.height = (s._plan ? s._plan.show : home.height) + 'px';
    body.to({ x: home.left, y: home.top, s: 1, r: 0 }, 'travel', { done: function () {
      g.remove();
      s.style.transition = 'none';
      s.classList.remove('is-lifted');
      void s.offsetWidth;
      s.style.transition = '';
      if (!chosen) return;
      var what = t.el.dataset.target;
      if (what === 'hand') Moves.hand(e, Card.readWorkflows(e)[Number(t.el.dataset.i)]);
      else Moves.perform(what, e.id);
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
      pressed = null;
    });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && ghost) { ev.stopPropagation(); finish(true); swallowClick(1500); } }, true);
  }

  /** Stops the click that ends a drag from opening the card. */
  function swallowClick(ms) {
    var stop = function (ev) { ev.stopPropagation(); ev.preventDefault(); window.removeEventListener('click', stop, true); };
    window.addEventListener('click', stop, true);
    setTimeout(function () { window.removeEventListener('click', stop, true); }, ms || 50);
  }

  return { start: start };
})();
