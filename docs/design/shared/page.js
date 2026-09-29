// PROTOTYPE - shared by every screen page of every design.
// Include it first in <head>, before any stylesheet, so the theme is set before the first paint:
//   <script src="../../shared/page.js"></script>
//
// URL parameters it understands:
//   ?theme=<name>   sets <html data-theme="<name>">. Every design defines at least "light" and "dark".
//   ?state=<name>   sets <html data-state="<name>">. A page may use it to show a state that normally
//                   needs interaction, e.g. ?state=scrolled for the shrunken glass composer.
//   ?glass=<0..1>   sets the custom property --glass-level on <html>, overriding the design's
//                   default. 0 is fully solid, 1 is the most glass the design allows.
//
// A book or compare page moves the glass level without reloading its frames: it posts
// { glass: <0..1> } to each frame, and this script applies it the same way. postMessage is used
// because frames opened from disk (file://) are cross-origin to the page that holds them.
(function () {
  var params = new URLSearchParams(location.search);
  var root = document.documentElement;
  var theme = params.get("theme");
  if (theme) root.dataset.theme = theme;
  var state = params.get("state");
  if (state) root.dataset.state = state;

  function setGlassLevel(value) {
    var level = Math.min(1, Math.max(0, Number(value)));
    if (isNaN(level)) return;
    root.style.setProperty("--glass-level", String(level));
    // An attribute, so CSS can drop glass-only details at 0. Not data-glass: designs already use that.
    root.toggleAttribute("data-glass-off", level === 0);
    document.dispatchEvent(new CustomEvent("glasschange", { detail: level }));
  }
  var glass = params.get("glass");
  if (glass !== null) setGlassLevel(glass);
  window.addEventListener("message", function (e) {
    if (e.data && typeof e.data.glass === "number") setGlassLevel(e.data.glass);
  });
  window.HerculePage = { setGlassLevel: setGlassLevel };

  // Inside a book or compare frame a page must not take focus: focusing an element in a
  // same-origin iframe scrolls the outer page to that frame and steals the reader's keys.
  if (window.top !== window) {
    HTMLElement.prototype.focus = function () {};
    document.addEventListener("DOMContentLoaded", function () {
      document.querySelectorAll("[autofocus]").forEach(function (el) {
        el.removeAttribute("autofocus");
      });
    });
  }
})();
