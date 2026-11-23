/**
 * The Settings > MCP servers specimen: the app, booted through its own router
 * over a fake controller (mcp-scene.ts), with Settings open on the MCP servers
 * section, drawn from the world in mcp-fixture.ts. `capture:ui` draws its four
 * states (scripts/ui-screens.ts); open it in the dev server for a check by eye.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`,
 * and opens the state its `?state=` names:
 * - none or `list`: the list, with a server in each state and the default list;
 * - `page`: the page of Linear's server, which needs sign-in, at its top;
 * - `projects`: the page of the hobby Sentry server scrolled to Projects, with
 *   the refusal open on webshop, whose list names the other server `sentry`;
 * - `picker`: the list with the picker of the default list open;
 * - `checking`: the page of Stripe's server, checked for the first time;
 * - `off`: the page of Grafana's server, switched off;
 * - `unreachable`: the page of Grafana's server, switched on, that did not answer;
 * - `error`: the page of GitHub's server, which answered a check with an error;
 * - `empty`: the list when no Connection has a plugin that offers a server;
 * - `failed`: the list when the read of the servers fails.
 *
 * Five more draw servers added by URL, from a world that holds some (see
 * `MCP_URL_RECORDS`):
 * - `urls`: the list with its group "Added by URL";
 * - `add-token`: the Add by URL dialog at its token step, after "Check server"
 *   created a server the controller found to need a token;
 * - `add-duplicate`: the dialog with the refusal of an address added before;
 * - `replace`: the Replace dialog, opened by switching on PostHog's row while
 *   a server added by URL sits on PostHog's address;
 * - `url-page`: the page of Notion, a server added by URL that needs sign-in.
 *
 * Two more draw the sign-in through the browser, on the page of Atlas, a
 * server added by URL that signs in through the browser. Main's listener
 * answers, as it does on a Mac, so the dialog shows the card that waits for
 * the browser, with the way to paste the address under it:
 * - `sign-in-waiting`: the dialog after "Sign in with your browser", at "Finish
 *   in your browser";
 * - `sign-in-refused`: the dialog after the controller refused to start the
 *   sign-in.
 */
// The fixed clock comes first: a page places a time against the moment the
// server was checked, and the sidebar's age clock reads the time when it loads.
import "./fixed-clock";
import {
  MCP_ATLAS_SERVER_ID,
  MCP_DOCS_SERVER_ID,
  MCP_GITHUB_SERVER_ID,
  MCP_GRAFANA_SERVER_ID,
  MCP_HOBBY_SERVER_ID,
  MCP_LINEAR_SERVER_ID,
  MCP_NEW_URL_SERVER,
  MCP_NO_OFFERS,
  MCP_OAUTH_RECORDS,
  MCP_NOTION_SERVER_ID,
  MCP_RECORDS,
  MCP_RECORDS_GITHUB_ERROR,
  MCP_RECORDS_GRAFANA_UNREACHABLE,
  MCP_SETTINGS_PAGE_RECORDS,
  MCP_STRIPE_SERVER_ID,
  MCP_URL_RECORDS,
} from "./mcp-fixture";
import { pressPart, typeInto, waitForPart } from "./mcp-script";
import { markMcpSceneReady, mountMcpScene, type McpScene } from "./mcp-scene";
import { buildErrorBody } from "@hercule/client-core/testing";

const state = new URLSearchParams(location.search).get("state") ?? "list";

/** The address the section opens at for `?state=`. Fails for a state the specimen does not draw. */
function chooseAddress(name: string): string {
  switch (name) {
    case "list":
    case "picker":
    case "empty":
    case "failed":
    case "urls":
    case "add-token":
    case "add-duplicate":
    case "replace":
      return "/settings/mcp-servers";
    case "url-page":
      return `/settings/mcp-servers/${MCP_NOTION_SERVER_ID}`;
    case "sign-in-waiting":
    case "sign-in-refused":
      return `/settings/mcp-servers/${MCP_ATLAS_SERVER_ID}`;
    case "page":
      return `/settings/mcp-servers/${MCP_LINEAR_SERVER_ID}`;
    case "projects":
      return `/settings/mcp-servers/${MCP_HOBBY_SERVER_ID}`;
    case "checking":
      return `/settings/mcp-servers/${MCP_STRIPE_SERVER_ID}`;
    case "off":
    case "unreachable":
      return `/settings/mcp-servers/${MCP_GRAFANA_SERVER_ID}`;
    case "error":
      return `/settings/mcp-servers/${MCP_GITHUB_SERVER_ID}`;
    default:
      throw new Error(`The MCP servers specimen draws no state "${name}".`);
  }
}

