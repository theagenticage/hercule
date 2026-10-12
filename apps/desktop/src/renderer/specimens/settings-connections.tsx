/**
 * The Settings > Connections specimen: the app's real shell with Settings
 * open on the Connections section, drawn from the records in
 * settings-connections-fixture.ts. `pnpm compare:bureau` compares its main
 * pane pixel for pixel with the Bureau book's
 * desktop/settings-connections.html, edited by
 * settings-connections-reference.ts to show the same Connections.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 *
 * The working face's paws tap. The page removes every animation, as the
 * book's page is held still, so the paws rest where they start.
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
