// A signal landing on a card: the one moment the Inbox lets itself be noticed. The card takes a small knock from above, its
// line rolls over to the new sentence, the count ticks, and a rim of light fades. The card never changes place.
window.Landing = (function () {
  var K = Kinds.KINDS;

  /**
   * Rolls a card's second line from the old sentence to the one now drawn. Both move together on one curve, 16px apart, and the
   * line clips them, so the two sentences never show at once. `old` is a copy of the old line.
   */
  function rollLine(el, old) {
    var line = el.querySelector('.c-line');
    var roll = line && line.querySelector('.c-roll');
    if (!roll || Motion.isReduced()) return;
    var clip = document.createElement('div');
    clip.className = 'c-line-clip';
    clip.style.left = line.offsetLeft + 'px';
    clip.style.top = line.offsetTop + 'px';
    clip.style.width = line.offsetWidth + 'px';
    clip.style.height = line.offsetHeight + 'px';
    [].forEach.call(old.querySelectorAll('.c-fresh'), function (d) { d.style.visibility = 'hidden'; });
    old.style.margin = '0';
    clip.appendChild(old);
    el.appendChild(clip);
    var curve = Motion.curve('hand');
    line.style.overflow = 'hidden';
    Motion.animate(old, [{ transform: 'none' }, { transform: 'translateY(-16px)' }], { duration: curve.ms, easing: curve.ease }).then(function () { clip.remove(); });
    Motion.animate(roll, [{ transform: 'translateY(16px)' }, { transform: 'none' }], { duration: curve.ms, easing: curve.ease }).then(function () { line.style.overflow = ''; });
  }

  /** Tells a screen reader what just happened, without taking focus. */
  function announce(text) { document.getElementById('announcer').textContent = text; }

  /** Applies a signal to its card: the line rolls, the count ticks, the rim lights, and the card takes the knock. */
  function apply(e, s, el) {
    var old = el.querySelector('.c-line') ? el.querySelector('.c-line').cloneNode(true) : null;
    e.signals.push(s);
    e.fresh = true;
    if (s.state) e.fields.state = s.state;
    App.redrawCard(e);
    if (Open.current() === e.id) Open.refresh();
    if (old) rollLine(el, old);
    el.dataset.landed = (K[e.kind].reasons[s.key] || {}).tone || 'plain';
    el.classList.remove('is-landed');
    void el.offsetWidth;
    el.classList.add('is-landed');
    setTimeout(function () { el.classList.remove('is-landed'); }, 1300);
    Motion.knock(el, 145);
    var n = el.querySelector('.c-more');
    if (n && !n.hidden) Motion.animate(n, [{ transform: 'translateY(6px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, delay: 160, fill: 'backwards', easing: 'cubic-bezier(.22,.9,.24,1)' });
  }

  /**
   * Lands a signal on an entity. What caused the change shows first: a small drop falls onto the card, or onto its row on the card
   * it rides on, and only then does it react. Nothing changes place, not even a part that now asks more than its lead.
   */
  function land(e, s) {
    var el = App.els()[e.id];
    announce(K[e.kind].noun + ' ' + Card.fill(K[e.kind].identifier, e.fields) + ': ' + Card.sayReason(K[e.kind], s).text);
    var tone = (K[e.kind].reasons[s.key] || {}).tone || 'plain';
    var row = !el && document.querySelector('.part[data-id="' + e.id + '"]');
    if (Motion.isReduced() || (!el && !row)) { if (el) apply(e, s, el); else applyToRow(e, s, tone); return; }
    var spot = (el ? el.querySelector('.c-line') : row.querySelector('.p-line')).getBoundingClientRect();
    dropOnto(spot.left + 3, (el || row).getBoundingClientRect().top - 24, spot.top + spot.height / 2, tone);
    setTimeout(function () { if (el) apply(e, s, el); else applyToRow(e, s, tone); }, 281);
  }

  /** Applies a signal to something riding on a card: its row changes its words and lights its rim. */
  function applyToRow(e, s, tone) {
    e.signals.push(s);
    e.fresh = true;
    if (s.state) e.fields.state = s.state;
    if (Open.current() === e.id) Open.refresh();
    App.layOut(true);
    var row = document.querySelector('.part[data-id="' + e.id + '"]');
    if (!row) return;
    row.dataset.landed = tone;
    row.classList.add('is-landed');
    setTimeout(function () { row.classList.remove('is-landed'); }, 1300);
    var said = row.querySelector('.p-line');
    if (said && !Motion.isReduced()) Motion.animate(said, [{ transform: 'translateY(5px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 240, easing: 'cubic-bezier(.22,.9,.24,1)' });
  }

  /** Lets a small drop fall from `from` onto the point x, y. It falls long enough to be seen, stretching as it goes, and flattens on contact at 281ms. */
  function dropOnto(x, from, y, tone) {
    var drop = document.createElement('i');
    drop.className = 'drop drop--' + tone;
    document.body.appendChild(drop);
    drop.animate([
      { transform: 'translate3d(' + x + 'px,' + from + 'px,0) scale(.7,1)', opacity: 0 },
      { transform: 'translate3d(' + x + 'px,' + (from + 12) + 'px,0) scale(.85,1.2)', opacity: 1, offset: 0.2 },
      { transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(.85,1.35)', opacity: 1, offset: 0.78, easing: 'linear' },
      { transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(1.5,.55)', opacity: 1, offset: 0.84 },
      { transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(1.5,.55)', opacity: 0 },
    ], { duration: 360, easing: 'cubic-bezier(.4,0,.9,.8)' }).finished.then(function () { drop.remove(); });
  }

  /** Brings a new card down into its place, with the rim every arrival gets. */
  function settleArrival(el) {
    if (!el) return;
    el.classList.remove('is-new');
    Motion.body(el.parentNode).set({ y: -20, o: 0 }).to({ y: 0, o: 1 }, 'self');
    // The rim waits until the card can be seen.
    setTimeout(function () {
      el.dataset.landed = 'plain';
      el.classList.add('is-landed');
      setTimeout(function () { el.classList.remove('is-landed'); }, 1300);
    }, 200);
  }

  return { rollLine: rollLine, land: land, announce: announce, settleArrival: settleArrival };
})();
