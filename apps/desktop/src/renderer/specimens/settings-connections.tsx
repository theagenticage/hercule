/**
 * The Settings > Connections specimen: the app's real shell with Settings
 * open on the Connections section, drawn from the records in
 * settings-connections-fixture.ts, with the "agent tools" note of each
 * Connection whose plugin offers an MCP server, from the servers of
 * mcp-fixture.ts. `capture:ui` captures it (scripts/ui-screens.ts).
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 *
 * The working face's paws tap. The page removes every animation, so
 * the paws rest where they start.
 */
import { MCP_RECORDS } from "./mcp-fixture";
import { mountConnectionsSettingsSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";
import {
  CONNECTIONS_SETTINGS_RECORDS,
  CONNECTIONS_SIDEBAR_RECORDS,
} from "./settings-connections-fixture";

await mountConnectionsSettingsSpecimen(
  CONNECTIONS_SIDEBAR_RECORDS,
  CONNECTIONS_SETTINGS_RECORDS,
  MCP_RECORDS,
);
const style = document.createElement("style");
style.textContent = "* { animation: none !important; }";
document.head.append(style);
await markSheetReady();
