/**
 * Tests the servers added by URL in Settings > MCP servers against the stubbed
 * controller: the group "Added by URL", the Add by URL dialog (a server that
 * needs no sign-in, the token step, each refusal and its button), the Replace
 * dialog with one candidate and with several, and the page of such a server
 * (its chips, the Sign-in row, the band's button and "Replace token…").
 * The thread's "Sign in…" is tested beside the thread's lines
 * (`mcp-lines.integration.test.tsx`, `plus-menu.integration.test.tsx`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { queryKeys } from "@hercule/client-core";
import { ADDRESS_FIELD_HINT } from "@hercule/client-core/mcp-servers";
import type { Handler } from "@hercule/client-core/testing";
import { forgetLastSettingsSection } from "../../../../../app/last-settings-section";
import {
  buildUrlServer,
  DOCS,
  DOCS_ID,
  NOTION,
  NOTION_ID,
  SENTRY_HOBBY,
  SENTRY_HOBBY_CONNECTION,
  SENTRY_HOBBY_ID,
  SENTRY_PLUGIN,
  SENTRY_WORK,
  SENTRY_WORK_CONNECTION,
  SENTRY_WORK_ID,
  LINEAR_PLUGIN,
} from "../../../../../screens/settings/mcp-servers/mcp-servers.testing";
import {
  findCalls,
  findRow,
  openList,
  openPage,
  readCells,
  SERVER_LIST_PATH,
  type OpenedMcpApp,
} from "../../../../../screens/settings/mcp-servers/mcp-world.testing";

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../../../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

afterEach(forgetLastSettingsSection);

/** The id the stubbed controller gives the first server a test creates. */
const CREATED_ID = "01a06d02-8300-7000-8000-000000000001";
const DOCS_URL = "https://mcp.docs.example/mcp";
const TOKEN = "abcd1234efgh5678";

const SENTRY_ADDRESS = "https://mcp.sentry.example/mcp";
const SENTRY_DOCS_ID = "01a06d02-8200-7000-8000-000000000013";
const SENTRY_NOTES_ID = "01a06d02-8200-7000-8000-000000000014";
const SENTRY_DOCS = buildUrlServer(SENTRY_DOCS_ID, "sentrydocs", SENTRY_ADDRESS);
const SENTRY_NOTES = buildUrlServer(SENTRY_NOTES_ID, "sentrynotes", `${SENTRY_ADDRESS}/notes`);

/** Changes the server `id` in the controller's world and pushes the change, as the controller does when a check ends. */
const finishCheck = (
  app: OpenedMcpApp,
  id: string,
  change: Parameters<typeof buildUrlServer>[3],
): void => {
  app.world.servers = app.world.servers.map((server) =>
    server.id === id ? { ...server, ...change } : server,
  );
  act(() => {
    app.live.pushInvalidation("mcpServer", [id]);
  });
};

const READY = { status: "ready", statusDetail: null, checkedAt: DOCS.checkedAt } as const;

/** Presses "Add by URL" and returns the dialog it opens. */
const openAddDialog = async (): Promise<HTMLElement> => {
  await userEvent.click(screen.getByRole("button", { name: "Add by URL" }));
  return screen.findByRole("dialog", { name: "Add an MCP server" });
};

/** Types `address` in the open dialog's Address field and presses "Check server". */
const checkAddress = async (dialog: HTMLElement, address: string): Promise<void> => {
  await userEvent.type(within(dialog).getByLabelText("Address"), address);
  await userEvent.click(within(dialog).getByRole("button", { name: "Check server" }));
};

describe("Settings > MCP servers, the group Added by URL", () => {
  it("lists each server added by URL with its whole address and tool count, under its own heading", async () => {
    await openList({
      servers: [SENTRY_WORK, { ...DOCS, status: "needs-sign-in", statusDetail: "401" }, NOTION],
    });

    expect(screen.getByRole("heading", { name: "Added by URL" })).toBeTruthy();
    expect(
      screen.getByText("Any remote MCP server, signed in once on the controller"),
    ).toBeTruthy();
    // The address is the account, and a server added by URL is written by its name alone.
    expect(readCells(findRow("docs")).slice(1, 4)).toEqual([
      `docs${DOCS_URL} · 2 tools`,
      "needs sign-in",
      "None",
    ]);
    expect(findRow("docs").classList.contains("is-fail")).toBe(true);
    expect(findRow("notion").querySelector(".mcp-name")?.textContent).toBe("notion");
    // Not a row of "From your Connections".
    expect(findRow("docs").querySelector("a")?.getAttribute("href")).toBe(
      `/settings/mcp-servers/${DOCS_ID}`,
    );
  });

  it("says None added with the line that tells what the group is for, and still offers Add by URL", async () => {
    await openList({ servers: [SENTRY_WORK] });

    expect(screen.getByText("None added")).toBeTruthy();
    expect(screen.getByText("Add any remote MCP server by its address.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add by URL" })).toBeTruthy();
  });

  it("switches a server added by URL off and on with one write each, on its record", async () => {
    const { world, calls } = await openList({ servers: [DOCS] });

    const toggle = within(findRow("docs")).getByRole("switch", { name: "Offer docs to threads" });
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(world.servers[0]!.enabled).toBe(false);
    });
    expect(findCalls(calls, "PATCH", `${SERVER_LIST_PATH}/${DOCS_ID}`).map((c) => c.body)).toEqual([
      { enabled: false },
    ]);
  });
});