const READ_FAILURE = "The controller could not read its MCP servers.";

/**
 * The router logs the error of a failed loader with `console.error`, and a
 * capture fails on any console error. The `failed` state shows that error on
 * purpose, so this drops that one message and passes every other on.
 */
function muteReadFailureLog(): void {
  const log = console.error.bind(console);
  console.error = (...parts: unknown[]) => {
    if (parts.some((part) => part instanceof Error && part.message === READ_FAILURE)) return;
    log(...parts);
  };
}

/** The records and answers the scene of `name` is drawn from. */
function chooseScene(name: string): McpScene {
  const scene = { records: MCP_SETTINGS_PAGE_RECORDS, mcp: MCP_RECORDS };
  const urlScene = { ...scene, mcp: MCP_URL_RECORDS };
  switch (name) {
    case "urls":
    case "replace":
    case "url-page":
      return urlScene;
    case "add-token":
      return { ...urlScene, create: { status: 200, body: MCP_NEW_URL_SERVER } };
    case "sign-in-waiting":
      return {
        ...scene,
        mcp: MCP_OAUTH_RECORDS,
        signInListens: true,
        signIn: {
          status: 200,
          body: {
            authorizationUrl: "https://auth.atlas.example/authorize?state=abc123",
            expiresAt: "2026-11-23T10:10:00.000Z",
          },
        },
      };
    case "sign-in-refused":
      return {
        ...scene,
        mcp: MCP_OAUTH_RECORDS,
        signIn: {
          status: 409,
          body: {
            error: {
              code: "invalid_state",
              message: "The sign-in service could not be reached.",
              details: { reason: "source-unreadable" },
            },
          },
        },
      };
    case "add-duplicate":
      return {
        ...urlScene,
        create: {
          status: 409,
          body: {
            error: {
              code: "conflict",
              message: "This address is added already.",
              details: { reason: "mcp-server-exists", mcpServerId: MCP_DOCS_SERVER_ID },
            },
          },
        },
      };
    case "unreachable":
      return { ...scene, mcp: MCP_RECORDS_GRAFANA_UNREACHABLE };
    case "error":
      return { ...scene, mcp: MCP_RECORDS_GITHUB_ERROR };
    case "empty":
      return MCP_NO_OFFERS;
    case "failed":
      return {
        ...scene,
        handlers: {
          "GET /api/v1/mcp-servers": {
            status: 500,
            body: buildErrorBody("internal", READ_FAILURE),
          },
        },
      };
    default:
      return scene;
  }
}

if (state === "failed") muteReadFailureLog();
const page = await mountMcpScene(chooseScene(state), chooseAddress(state));
await waitForPart(state === "failed" ? ".render-failure" : ".mcp-list, .mcp-record");
if (state === "projects") {
  // Ticking webshop while its list names the other `sentry` opens the refusal.
  await waitForPart(".mcp-proj-row");
  const webshop = [...document.querySelectorAll<HTMLElement>(".mcp-proj-row")].find((row) =>
    row.textContent?.startsWith("webshop"),
  );
  webshop?.querySelector<HTMLInputElement>("input")?.click();
  await waitForPart(".mcp-clash");
  const body = document.querySelector(".set-body");
  if (body === null) throw new Error("The Settings specimen draws no section body.");
  body.scrollTop = body.scrollHeight;
}
if (state === "picker") {
  await pressPart('section[aria-label="Threads without a project"] button');
  await waitForPart("dialog[open].mcp-picker .mcp-pick-row");
}
if (state === "add-token" || state === "add-duplicate") {
  await pressPart('section[aria-label="Added by URL"] .mcp-group-top button');
  await typeInto(
    'dialog[open] input[placeholder="https://mcp.example.com/mcp"]',
    state === "add-token" ? "https://mcp.wiki.example/mcp" : "https://mcp.docs.example/mcp",
  );
  await pressPart('dialog[open] button[type="submit"]');
  await waitForPart(
    state === "add-token" ? 'dialog[open] input[type="password"]' : "dialog[open] .warn",
  );
}
if (state === "sign-in-waiting" || state === "sign-in-refused") {
  await pressPart(".mcp-band button");
  await pressPart("dialog[open] .setup-acts .btn--accent");
  await waitForPart(state === "sign-in-waiting" ? "dialog[open] .url-stuck" : "dialog[open] .warn");
}
if (state === "replace") {
  await pressPart('[role="switch"][aria-label="Offer posthog webshop to threads"]');
  await waitForPart("dialog[open] .url-replace");
}
await markMcpSceneReady(page);
