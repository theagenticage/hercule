// Loading. The cards are laid out from what the last visit knew, with their words held back, then the words arrive stack by
// stack. The skeleton is the real card, so nothing shifts when it resolves.
window.Skeleton = (function () {
  /**
   * Holds the words back, then lets them in stack by stack and row by row. The cards were laid out first and measured with
   * their words, so nothing shifts when the words arrive.
   */
  function run() {
    var main = document.getElementById('main');
    var parts = function () { return [].slice.call(document.querySelectorAll('.noticed, .stack-wrap')); };
    main.classList.add('is-holding');
    parts().forEach(function (p) { p.classList.add('is-loading'); });
    var delay = Number(new URLSearchParams(location.search).get('hold')) || 1400;
    setTimeout(function () {
      // Fonts may have arrived while the words were held back, so the cards are measured again, with their words, before they show.
      main.classList.remove('is-holding');
      parts().forEach(function (p) { p.classList.remove('is-loading'); });
      App.forgetMeasures();
      App.layOut(true);
      if (Motion.isReduced()) return;
      parts().forEach(function (part, si) {
        [].forEach.call(part.querySelectorAll('.plaque, .card'), function (card, ri) {
          var words = card.querySelectorAll('.c-title, .c-line, .c-pace, .c-status, .c-foot, .c-mark, .pl-title, .pl-why, .pl-marks');
          [].forEach.call(words, function (w) {
            w.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: si * 60 + Math.min(ri, 16) * 14, fill: 'backwards', easing: 'ease-out' });
          });
        });
        [].forEach.call(part.querySelectorAll('.stack-n, .stack-foot'), function (w) { w.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: si * 60, fill: 'backwards' }); });
      });
    }, delay);
  }
  return { run: run };
})();
