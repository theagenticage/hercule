// Applies the Appearance to the document: the theme in use and the glass.
// The page's own code never changes these attributes itself; it dispatches
// an `appearancechange` event instead, so this file holds all of the work.
//
// What it sets on <html>:
// - `data-theme`: the theme in use. With Follow the system off, it is the
//   chosen theme. With it on, it is the night theme while macOS is dark and
//   the day theme otherwise. `decideThemeInUse` in `src/ipc/appearance.ts`
//   has the same rule; this file repeats it because it runs before any bundle
//   loads, and its test checks that the two agree.
// - `--glass-percent`: the Glass level, from 0 to 100. base.css turns it into
//   the glass of every surface.
// - `data-solid-glass`: present when every glass surface is solid, either
//   because the user turned on Reduce transparency or because the Glass level
//   is 0.
//
// The Appearance is read from main once, synchronously, before the first
// paint, so a dark Mac never sees a light window first. After that, two
// listeners apply it again: one when macOS switches between light and dark,
// and one when the page dispatches an `appearancechange` event whose `detail`
// is the new Appearance. They run only then, so they cost nothing while the
// app is idle. They are added here rather than by the app's own code, so that
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
// Only a change of theme snaps. Dragging the Glass slider sends many events,
// so a change of glass alone sets only what changed and reads no style.
//
// A file rather than an inline snippet, because the window's CSP allows no
// inline script. The block keeps these names out of the page's global scope.
{
  const root = document.documentElement;
  const dark = matchMedia("(prefers-color-scheme: dark)");
  let appearance = window.bridge.appearance.read();

  const decideThemeInUse = () => {
    if (!appearance.followSystem) return appearance.theme;
    return dark.matches ? appearance.nightTheme : appearance.dayTheme;
  };

  // Sets the theme, snapping when the page has already painted another one.
  // Before the first paint there is nothing to fade, so the first theme is
  // set without the snap and without a style read.
  const applyTheme = () => {
    const theme = decideThemeInUse();
    if (root.dataset.theme === theme) return;
    if (root.dataset.theme === undefined) {
      root.dataset.theme = theme;
      return;
    }
    root.dataset.themeChanging = "";
    root.dataset.theme = theme;
    // Recalculates the page's style now, while transitions are off.
    void getComputedStyle(root).color;
    delete root.dataset.themeChanging;
  };

  const applyGlass = () => {
    root.style.setProperty("--glass-percent", String(appearance.glassPercent));
    root.toggleAttribute(
      "data-solid-glass",
      appearance.reduceTransparency || appearance.glassPercent === 0,
    );
  };

  applyTheme();
  applyGlass();
  dark.addEventListener("change", applyTheme);
  document.addEventListener("appearancechange", (event) => {
    appearance = event.detail;
    applyTheme();
    applyGlass();
  });
}
