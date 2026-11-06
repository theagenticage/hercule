// The Hercule head, as the book's crew.js draws it. The shared faces.js has no logo, and the Inbox needs one.
(function () {
  var EGG = 'M16 2.4c-6.3 0-10.9 7.6-10.9 14.8 0 7.1 4.8 12.4 10.9 12.4s10.9-5.3 10.9-12.4C26.9 10 22.3 2.4 16 2.4z';
  var TACHE = 'M16 19.2c-1.5-1.2-3.4-1.5-5.1-.7-.9.4-1.7.3-2.3-.4-.4-.5-1.2-.3-1.1.4.3 1.9 2 3 4 2.8 1.8-.2 3.3-.9 4.5-1.8 1.2.9 2.7 1.6 4.5 1.8 2 .2 3.7-.9 4-2.8.1-.7-.7-.9-1.1-.4-.6.7-1.4.8-2.3.4-1.7-.8-3.6-.5-5.1.7z';
  /** Returns the Hercule mark as SVG markup; with mono it is drawn in currentColor. */
  Crew.logo = function (size, opts) {
    size = size || 28;
    opts = opts || {};
    var fill = opts.mono ? 'currentColor' : 'oklch(var(--char-l) var(--char-c) var(--hue-lime))';
    var ink = opts.mono ? 'var(--bg)' : 'var(--face-ink)';
    return '<svg class="logo" viewBox="0 0 32 32" width="' + size + '" height="' + size + '" role="img" aria-label="Hercule"><path d="' + EGG + '" fill="' + fill + '"/><g fill="' + ink + '"><circle cx="12.4" cy="14.6" r="1.55"/><circle cx="19.6" cy="14.6" r="1.55"/><path d="' + TACHE + '"/></g></svg>';
  };
})();