describe("Add by URL", () => {
  it("creates a server that needs no sign-in, leaves the suggested name to the controller, and ends on ready", async () => {
    const app = await openList({ servers: [] });
    const dialog = await openAddDialog();

    await userEvent.type(within(dialog).getByLabelText("Address"), DOCS_URL);

    // A key goes in the token field, so the address form says not to put one in the address.
    expect(within(dialog).getByText(ADDRESS_FIELD_HINT)).toBeTruthy();
    // The name follows the address until the user types in it.
    expect(within(dialog).getByLabelText<HTMLInputElement>("Name").value).toBe("docs");
    expect(within(dialog).getByText("mcp__tools__docs__<tool>")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Check server" }));

    await within(dialog).findByText("Asking mcp.docs.example for its tools.");
    expect(findCalls(app.calls, "POST", SERVER_LIST_PATH).map((call) => call.body)).toEqual([
      { source: { kind: "url", url: DOCS_URL } },
    ]);
    finishCheck(app, CREATED_ID, { ...READY, tools: DOCS.tools });

    await within(dialog).findByText("ready · 2 tools");
    // The new server's tools are listed, as the web app lists them.
    expect(
      [...dialog.querySelectorAll(".url-tools .mcp-tool")].map((tool) => tool.textContent),
    ).toEqual(["search_issuesSearches issues.", "get_issueReads one issue."]);
    expect(within(dialog).getByText(/^No project names it yet\./)).toBeTruthy();
    // The server is in the list behind the dialog.
    await waitFor(() => {
      expect(findRow("docs")).toBeTruthy();
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Open docs" }));
    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe(`/settings/mcp-servers/${CREATED_ID}`);
    });
  });

  it("sends a name the user typed, and keeps it when the address changes", async () => {
    const app = await openList({ servers: [] });
    const dialog = await openAddDialog();
    const address = within(dialog).getByLabelText("Address");

    await userEvent.type(address, "https://mcp.docs.example/mcp");
    await userEvent.clear(within(dialog).getByLabelText("Name"));
    await userEvent.type(within(dialog).getByLabelText("Name"), "manuals");
    await userEvent.type(address, "x");
    expect(within(dialog).getByLabelText<HTMLInputElement>("Name").value).toBe("manuals");
    await userEvent.click(within(dialog).getByRole("button", { name: "Check server" }));

    await waitFor(() => {
      expect(findCalls(app.calls, "POST", SERVER_LIST_PATH).map((call) => call.body)).toEqual([
        { source: { kind: "url", url: "https://mcp.docs.example/mcpx", name: "manuals" } },
      ]);
    });
  });

  it("asks for a token when the server needs one, sends it with setToken, and follows the check to ready", async () => {
    const app = await openList({ servers: [] });
    const dialog = await openAddDialog();
    await checkAddress(dialog, DOCS_URL);
    await within(dialog).findByText("Asking mcp.docs.example for its tools.");

    finishCheck(app, CREATED_ID, {
      status: "needs-sign-in",
      statusDetail: "401",
      source: { kind: "url", url: DOCS_URL, signIn: "none", signInOffered: "token" },
    });

    await within(dialog).findByText("This server needs a token.");
    expect(
      within(dialog).getByText("Kept on the controller. It never reaches a runner."),
    ).toBeTruthy();
    // A token the contract refuses is shown in the form, and nothing is sent.
    await userEvent.type(within(dialog).getByLabelText("Token"), "short");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save token" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(
      /at least 8 printable characters/,
    );
    expect(app.world.tokens).toEqual([]);

    await userEvent.clear(within(dialog).getByLabelText("Token"));
    await userEvent.type(within(dialog).getByLabelText("Token"), TOKEN);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save token" }));

    await waitFor(() => {
      expect(app.world.tokens).toEqual([{ id: CREATED_ID, token: TOKEN }]);
    });
    await within(dialog).findByText("Asking mcp.docs.example for its tools.");
    finishCheck(app, CREATED_ID, { ...READY, tools: DOCS.tools });
    await within(dialog).findByText("ready · 2 tools");
  });

  it("shows the controller's reason when the saved token is refused, with the token form again", async () => {
    const app = await openList({ servers: [] });
    const dialog = await openAddDialog();
    await checkAddress(dialog, DOCS_URL);
    await within(dialog).findByText("Asking mcp.docs.example for its tools.");
    finishCheck(app, CREATED_ID, {
      status: "needs-sign-in",
      source: { kind: "url", url: DOCS_URL, signIn: "none", signInOffered: "token" },
    });
    await userEvent.type(await within(dialog).findByLabelText("Token"), TOKEN);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save token" }));
    await waitFor(() => {
      expect(app.world.tokens).toHaveLength(1);
    });

    finishCheck(app, CREATED_ID, {
      status: "needs-sign-in",
      statusDetail: "docs.example refused the token (401).",
    });

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "docs.example refused the token (401).",
    );
    expect(within(dialog).getByText("The server refused its token. Paste a new one.")).toBeTruthy();
    // The refused token is not handed back: the field opens empty, and a retry sends only what is typed now.
    expect(within(dialog).getByLabelText<HTMLInputElement>("Token").value).toBe("");
    expect(dialog.innerHTML).not.toContain(TOKEN);
    await userEvent.type(within(dialog).getByLabelText("Token"), "a-second-token-1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save token" }));
    await waitFor(() => {
      expect(app.world.tokens).toEqual([
        { id: CREATED_ID, token: TOKEN },
        { id: CREATED_ID, token: "a-second-token-1" },
      ]);
    });
  });

  it("says apart a check that failed, and checks again from the dialog", async () => {
    const app = await openList({ servers: [] });
    const dialog = await openAddDialog();
    await checkAddress(dialog, DOCS_URL);
    await within(dialog).findByText("Asking mcp.docs.example for its tools.");

    finishCheck(app, CREATED_ID, {
      status: "unreachable",
      statusDetail: "No answer in 10 seconds.",
    });

    await within(dialog).findByText("mcp.docs.example could not be reached.");
    expect(within(dialog).getByText(/No answer in 10 seconds\./)).toBeTruthy();
    // The dialog opened on the list, so the failed server is somewhere else.
    expect(within(dialog).getByRole("button", { name: "Open docs" })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Check now" }));
    await waitFor(() => {
      expect(app.world.checked).toEqual([CREATED_ID]);
    });
    await within(dialog).findByText("Asking mcp.docs.example for its tools.");
  });

  it("stays busy after Check now until the record answers, takes no second press, and shows the new failure when it comes", async () => {
    let checkRequests = 0;
    // The controller acknowledges and checks later: it changes nothing the record shows at first.
    const app = await openList({
      servers: [],
      handlers: {
        [`POST ${SERVER_LIST_PATH}/${CREATED_ID}/check`]: () => {
          checkRequests += 1;
          return { body: {} };
        },
      },
    });
    const dialog = await openAddDialog();
    await checkAddress(dialog, DOCS_URL);
    await within(dialog).findByText("Asking mcp.docs.example for its tools.");
    finishCheck(app, CREATED_ID, {
      status: "unreachable",
      statusDetail: "No answer in 10 seconds.",
      updatedAt: "2026-11-23T09:00:00.000Z",
    });
    await within(dialog).findByText("mcp.docs.example could not be reached.");

    await userEvent.click(within(dialog).getByRole("button", { name: "Check now" }));
    await waitFor(() => {
      expect(checkRequests).toBe(1);
    });
    await waitFor(() => {
      expect(app.context.queryClient.isFetching()).toBe(0);
    });

    // Both reads came back with the old failure. The button is still busy, and a press asks nothing.
    const checkNow = within(dialog).getByRole("button", { name: "Check now" });
    expect(checkNow.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(checkNow);
    expect(checkRequests).toBe(1);

    finishCheck(app, CREATED_ID, {
      statusDetail: "Connection refused.",
      updatedAt: "2026-11-23T09:01:00.000Z",
    });
    await within(dialog).findByText(/Connection refused\./);
    expect(
      within(dialog).getByRole("button", { name: "Check now" }).getAttribute("aria-disabled"),
    ).toBe("false");
  });

  it("offers Open on a new server that is switched off while it is checked", async () => {
    const app = await openList({ servers: [] });
    const dialog = await openAddDialog();
    await checkAddress(dialog, DOCS_URL);
    await within(dialog).findByText("Asking mcp.docs.example for its tools.");

    finishCheck(app, CREATED_ID, { enabled: false });

    await within(dialog).findByText("This server is switched off, so it is not checked.");
    expect(within(dialog).getByRole("button", { name: "Open docs" })).toBeTruthy();
  });

  it("keeps the server when the dialog is closed after the check, and says so while it waits", async () => {
    const app = await openList({ servers: [] });
    const dialog = await openAddDialog();
    await checkAddress(dialog, DOCS_URL);

    expect(await within(dialog).findByText("The server stays in the list.")).toBeTruthy();
    // Esc and a click on the scrim close the dialog through the browser.
    act(() => {
      (dialog as HTMLDialogElement).close();
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(findRow("docs")).toBeTruthy();
    });
    expect(app.world.servers.map((server) => server.id)).toEqual([CREATED_ID]);
  });

  it("refuses an address added before in the form, with a button to the server", async () => {
    const app = await openList({ servers: [DOCS] });
    const dialog = await openAddDialog();

    await checkAddress(dialog, DOCS_URL);

    await waitFor(() => {
      expect(dialog.textContent).toContain(
        "You added this server before, as docs. One address is one server.",
      );
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Open docs" }));
    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe(`/settings/mcp-servers/${DOCS_ID}`);
    });
  });

  it("drops the button to the server an address was refused for when that server is deleted meanwhile", async () => {
    const app = await openList({ servers: [DOCS] });
    const dialog = await openAddDialog();
    await checkAddress(dialog, DOCS_URL);
    await within(dialog).findByRole("button", { name: "Open docs" });

    app.world.servers = [];
    act(() => {
      app.live.pushInvalidation("mcpServer", [DOCS_ID]);
    });

    await within(dialog).findByText(
      "You added this server before, but it was removed since. Check the server again to add it.",
    );
    expect(within(dialog).queryByRole("button", { name: /^Open/ })).toBeNull();
  });

  it("refuses an address a plugin offers, and leads to that plugin's row for the Connection that is connected", async () => {
    await openList({
      servers: [SENTRY_WORK],
      handlers: {
        [`POST ${SERVER_LIST_PATH}`]: {
          status: 409,
          body: {
            error: {
              code: "conflict",
              message: "The Sentry plugin offers this server.",
              details: {
                reason: "mcp-server-on-plugin-origin",
                contributionId: "sentry/sentry",
                connectionId: SENTRY_WORK_CONNECTION.id,
                pluginState: "active",
              },
            },
          },
        },
      },
    });
    const dialog = await openAddDialog();

    await checkAddress(dialog, SENTRY_ADDRESS);

    await within(dialog).findByText(
      "The Sentry plugin already offers this server. It is reached with a Sentry Connection, with no second sign-in, so it is not added by hand.",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Show Sentry · work" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(document.activeElement).toBe(
      within(findRow("sentry work")).getByRole("switch", { name: "Offer sentry work to threads" }),
    );
  });

  it("sends the user to Settings > Connections when the plugin's Connection is missing", async () => {
    const app = await openList({
      servers: [],
      connections: [],
      handlers: {
        [`POST ${SERVER_LIST_PATH}`]: {
          status: 409,
          body: {
            error: {
              code: "conflict",
              message: "The Sentry plugin offers this server.",
              details: {
                reason: "mcp-server-on-plugin-origin",
                contributionId: "sentry/sentry",
                connectionId: null,
                pluginState: "active",
              },
            },
          },
        },
      },
    });
    const dialog = await openAddDialog();
    await checkAddress(dialog, SENTRY_ADDRESS);

    await within(dialog).findByText(/Connect Sentry first in Settings > Connections/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Open Connections" }));

    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe("/settings/connections");
    });
  });

  it("says where a switched-off plugin is switched on, in words, because the app has no Plugins page", async () => {
    await openList({
      servers: [],
      handlers: {
        "GET /api/v1/plugins": {
          body: [{ ...SENTRY_PLUGIN, enabled: false, status: { _tag: "inactive" } }, LINEAR_PLUGIN],
        },
        [`POST ${SERVER_LIST_PATH}`]: {
          status: 409,
          body: {
            error: {
              code: "conflict",
              message: "The Sentry plugin offers this server.",
              details: {
                reason: "mcp-server-on-plugin-origin",
                contributionId: "sentry/sentry",
                connectionId: null,
                pluginState: "switched-off",
              },
            },
          },
        },
      },
    });
    const dialog = await openAddDialog();
    await checkAddress(dialog, SENTRY_ADDRESS);

    await within(dialog).findByText(
      /Switch the Sentry plugin on in Settings > Plugins in the web app to use it\./,
    );
    expect(within(dialog).queryByRole("button", { name: /Plugins/ })).toBeNull();
  });
});

