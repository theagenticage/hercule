/**
 * Tests the two states of the Replace dialog that the refusal tests do not
 * reach: the button while the write runs, and the way to read the list again
 * when the write went through and the list could not be read. The words come
 * from client-core; these tests check that this app draws them.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  buildConnection,
  buildMcpControllerHandlers,
  buildMcpWorld,
  buildPlugin,
} from "@hercule/client-core/mcp-servers/testing";
import { buildErrorBody, renderApp, stubApi, type Handler } from "../../../../app/testing";
import { buildUrlServer } from "../../../../app/testing-mcp-servers";

const makeId = (kind: string, n: number): string =>
  `0199c0ff-${kind.repeat(4)}-7000-8000-${String(n).padStart(12, "0")}`;

const C_WORK = makeId("c", 1);
const S_HAND = buildUrlServer(makeId("5", 3), "sentry_hand", "https://mcp.sentry.example/mcp");
const LIST_PATH = "/api/v1/mcp-servers";

/** Opens Settings > MCP servers on a controller that holds one server added by hand on the Sentry address. */
const openList = async (extra: Readonly<Record<string, Handler>>) => {
  const world = buildMcpWorld({
    servers: [S_HAND],
    projects: [],
    plugins: [buildPlugin("sentry", "Sentry")],
    connections: [buildConnection(C_WORK, "sentry/sentry", "work", "acct:work")],
  });
  const api = stubApi({
    ...buildMcpControllerHandlers(world, { createdIds: [] }),
    "GET /api/v1/setup": { body: { complete: true } },
    "GET /api/v1/settings": {
      body: {
        controller: {},
        user: { "onboarding.completedSteps": ["timezone", "assistant"], "thread.mcpServerIds": [] },
      },
    },
    "GET /api/v1/plugins": () => ({ body: world.plugins }),
    "GET /api/v1/connections": () => ({ body: { items: world.connections } }),
    "GET /api/v1/projects": { body: { items: [] } },
    [`GET ${LIST_PATH}`]: () => ({ body: { items: world.servers } }),
    [`GET ${LIST_PATH}/${S_HAND.id}`]: () => ({ body: S_HAND }),
    ...extra,
  });
  await renderApp({ path: "/settings/mcp-servers", api: api.fetch, token: "held" });
  return api;
};

/** Presses the switch that opens the Replace dialog, and returns the dialog. */
const openReplaceDialog = async (): Promise<HTMLElement> => {
  const row = await screen.findByRole("switch", { name: "Offer sentry work to threads" });
  await userEvent.click(row);
  return screen.findByRole("dialog");
};

describe("Settings > MCP servers > Replace while it writes and when it cannot read the result", () => {
  it("shows the button as busy while the controller has not answered the write", async () => {
    await openList({ [`PATCH ${LIST_PATH}/${S_HAND.id}`]: () => new Promise(() => undefined) });
    const dialog = await openReplaceDialog();

    await userEvent.click(within(dialog).getByRole("button", { name: "Replace" }));

    expect(await within(dialog).findByRole("button", { name: "Replacing…" })).toBeTruthy();
  });

  it("offers to read the list again when the write went through and the list cannot be read", async () => {
    let written = false;
    const api = await openList({
      [`PATCH ${LIST_PATH}/${S_HAND.id}`]: () => {
        written = true;
        return { body: S_HAND };
      },
      [`GET ${LIST_PATH}`]: () =>
        written
          ? { status: 500, body: buildErrorBody("internal", "The list could not be read.") }
          : { body: { items: [S_HAND] } },
    });
    const dialog = await openReplaceDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Replace" }));

    const readAgain = await within(dialog).findByRole("button", { name: "Read again" });
    const readsBefore = api.calls.filter((call) => call.path === LIST_PATH).length;
    await userEvent.click(readAgain);

    await waitFor(() => {
      expect(api.calls.filter((call) => call.path === LIST_PATH).length).toBeGreaterThan(
        readsBefore,
      );
    });
  });
});
