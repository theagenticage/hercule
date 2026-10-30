// PROTOTYPE - marks for the vendors and harnesses the book has no brand file for, drawn
// monochrome in currentColor on the book's 24-unit grid. Placeholders: none is a vendor's
// official artwork. Pv.mark(name, size) draws any mark: these, the book's brands, or an icon.
(function () {
  var FILLED = {
    // Z.ai: a heavy Z.
    zai: "M4.5 3.5h15v3.3L9.9 17.2h9.6v3.3h-15v-3.3l9.6-10.4H4.5z",
    // OpenCode: a square O whose lower half is filled.
    opencode: "M3.5 3.5h17v17h-17zM7 7v10h10V7zM7 12.5h10V17H7z",
  };
  var STROKED = {
    // OpenRouter: one line that splits into two routes.
    openrouter: '<path d="M2.5 12h4.2c3.2 0 3.8-5.2 7.6-5.2h4.2M6.7 12c3.2 0 3.8 5.2 7.6 5.2h4.2"/><path d="M16.4 4.4l2.4 2.4-2.4 2.4M16.4 14.8l2.4 2.4-2.4 2.4"/>',
    // Codex: a prompt in a rounded window.
    codex: '<rect x="3.2" y="4.2" width="17.6" height="15.6" rx="4"/><path d="M7.6 9.4l2.8 2.6-2.8 2.6M12.6 15.2h3.8"/>',
  };
  var ICONS = { server: 1, globe: 1, laptop: 1, key: 1, link: 1, cpu: 1 };

  function mark(name, size) {
    size = size || 16;
    if (FILLED[name]) {
      return '<svg class="br" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path d="' + FILLED[name] + '"/></svg>';
    }
    if (STROKED[name]) {
      return '<svg class="br" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + STROKED[name] + "</svg>";
    }
    if (ICONS[name]) return Crew.icon(name, size);
    return Crew.brand(name, size);
  }

  window.Pv = window.Pv || {};
  window.Pv.mark = mark;
})();
