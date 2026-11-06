// A signal landing on a card: the one moment the Inbox lets itself be noticed. The card takes a small knock from above, its
// line rolls over to the new sentence, the count ticks, and a rim of light fades. The card never changes place.
window.Landing = (function () {
  var K = Kinds.KINDS;

  /** Rolls a card's second line from the old sentence to the one now drawn. `old` is a copy of the old line. */
  function rollLine(el, old) {
    var line = el.querySelector('.c-line');
    if (!line || Motion.isReduced()) return;
    old.classList.add('c-line--old');
    old.style.gridArea = 'auto';
    old.style.left = line.offsetLeft + 'px';
    old.style.top = line.offsetTop + 'px';
    old.style.width = line.offsetWidth + 'px';
    el.appendChild(old);
    Motion.animate(old, [{ transform: 'none', opacity: 1 }, { transform: 'translateY(-12px)', opacity: 0 }], { duration: 160, easing: 'cubic-bezier(.5,0,.8,.4)' }).then(function () { old.remove(); });
    Motion.animate(line, [{ transform: 'translateY(12px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: Motion.curve('hand').ms, delay: 40, fill: 'backwards', easing: Motion.curve('hand').ease });
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
    if (old) rollLine(el, old);
    el.dataset.landed = (K[e.kind].reasons[s.key] || {}).tone || 'plain';
    el.classList.remove('is-landed');
    void el.offsetWidth;
    el.classList.add('is-landed');
    setTimeout(function () { el.classList.remove('is-landed'); }, 1300);
    Motion.body(el).to({ y: 2 }, 'hand', { done: function () { Motion.body(el).to({ y: 0 }, 'hand'); } });
    var n = el.querySelector('.c-more');
    if (n && !n.hidden) Motion.animate(n, [{ transform: 'translateY(6px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, delay: 160, fill: 'backwards', easing: 'cubic-bezier(.22,.9,.24,1)' });
    App.layOut();
  }

  /**
   * Lands a signal on an entity. What caused the change shows first: a small drop falls onto the card, and only then does the
   * card react. The card never changes place.
   */
  function land(e, s) {
    var el = App.els()[e.id];
    announce(K[e.kind].noun + ' ' + Card.fill(K[e.kind].identifier, e.fields) + ': ' + Card.sayReason(K[e.kind], s).text);
    if (!el || !el._plan) {
      // A card folded in a pile cannot be shown, so the pile takes the knock.
      e.signals.push(s);
      e.fresh = true;
      var pile = [].filter.call(document.querySelectorAll('.card.is-pile'), function (p) { return (p._members || []).indexOf(e) >= 0; })[0];
      if (pile) Motion.body(pile).to({ y: 2 }, 'hand', { done: function () { Motion.body(pile).to({ y: 0 }, 'hand'); } });
      return;
    }
    if (Motion.isReduced()) { apply(e, s, el); return; }
    var line = el.querySelector('.c-line').getBoundingClientRect();
    var r = el.getBoundingClientRect();
    var tone = (K[e.kind].reasons[s.key] || {}).tone || 'plain';
    var drop = document.createElement('i');
    drop.className = 'drop drop--' + tone;
    document.body.appendChild(drop);
    var x = line.left + 3, y = (line.height ? line.top + line.height / 2 : r.top + 22);
    drop.animate([
      { transform: 'translate3d(' + x + 'px,' + (y - 40) + 'px,0) scale(.6)', opacity: 0 },
      { transform: 'translate3d(' + x + 'px,' + (y - 26) + 'px,0) scale(.9)', opacity: 1, offset: 0.35 },
      { transform: 'translate3d(' + x + 'px,' + y + 'px,0) scale(1.05,.8)', opacity: 1 },
    ], { duration: 210, easing: 'cubic-bezier(.55,0,.85,.5)' }).finished.then(function () {
      drop.remove();
      apply(e, s, el);
    });
  }

  return { rollLine: rollLine, land: land, announce: announce };
})();
