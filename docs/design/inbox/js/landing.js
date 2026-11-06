// A signal landing on a card: the one moment the Inbox lets itself be noticed. The card takes a small knock from above, its
// line rolls over to the new sentence, the count ticks, and a rim of light fades. The card never changes place.
window.Landing = (function () {
  var K = Kinds.KINDS;

  /** Rolls a card's second line from the old sentence to the one now drawn. `old` is a copy of the old line. */
  function rollLine(el, old) {
    var line = el.querySelector('.c-line');
    if (!line || Motion.reduced.matches) return;
    old.classList.add('c-line--old');
    old.style.gridRow = window.getComputedStyle(line).gridRowStart;
    line.parentNode.insertBefore(old, line);
    Motion.animate(old, [{ transform: 'none', opacity: 1 }, { transform: 'translateY(-14px)', opacity: 0 }], { duration: 240, easing: 'cubic-bezier(.5,0,.8,.4)' }).then(function () { old.remove(); });
    Motion.animate(line, [{ transform: 'translateY(14px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: Motion.SPRINGS.settle.ms, delay: 80, fill: 'backwards', easing: Motion.SPRINGS.settle.ease });
  }

  /** Lands a signal on an entity. The kind's phrase becomes the card's line; the older signal joins the quiet count. */
  function land(e, s) {
    var el = App.els()[e.id];
    var old = el && el.querySelector('.c-line') ? el.querySelector('.c-line').cloneNode(true) : null;
    e.signals.push(s);
    if (s.state) e.fields.state = s.state;
    if (!el) { App.layOut(); return; }
    App.redrawCard(e);
    if (old) rollLine(el, old);
    var tone = (K[e.kind].reasons[s.key] || {}).tone || 'plain';
    el.dataset.landed = tone;
    el.classList.remove('is-landed');
    void el.offsetWidth;
    el.classList.add('is-landed');
    setTimeout(function () { el.classList.remove('is-landed'); }, 1500);
    var base = el.style.transform;
    if (!Motion.reduced.matches) {
      el.animate([{ transform: base }, { transform: base + ' translateY(2px) scale(.996)', offset: 0.18 }, { transform: base }], { duration: Motion.SPRINGS.land.ms, easing: 'linear', composite: 'replace' });
      var n = el.querySelector('.c-more');
      if (n && !n.hidden) Motion.animate(n, [{ transform: 'translateY(6px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, delay: 160, fill: 'backwards', easing: 'cubic-bezier(.22,.9,.24,1)' });
    }
    delete App.measured()[e.id];
    App.layOut();
  }

  return { rollLine: rollLine, land: land };
})();
