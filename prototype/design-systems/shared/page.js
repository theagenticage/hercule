// PROTOTYPE - shared by every screen page of every design.
// Include it first in <head>, before any stylesheet, so the theme is set before the first paint:
//   <script src="../../shared/page.js"></script>
//
// URL parameters it understands:
//   ?theme=<name>   sets <html data-theme="<name>">. Every design defines at least "light" and "dark".
//   ?state=<name>   sets <html data-state="<name>">. A page may use it to show a state that normally
//                   needs interaction, e.g. ?state=scrolled for the shrunken glass composer.
(function () {
  var params = new URLSearchParams(location.search);
  var root = document.documentElement;
  var theme = params.get("theme");
  if (theme) root.dataset.theme = theme;
  var state = params.get("state");
  if (state) root.dataset.state = state;

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
