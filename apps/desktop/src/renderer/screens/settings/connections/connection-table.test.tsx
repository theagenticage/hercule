/**
 * Tests that the strip and each row show the Connections' event counts, and
 * that the items of a Connection row's ⋯ menu call the table's callbacks
 * with that row's Connection, and its type for Reconnect.
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
import { ConnectionTable } from "./connection-table";

const GITHUB: ConnectionType = {
  type: GITHUB_CONNECTION_TYPE,
  displayName: "GitHub",
  pluginName: "GitHub",
  setup: [{ kind: "device" }],
  hasPublicClient: false,
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
const chooseRowItem = async (item: string) => {
  const callbacks = { onReconnect: vi.fn(), onConfigure: vi.fn(), onDelete: vi.fn() };
  render(
    <ConnectionTable
      connections={[CONNECTION]}
      counts={COUNTS}
      types={[GITHUB]}
      plugins={[]}
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
        onReconnect={noop}
        onConfigure={noop}
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
});
