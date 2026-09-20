// Carries a stored theme choice to the document before the app renders, so
// the first paint is already the right one. The ThemeSelector in
// packages/ui/src/theme/ writes the same key; keep the two in step.
//
// A file rather than an inline snippet because the CSP the controller serves
// the app under allows no inline script.
try {
  const theme = localStorage.getItem("hercule:theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  // Storage denied: the app paints in the system theme.
}
