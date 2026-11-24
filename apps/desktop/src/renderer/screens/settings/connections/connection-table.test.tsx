/**
 * Tests that the strip and each row show the Connections' event counts, that
 * the items of a Connection row's ⋯ menu call the table's callbacks with that
 * row's Connection, and its type for Reconnect, and that a Connection whose
 * plugin offers an MCP server says what the server is doing.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectionType } from "@hercule/client-core";
import {
  GITHUB_CONNECTION_TYPE,
  type Connection,
  type EventCountsByConnection,
} from "@hercule/contract";
import type { AgentTools } from "./agent-tools";
import { ConnectionTable } from "./connection-table";

const GITHUB: ConnectionType = {
  type: GITHUB_CONNECTION_TYPE,
  displayName: "GitHub",
  pluginName: "GitHub",
  setup: [{ kind: "device" }],
  hasPublicClient: false,
  clientSetupFields: [],
  registeredRedirectUris: [],
  feeds: [],
};

const CONNECTION: Connection = {
  id: "01a06d02-7700-7000-8000-000000000001",
  type: GITHUB_CONNECTION_TYPE,
  label: "rogier",
  displayName: "rogier",
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [],
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
};

const FAILED: Connection = {
  ...CONNECTION,
  id: "01a06d02-7700-7000-8000-000000000002",
  label: "work",
  status: "error",
  statusDetail: "token revoked",
};

/** 1,200 events in the last hour for `CONNECTION`, and none for `FAILED`. */
const COUNTS: EventCountsByConnection = {
  connections: [
    { connectionId: CONNECTION.id, hourly: [...Array.from({ length: 23 }, () => 0), 1200] },
  ],
};

/**
 * Draws the table with `CONNECTION`, presses its row's ⋯ button and then the
 * item `item`, and returns the three callbacks. jsdom has no popover API, so
 * the menu is left out of the accessibility tree and is found by the button's
 * `popovertarget`.
 */
const chooseRowItem = async (
  item: string,
  agentTools: ReadonlyMap<string, readonly AgentTools[]> | undefined = undefined,
) => {
  const callbacks = {
    onReconnect: vi.fn(),
    onConfigure: vi.fn(),
    onOpenAgentTools: vi.fn(),
    onDelete: vi.fn(),
  };
  render(
    <ConnectionTable
      connections={[CONNECTION]}
      counts={COUNTS}
      types={[GITHUB]}
      plugins={[]}
      agentTools={agentTools}
      {...callbacks}
    />,
  );
  const more = screen.getByRole("button", { name: "More for GitHub · rogier" });
  await userEvent.click(more);
  const menu = document.getElementById(more.getAttribute("popovertarget")!)!;
  await userEvent.click(within(menu).getByRole("menuitem", { name: item, hidden: true }), {
    pointerEventsCheck: 0,
  });
  return callbacks;
};

