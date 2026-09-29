// Keeps the document's theme in step with the macOS appearance: Whitehaven when
// macOS is light, Orient Express when it is dark.
//
// The theme is set once before the first paint, so a dark Mac never sees a
// light window first. After that, one listener sets it again whenever the
// appearance changes; it runs only then, so it costs nothing while the app is
// idle. The listener is added here rather than by the app's own code, so that
// a change between this script and the app's start is not missed.
//
// A theme change snaps, as the native window around the page does: no control
// fades to its new colours. While `data-theme-changing` is set on <html>,
// base.css switches every transition off. Reading a computed style makes
// Chromium recalculate the page's style at once, while transitions are off, so
// the new colours are already in place when the attribute is removed and no
// transition starts. A computed colour costs a style pass only; reading a size,
// such as `offsetHeight`, would also force a layout pass.
//
// A file rather than an inline snippet, because the window's CSP allows no
// inline script. The block keeps these names out of the page's global scope.
{
  const root = document.documentElement;
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const applyTheme = () => {
    root.dataset.theme = dark.matches ? "orient-express" : "whitehaven";
  };
  applyTheme();
  dark.addEventListener("change", () => {
    root.dataset.themeChanging = "";
    applyTheme();
    // Recalculates the page's style now, while transitions are off.
    void getComputedStyle(root).color;
    delete root.dataset.themeChanging;
  });
}
