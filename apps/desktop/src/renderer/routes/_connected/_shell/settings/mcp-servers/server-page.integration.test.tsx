/**
 * Tests the page of one server in Settings > MCP servers: its heading and
 * chips, the status band for each status and its one button, the Server
 * section, Check now, Tools, the Projects boxes with the refusal and the
 * swap, Remove, and the redirects to the list.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project } from "@hercule/contract";
import { queryKeys } from "@hercule/client-core";
import { buildErrorBody } from "@hercule/client-core/testing";
import {
  forgetLastSettingsSection,
  readLastSettingsSection,
} from "../../../../../app/last-settings-section";
import { holdAnswer } from "../../../../../app/testing";
import {
  buildConnection,
  buildServer,
  LINEAR,
  LINEAR_ID,
  OFFERING_CONNECTIONS,
  SENTRY_HOBBY,
  SENTRY_HOBBY_ID,
  SENTRY_WORK,
  SENTRY_WORK_ID,
} from "../../../../../screens/settings/mcp-servers/mcp-servers.testing";
import {
  findCalls,
  LIST_PATH,
  openAt,
  openPage,
  OPS,
  SERVER_LIST_PATH,
  WEBSHOP,
} from "../../../../../screens/settings/mcp-servers/mcp-world.testing";

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../../../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

afterEach(forgetLastSettingsSection);

const WORK_URL = `${SERVER_LIST_PATH}/${SENTRY_WORK_ID}`;

/** Returns the section of the page headed `name`. */
const findSection = (name: string): HTMLElement =>
  screen.getByRole("heading", { level: 2, name: new RegExp(`^${name}`) }).closest("section")!;

/** Returns the Projects row of the project named `name`. */
const findProjectRow = (name: string): HTMLElement =>
  [...findSection("Projects").querySelectorAll<HTMLElement>(".mcp-proj-row")].find(
    (row) => row.querySelector(".proj-name")?.textContent === name,
  )!;

/** Waits for the Projects row of the project named `name` to draw, and returns it. */
const waitForProjectRow = async (name: string): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(findProjectRow(name)).toBeTruthy();
  });
  return findProjectRow(name);
};

const named = (project: Project, ...ids: string[]): Project => ({ ...project, mcpServerIds: ids });

