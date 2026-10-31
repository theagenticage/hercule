/**
 * The Settings > Providers specimen: the app's real shell with Settings
 * open on the Providers section, drawn from the records in
 * settings-providers-fixture.ts. No capture script draws it; open it in the
 * dev server for a check by eye.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 * `?sheet=<name>` opens the sheet of the account whose card is called that,
 * such as `?sheet=Anthropic%20%C2%B7%20Work`.
 */
import { mountProvidersSettingsSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";
import {
  PROVIDERS_SETTINGS_RECORDS,
  PROVIDERS_SIDEBAR_RECORDS,
} from "./settings-providers-fixture";

await mountProvidersSettingsSpecimen(PROVIDERS_SIDEBAR_RECORDS, PROVIDERS_SETTINGS_RECORDS);
const sheet = new URLSearchParams(location.search).get("sheet");
if (sheet !== null) {
  const card = document.querySelector<HTMLElement>(`button[title="Open ${sheet}"]`);
  if (card === null) throw new Error(`The page has no card called ${sheet}.`);
  card.click();
  // The dialog focuses its first control, whose ring the page would draw
  // although no key was pressed.
  await new Promise((resolve) => requestAnimationFrame(resolve));
  (document.activeElement as HTMLElement | null)?.blur();
  await new Promise((resolve) => requestAnimationFrame(resolve));
}
const style = document.createElement("style");
style.textContent = "* { animation: none !important; }";
document.head.append(style);
await markSheetReady();
