/**
 * The Settings > Connections specimen: the app, booted through its own router
 * over a fake controller (mcp-scene.ts), with Settings open on the Connections
 * section, drawn from the records in settings-connections-fixture.ts, with the
 * "agent tools" note of each Connection whose plugin offers an MCP server, from
 * the servers of mcp-fixture.ts. `capture:ui` captures it (scripts/
 * ui-screens.ts).
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 *
 * The working face's paws tap. The page removes every animation, so
 * the paws rest where they start.
 */
import { MCP_RECORDS } from "./mcp-fixture";
import { markMcpSceneReady, mountMcpScene } from "./mcp-scene";
import { waitForPart } from "./mcp-script";
import {
  CONNECTIONS_SETTINGS_RECORDS,
  CONNECTIONS_SIDEBAR_RECORDS,
} from "./settings-connections-fixture";

const { connections, plugins, counts } = CONNECTIONS_SETTINGS_RECORDS;
const page = await mountMcpScene(
  {
    records: { ...CONNECTIONS_SIDEBAR_RECORDS, connections, plugins },
    mcp: MCP_RECORDS,
    eventCounts: counts,
  },
  "/settings/connections",
);
await waitForPart(".conn");
await markMcpSceneReady(page);
