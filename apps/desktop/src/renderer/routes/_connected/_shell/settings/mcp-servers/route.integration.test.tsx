/**
 * Tests Settings > MCP servers: the list in each status, its switches (create
 * and update, busy while the write runs, a refusal under the row), the default
 * list and its picker, a server's page in each status, Check now, the
 * Projects boxes with the refusal and the swap, Remove, the redirects, and the
 * topic the section holds. Each test counts the reads it sends: the section
 * reads again on its own writes and on the `mcpServer` topic's pushes, and
 * never on a timer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project } from "@hercule/contract";
import { queryKeys } from "@hercule/client-core";
import { buildErrorBody } from "@hercule/client-core/testing";
import { forgetLastSettingsSection } from "../../../../../app/last-settings-section";
import { holdAnswer } from "../../../../../app/testing";
import {
  buildServer,
  LINEAR,
  LINEAR_CONNECTION,
  LINEAR_ID,
  SENTRY_HOBBY,
  SENTRY_HOBBY_CONNECTION,
  SENTRY_HOBBY_ID,
  SENTRY_WORK,
  SENTRY_WORK_ID,
} from "../../../../../screens/settings/mcp-servers/mcp-servers.testing";
import {
  findCalls,
  findRow,
  LIST_PATH,
  openList,
  OPS,
  readCells,
  SERVER_LIST_PATH,
  WEBSHOP,
} from "../../../../../screens/settings/mcp-servers/mcp-world.testing";

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../../../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

// The section opened last is kept in memory for as long as the app runs.
afterEach(forgetLastSettingsSection);

describe("Settings > MCP servers, the list", () => {
  it("draws the lead, one row for each Connection that offers a server, and the default list", async () => {
    const { calls } = await openList({ servers: [SENTRY_WORK, LINEAR] });

    expect(screen.getByText(/An MCP server gives agents tools from another service/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "From your Connections" })).toBeTruthy();
    expect(
      screen.getByText("No second sign-in: the server is reached with the Connection"),
    ).toBeTruthy();
    const head = document.querySelector(".set-table-head")!;
    expect([...head.children].map((cell) => cell.textContent)).toEqual([
      "",
      "Server",
      "Status",
      "Projects",
      "Offered",
      "",
    ]);
    const rows = [...document.querySelectorAll(".mcp-row")];
    // Ordered by the Connection's type, then its label.
    expect(rows.map((row) => row.querySelector(".mcp-name")?.textContent)).toEqual([
      "linear acme",
      "sentry hobby",
      "sentry work",
    ]);
    expect(readCells(findRow("sentry work")).slice(1, 4)).toEqual([
      "sentry workSentry Connection · 2 tools",
      "ready",
      "None",
    ]);
    expect(readCells(findRow("sentry hobby")).slice(1, 4)).toEqual([
      "sentry hobbySentry Connection · switch it on to see its tools",
      "off",
      "None",
    ]);
    expect(screen.getByRole("heading", { name: "Threads without a project" })).toBeTruthy();
    expect(screen.getByText("A thread in no project starts with these servers")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change…" })).toBeTruthy();
    // Once on open, and once more on the `mcpServer` topic's first push, which
    // says that any server may have changed before the subscription.
    expect(findCalls(calls, "GET", SERVER_LIST_PATH)).toHaveLength(2);
  });

  it("leads a row with a record to its page, and a row with none to nowhere", async () => {
    const { router } = await openList({ servers: [SENTRY_WORK] });

    expect(within(findRow("sentry hobby")).queryByRole("link")).toBeNull();
    expect(findRow("sentry hobby").querySelector(".ic")).toBeNull();
    const link = within(findRow("sentry work")).getByRole("link", { name: /sentry work/ });
    expect(findRow("sentry work").querySelector(".ic")).not.toBeNull();
    await userEvent.click(link);

    expect(await screen.findByRole("heading", { level: 1, name: "sentry" })).toBeTruthy();
    expect(router.state.location.pathname).toBe(`${LIST_PATH}/${SENTRY_WORK_ID}`);
  });

  it.each([
    ["ready", "ready", false],
    ["needs-sign-in", "needs sign-in", true],
    ["unreachable", "unreachable", true],
    ["error", "error", true],
  ] as const)(
    "draws a server that is %s as the word %s, in the failure colours when it needs the user",
    async (status, word, failing) => {
      await openList({
        servers: [{ ...SENTRY_WORK, status, statusDetail: failing ? "revoked 09:12" : null }],
      });

      const row = findRow("sentry work");
      const cell = row.querySelector(".mcp-status")!;
      expect(cell.textContent).toBe(word);
      expect(row.classList.contains("is-fail")).toBe(failing);
      expect(cell.classList.contains("mcp-status--fail")).toBe(failing);
      expect(cell.querySelector(".dot--fail") !== null).toBe(failing);
      expect(cell.getAttribute("title")).toBe(failing ? "revoked 09:12" : null);
    },
  );

  it("draws a server being checked with the spinner, and a switched-off server as off", async () => {
    await openList({
      servers: [
        { ...SENTRY_WORK, status: "checking" },
        { ...SENTRY_HOBBY, enabled: false, status: "needs-sign-in", statusDetail: "revoked" },
      ],
    });

    const checking = findRow("sentry work").querySelector(".mcp-status")!;
    expect(checking.textContent).toBe("checking");
    expect(checking.querySelector(".spin")).not.toBeNull();
    const off = findRow("sentry hobby").querySelector(".mcp-status")!;
    expect(off.textContent).toBe("off");
    expect(off.classList.contains("mcp-status--off")).toBe(true);
    expect(findRow("sentry hobby").classList.contains("is-fail")).toBe(false);
  });

  it("shows the projects that name a server as tiles, then as a count with their names", async () => {
    const third: Project = { ...OPS, id: "01a06d02-7000-7000-8000-000000000003", name: "payments" };
    const named = (project: Project, ...ids: string[]): Project => ({
      ...project,
      mcpServerIds: ids,
    });
    await openList({
      servers: [SENTRY_WORK, SENTRY_HOBBY],
      projects: [
        named(WEBSHOP, SENTRY_WORK_ID, SENTRY_HOBBY_ID),
        named(OPS, SENTRY_WORK_ID),
        named(third, SENTRY_WORK_ID),
      ],
    });

    const count = findRow("sentry work").querySelector(".mcp-projects")!;
    expect(count.textContent).toBe("3 projects");
    expect(count.getAttribute("title")).toBe("webshop, ops and payments");
    const tiles = [...findRow("sentry hobby").querySelectorAll(".mcp-projects .proj-name")];
    expect(tiles.map((tile) => tile.textContent)).toEqual(["webshop"]);
  });

  it("shows the servers of the default list as chips, or None", async () => {
    await openList({ servers: [SENTRY_WORK, LINEAR], defaultIds: [SENTRY_WORK_ID] });

    const group = screen.getByRole("region", { name: "Threads without a project" });
    expect([...group.querySelectorAll(".chip .mcp-name")].map((name) => name.textContent)).toEqual([
      "sentry work",
    ]);
    expect(within(group).queryByText("None")).toBeNull();
  });

  it("says None for an empty default list", async () => {
    await openList({ servers: [SENTRY_WORK] });

    const group = screen.getByRole("region", { name: "Threads without a project" });
    expect(within(group).getByText("None")).toBeTruthy();
  });

  it("says where a row comes from while no Connection's plugin offers a server", async () => {
    await openList({ connections: [] });

    expect(screen.getByText("No Connection offers a server yet")).toBeTruthy();
    expect(document.querySelector(".set-table-head")).toBeNull();
  });
});

describe("Settings > MCP servers, the switches", () => {
  it("creates the server of a row with no record from the plugin's contribution and the Connection", async () => {
    const { world, calls } = await openList({ servers: [SENTRY_WORK] });

    await userEvent.click(
      within(findRow("sentry hobby")).getByRole("switch", {
        name: "Offer sentry hobby to threads",
      }),
    );

    await waitFor(() => {
      expect(
        within(findRow("sentry hobby")).getByRole("link", { name: /sentry hobby/ }),
      ).toBeTruthy();
    });
    expect(findCalls(calls, "POST", SERVER_LIST_PATH).map((call) => call.body)).toEqual([
      {
        source: {
          kind: "plugin",
          contributionId: "sentry/sentry",
          connectionId: SENTRY_HOBBY_CONNECTION.id,
        },
      },
    ]);
    expect(world.servers.map((server) => server.status)).toEqual(["ready", "checking"]);
    const row = findRow("sentry hobby");
    expect(row.querySelector(".mcp-status")?.textContent).toBe("checking");
    expect(within(row).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(within(row).getByRole("switch").getAttribute("aria-disabled")).toBe("false");
  });

  it("turns the server of a row with a record off, and on again, with mcpServer.update", async () => {
    const { calls } = await openList({ servers: [SENTRY_WORK] });
    const flip = () => within(findRow("sentry work")).getByRole("switch");

    await userEvent.click(flip());
    await waitFor(() => {
      expect(findRow("sentry work").querySelector(".mcp-status")?.textContent).toBe("off");
    });
    await userEvent.click(flip());
    await waitFor(() => {
      expect(findRow("sentry work").querySelector(".mcp-status")?.textContent).toBe("ready");
    });

    expect(
      findCalls(calls, "PATCH", `${SERVER_LIST_PATH}/${SENTRY_WORK_ID}`).map((call) => call.body),
    ).toEqual([{ enabled: false }, { enabled: true }]);
    // Off is never a delete.
    expect(findCalls(calls, "DELETE", `${SERVER_LIST_PATH}/${SENTRY_WORK_ID}`)).toEqual([]);
  });

  it("keeps the switch aria-disabled while its write runs, and ignores a second press", async () => {
    const held = holdAnswer();
    const { calls } = await openList({
      servers: [SENTRY_WORK],
      handlers: { [`PATCH ${SERVER_LIST_PATH}/${SENTRY_WORK_ID}`]: held.handler },
    });
    const flip = within(findRow("sentry work")).getByRole("switch");

    await userEvent.click(flip);
    await waitFor(() => {
      expect(flip.getAttribute("aria-disabled")).toBe("true");
    });
    await userEvent.click(flip);
    held.answer({ body: { ...SENTRY_WORK, enabled: false } });

    await waitFor(() => {
      expect(flip.getAttribute("aria-disabled")).toBe("false");
    });
    expect(findCalls(calls, "PATCH", `${SERVER_LIST_PATH}/${SENTRY_WORK_ID}`)).toHaveLength(1);
  });

  it("shows a refusal under its row in the controller's words, and reads the list again", async () => {
    const { calls } = await openList({
      servers: [SENTRY_WORK],
      handlers: {
        [`POST ${SERVER_LIST_PATH}`]: {
          status: 409,
          body: buildErrorBody(
            "conflict",
            "Another Connection of this account already has a server.",
          ),
        },
      },
    });
    const before = findCalls(calls, "GET", SERVER_LIST_PATH).length;

    await userEvent.click(
      within(findRow("sentry hobby")).getByRole("switch", {
        name: "Offer sentry hobby to threads",
      }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Another Connection of this account already has a server.");
    expect(findRow("sentry hobby").nextElementSibling).toBe(alert);
    expect(findRow("sentry hobby").querySelector(".mcp-status")?.textContent).toBe("off");
    expect(findCalls(calls, "GET", SERVER_LIST_PATH).length).toBe(before + 1);
  });

  it("drops a refusal once another client's server makes the row show something else", async () => {
    const { world, live } = await openList({
      servers: [SENTRY_WORK],
      handlers: {
        [`POST ${SERVER_LIST_PATH}`]: {
          status: 409,
          body: buildErrorBody("conflict", "A server for this Connection already exists."),
        },
      },
    });
    await userEvent.click(
      within(findRow("sentry hobby")).getByRole("switch", {
        name: "Offer sentry hobby to threads",
      }),
    );
    await screen.findByRole("alert");

    world.servers = [...world.servers, SENTRY_HOBBY];
    act(() => {
      live.pushInvalidation("mcpServer", [SENTRY_HOBBY_ID]);
    });

    await waitFor(() => {
      expect(
        within(findRow("sentry hobby")).getByRole("link", { name: /sentry hobby/ }),
      ).toBeTruthy();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not open the page when the switch is pressed", async () => {
    const { router } = await openList({ servers: [SENTRY_WORK] });

    await userEvent.click(within(findRow("sentry work")).getByRole("switch"));

    await waitFor(() => {
      expect(findRow("sentry work").querySelector(".mcp-status")?.textContent).toBe("off");
    });
    expect(router.state.location.pathname).toBe(LIST_PATH);
  });
});

/** Returns the picker's row for the server name `name`. */
const findPickRow = (name: string): HTMLElement => {
  const dialog = screen.getByRole("dialog");
  const row = [...dialog.querySelectorAll<HTMLElement>(".mcp-pick-row")].find(
    (each) => each.querySelector(".mcp-name > b")?.textContent === name,
  );
  if (row === undefined) throw new Error(`no picker row for ${name}`);
  return row;
};

