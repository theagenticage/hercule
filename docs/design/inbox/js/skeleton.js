// Loading. The cards are laid out from what the last visit knew, with their words held back, then the words arrive stack by
// stack. The skeleton is the real card, so nothing shifts when it resolves.
window.Skeleton = (function () {
  /** Holds the words back, then lets them in stack by stack and row by row. The cards were laid out first, so nothing shifts. */
  function run() {
    var main = document.getElementById('main');
    main.classList.add('is-loading');
    var delay = Number(new URLSearchParams(location.search).get('hold')) || 1400;
    setTimeout(function () {
      main.classList.add('is-arriving');
      main.classList.remove('is-loading');
      // Fonts may have arrived while the words were held back, so the cards are measured once more, before they show.
      App.forgetMeasures();
      App.layOut(true);
      setTimeout(function () { main.classList.remove('is-arriving'); }, 120);
      if (Motion.isReduced()) return;
      var stacks = [].slice.call(document.querySelectorAll('.noticed, .stack'));
      stacks.forEach(function (stack, si) {
        var rows = stack.querySelectorAll('.plaque, .card');
        [].forEach.call(rows, function (card, ri) {
          var words = card.querySelectorAll('.c-title, .c-line, .c-pace, .c-status, .c-foot, .c-mark, .pl-title, .pl-why, .pl-marks');
          [].forEach.call(words, function (w) {
            w.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 40 + si * 60 + Math.min(ri, 16) * 14, fill: 'backwards', easing: 'ease-out' });
          });
        });
      });
    }, delay);
  }
  return { run: run };
})();
