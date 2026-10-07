/**
 * The Settings > Assistants specimen: the app's real shell with Settings
 * open on the Assistants section and Ada picked, drawn from the records in
 * settings-assistants-fixture.ts. `pnpm compare:bureau` compares its main
 * pane pixel for pixel with the Bureau book's
 * desktop/settings-assistants.html, edited by
 * settings-assistants-reference.ts to show the same data.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 * With `?state=scrolled`, it scrolls the section's body to its end, as the
 * reference does, so the rows below the first screen are compared too.
 *
 * The working face's paws tap. The page removes every animation, as the
 * book's page is held still, so the paws rest where they start.
 */
// The fixed clock comes first: the heartbeat's "now" line reads the time
// when the section opens.
import "./fixed-clock";
import {
  SETTINGS_ASSISTANTS_PATH,
  SETTINGS_ASSISTANTS_RECORDS,
  SETTINGS_ASSISTANTS_SCREEN,
} from "./settings-assistants-fixture";
import { mountAssistantsSettingsSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

await mountAssistantsSettingsSpecimen(
  SETTINGS_ASSISTANTS_RECORDS,
  SETTINGS_ASSISTANTS_PATH,
  SETTINGS_ASSISTANTS_SCREEN,
);
const style = document.createElement("style");
style.textContent = "* { animation: none !important; }";
document.head.append(style);
if (new URLSearchParams(location.search).get("state") === "scrolled") {
  const body = document.querySelector(".set-body");
  if (body === null) throw new Error("The Settings specimen draws no section body.");
  body.scrollTop = body.scrollHeight;
}
await markSheetReady();