describe("a server's page", () => {
  it("draws the heading, the chips, the Server section, the tools, the projects and Remove", async () => {
    await openPage(SENTRY_WORK);

    expect(screen.getByRole("heading", { level: 2, name: "sentry work" })).toBeTruthy();
    expect(
      [...document.querySelectorAll(".mcp-chips .chip")].map((chip) => chip.textContent),
    ).toEqual(["From the Sentry plugin", "mcp.sentry.example"]);
    expect(document.querySelector(".crumb")?.textContent).toBe("Settings / MCP servers /");
    expect(document.querySelector(".crumb a")?.getAttribute("href")).toBe(LIST_PATH);
    // A ready server has no band.
    expect(document.querySelector(".mcp-band")).toBeNull();

    const server = findSection("Server");
    expect(
      within(server)
        .getByRole("switch", { name: "Offered to threads" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(server).getByText("sentry", { selector: ".mcp-value" })).toBeTruthy();
    expect(server.querySelector(".set-label code")?.textContent).toBe("mcp__tools__<name>__<tool>");
    expect(within(server).getByText("Sentry · work")).toBeTruthy();
    expect(within(server).getByText("work@acme.example")).toBeTruthy();
    expect(within(server).getByRole("link", { name: "Open" }).getAttribute("href")).toBe(
      "/settings/connections",
    );
    expect(within(server).getByText(/^Hercule lists the tools again once a day/)).toBeTruthy();

    const tools = findSection("Tools");
    expect(within(tools).getByRole("heading", { name: "Tools2" })).toBeTruthy();
    expect([...tools.querySelectorAll(".mcp-tool")].map((row) => row.textContent)).toEqual([
      "search_issuesSearches issues.",
      "get_issueReads one issue.",
    ]);

    expect(findSection("Projects").querySelector("small")?.textContent).toBe("0 of 3");
    expect(findSection("Remove sentry")).toBeTruthy();
  });

  it("reads the age of the last check from the age clock", async () => {
    await openPage({
      ...SENTRY_WORK,
      checkedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    });

    expect(within(findSection("Server")).getByText("3 hours ago")).toBeTruthy();
  });

  it("says a server not checked yet was not, and shows the empty tools line", async () => {
    await openPage({ ...SENTRY_WORK, status: "checking", tools: [], checkedAt: null });

    expect(within(findSection("Server")).getByText("Not yet")).toBeTruthy();
    expect(
      within(findSection("Tools")).getByText("The tools show here once the check is done."),
    ).toBeTruthy();
  });

  it("goes to Settings > Connections from Open", async () => {
    const { router } = await openPage(SENTRY_WORK);
    // The page of Connections reads these.
    await userEvent.click(within(findSection("Server")).getByRole("link", { name: "Open" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/connections");
    });
  });
});

describe("a server's status band", () => {
  it("draws the spinner and what the check is doing while the server is checking", async () => {
    await openPage({ ...SENTRY_WORK, status: "checking" });

    const band = document.querySelector(".mcp-band")!;
    expect(band.textContent).toBe("Checking: asking the server for its tools.");
    expect(band.querySelector(".spin")).not.toBeNull();
    expect(within(band as HTMLElement).queryByRole("button")).toBeNull();
    // Check now waits for the check that runs.
    expect(
      within(findSection("Server"))
        .getByRole("button", { name: "Check now" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("says a switched-off server is off, and cannot be checked", async () => {
    await openPage({ ...SENTRY_WORK, enabled: false });

    expect(document.querySelector(".mcp-band")?.textContent).toBe(
      "Off. No thread gets this server. Its name, its sign-in and the projects that name it are kept.",
    );
    expect(
      within(findSection("Server"))
        .getByRole("button", { name: "Check now" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      within(findSection("Server"))
        .getByRole("switch", { name: "Offered to threads" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("offers Reconnect for a server that needs sign-in, shows the reason in the band, and keeps the Connection row to the short word", async () => {
    await openPage({ ...SENTRY_WORK, status: "needs-sign-in", statusDetail: "revoked 09:12" });

    const band = document.querySelector<HTMLElement>(".mcp-band--fail")!;
    expect(band.textContent).toContain("Needs sign-in.");
    expect(band.querySelector("small")?.textContent).toBe("revoked 09:12");
    expect(within(band).getByRole("button", { name: "Reconnect Sentry · work" })).toBeTruthy();
    // The band holds the page's one button and the reason: the Connection row has no button, and
    // says only the short word.
    const server = findSection("Server");
    expect(within(server).queryByRole("link", { name: "Open" })).toBeNull();
    expect(server.querySelector(".mcp-value-fail")?.textContent).toBe("needs sign-in");
  });

  it("opens the Connection's own Reconnect dialog from the band's button", async () => {
    await openPage({ ...SENTRY_WORK, status: "needs-sign-in", statusDetail: "revoked" });

    await userEvent.click(screen.getByRole("button", { name: "Reconnect Sentry · work" }));

    expect(await screen.findByRole("dialog", { name: "Reconnect Sentry · work" })).toBeTruthy();
  });

  it.each(["unreachable", "error"] as const)(
    "offers Check now for a server that is %s",
    async (status) => {
      const { world, calls } = await openPage({
        ...SENTRY_WORK,
        status,
        statusDetail: "Sentry's MCP server refused the Connection's token",
      });

      const band = document.querySelector<HTMLElement>(".mcp-band--fail")!;
      expect(band.querySelector("small")?.textContent).toBe(
        "Sentry's MCP server refused the Connection's token",
      );
      await userEvent.click(within(band).getByRole("button", { name: "Check now" }));

      await waitFor(() => {
        expect(world.checked).toEqual([SENTRY_WORK_ID]);
      });
      expect(findCalls(calls, "POST", `${WORK_URL}/check`)).toHaveLength(1);
      // The server is checking now, which the page reads again.
      await waitFor(() => {
        expect(document.querySelector(".mcp-band")?.textContent).toBe(
          "Checking: asking the server for its tools.",
        );
      });
    },
  );

  it("shows the end of a check when the controller pushes it", async () => {
    const { world, live } = await openPage({ ...SENTRY_WORK, status: "checking" });

    world.servers = [{ ...SENTRY_WORK, tools: [{ name: "only_one", description: "One." }] }];
    act(() => {
      live.pushInvalidation("mcpServer", [SENTRY_WORK_ID]);
    });

    await waitFor(() => {
      expect(document.querySelector(".mcp-band")).toBeNull();
    });
    expect(within(findSection("Tools")).getByText("only_one")).toBeTruthy();
  });
});

describe("a server's page, Check now and the switch", () => {
  it("starts a check from the Server section and ignores a second press while it runs", async () => {
    const held = holdAnswer();
    const { calls } = await openPage(SENTRY_WORK, {
      handlers: { [`POST ${WORK_URL}/check`]: held.handler },
    });
    const check = within(findSection("Server")).getByRole("button", { name: "Check now" });

    await userEvent.click(check);
    await waitFor(() => {
      expect(check.getAttribute("aria-disabled")).toBe("true");
    });
    await userEvent.click(check);
    held.answer({ body: {} });

    await waitFor(() => {
      expect(check.getAttribute("aria-disabled")).toBe("false");
    });
    expect(findCalls(calls, "POST", `${WORK_URL}/check`)).toHaveLength(1);
  });

  it("shows a refused check under its row", async () => {
    await openPage(SENTRY_WORK, {
      handlers: {
        [`POST ${WORK_URL}/check`]: {
          status: 409,
          body: buildErrorBody("invalid_state", "The server is switched off."),
        },
      },
    });

    await userEvent.click(within(findSection("Server")).getByRole("button", { name: "Check now" }));

    expect((await screen.findByRole("alert")).textContent).toBe("The server is switched off.");
  });

  it("switches the server off and on with mcpServer.update", async () => {
    const { calls } = await openPage(SENTRY_WORK);
    const flip = () =>
      within(findSection("Server")).getByRole("switch", { name: "Offered to threads" });

    await userEvent.click(flip());
    await waitFor(() => {
      expect(flip().getAttribute("aria-checked")).toBe("false");
    });
    expect(document.querySelector(".mcp-band")?.textContent).toContain("Off.");
    await userEvent.click(flip());
    await waitFor(() => {
      expect(flip().getAttribute("aria-checked")).toBe("true");
    });

    expect(findCalls(calls, "PATCH", WORK_URL).map((call) => call.body)).toEqual([
      { enabled: false },
      { enabled: true },
    ]);
  });
});

describe("a server's page, Projects", () => {
  it("ticks a project's box with a write of its list, and unticks it", async () => {
    const { world, calls } = await openPage(SENTRY_WORK);

    await userEvent.click(within(findProjectRow("webshop")).getByRole("checkbox"));

    await waitFor(() => {
      expect(world.projects[0]!.mcpServerIds).toEqual([SENTRY_WORK_ID]);
    });
    await waitFor(() => {
      expect(findSection("Projects").querySelector("small")?.textContent).toBe("1 of 3");
    });
    await userEvent.click(within(findProjectRow("webshop")).getByRole("checkbox"));
    await waitFor(() => {
      expect(world.projects[0]!.mcpServerIds).toEqual([]);
    });
    expect(
      findCalls(calls, "PATCH", `/api/v1/projects/${WEBSHOP.id}`).map((call) => call.body),
    ).toEqual([{ mcpServerIds: [SENTRY_WORK_ID] }, { mcpServerIds: [] }]);
  });

  it("writes the default list from the row of the threads without a project", async () => {
    const { world, calls } = await openPage(SENTRY_WORK);

    await userEvent.click(
      within(findProjectRow("Threads without a project")).getByRole("checkbox"),
    );

    await waitFor(() => {
      expect(world.defaultIds).toEqual([SENTRY_WORK_ID]);
    });
    expect(findCalls(calls, "PATCH", "/api/v1/settings").map((call) => call.body)).toEqual([
      { user: { "thread.mcpServerIds": [SENTRY_WORK_ID] } },
    ]);
  });

  it("says a project already uses the other server of the name, and refuses to tick it", async () => {
    const { world, calls } = await openPage(SENTRY_WORK, {
      servers: [SENTRY_WORK, SENTRY_HOBBY],
      projects: [named(WEBSHOP, SENTRY_HOBBY_ID), OPS],
    });
    const row = findProjectRow("webshop");

    expect(row.querySelector(".mcp-proj-other")?.textContent).toBe("uses sentry hobby");
    await userEvent.click(within(row).getByRole("checkbox"));

    const refusal = within(row).getByRole("alert");
    expect(refusal.textContent).toBe(
      "webshop already uses sentry hobby. One project cannot name both: their tools would get the same names.Use sentry workKeep sentry hobby",
    );
    expect(row.querySelector(".mcp-proj-other")).toBeNull();
    expect(within(row).getByRole("checkbox").getAttribute("aria-checked")).toBe("mixed");
    expect(findCalls(calls, "PATCH", `/api/v1/projects/${WEBSHOP.id}`)).toEqual([]);
    expect(world.projects[0]!.mcpServerIds).toEqual([SENTRY_HOBBY_ID]);
  });

  it("refuses a tick, without a write, when the list names the other server of the name by the time of the press", async () => {
    const { world, calls, context } = await openPage(SENTRY_WORK, {
      servers: [SENTRY_WORK, SENTRY_HOBBY],
      projects: [WEBSHOP, OPS],
    });
    const row = findProjectRow("webshop");

    // A read has put the other server in the webshop's list, which the box has not drawn yet.
    // The refusal reads the list again, so the controller holds it too.
    world.projects = [named(WEBSHOP, SENTRY_HOBBY_ID), OPS];
    context.queryClient.setQueryData(queryKeys.projects(), world.projects);
    fireEvent.click(within(row).getByRole("checkbox"));

    await waitFor(() => {
      expect(within(findProjectRow("webshop")).getByRole("alert").textContent).toContain(
        "webshop already uses sentry hobby",
      );
    });
    expect(findCalls(calls, "PATCH", `/api/v1/projects/${WEBSHOP.id}`)).toEqual([]);
    expect(world.projects[0]!.mcpServerIds).toEqual([SENTRY_HOBBY_ID]);
  });

  it("unticks only this server, whatever else the list names by the time of the press", async () => {
    const { world, context } = await openPage(SENTRY_WORK, {
      servers: [SENTRY_WORK, SENTRY_HOBBY, LINEAR],
      projects: [named(WEBSHOP, SENTRY_WORK_ID), OPS],
    });
    const row = findProjectRow("webshop");

    context.queryClient.setQueryData(queryKeys.projects(), [
      named(WEBSHOP, SENTRY_WORK_ID, LINEAR_ID),
      OPS,
    ]);
    fireEvent.click(within(row).getByRole("checkbox"));

    await waitFor(() => {
      expect(world.projects[0]!.mcpServerIds).toEqual([LINEAR_ID]);
    });
  });

  it("closes the refusal with Keep and leaves the list as it was", async () => {
    await openPage(SENTRY_WORK, {
      servers: [SENTRY_WORK, SENTRY_HOBBY],
      projects: [named(WEBSHOP, SENTRY_HOBBY_ID), OPS],
    });
    const row = findProjectRow("webshop");
    await userEvent.click(within(row).getByRole("checkbox"));

    await userEvent.click(within(row).getByRole("button", { name: "Keep sentry hobby" }));

    expect(within(row).queryByRole("alert")).toBeNull();
    expect(row.querySelector(".mcp-proj-other")?.textContent).toBe("uses sentry hobby");
  });

  it("swaps the servers with Use, in one write whose list holds this server and not the other", async () => {
    const { world, calls } = await openPage(SENTRY_WORK, {
      servers: [SENTRY_WORK, SENTRY_HOBBY],
      projects: [named(WEBSHOP, SENTRY_HOBBY_ID), OPS],
    });
    const row = findProjectRow("webshop");
    await userEvent.click(within(row).getByRole("checkbox"));

    await userEvent.click(within(row).getByRole("button", { name: "Use sentry work" }));

    await waitFor(() => {
      expect(world.projects[0]!.mcpServerIds).toEqual([SENTRY_WORK_ID]);
    });
    expect(
      findCalls(calls, "PATCH", `/api/v1/projects/${WEBSHOP.id}`).map((call) => call.body),
    ).toEqual([{ mcpServerIds: [SENTRY_WORK_ID] }]);
    await waitFor(() => {
      expect(within(findProjectRow("webshop")).queryByRole("alert")).toBeNull();
    });
    expect(within(findProjectRow("webshop")).getByRole("checkbox", { checked: true })).toBeTruthy();
  });

  it("swaps the server the refusal names now, when a push changed the occupant after the refusal showed", async () => {
    const sideConnection = buildConnection(
      "01a06d02-8100-7000-8000-000000000004",
      "sentry/sentry",
      "side",
    );
    const side = buildServer("01a06d02-8200-7000-8000-000000000004", "sentry", sideConnection);
    const { world, calls, context } = await openPage(SENTRY_WORK, {
      servers: [SENTRY_WORK, SENTRY_HOBBY, side],
      connections: [...OFFERING_CONNECTIONS, sideConnection],
      projects: [named(WEBSHOP, SENTRY_HOBBY_ID), OPS],
    });
    const row = findProjectRow("webshop");
    await userEvent.click(within(row).getByRole("checkbox"));
    expect(within(row).getByRole("alert").textContent).toContain(
      "webshop already uses sentry hobby",
    );

    // A read puts another account of the name in the list, and the refusal now describes it.
    context.queryClient.setQueryData(queryKeys.projects(), [named(WEBSHOP, side.id), OPS]);
    await waitFor(() => {
      expect(within(findProjectRow("webshop")).getByRole("alert").textContent).toContain(
        "webshop already uses sentry side",
      );
    });
    world.projects = [named(WEBSHOP, side.id), OPS];
    await userEvent.click(
      within(findProjectRow("webshop")).getByRole("button", { name: "Use sentry work" }),
    );

    await waitFor(() => {
      expect(world.projects[0]!.mcpServerIds).toEqual([SENTRY_WORK_ID]);
    });
    expect(
      findCalls(calls, "PATCH", `/api/v1/projects/${WEBSHOP.id}`).map((call) => call.body),
    ).toEqual([{ mcpServerIds: [SENTRY_WORK_ID] }]);
  });

  it("keeps the box of the threads without a project off until the settings read of this opening has answered", async () => {
    let gate: Promise<void> = Promise.resolve();
    let release = (): void => undefined;
    let defaultIds: string[] = [];
    const { router } = await openAt(LIST_PATH, {
      servers: [SENTRY_WORK],
      handlers: {
        "GET /api/v1/settings": async () => {
          await gate;
          return { body: { controller: {}, user: { "thread.mcpServerIds": defaultIds } } };
        },
      },
    });
    defaultIds = [LINEAR_ID];
    gate = new Promise((resolve) => {
      release = resolve;
    });

    await act(() =>
      router.navigate({ to: "/settings/mcp-servers/$id", params: { id: SENTRY_WORK_ID } }),
    );
    const box = await within(await waitForProjectRow("Threads without a project")).findByRole(
      "checkbox",
    );

    expect(box.getAttribute("aria-disabled")).toBe("true");
    release();
    await waitFor(() => {
      expect(box.getAttribute("aria-disabled")).toBe("false");
    });
  });

  it("refuses the swap for the threads without a project in its own words", async () => {
    await openPage(SENTRY_WORK, {
      servers: [SENTRY_WORK, SENTRY_HOBBY],
      defaultIds: [SENTRY_HOBBY_ID],
    });
    const row = findProjectRow("Threads without a project");

    await userEvent.click(within(row).getByRole("checkbox"));

    expect(within(row).getByRole("alert").textContent).toContain(
      "Threads without a project already use sentry hobby. One list cannot name both",
    );
  });

  it("keeps a box ignoring presses while its write runs, and shows a refusal under it", async () => {
    const held = holdAnswer();
    const { calls } = await openPage(SENTRY_WORK, {
      handlers: { [`PATCH /api/v1/projects/${WEBSHOP.id}`]: held.handler },
    });
    const box = within(findProjectRow("webshop")).getByRole("checkbox");

    await userEvent.click(box);
    await waitFor(() => {
      expect(box.getAttribute("aria-disabled")).toBe("true");
    });
    await userEvent.click(box);
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

    const alert = await within(findProjectRow("webshop")).findByRole("alert");
    expect(alert.textContent).toBe("Could not save: This token lacks mcp.manage.");
    expect(findCalls(calls, "PATCH", `/api/v1/projects/${WEBSHOP.id}`)).toHaveLength(1);
    expect((box as HTMLInputElement).checked).toBe(false);
  });
});

describe("a server's page, Remove", () => {
  it("asks first, naming the projects, then deletes and goes back to the list", async () => {
    const { world, router, calls } = await openPage(SENTRY_WORK, {
      projects: [named(WEBSHOP, SENTRY_WORK_ID), named(OPS, SENTRY_WORK_ID)],
      defaultIds: [SENTRY_WORK_ID],
    });

    await userEvent.click(screen.getByRole("button", { name: "Remove server…" }));

    const dialog = await screen.findByRole("dialog", { name: "Remove sentry work?" });
    expect(dialog.textContent).toContain(
      "webshop, ops and threads without a project name it. Every project's list and every thread's list drops it, and a running thread loses its tools at once.",
    );
    expect(findCalls(calls, "DELETE", WORK_URL)).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(LIST_PATH);
    });
    expect(world.servers).toEqual([]);
    expect(world.projects.map((project) => project.mcpServerIds)).toEqual([[], []]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says that no project names a server no list names, and keeps the server when Cancel is pressed", async () => {
    const { world } = await openPage(SENTRY_WORK);
    await userEvent.click(screen.getByRole("button", { name: "Remove server…" }));

    const dialog = await screen.findByRole("dialog", { name: "Remove sentry work?" });
    expect(dialog.textContent).toContain("No project names it.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(world.servers).toHaveLength(1);
  });

  it("goes back to the list when the controller says the server is gone", async () => {
    const { router } = await openPage(SENTRY_WORK, {
      handlers: {
        [`DELETE ${WORK_URL}`]: { status: 404, body: buildErrorBody("not_found", "no server") },
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Remove server…" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove sentry work?" });

    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(LIST_PATH);
    });
  });

  it("keeps a refusal in the dialog", async () => {
    await openPage(SENTRY_WORK, {
      handlers: {
        [`DELETE ${WORK_URL}`]: {
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
    await userEvent.click(screen.getByRole("button", { name: "Remove server…" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove sentry work?" });

    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Could not remove: This token lacks mcp.manage.",
    );
  });
});

describe("a server's page, leaving it", () => {
  it("goes back to the list for an id that names no server", async () => {
    const { router } = await openAt(`${LIST_PATH}/01a06d02-8200-7000-8000-0000000000ff`);

    expect(await screen.findByRole("heading", { level: 1, name: "MCP servers" })).toBeTruthy();
    expect(router.state.location.pathname).toBe(LIST_PATH);
    // The redirect replaced the page's entry, so Back does not return to it.
    expect(router.history.length).toBeLessThanOrEqual(2);
  });

  it("goes back to the list for text that is no id at all", async () => {
    const { router } = await openAt(`${LIST_PATH}/not-an-id`);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(LIST_PATH);
    });
  });

  it("goes back to the list when the server is deleted while its page is open", async () => {
    const { world, live, router } = await openPage(SENTRY_WORK);

    world.servers = [];
    act(() => {
      live.pushInvalidation("mcpServer", [SENTRY_WORK_ID], { kind: "deleted" });
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(LIST_PATH);
    });
    expect(await screen.findByRole("heading", { level: 1, name: "MCP servers" })).toBeTruthy();
  });

  it("remembers the list, not the page, as the section Settings opens again", async () => {
    const { router } = await openPage(SENTRY_WORK);

    expect(readLastSettingsSection()).toBe(LIST_PATH);
    expect(router.state.location.pathname).toBe(`${LIST_PATH}/${SENTRY_WORK_ID}`);
  });
});

describe("the topic of Settings > MCP servers", () => {
  const HELD = "mcpServer";

  it("is held on a server's page and dropped when another section opens", async () => {
    const { live, router } = await openPage(SENTRY_WORK, {
      handlers: { "GET /api/v1/skills": { body: { items: [] } } },
    });
    expect(live.readTopics()).toContain(HELD);

    await act(() => router.navigate({ to: "/settings/skills" }));

    await waitFor(() => {
      expect(live.readTopics()).not.toContain(HELD);
    });
  });

  it("is kept while the list and a page are visited one after the other", async () => {
    const { live, router } = await openAt(LIST_PATH, { servers: [SENTRY_WORK] });
    const subscriptions = live.readTopics().filter((topic) => topic === HELD);
    expect(subscriptions).toHaveLength(1);

    await act(() =>
      router.navigate({ to: "/settings/mcp-servers/$id", params: { id: SENTRY_WORK_ID } }),
    );
    await screen.findByRole("heading", { level: 1, name: "sentry" });

    expect(live.readTopics().filter((topic) => topic === HELD)).toHaveLength(1);
  });
});
