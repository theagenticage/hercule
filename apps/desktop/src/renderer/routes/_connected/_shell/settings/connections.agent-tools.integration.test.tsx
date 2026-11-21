/**
 * Tests the "agent tools" note of Settings > Connections: its words for each
 * state of a Connection's MCP server, where it leads, the menu item with the
 * same target, and the topic the section holds for it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildErrorBody } from "@hercule/client-core/testing";
import { forgetLastSettingsSection } from "../../../../app/last-settings-section";
import {
  SENTRY_HOBBY_CONNECTION,
  SENTRY_WORK,
  SENTRY_WORK_ID,
  LINEAR,
} from "../../../../screens/settings/mcp-servers/mcp-servers.testing";
import {
  openAt,
  SERVER_LIST_PATH,
  waitForTopicReads,
} from "../../../../screens/settings/mcp-servers/mcp-world.testing";

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

afterEach(forgetLastSettingsSection);

const CONNECTIONS_PATH = "/settings/connections";

/** Opens Settings > Connections and waits for its table. */
const openConnections = async (options: Parameters<typeof openAt>[1] = {}) => {
  const app = await openAt(CONNECTIONS_PATH, options);
  await screen.findByRole("heading", { level: 1, name: "Connections" });
  return app;
};

/** Returns the row of the Connection named `name`, such as "Sentry · work". */
const findRow = (name: string): HTMLElement =>
  screen.getByText(name, { selector: "b" }).closest<HTMLElement>(".conn")!;

describe("Settings > Connections, agent tools", () => {
  it("says off for a Connection whose server has no record, and on for a ready one", async () => {
    await openConnections({ servers: [SENTRY_WORK] });

    const work = within(findRow("Sentry · work")).getByRole("button", { name: /^agent tools/ });
    expect(work.textContent).toBe("agent tools on");
    expect(work.title).toBe("Agent tools are switched on and off in Settings > MCP servers");
    expect(
      within(findRow("Sentry · hobby")).getByRole("button", { name: /^agent tools/ }).textContent,
    ).toBe("agent tools off");
    expect(
      within(findRow("Linear · acme")).getByRole("button", { name: /^agent tools/ }).textContent,
    ).toBe("agent tools off");
  });

  it("puts the note on the account's line, after the account", async () => {
    await openConnections({ servers: [SENTRY_WORK] });

    const line = within(findRow("Sentry · work")).getByRole("button", {
      name: /^agent tools/,
    }).parentElement!;
    expect(line.className).toBe("conn-line");
    expect(line.firstElementChild?.textContent).toBe("work@acme.example");
  });

  it.each([
    ["checking", "agent tools: checking", false],
    ["needs-sign-in", "agent tools: needs sign-in", true],
    ["unreachable", "agent tools: unreachable", true],
    ["error", "agent tools: error", true],
  ] as const)("says %s as '%s'", async (status, words, failing) => {
    await openConnections({ servers: [{ ...SENTRY_WORK, status, statusDetail: "why" }] });

    const note = within(findRow("Sentry · work")).getByRole("button", { name: /^agent tools/ });
    expect(note.textContent).toBe(words);
    expect(note.classList.contains("is-fail")).toBe(failing);
    expect(note.querySelector(".dot--fail") !== null).toBe(failing);
  });

  it("says off for a server switched off, whatever its status was", async () => {
    await openConnections({
      servers: [{ ...SENTRY_WORK, enabled: false, status: "needs-sign-in" }],
    });

    expect(
      within(findRow("Sentry · work")).getByRole("button", { name: /^agent tools/ }).textContent,
    ).toBe("agent tools off");
  });

  it("leads to the server's page from the note", async () => {
    const { router } = await openConnections({ servers: [SENTRY_WORK] });

    await userEvent.click(
      within(findRow("Sentry · work")).getByRole("button", { name: "agent tools on" }),
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/settings/mcp-servers/${SENTRY_WORK_ID}`);
    });
    expect(await screen.findByRole("heading", { level: 1, name: "sentry" })).toBeTruthy();
  });

  it("leads to the list from the note of a Connection whose server has no record", async () => {
    const { router } = await openConnections({ servers: [SENTRY_WORK] });

    await userEvent.click(
      within(findRow("Sentry · hobby")).getByRole("button", { name: "agent tools off" }),
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/mcp-servers");
    });
  });

  it("leads to the same place from the row's menu item Agent tools…", async () => {
    const { router } = await openConnections({ servers: [LINEAR] });
    const row = findRow("Linear · acme");
    const more = within(row).getByRole("button", { name: "More for Linear · acme" });
    await userEvent.click(more);
    const menu = document.getElementById(more.getAttribute("popovertarget")!)!;

    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Agent tools…", hidden: true }),
      {
        pointerEventsCheck: 0,
      },
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/settings/mcp-servers/${LINEAR.id}`);
    });
  });

  it("says the tools are not available, in plain text, when the servers cannot be read, and keeps the Connection's actions", async () => {
    await openConnections({
      servers: [SENTRY_WORK],
      handlers: {
        [`GET ${SERVER_LIST_PATH}`]: {
          status: 403,
          body: buildErrorBody("forbidden", "This token lacks mcp.read."),
        },
      },
    });

    const row = findRow("Sentry · work");
    await waitFor(() => {
      expect(within(row).getByText("agent tools: not available")).toBeTruthy();
    });
    expect(within(row).queryByRole("button", { name: /^agent tools/ })).toBeNull();
    expect(within(row).getByRole("button", { name: "More for Sentry · work" })).toBeTruthy();
  });

  it("shows no note, and no menu item, for a Connection whose plugin offers no server", async () => {
    await openConnections({
      servers: [],
      connections: [{ ...SENTRY_HOBBY_CONNECTION, type: "other/other", label: "other" }],
    });

    expect(screen.queryByRole("button", { name: /^agent tools/ })).toBeNull();
  });

  it("holds the mcpServer topic while it is open, and shows a change of the server at once", async () => {
    const app = await openConnections({ servers: [SENTRY_WORK] });
    await waitForTopicReads(app);

    app.world.servers = [{ ...SENTRY_WORK, status: "needs-sign-in", statusDetail: "revoked" }];
    act(() => {
      app.live.pushInvalidation("mcpServer", [SENTRY_WORK_ID]);
    });

    await waitFor(() => {
      expect(
        within(findRow("Sentry · work")).getByRole("button", { name: /^agent tools/ }).textContent,
      ).toBe("agent tools: needs sign-in");
    });
    await act(() => app.router.navigate({ to: "/settings/appearance" }));
    await waitFor(() => {
      expect(app.live.readTopics()).not.toContain("mcpServer");
    });
  });

  it("leaves the notes out, and the table usable, when the servers cannot be read", async () => {
    await openConnections({
      handlers: {
        [`GET ${SERVER_LIST_PATH}`]: {
          status: 403,
          body: {
            error: { code: "forbidden", message: "No mcp.read.", details: { grant: "mcp.read" } },
          },
        },
      },
    });

    expect(screen.getByText("Sentry · work", { selector: "b" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^agent tools/ })).toBeNull();
  });
});
