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
 * More draw the sign-in through the browser, on the page of Atlas, a server
 * added by URL that signs in through the browser. Main's listener answers, as
 * it does on a Mac, so the dialog shows the card that waits for the browser,
 * with the way to paste the address under it:
 * - `sign-in-choice`: the dialog the band's "Sign in..." opens, at the choice
 *   "Sign in with your browser";
 * - `sign-in-waiting`: the dialog after "Sign in with your browser", at "Finish
 *   in your browser", before the browser was opened;
 * - `sign-in-long-host`: the same, for a host of 45 characters with no hyphen;
 * - `sign-in-open-failed`: the same after "Open" when the system could not
 *   open the browser;
 * - `sign-in-paste`: the same when main cannot listen, so the paste field is
 *   the only way back;
 * - `sign-in-timed-out`: the dialog after main gave up waiting for the browser;
 * - `sign-in-refused`: the dialog after the controller refused to start the
 *   sign-in.
 *
 * The rest draw the other steps of the dialogs and the pages of ready servers
 * added by URL:
 * - `add-empty`: the Add by URL dialog as it opens;
 * - `add-checking`: the dialog while "Check server" waits for the controller;
 * - `add-ready`: the dialog at the end, when the new server answered with its tools;
 * - `add-plugin-origin`: the dialog with the refusal of an address a plugin offers;
 * - `token`: the sign-in dialog on the page of Notion, a server that takes a
 *   pasted token, at its token field;
 * - `replace-several`: the Replace dialog with two servers to choose from;
 * - `replace-stale`: the Replace dialog after the controller refused, because
 *   the Connection has a server already;
 * - `url-page-token`: the page of a ready server that holds a token, with "Replace token...";
 * - `url-page-oauth`: the page of a ready server that holds a sign-in through
 *   the browser, with "Sign in again...";
 * - `urls-long`: the list with a server whose address is far longer than its row.
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
  MCP_LEDGER_SERVER_ID,
  MCP_LONG_ADDRESS_RECORDS,
  MCP_NEW_URL_SERVER,
  MCP_NO_OFFERS,
  MCP_OAUTH_RECORDS,
  MCP_NOTION_SERVER_ID,
  MCP_RECORDS,
  MCP_READY_NEW_URL_SERVER,
  MCP_READY_URL_RECORDS,
  MCP_RECORDS_GITHUB_ERROR,
  MCP_RECORDS_GRAFANA_UNREACHABLE,
  MCP_RELAY_SERVER_ID,
  MCP_REPLACE_SEVERAL_RECORDS,
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
    case "add-empty":
    case "add-checking":
    case "add-ready":
    case "add-plugin-origin":
    case "replace":
    case "replace-several":
    case "replace-stale":
    case "urls-long":
      return "/settings/mcp-servers";
    case "url-page":
    case "token":
      return `/settings/mcp-servers/${MCP_NOTION_SERVER_ID}`;
    case "url-page-token":
      return `/settings/mcp-servers/${MCP_LEDGER_SERVER_ID}`;
    case "url-page-oauth":
      return `/settings/mcp-servers/${MCP_RELAY_SERVER_ID}`;
    case "sign-in-choice":
    case "sign-in-waiting":
    case "sign-in-long-host":
    case "sign-in-open-failed":
    case "sign-in-paste":
    case "sign-in-timed-out":
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

/** The host of the long-host scene: 45 characters, with no hyphen to break at. */
const LONG_APPROVAL_HOST = "authorization.identity.northwindtraders.co.uk";

/** The controller's answer to `startSignIn` for a sign-in page on `host`. */
const answerSignInStart = (host: string): NonNullable<McpScene["signIn"]> => ({
  status: 200,
  body: {
    authorizationUrl: `https://${host}/authorize?state=abc123`,
    expiresAt: "2026-11-23T10:10:00.000Z",
  },
});

/** The controller's answer to a Replace it refuses, because the Connection has a server already. */
const REPLACE_REFUSED: NonNullable<McpScene["update"]> = {
  status: 409,
  body: {
    error: {
      code: "conflict",
      message: "This Connection has a server already.",
      details: { reason: "mcp-server-exists", mcpServerId: MCP_DOCS_SERVER_ID },
    },
  },
};

