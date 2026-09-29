// Keeps the document's theme in step with the macOS appearance: Whitehaven when
// macOS is light, Orient Express when it is dark.
//
// The theme is set once before the first paint, so a dark Mac never sees a
// light window first. After that, one listener sets it again whenever the
// appearance changes; it runs only then, so it costs nothing while the app is
// idle. The listener is added here rather than by the app's own code, so that
// a change between this script and the app's start is not missed.
//
// A file rather than an inline snippet, because the window's CSP allows no
// inline script. The block keeps the two names out of the page's global scope.
{
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const applyTheme = () => {
    document.documentElement.dataset.theme = dark.matches ? "orient-express" : "whitehaven";
  };
  applyTheme();
  dark.addEventListener("change", applyTheme);
}
