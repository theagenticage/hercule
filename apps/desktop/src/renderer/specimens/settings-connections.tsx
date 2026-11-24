/**
 * The Settings > Connections specimen: the app, booted through its own router
 * over a fake controller (mcp-scene.ts), with Settings open on the Connections
 * section, drawn from the records in settings-connections-fixture.ts, with the
 * "agent tools" note of each Connection whose plugin offers an MCP server, from
 * the servers of mcp-fixture.ts. `capture:ui` captures it (scripts/
 * ui-screens.ts).
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`,
 * and opens the state its `?state=` names:
 * - none: the table, with its "agent tools" notes;
 * - `slack-setup`: the dialog Add a Connection > Slack opens, before anything
 *   is pasted, so its button cannot be pressed;
 * - `slack-pasted`: the same with a configuration token pasted;
 * - `slack-refused`: the same after Slack refused the token, with the token
 *   still in the field;
 * - `slack-waiting`: the dialog after "Continue in Slack", while the browser is
 *   open on Slack's page;
 * - `slack-paste`: the same when nothing on this machine can listen, so the
 *   user pastes the address the browser ended on;
 * - `slack-reconnect`: the Reconnect dialog of a Slack Connection that needs
 *   to sign in again;
 * - `slack-reconnect-app`: the same after "Set up the Slack app again".
 *
 * The working face's paws tap. The page removes every animation, so
 * the paws rest where they start.
 */
import { MCP_RECORDS } from "./mcp-fixture";
import { markMcpSceneReady, mountMcpScene, type McpScene } from "./mcp-scene";
import { pressPart, pressPartWithText, typeInto, waitForPart } from "./mcp-script";
import {
  CONNECTIONS_SETTINGS_RECORDS,
  CONNECTIONS_SIDEBAR_RECORDS,
  SLACK_CONNECTION_NEEDING_SIGN_IN,
  SLACK_PLUGIN,
} from "./settings-connections-fixture";
import { buildErrorBody } from "@hercule/client-core/testing";

const state = new URLSearchParams(location.search).get("state") ?? "list";

const { connections, plugins, counts } = CONNECTIONS_SETTINGS_RECORDS;
const withSlack = state.startsWith("slack");
const reconnects = state.startsWith("slack-reconnect");

/** The page Slack's approval opens, as the controller's start answers it. */
const SLACK_AUTHORIZATION_URL = "https://slack.com/oauth/v2_user/authorize?state=abc123";

/** The scene's own answers for the Slack states, and how the app's listener for the browser's return behaves. */
const slackScene = (): Pick<McpScene, "handlers" | "signInReturn"> => ({
  // Without a listener, main cannot catch the return, so the dialog asks for a paste.
  ...(state === "slack-paste" ? {} : { signInReturn: "listens" as const }),
  handlers: {
    "POST /api/v1/oauth/start":
      state === "slack-refused"
        ? {
            status: 400,
            body: buildErrorBody(
              "validation",
              "This configuration token has expired: Slack configuration tokens last 12 hours. Make a new one. Go to api.slack.com/apps, open Your App Configuration Tokens, choose Generate Token, pick the workspace, and copy the Access Token.",
            ),
          }
        : { body: { authorizationUrl: SLACK_AUTHORIZATION_URL } },
  },
});

const page = await mountMcpScene(
  {
    records: {
      ...CONNECTIONS_SIDEBAR_RECORDS,
      connections: withSlack
        ? [...connections, ...(reconnects ? [SLACK_CONNECTION_NEEDING_SIGN_IN] : [])]
        : connections,
      plugins: withSlack ? [...plugins, SLACK_PLUGIN] : plugins,
    },
    mcp: MCP_RECORDS,
    eventCounts: counts,
    ...(withSlack ? slackScene() : {}),
  },
  "/settings/connections",
);
await waitForPart(".conn");

const TOKEN_FIELD = 'dialog[open] input[type="password"]';
const SLACK_TOKEN = "not-a-real-configuration-token-1";
if (withSlack && !reconnects) {
  await pressPart(".add-conn");
  await pressPartWithText(".add-conn-menu button", "Slack");
  await waitForPart(TOKEN_FIELD);
}
if (reconnects) {
  const rowMenuButton = await waitForPart('[aria-label="More for Slack · work"]');
  // Every row has its own menu, so the item is looked up in this row's.
  const menuId = rowMenuButton.getAttribute("popovertarget") ?? "";
  await pressPartWithText(`[id="${menuId}"] [role="menuitem"]`, "Reconnect");
  await waitForPart("dialog[open] .setup-acts .btn--accent");
}
if (state === "slack-reconnect-app") {
  await pressPartWithText("dialog[open] .link", "Set up the Slack app");
  await waitForPart(TOKEN_FIELD);
}
if (state === "slack-pasted" || state === "slack-refused") await typeInto(TOKEN_FIELD, SLACK_TOKEN);
if (state === "slack-refused" || state === "slack-waiting" || state === "slack-paste") {
  if (state !== "slack-refused") await typeInto(TOKEN_FIELD, SLACK_TOKEN);
  await pressPart("dialog[open] .setup-acts .btn--accent");
  await waitForPart(
    state === "slack-refused"
      ? 'dialog[open] [role="alert"]'
      : state === "slack-paste"
        ? "dialog[open] .setup-paste"
        : "dialog[open] .hx .wait",
  );
}
await markMcpSceneReady(page);