describe("Replace", () => {
  it("asks before moving the one server added by URL on the plugin's address, and writes one update", async () => {
    const app = await openList({ servers: [SENTRY_WORK, SENTRY_DOCS] });

    await userEvent.click(
      within(findRow("sentry hobby")).getByRole("switch", {
        name: "Offer sentry hobby to threads",
      }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Replace the sentrydocs server you added?",
    });
    expect(dialog.textContent).toContain(
      `You added ${SENTRY_ADDRESS} by hand, with a sign-in of its own. Sentry · hobby reaches the same server`,
    );
    expect(
      [...dialog.querySelectorAll(".url-replace > div")].map((line) => line.textContent),
    ).toEqual([
      "Staysthe name and the projects that name it.",
      "Changesit acts through the Connection.",
      "Goesthe sign-in made by hand.",
    ]);
    // Opening the dialog wrote nothing.
    expect(findCalls(app.calls, "POST", SERVER_LIST_PATH)).toEqual([]);
    expect(findCalls(app.calls, "PATCH", `${SERVER_LIST_PATH}/${SENTRY_DOCS_ID}`)).toEqual([]);

    await userEvent.click(within(dialog).getByRole("button", { name: "Replace" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(
      findCalls(app.calls, "PATCH", `${SERVER_LIST_PATH}/${SENTRY_DOCS_ID}`).map(
        (call) => call.body,
      ),
    ).toEqual([
      {
        source: {
          kind: "plugin",
          contributionId: "sentry/sentry",
          connectionId: SENTRY_HOBBY_CONNECTION.id,
        },
        enabled: true,
      },
    ]);
    expect(findCalls(app.calls, "POST", SERVER_LIST_PATH)).toEqual([]);
    // The server is the row of the Connection now, with its name and id kept.
    await waitFor(() => {
      expect(screen.getByText("None added")).toBeTruthy();
    });
    expect(
      within(findRow("sentrydocs"))
        .getByRole("link", { name: /sentrydocs/ })
        .getAttribute("href"),
    ).toBe(`/settings/mcp-servers/${SENTRY_DOCS_ID}`);
  });

  it("makes the user choose among several servers, and replaces only the one chosen", async () => {
    const app = await openList({ servers: [SENTRY_WORK, SENTRY_DOCS, SENTRY_NOTES] });
    await userEvent.click(
      within(findRow("sentry hobby")).getByRole("switch", {
        name: "Offer sentry hobby to threads",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Which server do you replace?" });

    // Nothing is chosen for the user: Replace waits for the choice.
    const replace = within(dialog).getByRole("button", { name: "Replace" });
    expect(replace.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(replace);
    expect(findCalls(app.calls, "PATCH", `${SERVER_LIST_PATH}/${SENTRY_NOTES_ID}`)).toEqual([]);
    expect(
      within(dialog)
        .getAllByRole("radio")
        .map((radio) => (radio as HTMLInputElement).checked),
    ).toEqual([false, false]);

    await userEvent.click(within(dialog).getByRole("radio", { name: /sentrynotes/ }));
    await screen.findByRole("dialog", { name: "Replace the sentrynotes server you added?" });
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(findCalls(app.calls, "PATCH", `${SERVER_LIST_PATH}/${SENTRY_NOTES_ID}`)).toHaveLength(1);
    expect(findCalls(app.calls, "PATCH", `${SERVER_LIST_PATH}/${SENTRY_DOCS_ID}`)).toEqual([]);
    // The other server stays added by URL.
    expect(findRow("sentrydocs").querySelector(".mcp-name")?.textContent).toBe("sentrydocs");
  });

  it("shows the controller's refusal in the dialog, with the server that won", async () => {
    await openList({
      servers: [SENTRY_WORK, SENTRY_DOCS],
      handlers: {
        [`PATCH ${SERVER_LIST_PATH}/${SENTRY_DOCS_ID}`]: {
          status: 409,
          body: {
            error: {
              code: "conflict",
              message: "This Connection has a server already.",
              details: { reason: "mcp-server-exists", mcpServerId: SENTRY_WORK_ID },
            },
          },
        },
      },
    });
    await userEvent.click(
      within(findRow("sentry hobby")).getByRole("switch", {
        name: "Offer sentry hobby to threads",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Replace the sentrydocs server you added?",
    });

    await userEvent.click(within(dialog).getByRole("button", { name: "Replace" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Nothing was replaced. This Connection has a server already.",
    );
    expect(within(dialog).getByRole("button", { name: "Open sentry" })).toBeTruthy();
  });
});

describe("Replace, as the controller and other clients move it", () => {
  /** The record of a plugin's server on the hobby Connection, as another client's create leaves it. */
  const HOBBY_WINNER = SENTRY_HOBBY;

  /** The server the Replace of `SENTRY_NOTES` leaves behind: on the hobby Connection, switched on. */
  const MOVED_NOTES = {
    ...SENTRY_NOTES,
    enabled: true,
    source: {
      kind: "plugin",
      contributionId: "sentry/sentry",
      connectionId: SENTRY_HOBBY_CONNECTION.id,
    },
  } as const;

  /** The answer of a controller that finds the record of the Connection's account already there. */
  const CONFLICT = {
    status: 409,
    body: {
      error: {
        code: "conflict",
        message: "This Connection has a server already.",
        details: { reason: "mcp-server-exists", mcpServerId: SENTRY_HOBBY_ID },
      },
    },
  } as const;

  /** The answer of a controller that no longer has the server the update is for. */
  const NOT_FOUND = {
    status: 404,
    body: { error: { code: "not_found", message: "This server is gone." } },
  } as const;

  /**
   * Opens the Replace dialog of the hobby row with `SENTRY_DOCS` and `SENTRY_NOTES` to choose
   * from, and holds the update until `release` is called. The update then answers with `answer`,
   * or moves `SENTRY_NOTES` onto the Connection when there is none.
   */
  const openHeldReplace = async (answer?: typeof CONFLICT | typeof NOT_FOUND) => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder: { app?: OpenedMcpApp } = {};
    const app = await openList({
      servers: [SENTRY_WORK, SENTRY_DOCS, SENTRY_NOTES],
      handlers: {
        [`PATCH ${SERVER_LIST_PATH}/${SENTRY_NOTES_ID}`]: async () => {
          await gate;
          if (answer !== undefined) return answer;
          holder.app!.world.servers = holder.app!.world.servers.map((server) =>
            server.id === SENTRY_NOTES_ID ? MOVED_NOTES : server,
          );
          return { body: MOVED_NOTES };
        },
      },
    });
    holder.app = app;
    await userEvent.click(
      within(findRow("sentry hobby")).getByRole("switch", {
        name: "Offer sentry hobby to threads",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Which server do you replace?" });
    await userEvent.click(within(dialog).getByRole("radio", { name: /sentrynotes/ }));
    return { app, dialog, release };
  };

  it("keeps the confirmed server selected while its update is held, and closes when its own record is on the Connection", async () => {
    const { app, release } = await openHeldReplace();
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));

    const dialog = screen.getByRole("dialog", {
      name: /Replace the sentrynotes server you added\?/,
    });
    // The radios are fixed on the confirmed server, whatever the list does.
    const radios = within(dialog).getAllByRole<HTMLInputElement>("radio");
    expect(radios.map((radio) => radio.checked)).toEqual([false, true]);
    expect(radios.every((radio) => radio.disabled)).toBe(true);

    release();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(findCalls(app.calls, "PATCH", `${SERVER_LIST_PATH}/${SENTRY_NOTES_ID}`)).toHaveLength(1);
  });

  it("keeps the dialog with the refusal and a link when another client's server appears on the Connection while the update is held, and lets the user choose again once the controller refuses", async () => {
    const { app, dialog, release } = await openHeldReplace(CONFLICT);
    await userEvent.click(within(dialog).getByRole("button", { name: "Replace" }));

    app.world.servers = [...app.world.servers, HOBBY_WINNER];
    act(() => {
      app.live.pushInvalidation("mcpServer", [SENTRY_HOBBY_ID]);
    });

    const refusal = await screen.findByRole("alert");
    expect(refusal.textContent).toBe(
      "Nothing was replaced. This Connection's server was added meanwhile.",
    );
    // The selection is fixed while the update is held.
    expect(
      within(screen.getByRole("dialog"))
        .getAllByRole<HTMLInputElement>("radio")
        .every((radio) => radio.disabled),
    ).toBe(true);

    release();
    // The controller refuses: the dialog stays with the reason and the winner's link, and the radios are free.
    await waitFor(() => {
      const radios = within(screen.getByRole("dialog")).getAllByRole<HTMLInputElement>("radio");
      expect(radios.some((radio) => radio.disabled)).toBe(false);
    });
    const open = screen.getByRole("dialog", { name: /Replace the sentrynotes server you added\?/ });
    expect(within(open).getByRole("alert").textContent).toBe(
      "Nothing was replaced. This Connection has a server already.",
    );
    expect(within(open).getByRole("button", { name: "Open sentry" })).toBeTruthy();
    expect(findCalls(app.calls, "PATCH", `${SERVER_LIST_PATH}/${SENTRY_NOTES_ID}`)).toHaveLength(1);
  });

  it("releases the selection when the confirmed server was deleted and the controller says not_found: the reason stays, the stale choice is cleared and the user chooses again", async () => {
    const { app, dialog, release } = await openHeldReplace(NOT_FOUND);
    await userEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
    app.world.servers = app.world.servers.filter((server) => server.id !== SENTRY_NOTES_ID);
    act(() => {
      app.live.pushInvalidation("mcpServer", [SENTRY_NOTES_ID]);
    });
    // While the update is held the dialog still names the confirmed server.
    await screen.findByRole("dialog", { name: /Replace the sentrynotes server you added\?/ });

    release();

    const chooser = await screen.findByRole("dialog", {
      name: /Replace the sentrydocs server you added\?/,
    });
    expect(within(chooser).getByRole("alert").textContent).toBe(
      "Nothing was replaced. This server is gone.",
    );
    // The deleted server is not offered, the one left is chosen for the user and Replace is free.
    expect(within(chooser).queryByText("sentrynotes")).toBeNull();
    await userEvent.click(within(chooser).getByRole("button", { name: "Replace" }));
    await waitFor(() => {
      expect(findCalls(app.calls, "PATCH", `${SERVER_LIST_PATH}/${SENTRY_DOCS_ID}`)).toHaveLength(
        1,
      );
    });
    expect(findCalls(app.calls, "PATCH", `${SERVER_LIST_PATH}/${SENTRY_NOTES_ID}`)).toHaveLength(1);
  });

  it("keeps the dialog with the refusal and a link when the Connection's server appears before the user confirms", async () => {
    const app = await openList({ servers: [SENTRY_WORK, SENTRY_DOCS] });
    await userEvent.click(
      within(findRow("sentry hobby")).getByRole("switch", {
        name: "Offer sentry hobby to threads",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Replace the sentrydocs server you added?",
    });

    app.world.servers = [...app.world.servers, HOBBY_WINNER];
    act(() => {
      app.live.pushInvalidation("mcpServer", [SENTRY_HOBBY_ID]);
    });

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Nothing was replaced. This Connection's server was added meanwhile.",
    );
    expect(within(dialog).getByRole("button", { name: "Open sentry" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: /Replace the sentrydocs/ })).toBe(dialog);
  });
});

describe("the page of a server added by URL", () => {
  it("shows Added by URL and the whole address as chips, no account beside the name and no Connection row", async () => {
    await openPage(DOCS);

    expect(
      [...document.querySelectorAll(".mcp-chips .chip")].map((chip) => chip.textContent),
    ).toEqual(["Added by URL", DOCS_URL]);
    expect(document.querySelector(".mcp-lead h2")?.textContent).toBe("docs");
    const server = screen.getByRole("heading", { level: 2, name: "Server" }).closest("section")!;
    expect(within(server).queryByText("Connection")).toBeNull();
    expect(within(server).getByText("Sign-in").nextElementSibling?.textContent).toBe(
      "Kept on the controller. It never reaches a runner.",
    );
    expect(within(server).getByText("None needed")).toBeTruthy();
    expect(
      screen.getByText("Deletes the server and its sign-in. Projects that name it stop naming it."),
    ).toBeTruthy();
  });

  it("replaces the token of a server that holds one, from the Sign-in row", async () => {
    const app = await openPage(NOTION);
    const server = screen.getByRole("heading", { level: 2, name: "Server" }).closest("section")!;
    expect(within(server).getByText("A token")).toBeTruthy();

    await userEvent.click(within(server).getByRole("button", { name: "Replace token…" }));

    const dialog = await screen.findByRole("dialog", { name: "Replace the token of notion" });
    expect(
      within(dialog).getByText("Paste a new token. It replaces the one this server holds."),
    ).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText("Token"), TOKEN);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save token" }));

    await waitFor(() => {
      expect(app.world.tokens).toEqual([{ id: NOTION_ID, token: TOKEN }]);
    });
    await within(dialog).findByText("Asking mcp.notion.example for its tools.");
    finishCheck(app, NOTION_ID, READY);
    await within(dialog).findByText("ready · 2 tools");
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("puts Sign in… in the band while a token server needs it, and the row then has no button of its own", async () => {
    const app = await openPage({
      ...NOTION,
      status: "needs-sign-in",
      statusDetail: "notion.example refused the token (401).",
    });
    const band = document.querySelector<HTMLElement>(".mcp-band")!;
    expect(band.textContent).toContain("Needs sign-in.");
    const server = screen.getByRole("heading", { level: 2, name: "Server" }).closest("section")!;
    expect(within(server).queryByRole("button", { name: "Replace token…" })).toBeNull();

    await userEvent.click(within(band).getByRole("button", { name: "Sign in…" }));

    const dialog = await screen.findByRole("dialog", { name: "Sign in to notion" });
    expect(within(dialog).getByText("The server refused its token. Paste a new one.")).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText("Token"), TOKEN);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save token" }));
    await waitFor(() => {
      expect(app.world.tokens).toHaveLength(1);
    });
  });

  it("keeps the heading the sign-in dialog opened with when the server moves onto a Connection meanwhile", async () => {
    const app = await openPage({
      ...NOTION,
      status: "needs-sign-in",
      statusDetail: "notion.example refused the token (401).",
    });
    const band = document.querySelector<HTMLElement>(".mcp-band")!;
    await userEvent.click(within(band).getByRole("button", { name: "Sign in…" }));
    await screen.findByRole("dialog", { name: "Sign in to notion" });

    finishCheck(app, NOTION_ID, {
      ...READY,
      enabled: true,
      source: {
        kind: "plugin",
        contributionId: "sentry/sentry",
        connectionId: SENTRY_HOBBY_CONNECTION.id,
      },
    });

    await within(screen.getByRole("dialog")).findByText(/is reached with a Connection now/);
    expect(screen.getByRole("dialog", { name: "Sign in to notion" })).toBeTruthy();
  });

  it("opens the token field, not the browser choice, for a server that refused its pasted token and still offers OAuth", async () => {
    await openPage({
      ...NOTION,
      status: "needs-sign-in",
      statusDetail: "notion.example refused the token (401).",
      source: { kind: "url", url: DOCS_URL, signIn: "token", signInOffered: "oauth" },
    });
    const band = document.querySelector<HTMLElement>(".mcp-band")!;

    await userEvent.click(within(band).getByRole("button", { name: "Sign in…" }));

    const dialog = await screen.findByRole("dialog", { name: "Sign in to notion" });
    expect(within(dialog).getByLabelText<HTMLInputElement>("Token").value).toBe("");
    expect(within(dialog).getByText("The server refused its token. Paste a new one.")).toBeTruthy();
    // The browser stays available, as the second way.
    expect(within(dialog).getByRole("button", { name: "Sign in with your browser" })).toBeTruthy();
  });

  it("opens an empty token field for Replace token… on a server that holds a token and offers OAuth", async () => {
    await openPage({
      ...NOTION,
      source: { kind: "url", url: DOCS_URL, signIn: "token", signInOffered: "oauth" },
    });
    const server = screen.getByRole("heading", { level: 2, name: "Server" }).closest("section")!;

    await userEvent.click(within(server).getByRole("button", { name: "Replace token…" }));

    const dialog = await screen.findByRole("dialog", { name: "Sign in to notion" });
    expect(within(dialog).getByLabelText<HTMLInputElement>("Token").value).toBe("");
    expect(within(dialog).queryByText("This server signs in through your browser.")).toBeNull();
  });

  it("opens Replace token… on the token field though the record turned to OAuth between the press and the dialog's read", async () => {
    const app = await openPage({
      ...NOTION,
      source: { kind: "url", url: DOCS_URL, signIn: "token", signInOffered: "oauth" },
    });
    const server = screen.getByRole("heading", { level: 2, name: "Server" }).closest("section")!;
    const button = within(server).getByRole("button", { name: "Replace token…" });

    // A sign-in through the browser lands in the cache in the same turn as the press.
    act(() => {
      fireEvent.click(button);
      app.context.queryClient.setQueryData(queryKeys.mcpServer(NOTION_ID), {
        ...NOTION,
        source: { kind: "url", url: DOCS_URL, signIn: "oauth", signInOffered: "oauth" },
      });
    });

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText<HTMLInputElement>("Token").value).toBe("");
    expect(within(dialog).queryByText("This server signs in through your browser.")).toBeNull();
  });

  it("moves an untouched browser choice to the token field when the record turns token-first meanwhile", async () => {
    const app = await openPage({
      ...DOCS,
      status: "needs-sign-in",
      source: { kind: "url", url: DOCS_URL, signIn: "none", signInOffered: "oauth" },
    });
    const band = document.querySelector<HTMLElement>(".mcp-band")!;
    await userEvent.click(within(band).getByRole("button", { name: "Sign in…" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign in to docs" });
    expect(within(dialog).queryByLabelText("Token")).toBeNull();

    // Somebody pasted a token, and the server refused it.
    app.world.servers = app.world.servers.map((server) => ({
      ...server,
      source: { kind: "url", url: DOCS_URL, signIn: "token", signInOffered: "oauth" },
    }));
    act(() => {
      app.live.pushInvalidation("mcpServer", [DOCS_ID]);
    });

    expect(await within(dialog).findByLabelText("Token")).toBeTruthy();
  });

  it("offers no Open button on the server's own page when the check of a new token fails, only Check now", async () => {
    const app = await openPage(NOTION);
    const server = screen.getByRole("heading", { level: 2, name: "Server" }).closest("section")!;
    await userEvent.click(within(server).getByRole("button", { name: "Replace token…" }));
    const dialog = await screen.findByRole("dialog", { name: "Replace the token of notion" });
    await userEvent.type(within(dialog).getByLabelText("Token"), TOKEN);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save token" }));
    await within(dialog).findByText("Asking mcp.notion.example for its tools.");

    finishCheck(app, NOTION_ID, { status: "error", statusDetail: "It answered with HTML." });

    await within(dialog).findByText("mcp.notion.example answered in a way Hercule could not use.");
    expect(within(dialog).getByRole("button", { name: "Check now" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /^Open/ })).toBeNull();
  });

  it("offers Sign in… in the band of a server that asks for OAuth, which opens the dialog with the browser first", async () => {
    await openPage({
      ...DOCS,
      status: "needs-sign-in",
      source: { kind: "url", url: DOCS_URL, signIn: "none", signInOffered: "oauth" },
    });
    const band = document.querySelector<HTMLElement>(".mcp-band")!;

    expect(band.textContent).toContain(
      "Sign in through your browser, or paste a token, and this server comes back with it.",
    );
    await userEvent.click(within(band).getByRole("button", { name: "Sign in…" }));

    const dialog = await screen.findByRole("dialog", { name: "Sign in to docs" });
    expect(within(dialog).getByRole("button", { name: "Sign in with your browser" })).toBeTruthy();
    expect(within(dialog).queryByLabelText("Token")).toBeNull();
  });

  it("shows Sign in again… in the Sign-in row of a server that holds an OAuth sign-in", async () => {
    await openPage({
      ...DOCS,
      source: { kind: "url", url: DOCS_URL, signIn: "oauth", signInOffered: "oauth" },
    });
    const server = screen.getByRole("heading", { level: 2, name: "Server" }).closest("section")!;
    expect(within(server).getByText("OAuth")).toBeTruthy();

    await userEvent.click(within(server).getByRole("button", { name: "Sign in again…" }));

    const dialog = await screen.findByRole("dialog", { name: "Sign in to docs" });
    expect(within(dialog).getByRole("button", { name: "Sign in with your browser" })).toBeTruthy();
  });
});

const AUTHORIZATION_URL = "https://auth.docs.example/authorize?state=abc123&client_id=x";
const CALLBACK = "code=the-code&state=abc123";

type ReturnOutcome =
  | { readonly _tag: "received"; readonly callbackQuery: string }
  | { readonly _tag: "cancelled" }
  | { readonly _tag: "timed-out" };

/**
 * Plays main's `signInReturn`: a listener on `redirectUri` (or none when
 * `listens` is false), whose waits the test settles by hand, or that the
 * browser has come back to already when `returnsAtOnce` is true.
 */
const buildSignInReturn = (listens = true, returnsAtOnce = false) => {
  const waits: ((outcome: ReturnOutcome) => void)[] = [];
  return {
    waits,
    listen: vi.fn(() =>
      Promise.resolve(
        listens
          ? ({
              _tag: "listening",
              listenerId: "l-1",
              redirectUri: "http://127.0.0.1:4937/callback",
            } as const)
          : ({ _tag: "unavailable" } as const),
      ),
    ),
    wait: vi.fn(
      () =>
        new Promise<ReturnOutcome>((resolve) => {
          if (returnsAtOnce) resolve({ _tag: "received", callbackQuery: CALLBACK });
          else waits.push(resolve);
        }),
    ),
    cancel: vi.fn(() => Promise.resolve(undefined)),
  };
};

const invalidState = (reason: string) => ({
  status: 409,
  body: {
    error: { code: "invalid_state", message: "The controller's words.", details: { reason } },
  },
});

/** Opens the page of a server added by URL that needs sign-in through the browser, and its dialog at the first step. */
const openSignInDialog = async (
  signInReturn: ReturnType<typeof buildSignInReturn>,
  finish: Handler = { body: {} },
  openLink?: (
    url: string,
  ) => Promise<
    { readonly _tag: "Opened" } | { readonly _tag: "NotOpened"; readonly reason: string }
  >,
) => {
  const app = await openPage(
    {
      ...DOCS,
      status: "needs-sign-in",
      source: { kind: "url", url: DOCS_URL, signIn: "none", signInOffered: "oauth" },
    },
    {
      signInReturn,
      ...(openLink === undefined ? {} : { openLink }),
      handlers: {
        [`POST ${SERVER_LIST_PATH}/${DOCS_ID}/sign-in`]: {
          body: { authorizationUrl: AUTHORIZATION_URL, expiresAt: "2026-11-23T10:10:00.000Z" },
        },
        [`POST ${SERVER_LIST_PATH}/${DOCS_ID}/sign-in/finish`]: finish,
      },
    },
  );
  const band = document.querySelector<HTMLElement>(".mcp-band")!;
  await userEvent.click(within(band).getByRole("button", { name: "Sign in…" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign in to docs" });
  return { app, dialog };
};

describe("Signing in to a server added by URL through the browser", () => {
  it("listens first, starts with the listener's address, opens the browser after showing who approves, and finishes with what the browser sent", async () => {
    const signInReturn = buildSignInReturn();
    const { app, dialog } = await openSignInDialog(signInReturn, () => {
      app.world.servers = app.world.servers.map((server) =>
        server.id === DOCS_ID ? { ...server, status: "checking" } : server,
      );
      return { body: app.world.servers.find((server) => server.id === DOCS_ID) };
    });

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in with your browser" }),
    );

    await within(dialog).findByText("Finish in your browser");
    expect(within(dialog).getByText("You will approve on auth.docs.example.")).toBeTruthy();
    expect(
      findCalls(app.calls, "POST", `${SERVER_LIST_PATH}/${DOCS_ID}/sign-in`).map((c) => c.body),
    ).toEqual([{ redirectUri: "http://127.0.0.1:4937/callback" }]);
    expect(signInReturn.listen).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(app.openedLinks).toEqual([AUTHORIZATION_URL]);
    });
    expect(signInReturn.wait).toHaveBeenCalledWith({
      listenerId: "l-1",
      authorizationUrl: AUTHORIZATION_URL,
    });

    await act(async () => {
      signInReturn.waits[0]!({ _tag: "received", callbackQuery: CALLBACK });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        findCalls(app.calls, "POST", `${SERVER_LIST_PATH}/${DOCS_ID}/sign-in/finish`).map(
          (c) => c.body,
        ),
      ).toEqual([{ callbackQuery: CALLBACK }]);
    });
    await within(dialog).findByText("Asking mcp.docs.example for its tools.");
    finishCheck(app, DOCS_ID, READY);
    await within(dialog).findByText("ready · 2 tools");
  });

  it("opens the browser only after the dialog shows who approves, once", async () => {
    const signInReturn = buildSignInReturn();
    const dialogsWhenOpened: string[] = [];
    const { app, dialog } = await openSignInDialog(signInReturn, undefined, () => {
      dialogsWhenOpened.push(document.querySelector("dialog[open]")?.textContent ?? "");
      return Promise.resolve({ _tag: "Opened" });
    });

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in with your browser" }),
    );

    await waitFor(() => {
      expect(app.openedLinks).toEqual([AUTHORIZATION_URL]);
    });
    expect(dialogsWhenOpened).toHaveLength(1);
    expect(dialogsWhenOpened[0]).toContain("Finish in your browser");
    expect(dialogsWhenOpened[0]).toContain("You will approve on auth.docs.example.");
    // It said so before it opened: the label is Open again from then on.
    expect(within(dialog).getByRole("button", { name: "Open again" })).toBeTruthy();
  });

  it("opens the browser only after the frame that presents the waiting step and the task after it, never in the commit's own effect flush", async () => {
    const frames: FrameRequestCallback[] = [];
    const holdFrames = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    try {
      const signInReturn = buildSignInReturn();
      const { app, dialog } = await openSignInDialog(signInReturn);

      await userEvent.click(
        within(dialog).getByRole("button", { name: "Sign in with your browser" }),
      );
      await within(dialog).findByText("Finish in your browser");

      // The card is committed and its effects have run, but no frame presented it: no browser yet,
      // however many tasks go by.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(frames.length).toBeGreaterThan(0);
      expect(app.openedLinks).toEqual([]);

      // The frame has run. The browser still waits for the task after it.
      act(() => {
        for (const frame of frames.splice(0)) frame(0);
      });
      expect(app.openedLinks).toEqual([]);
      await waitFor(() => {
        expect(app.openedLinks).toEqual([AUTHORIZATION_URL]);
      });
    } finally {
      holdFrames.mockRestore();
    }
  });

  it("is ready for the browser's return before the browser opens, and opens no browser for a sign-in that a return already finished", async () => {
    const signInReturn = buildSignInReturn(true, true);
    const openLink = vi.fn(() => Promise.resolve({ _tag: "Opened" } as const));
    const { app, dialog } = await openSignInDialog(signInReturn, undefined, openLink);

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in with your browser" }),
    );

    await waitFor(() => {
      expect(
        findCalls(app.calls, "POST", `${SERVER_LIST_PATH}/${DOCS_ID}/sign-in/finish`).map(
          (c) => c.body,
        ),
      ).toEqual([{ callbackQuery: CALLBACK }]);
    });
    // The return finished the sign-in before the card was presented, so there is nothing to open.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signInReturn.wait).toHaveBeenCalled();
    expect(openLink).not.toHaveBeenCalled();
  });

  it("says why the browser did not open, in main's own sentence", async () => {
    const signInReturn = buildSignInReturn();
    const { dialog } = await openSignInDialog(signInReturn, undefined, () =>
      Promise.resolve({
        _tag: "NotOpened",
        reason: "The system could not open your default browser. Check that one is set.",
      }),
    );

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in with your browser" }),
    );

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "The browser did not open the sign-in page: The system could not open your default browser. Check that one is set.",
    );
    // The sign-in still waits, and Open again tries once more.
    expect(within(dialog).getByRole("button", { name: "Open again" })).toBeTruthy();
  });

  it.each([
    ["Esc", (dialog: HTMLElement) => fireEvent(dialog, new Event("cancel", { cancelable: true }))],
    [
      "a click on the scrim",
      (dialog: HTMLElement) => {
        fireEvent.pointerDown(dialog);
        fireEvent.click(dialog);
      },
    ],
  ])(
    "ends the sign-in at once on %s, so a return that comes before the dialog has closed changes nothing",
    async (_name, request) => {
      const signInReturn = buildSignInReturn();
      const { app, dialog } = await openSignInDialog(signInReturn);
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Sign in with your browser" }),
      );
      await within(dialog).findByText("Finish in your browser");

      // The result arrives in the same turn as the request, before the dialog's close event.
      await act(async () => {
        request(dialog);
        signInReturn.waits[0]!({ _tag: "received", callbackQuery: CALLBACK });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(signInReturn.cancel).toHaveBeenCalledWith({ listenerId: "l-1" });
      expect(findCalls(app.calls, "POST", `${SERVER_LIST_PATH}/${DOCS_ID}/sign-in/finish`)).toEqual(
        [],
      );
    },
  );

  it("retires the sign-in in the commit that unmounts the dialog, before the dialog leaves the DOM, so a return delivered at that boundary finishes nothing", async () => {
    const signInReturn = buildSignInReturn();
    const { app, dialog } = await openSignInDialog(signInReturn);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in with your browser" }),
    );
    await within(dialog).findByText("Finish in your browser");
    // The moment React takes the dialog out of the DOM is the boundary: the browser's return is
    // delivered there, and the listener must have been retired by then. A passive cleanup runs after it.
    // Called with the node it was taken from, so it is not unbound.
    // oxlint-disable-next-line typescript/unbound-method
    const removeChild = Node.prototype.removeChild;
    let cancelsWhenRemoved: number | null = null;
    Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
      if (cancelsWhenRemoved === null && child.contains(dialog)) {
        cancelsWhenRemoved = signInReturn.cancel.mock.calls.length;
        signInReturn.waits[0]!({ _tag: "received", callbackQuery: CALLBACK });
      }
      return removeChild.call(this, child) as T;
    };
    try {
      await act(async () => {
        await app.router.navigate({ to: "/settings/connections" });
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      Node.prototype.removeChild = removeChild;
    }

    expect(document.contains(dialog)).toBe(false);
    expect(cancelsWhenRemoved).toBe(1);
    expect(signInReturn.cancel).toHaveBeenCalledWith({ listenerId: "l-1" });
    expect(findCalls(app.calls, "POST", `${SERVER_LIST_PATH}/${DOCS_ID}/sign-in/finish`)).toEqual(
      [],
    );
  });

  it("offers the browser again, with the server's reason, when the server refuses the sign-in it was just given", async () => {
    const signInReturn = buildSignInReturn();
    const { app, dialog } = await openSignInDialog(signInReturn, () => {
      app.world.servers = app.world.servers.map((server) =>
        server.id === DOCS_ID ? { ...server, status: "checking" } : server,
      );
      return { body: app.world.servers.find((server) => server.id === DOCS_ID) };
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in with your browser" }),
    );
    await within(dialog).findByText("Finish in your browser");
    await act(async () => {
      signInReturn.waits[0]!({ _tag: "received", callbackQuery: CALLBACK });
      await Promise.resolve();
    });
    await within(dialog).findByText("Asking mcp.docs.example for its tools.");

    finishCheck(app, DOCS_ID, {
      status: "needs-sign-in",
      statusDetail: "docs.example refused it.",
    });

    expect((await within(dialog).findByRole("alert")).textContent).toBe("docs.example refused it.");
    expect(within(dialog).getByRole("button", { name: "Sign in with your browser" })).toBeTruthy();
    expect(within(dialog).queryByLabelText("Token")).toBeNull();
  });

  it("opens the browser again on Open again, and says why when it cannot be opened", async () => {
    const signInReturn = buildSignInReturn();
    const { app, dialog } = await openSignInDialog(signInReturn);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in with your browser" }),
    );
    await within(dialog).findByText("Finish in your browser");

    await userEvent.click(await within(dialog).findByRole("button", { name: "Open again" }));

    await waitFor(() => {
      expect(app.openedLinks).toEqual([AUTHORIZATION_URL, AUTHORIZATION_URL]);
    });
  });

  it("cancels the listener on Cancel, goes back to the form, and ignores a return that comes late", async () => {
    const signInReturn = buildSignInReturn();
    const { app, dialog } = await openSignInDialog(signInReturn);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in with your browser" }),
    );
    await within(dialog).findByText("Finish in your browser");

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await act(async () => {
      signInReturn.waits[0]!({ _tag: "received", callbackQuery: CALLBACK });
      await Promise.resolve();
    });

    expect(signInReturn.cancel).toHaveBeenCalledWith({ listenerId: "l-1" });
    expect(within(dialog).getByRole("button", { name: "Sign in with your browser" })).toBeTruthy();
    expect(findCalls(app.calls, "POST", `${SERVER_LIST_PATH}/${DOCS_ID}/sign-in/finish`)).toEqual(
      [],
    );
  });

  it("ends the listener and sends nothing when the dialog is closed, whatever the browser sends later", async () => {
    const signInReturn = buildSignInReturn();
    const { app, dialog } = await openSignInDialog(signInReturn);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in with your browser" }),
    );
    await within(dialog).findByText("Finish in your browser");

    act(() => {
      (dialog as HTMLDialogElement).close();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await act(async () => {
      signInReturn.waits[0]!({ _tag: "received", callbackQuery: CALLBACK });
      await Promise.resolve();
    });

    expect(signInReturn.cancel).toHaveBeenCalledWith({ listenerId: "l-1" });
    expect(findCalls(app.calls, "POST", `${SERVER_LIST_PATH}/${DOCS_ID}/sign-in/finish`)).toEqual(
      [],
    );
  });

  it("says the browser did not come back in time, and starts again", async () => {
    const signInReturn = buildSignInReturn();
    const { dialog } = await openSignInDialog(signInReturn);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in with your browser" }),
    );
    await within(dialog).findByText("Finish in your browser");

    await act(async () => {
      signInReturn.waits[0]!({ _tag: "timed-out" });
      await Promise.resolve();
    });

    await within(dialog).findByText(
      "The browser did not come back within 10 minutes. Start again.",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Start again" }));
    await within(dialog).findByText("Finish in your browser");
    expect(signInReturn.listen).toHaveBeenCalledTimes(2);
  });

  it("offers Paste the browser's address… when it did not come back, cancels the wait, and finishes with the pasted address", async () => {
    const signInReturn = buildSignInReturn();
    const { app, dialog } = await openSignInDialog(signInReturn);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in with your browser" }),
    );
    await within(dialog).findByText("Approved, and the browser did not come back here?");
    expect(within(dialog).queryByLabelText("Address the browser ended on")).toBeNull();

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Paste the browser's address…" }),
    );
    await userEvent.type(
      within(dialog).getByLabelText("Address the browser ended on"),
      `http://127.0.0.1:4937/callback?${CALLBACK}`,
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Finish sign-in" }));

    await waitFor(() => {
      expect(
        findCalls(app.calls, "POST", `${SERVER_LIST_PATH}/${DOCS_ID}/sign-in/finish`).map(
          (c) => c.body,
        ),
      ).toEqual([{ callbackQuery: `http://127.0.0.1:4937/callback?${CALLBACK}` }]);
    });
    expect(signInReturn.cancel).toHaveBeenCalledWith({ listenerId: "l-1" });
  });

  it("offers only the paste when the listener is unavailable, and still opens the browser", async () => {
    const signInReturn = buildSignInReturn(false);
    const { app, dialog } = await openSignInDialog(signInReturn);

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in with your browser" }),
    );

    expect(await within(dialog).findByLabelText("Address the browser ended on")).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: "Paste the browser's address…" }),
    ).toBeNull();
    expect(signInReturn.wait).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(app.openedLinks).toEqual([AUTHORIZATION_URL]);
    });
    const [start] = findCalls(app.calls, "POST", `${SERVER_LIST_PATH}/${DOCS_ID}/sign-in`);
    expect((start!.body as { redirectUri: string }).redirectUri).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
  });

  it.each([
    [
      "sign-in-expired",
      "This sign-in ran out, or another one for this server replaced it. Start again.",
    ],
    [
      "sign-in-refused",
      "The browser or the provider refused the sign-in. Nothing was changed. You can start again.",
    ],
    [
      "source-unreadable",
      "The server or its sign-in service could not be reached. Try again later.",
    ],
  ])("says %s when the controller refuses the finish", async (reason, message) => {
    const signInReturn = buildSignInReturn();
    const { dialog } = await openSignInDialog(signInReturn, invalidState(reason));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in with your browser" }),
    );
    await within(dialog).findByText("Finish in your browser");

    await act(async () => {
      signInReturn.waits[0]!({ _tag: "received", callbackQuery: CALLBACK });
      await Promise.resolve();
    });

    await within(dialog).findByText(message);
    expect(within(dialog).getByRole("button", { name: "Start again" })).toBeTruthy();
  });

  it("goes back to the token field, saying only a token works, when the server allows no sign-in through the browser", async () => {
    const signInReturn = buildSignInReturn();
    const { dialog } = await openSignInDialog(signInReturn, invalidState("sign-in-unsupported"));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Sign in with your browser" }),
    );
    await within(dialog).findByText("Finish in your browser");

    await act(async () => {
      signInReturn.waits[0]!({ _tag: "received", callbackQuery: CALLBACK });
      await Promise.resolve();
    });

    expect(await within(dialog).findByLabelText("Token")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "This server does not allow a sign-in through the browser. Paste a token instead.",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Sign in with your browser" })).toBeNull();
  });

  it("signs in a server the Add dialog just created, and ends on the new server's footer", async () => {
    const signInReturn = buildSignInReturn();
    const app = await openList({
      servers: [],
      signInReturn,
      handlers: {
        [`POST ${SERVER_LIST_PATH}/${CREATED_ID}/sign-in`]: {
          body: { authorizationUrl: AUTHORIZATION_URL, expiresAt: "2026-11-23T10:10:00.000Z" },
        },
        [`POST ${SERVER_LIST_PATH}/${CREATED_ID}/sign-in/finish`]: () => {
          app.world.servers = app.world.servers.map((server) => ({
            ...server,
            status: "checking",
          }));
          return { body: app.world.servers.find((server) => server.id === CREATED_ID) };
        },
      },
    });
    const dialog = await openAddDialog();
    await checkAddress(dialog, DOCS_URL);
    await within(dialog).findByText("Asking mcp.docs.example for its tools.");
    finishCheck(app, CREATED_ID, {
      status: "needs-sign-in",
      source: { kind: "url", url: DOCS_URL, signIn: "none", signInOffered: "oauth" },
    });

    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Sign in with your browser" }),
    );
    await within(dialog).findByText("Finish in your browser");
    await act(async () => {
      signInReturn.waits[0]!({ _tag: "received", callbackQuery: CALLBACK });
      await Promise.resolve();
    });
    await within(dialog).findByText("Asking mcp.docs.example for its tools.");
    finishCheck(app, CREATED_ID, { ...READY, tools: DOCS.tools });

    await within(dialog).findByText("ready · 2 tools");
    expect(within(dialog).getByRole("button", { name: "Open docs" })).toBeTruthy();
  });
});
