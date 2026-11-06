// Loading. The cards are laid out from what the last visit knew, with their words held back, then the words arrive stack by
// stack. The skeleton is the real card, so nothing shifts when it resolves.
window.Skeleton = (function () {
  function run() {
    var main = document.getElementById('main');
    main.classList.add('is-loading');
    var delay = Number(new URLSearchParams(location.search).get('hold')) || 1400;
    setTimeout(function () {
      var cards = [].slice.call(document.querySelectorAll('.plaque, .stack .card'));
      main.classList.remove('is-loading');
      if (Motion.isReduced()) return;
      cards.forEach(function (c, i) {
        var words = c.querySelectorAll('.c-title, .c-line, .c-pace, .pl-title, .pl-why');
        [].forEach.call(words, function (w) {
          w.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: Math.min(i, 24) * 14, fill: 'backwards', easing: 'ease-out' });
        });
      });
    }, delay);
  }
  return { run: run };
})();