const SETTINGS_PATH = "/api/v1/settings";

describe("Settings > MCP servers, the default list and its picker", () => {
  const PICKER_TITLE = "MCP servers of threads without a project";

  it("opens the picker on the default list, with a row for each name and its account choice", async () => {
    await openList({ servers: [SENTRY_WORK, SENTRY_HOBBY, LINEAR], defaultIds: [SENTRY_WORK_ID] });

    await userEvent.click(screen.getByRole("button", { name: "Change…" }));

    const dialog = await screen.findByRole("dialog", { name: PICKER_TITLE });
    expect(within(dialog).getByText("1 chosen")).toBeTruthy();
    // The names the list has come first, as the dialog opened with them.
    const names = [...dialog.querySelectorAll(".mcp-pick-row .mcp-name > b")].map(
      (name) => name.textContent,
    );
    expect(names).toEqual(["sentry", "linear"]);
    const sentry = findPickRow("sentry");
    expect(sentry.querySelector("small")?.textContent).toBe("Sentry Connection, 2 accounts");
    // A name with a choice of account shows the name alone.
    expect(sentry.querySelector(".mcp-account")).toBeNull();
    const account = within(sentry).getByRole("combobox", { name: "Account of sentry" });
    expect((account as HTMLSelectElement).value).toBe(SENTRY_WORK_ID);
    expect([...(account as HTMLSelectElement).options].map((option) => option.text)).toEqual([
      "hobby",
      "work",
    ]);
    const linear = findPickRow("linear");
    expect(linear.querySelector("small")?.textContent).toBe("Linear Connection");
    expect(linear.querySelector(".mcp-account")?.textContent).toBe("acme");
    expect(dialog.querySelector(".mcp-picker-foot .time")?.textContent).toBe(
      "A thread in no project starts with this list. Each change is saved as you make it.",
    );
    expect(within(dialog).queryByRole("textbox", { name: "Filter servers" })).toBeNull();
    // This picker has no list to go back to.
    expect(within(dialog).queryByRole("button", { name: /^Back|^Switch/ })).toBeNull();
  });

  it("writes the setting at once on each change, and draws the chip", async () => {
    const { world, calls } = await openList({ servers: [SENTRY_WORK, LINEAR] });
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    await screen.findByRole("dialog", { name: PICKER_TITLE });

    await userEvent.click(within(findPickRow("linear")).getByRole("checkbox"));

    await waitFor(() => {
      expect(world.defaultIds).toEqual([LINEAR.id]);
    });
    expect(findCalls(calls, "PATCH", SETTINGS_PATH).map((call) => call.body)).toEqual([
      { user: { "thread.mcpServerIds": [LINEAR.id] } },
    ]);
    await waitFor(() => {
      expect(within(screen.getByRole("dialog")).getByText("1 chosen")).toBeTruthy();
    });
    const group = screen.getByRole("region", { name: "Threads without a project" });
    expect([...group.querySelectorAll(".chip .mcp-name")].map((name) => name.textContent)).toEqual([
      "linear acme",
    ]);

    await userEvent.click(within(findPickRow("linear")).getByRole("checkbox"));
    await waitFor(() => {
      expect(world.defaultIds).toEqual([]);
    });
  });

  it("swaps the account of a chosen name in one write, and keeps the account it was left on", async () => {
    const { world, calls } = await openList({
      servers: [SENTRY_WORK, SENTRY_HOBBY],
      defaultIds: [SENTRY_WORK_ID],
    });
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    await screen.findByRole("dialog", { name: PICKER_TITLE });
    const account = within(findPickRow("sentry")).getByRole("combobox", {
      name: "Account of sentry",
    });

    await userEvent.selectOptions(account, "hobby");

    await waitFor(() => {
      expect(world.defaultIds).toEqual([SENTRY_HOBBY_ID]);
    });
    expect(findCalls(calls, "PATCH", SETTINGS_PATH)).toHaveLength(1);

    // Switched off and on again, the name comes back on the account it showed.
    await userEvent.click(within(findPickRow("sentry")).getByRole("checkbox"));
    await waitFor(() => {
      expect(world.defaultIds).toEqual([]);
    });
    expect((account as HTMLSelectElement).disabled).toBe(true);
    expect((account as HTMLSelectElement).value).toBe(SENTRY_HOBBY_ID);
    await userEvent.click(within(findPickRow("sentry")).getByRole("checkbox"));
    await waitFor(() => {
      expect(world.defaultIds).toEqual([SENTRY_HOBBY_ID]);
    });
  });

  it("ignores changes while a write runs, until the setting is read again", async () => {
    const held = holdAnswer();
    const { calls } = await openList({
      servers: [SENTRY_WORK, LINEAR],
      handlers: { [`PATCH ${SETTINGS_PATH}`]: held.handler },
    });
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    await screen.findByRole("dialog", { name: PICKER_TITLE });
    const linear = within(findPickRow("linear")).getByRole("checkbox");
    const sentry = within(findPickRow("sentry")).getByRole("checkbox");

    await userEvent.click(linear);
    await waitFor(() => {
      expect(linear.getAttribute("aria-disabled")).toBe("true");
    });
    await userEvent.click(sentry);
    held.answer({
      body: { controller: {}, user: { "thread.mcpServerIds": [LINEAR.id] } },
    });

    await waitFor(() => {
      expect(linear.getAttribute("aria-disabled")).toBe("false");
    });
    expect(findCalls(calls, "PATCH", SETTINGS_PATH)).toHaveLength(1);
    expect((sentry as HTMLInputElement).checked).toBe(false);
  });

  it("shows the controller's refusal under the rows and leaves the list as the controller holds it", async () => {
    const { world } = await openList({
      servers: [SENTRY_WORK, LINEAR],
      handlers: {
        [`PATCH ${SETTINGS_PATH}`]: {
          status: 403,
          body: {
            error: {
              code: "forbidden",
              message: "This token lacks mcp.manage.",
              details: { grant: "mcp.manage" },
            },
          },
        },
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    await screen.findByRole("dialog", { name: PICKER_TITLE });

    await userEvent.click(within(findPickRow("linear")).getByRole("checkbox"));

    const alert = await within(screen.getByRole("dialog")).findByRole("alert");
    expect(alert.textContent).toBe("Could not save: This token lacks mcp.manage.");
    expect(world.defaultIds).toEqual([]);
    expect(within(findPickRow("linear")).getByRole("checkbox", { checked: false })).toBeTruthy();
  });

  it("keeps the guard of the list when the picker is closed and opened again while its write runs", async () => {
    const held = holdAnswer();
    const { calls } = await openList({
      servers: [SENTRY_WORK, LINEAR],
      handlers: { [`PATCH ${SETTINGS_PATH}`]: held.handler },
    });
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    await screen.findByRole("dialog", { name: PICKER_TITLE });
    await userEvent.click(within(findPickRow("linear")).getByRole("checkbox"));
    await waitFor(() => {
      expect(findCalls(calls, "PATCH", SETTINGS_PATH)).toHaveLength(1);
    });

    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    await screen.findByRole("dialog", { name: PICKER_TITLE });
    const sentry = within(findPickRow("sentry")).getByRole("checkbox");
    expect(sentry.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(sentry);
    held.answer({ body: { controller: {}, user: { "thread.mcpServerIds": [LINEAR_ID] } } });

    await waitFor(() => {
      expect(sentry.getAttribute("aria-disabled")).toBe("false");
    });
    expect(findCalls(calls, "PATCH", SETTINGS_PATH)).toHaveLength(1);
  });

  it("applies a change to the setting as the cache holds it when the user presses, not as the picker drew it", async () => {
    const { world, context } = await openList({
      servers: [SENTRY_WORK, LINEAR],
      defaultIds: [SENTRY_WORK_ID],
    });
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    await screen.findByRole("dialog", { name: PICKER_TITLE });
    const sentry = within(findPickRow("sentry")).getByRole("checkbox");

    // Another client added linear, and a read has put that in the cache, but the
    // picker has not drawn it yet when the press arrives.
    context.queryClient.setQueryData(queryKeys.settings(), {
      controller: {},
      user: { "thread.mcpServerIds": [SENTRY_WORK_ID, LINEAR_ID] },
    });
    fireEvent.click(sentry);

    await waitFor(() => {
      expect(world.defaultIds).toEqual([LINEAR_ID]);
    });
  });

  it("shows a refusal that came after the picker was closed, when the picker opens again", async () => {
    const held = holdAnswer();
    await openList({
      servers: [SENTRY_WORK, LINEAR],
      handlers: { [`PATCH ${SETTINGS_PATH}`]: held.handler },
    });
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    await screen.findByRole("dialog", { name: PICKER_TITLE });
    await userEvent.click(within(findPickRow("linear")).getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    held.answer({
      status: 403,
      body: {
        error: {
          code: "forbidden",
          message: "This token lacks mcp.manage.",
          details: { grant: "mcp.manage" },
        },
      },
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Change…" }).getAttribute("aria-disabled")).toBe(
        "false",
      );
    });
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));

    const alert = await within(await screen.findByRole("dialog")).findByRole("alert");
    expect(alert.textContent).toBe("Could not save: This token lacks mcp.manage.");
  });

  it("keeps Change... off until the settings read of this opening has answered", async () => {
    let gate: Promise<void> = Promise.resolve();
    let release = (): void => undefined;
    let defaultIds: string[] = [];
    const { router } = await openList({
      servers: [SENTRY_WORK, LINEAR],
      handlers: {
        "GET /api/v1/skills": { body: { items: [] } },
        [`GET ${SETTINGS_PATH}`]: async () => {
          await gate;
          return { body: { controller: {}, user: { "thread.mcpServerIds": defaultIds } } };
        },
      },
    });
    await act(() => router.navigate({ to: "/settings/skills" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/skills");
    });

    // The CLI changed the setting while the section was closed, and the answer is on its way.
    defaultIds = [LINEAR_ID];
    gate = new Promise((resolve) => {
      release = resolve;
    });
    await act(() => router.navigate({ to: LIST_PATH }));
    const change = await screen.findByRole("button", { name: "Change…" });

    expect(change.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(change);
    expect(screen.queryByRole("dialog")).toBeNull();

    release();
    await waitFor(() => {
      expect(change.getAttribute("aria-disabled")).toBe("false");
    });
    await userEvent.click(change);
    await screen.findByRole("dialog", { name: PICKER_TITLE });
    expect(within(findPickRow("linear")).getByRole("checkbox", { checked: true })).toBeTruthy();
  });

  it("shows the status word of a server that is not ready, and a filter past eight names", async () => {
    const tools = Array.from({ length: 9 }, (_, at) =>
      buildServer(
        `01a06d02-8400-7000-8000-${String(at + 1).padStart(12, "0")}`,
        `tool${String(at + 1)}`,
        LINEAR_CONNECTION,
        at === 0 ? { status: "needs-sign-in", statusDetail: "revoked" } : {},
      ),
    );
    await openList({ servers: tools });
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    const dialog = await screen.findByRole("dialog", { name: PICKER_TITLE });

    expect(findPickRow("tool1").querySelector(".mcp-status")?.textContent).toBe("needs sign-in");
    expect(findPickRow("tool2").querySelector(".mcp-status")).toBeNull();
    const filter = within(dialog).getByRole("textbox", { name: "Filter servers" });
    await userEvent.type(filter, "tool3");

    expect(
      [...dialog.querySelectorAll(".mcp-pick-row .mcp-name > b")].map((n) => n.textContent),
    ).toEqual(["tool3"]);
    await userEvent.clear(filter);
    await userEvent.type(filter, "nothing");
    expect(within(dialog).getByText('No server matches "nothing".')).toBeTruthy();
  });

  it("closes with Done and leaves the written list on the group", async () => {
    await openList({ servers: [SENTRY_WORK, LINEAR], defaultIds: [LINEAR_ID] });
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    await screen.findByRole("dialog", { name: PICKER_TITLE });

    await userEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    const group = screen.getByRole("region", { name: "Threads without a project" });
    expect(group.querySelectorAll(".chip")).toHaveLength(1);
  });
});

describe("Settings > MCP servers, the section", () => {
  it("selects its row in the Settings list while the list is open", async () => {
    await openList({ servers: [SENTRY_WORK] });

    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(
      within(nav).getByRole("link", { name: "MCP servers" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("holds the mcpServer topic while it is open, and drops it when another section opens", async () => {
    const { live, router } = await openList({
      servers: [SENTRY_WORK],
      handlers: { "GET /api/v1/skills": { body: { items: [] } } },
    });
    expect(live.readTopics().filter((topic) => topic === "mcpServer")).toHaveLength(1);

    await act(() => router.navigate({ to: "/settings/skills" }));

    await waitFor(() => {
      expect(live.readTopics()).not.toContain("mcpServer");
    });
  });

  it("reads the default list again each time the section opens", async () => {
    const { world, router, calls } = await openList({
      servers: [SENTRY_WORK, LINEAR],
      handlers: { "GET /api/v1/skills": { body: { items: [] } } },
    });
    await act(() => router.navigate({ to: "/settings/skills" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/skills");
    });
    const before = findCalls(calls, "GET", SETTINGS_PATH).length;

    // The CLI changed the setting while the section was closed.
    world.defaultIds = [LINEAR_ID];
    await act(() => router.navigate({ to: LIST_PATH }));

    await waitFor(() => {
      expect(findCalls(calls, "GET", SETTINGS_PATH)).toHaveLength(before + 1);
    });
    const group = screen.getByRole("region", { name: "Threads without a project" });
    await waitFor(() => {
      expect(group.querySelectorAll(".chip")).toHaveLength(1);
    });
  });

  it("does not put a late response of a switch back in the list after a read removed the server", async () => {
    const held = holdAnswer();
    let listed = [LINEAR, SENTRY_WORK];
    let gate: Promise<void> = Promise.resolve();
    let release = (): void => undefined;
    const { live, calls } = await openList({
      servers: [SENTRY_WORK, LINEAR],
      handlers: {
        [`PATCH ${SERVER_LIST_PATH}/${SENTRY_WORK_ID}`]: held.handler,
        // The list answers once the gate is open.
        [`GET ${SERVER_LIST_PATH}`]: async () => {
          await gate;
          return { body: { items: listed } };
        },
      },
    });
    await userEvent.click(within(findRow("sentry work")).getByRole("switch"));

    // Another client deletes the server, and the live read removes its row.
    listed = [LINEAR];
    act(() => {
      live.pushInvalidation("mcpServer", [SENTRY_WORK_ID], { kind: "deleted" });
    });
    // The row stays as the Connection's offer, which has no record.
    const readsNoRecord = (): boolean =>
      readCells(findRow("sentry work"))[1]!.includes("switch it on to see its tools");
    await waitFor(() => {
      expect(readsNoRecord()).toBe(true);
    });
    // The write's own read is held, so only the late response could bring the row back.
    gate = new Promise((resolve) => {
      release = resolve;
    });
    const readsBeforeAnswer = findCalls(calls, "GET", SERVER_LIST_PATH).length;
    held.answer({ body: { ...SENTRY_WORK, enabled: false } });
    // The write has handled its response once it starts its own read of the list.
    await waitFor(() => {
      expect(findCalls(calls, "GET", SERVER_LIST_PATH).length).toBeGreaterThan(readsBeforeAnswer);
    });

    expect(readsNoRecord()).toBe(true);
    release();
  });

  it("reads the list again on a push, and shows what another client changed", async () => {
    const { world, live, calls } = await openList({ servers: [SENTRY_WORK] });
    const before = findCalls(calls, "GET", SERVER_LIST_PATH).length;

    world.servers = [{ ...SENTRY_WORK, status: "unreachable", statusDetail: "timed out" }];
    act(() => {
      live.pushInvalidation("mcpServer", [SENTRY_WORK_ID]);
    });

    await waitFor(() => {
      expect(findRow("sentry work").querySelector(".mcp-status")?.textContent).toBe("unreachable");
    });
    expect(findCalls(calls, "GET", SERVER_LIST_PATH)).toHaveLength(before + 1);
  });
});
