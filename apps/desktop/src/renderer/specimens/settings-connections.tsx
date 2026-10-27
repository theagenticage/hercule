/**
 * The Settings > Connections specimen: the app's real shell with Settings
 * open on the Connections section, drawn from the records in
 * settings-connections-fixture.ts. No capture script draws it now; open it in
 * the dev server for a check by eye.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 *
 * The working face's paws tap. The page removes every animation, so
 * the paws rest where they start.
 */
import { mountConnectionsSettingsSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";
import {
  CONNECTIONS_SETTINGS_RECORDS,
  CONNECTIONS_SIDEBAR_RECORDS,
} from "./settings-connections-fixture";

await mountConnectionsSettingsSpecimen(CONNECTIONS_SIDEBAR_RECORDS, CONNECTIONS_SETTINGS_RECORDS);
const style = document.createElement("style");
style.textContent = "* { animation: none !important; }";
document.head.append(style);
await markSheetReady();