describe("ConnectionTable", () => {
  it("shows the events, the event sources and the failing Connections, and each row's events", () => {
    const noop = (): void => {};
    render(
      <ConnectionTable
        connections={[CONNECTION, FAILED]}
        counts={COUNTS}
        types={[GITHUB]}
        plugins={[]}
        agentTools={undefined}
        onReconnect={noop}
        onConfigure={noop}
        onOpenAgentTools={noop}
        onDelete={noop}
      />,
    );

    const stat = (label: string) => screen.getByText(label).parentElement!.textContent;
    expect(stat("events in 24 hours")).toBe("1,200events in 24 hours");
    expect(stat("event sources")).toBe("2event sources");
    expect(stat("failing")).toBe("1failing");
    const row = (name: string) => screen.getByText(name).closest(".conn")!;
    expect(row("GitHub · rogier").querySelector(".n")?.textContent).toBe("1,200");
    expect(row("GitHub · work").querySelector(".n")?.textContent).toBe("0");
  });

  it("calls onReconnect with the Connection and its type", async () => {
    const { onReconnect, onConfigure, onDelete } = await chooseRowItem("Reconnect…");

    expect(onReconnect).toHaveBeenCalledExactlyOnceWith(CONNECTION, GITHUB);
    expect(onConfigure).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("calls onConfigure with the Connection", async () => {
    const { onReconnect, onConfigure, onDelete } = await chooseRowItem("Configure…");

    expect(onConfigure).toHaveBeenCalledExactlyOnceWith(CONNECTION);
    expect(onReconnect).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("calls onDelete with the Connection", async () => {
    const { onReconnect, onConfigure, onDelete } = await chooseRowItem("Delete…");

    expect(onDelete).toHaveBeenCalledExactlyOnceWith(CONNECTION);
    expect(onReconnect).not.toHaveBeenCalled();
    expect(onConfigure).not.toHaveBeenCalled();
  });

  describe("agent tools", () => {
    const TOOLS: ReadonlyMap<string, readonly AgentTools[]> = new Map([
      [CONNECTION.id, [{ text: "agent tools on", tone: "on", serverId: "s-1" }]],
      [FAILED.id, [{ text: "agent tools: needs sign-in", tone: "fail", serverId: null }]],
    ]);

    it("shows each note on its row, in the fail colour with a red dot for a failing server", () => {
      render(
        <ConnectionTable
          connections={[CONNECTION, FAILED]}
          counts={COUNTS}
          types={[GITHUB]}
          plugins={[]}
          agentTools={TOOLS}
          onReconnect={vi.fn()}
          onConfigure={vi.fn()}
          onOpenAgentTools={vi.fn()}
          onDelete={vi.fn()}
        />,
      );

      const on = screen.getByRole("button", { name: "agent tools on" });
      expect(on.closest(".conn")?.textContent).toContain("GitHub · rogier");
      expect(on.className).toContain("is-on");
      expect(on.title).toBe("Agent tools are switched on and off in Settings > MCP servers");
      const failing = screen.getByRole("button", { name: "agent tools: needs sign-in" });
      expect(failing.className).toContain("is-fail");
      expect(failing.querySelector(".dot--fail")).not.toBeNull();
    });

    it("shows one note for each server a Connection's plugins offer", () => {
      render(
        <ConnectionTable
          connections={[CONNECTION]}
          counts={COUNTS}
          types={[GITHUB]}
          plugins={[]}
          agentTools={
            new Map([
              [
                CONNECTION.id,
                [
                  { text: "agent tools on", tone: "on", serverId: "s-1" },
                  { text: "agent tools off", tone: "off", serverId: null },
                ],
              ],
            ])
          }
          onReconnect={vi.fn()}
          onConfigure={vi.fn()}
          onOpenAgentTools={vi.fn()}
          onDelete={vi.fn()}
        />,
      );

      expect(
        screen.getAllByRole("button", { name: /^agent tools/ }).map((note) => note.textContent),
      ).toEqual(["agent tools on", "agent tools off"]);
    });

    it("shows no note for a Connection with no entry, or while the servers are unread", () => {
      const { rerender } = render(
        <ConnectionTable
          connections={[CONNECTION, FAILED]}
          counts={COUNTS}
          types={[GITHUB]}
          plugins={[]}
          agentTools={new Map([[FAILED.id, TOOLS.get(FAILED.id)!]])}
          onReconnect={vi.fn()}
          onConfigure={vi.fn()}
          onOpenAgentTools={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
      expect(screen.getAllByRole("button", { name: /^agent tools/ })).toHaveLength(1);

      rerender(
        <ConnectionTable
          connections={[CONNECTION, FAILED]}
          counts={COUNTS}
          types={[GITHUB]}
          plugins={[]}
          agentTools={undefined}
          onReconnect={vi.fn()}
          onConfigure={vi.fn()}
          onOpenAgentTools={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
      expect(screen.queryByRole("button", { name: /^agent tools/ })).toBeNull();
    });

    it("calls onOpenAgentTools with the note from the note's button", async () => {
      const onOpenAgentTools = vi.fn();
      render(
        <ConnectionTable
          connections={[CONNECTION]}
          counts={COUNTS}
          types={[GITHUB]}
          plugins={[]}
          agentTools={TOOLS}
          onReconnect={vi.fn()}
          onConfigure={vi.fn()}
          onOpenAgentTools={onOpenAgentTools}
          onDelete={vi.fn()}
        />,
      );

      await userEvent.click(screen.getByRole("button", { name: "agent tools on" }));

      expect(onOpenAgentTools).toHaveBeenCalledExactlyOnceWith(TOOLS.get(CONNECTION.id)![0]);
    });

    it("calls onOpenAgentTools from the row's menu item Agent tools…", async () => {
      const { onOpenAgentTools, onDelete } = await chooseRowItem("Agent tools…", TOOLS);

      expect(onOpenAgentTools).toHaveBeenCalledExactlyOnceWith(TOOLS.get(CONNECTION.id)![0]);
      expect(onDelete).not.toHaveBeenCalled();
    });

    it("leaves the menu item out for a Connection with no note", async () => {
      render(
        <ConnectionTable
          connections={[CONNECTION]}
          counts={COUNTS}
          types={[GITHUB]}
          plugins={[]}
          agentTools={undefined}
          onReconnect={vi.fn()}
          onConfigure={vi.fn()}
          onOpenAgentTools={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
      const more = screen.getByRole("button", { name: "More for GitHub · rogier" });
      await userEvent.click(more);
      const menu = document.getElementById(more.getAttribute("popovertarget")!)!;

      expect(
        within(menu).queryByRole("menuitem", { name: "Agent tools…", hidden: true }),
      ).toBeNull();
    });
  });
});
