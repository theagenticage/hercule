/**
 * The Settings > Appearance specimen: the app's real shell with Settings
 * open on the Appearance section, as on a Mac where the user never changed
 * the Appearance. `pnpm compare:bureau` compares its main pane pixel for
 * pixel with the Bureau book's desktop/settings-appearance.html, edited by
 * settings-appearance-reference.ts to show the same rows.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 * With Follow the system on, the app presses the card of the theme macOS's
 * appearance puts in use, so the capture window reports the appearance that
 * matches the theme (see scripts/sheet-window.ts).
 *
 * The working face's paws tap. The page removes every animation, as the
 * book's page is held still, so the paws rest where they start.
 */
import {
  SETTINGS_ASSISTANTS_RECORDS,
  SETTINGS_ASSISTANTS_SCREEN,
} from "./settings-assistants-fixture";
import { mountAppearanceSettingsSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

// The book draws Settings beside the same sidebar, with the same Connection
// needing attention, as on its Assistants page. The comparison covers only
// the main pane, so the sidebar holds just the first four threads. With
// every fixture thread in rows 58px or taller, the browser draws a few edge
// pixels of 16 glass items in the main pane differently from the book's,
// although nothing in the main pane changed; with four threads it draws
// them the same.
await mountAppearanceSettingsSpecimen(
  { ...SETTINGS_ASSISTANTS_RECORDS, threads: SETTINGS_ASSISTANTS_RECORDS.threads.slice(0, 4) },
  {
    connections: SETTINGS_ASSISTANTS_SCREEN.connections,
  },
);
const style = document.createElement("style");
style.textContent = "* { animation: none !important; }";
document.head.append(style);
await markSheetReady();
