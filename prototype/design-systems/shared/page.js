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
})();