/** The records and answers the scene of `name` is drawn from. */
function chooseScene(name: string): McpScene {
  const scene = { records: MCP_SETTINGS_PAGE_RECORDS, mcp: MCP_RECORDS };
  const urlScene = { ...scene, mcp: MCP_URL_RECORDS };
  const oauthScene = { ...scene, mcp: MCP_OAUTH_RECORDS };
  switch (name) {
    case "urls":
    case "replace":
    case "url-page":
      return urlScene;
    case "add-token":
      return { ...urlScene, create: { status: 200, body: MCP_NEW_URL_SERVER } };
    case "sign-in-waiting":
      return {
        ...oauthScene,
        signInReturn: "listens",
        signIn: answerSignInStart("auth.atlas.example"),
      };
    case "sign-in-long-host":
      return {
        ...oauthScene,
        signInReturn: "listens",
        signIn: answerSignInStart(LONG_APPROVAL_HOST),
      };
    case "sign-in-open-failed":
      return {
        ...oauthScene,
        signInReturn: "listens",
        browserOpens: false,
        signIn: answerSignInStart("auth.atlas.example"),
      };
    case "sign-in-paste":
      return { ...oauthScene, signIn: answerSignInStart("auth.atlas.example") };
    case "sign-in-timed-out":
      return {
        ...oauthScene,
        signInReturn: "times-out",
        signIn: answerSignInStart("auth.atlas.example"),
      };
    case "sign-in-choice":
      return oauthScene;
    case "add-empty":
      return urlScene;
    case "add-checking":
      return {
        ...urlScene,
        // The controller never answers, so the dialog stays at its wait.
        handlers: { "POST /api/v1/mcp-servers": () => new Promise(() => undefined) },
      };
    case "add-ready":
      return { ...urlScene, create: { status: 200, body: MCP_READY_NEW_URL_SERVER } };
    case "add-plugin-origin":
      return {
        ...scene,
        create: {
          status: 409,
          body: {
            error: {
              code: "conflict",
              message: "The PostHog plugin offers this server.",
              details: {
                reason: "mcp-server-on-plugin-origin",
                contributionId: "posthog/posthog",
                connectionId: "c-posthog",
                pluginState: "active",
              },
            },
          },
        },
      };
    case "token":
      return urlScene;
    case "replace-several":
      return { ...scene, mcp: MCP_REPLACE_SEVERAL_RECORDS };
    case "replace-stale":
      return { ...urlScene, update: REPLACE_REFUSED };
    case "url-page-token":
    case "url-page-oauth":
      return { ...scene, mcp: MCP_READY_URL_RECORDS };
    case "urls-long":
      return { ...scene, mcp: MCP_LONG_ADDRESS_RECORDS };
    case "sign-in-refused":
      return {
        ...oauthScene,
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
/** Presses "Add by URL" and returns when the dialog's Address field is there. */
const openAddDialog = async (): Promise<void> => {
  await pressPart('section[aria-label="Added by URL"] .mcp-group-top button');
  await waitForPart(ADDRESS_FIELD);
};
const ADDRESS_FIELD = 'dialog[open] input[placeholder="https://mcp.example.com/mcp"]';

/** The address each Add scene types, and what its dialog shows once the controller answered. */
const ADD_SCENES: Readonly<Record<string, { address: string; settled: string }>> = {
  "add-token": {
    address: "https://mcp.wiki.example/mcp",
    settled: 'dialog[open] input[type="password"]',
  },
  "add-duplicate": { address: "https://mcp.docs.example/mcp", settled: "dialog[open] .warn" },
  "add-plugin-origin": { address: "https://mcp.posthog.com/mcp", settled: "dialog[open] .warn" },
  "add-checking": { address: "https://mcp.wiki.example/mcp", settled: "dialog[open] .wait" },
  "add-ready": { address: "https://mcp.knowledge.example/mcp", settled: "dialog[open] .url-tools" },
};
if (state === "add-empty") await openAddDialog();
const addScene = ADD_SCENES[state];
if (addScene !== undefined) {
  await openAddDialog();
  await typeInto(ADDRESS_FIELD, addScene.address);
  await pressPart('dialog[open] button[type="submit"]');
  await waitForPart(addScene.settled);
}
if (state === "sign-in-choice" || state === "token") {
  await pressPart(".mcp-band button");
  await waitForPart(
    state === "token"
      ? 'dialog[open] input[type="password"]'
      : "dialog[open] .setup-acts .btn--accent",
  );
}
if (
  state === "sign-in-waiting" ||
  state === "sign-in-long-host" ||
  state === "sign-in-open-failed" ||
  state === "sign-in-paste" ||
  state === "sign-in-timed-out" ||
  state === "sign-in-refused"
) {
  await pressPart(".mcp-band button");
  await pressPart("dialog[open] .setup-acts .btn--accent");
  await waitForPart(
    state === "sign-in-timed-out" || state === "sign-in-refused"
      ? "dialog[open] .warn"
      : state === "sign-in-paste"
        ? "dialog[open] .url-paste"
        : "dialog[open] .url-waiting > .setup-acts > .btn:last-child",
  );
}
if (state === "sign-in-open-failed") {
  await pressPart("dialog[open] .url-waiting > .setup-acts > .btn:last-child");
  await waitForPart("dialog[open] .url-waiting .fl-err");
}
if (state === "replace" || state === "replace-several" || state === "replace-stale") {
  await pressPart('[role="switch"][aria-label="Offer posthog webshop to threads"]');
  await waitForPart(
    state === "replace-several" ? "dialog[open] .options" : "dialog[open] .url-replace",
  );
}
if (state === "replace-stale") {
  await pressPart('dialog[open] button[type="submit"]');
  await waitForPart("dialog[open] .fl-err");
}
await markMcpSceneReady(page);
