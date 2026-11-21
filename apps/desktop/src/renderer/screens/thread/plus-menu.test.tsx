/**
 * Tests the `+` menu's rows on their own: the attach row's disabled state, and
 * the MCP servers row drawn off with its reason, which the thread's composer
 * does while it answers a question if the owner decides servers are off then.
 * jsdom has no popover API, so a test sends the `toggle` event the browser sends.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PlusMenu } from "./plus-menu";
import type { ThreadServers } from "./use-thread-servers";

const SERVERS: ThreadServers = {
  ids: [],
  projectId: null,
  row: { words: "none", failing: false },
  change: () => undefined,
  busy: false,
  refusal: null,
  clearRefusal: () => undefined,
};

const openMenu = (): void => {
  act(() => {
    fireEvent(
      document.querySelector("[popover]")!,
      Object.assign(new Event("toggle"), { newState: "open" }),
    );
  });
};

describe("the + menu's rows", () => {
  it("attaches from the attach row, and does nothing from one that is off", () => {
    const onAttach = vi.fn();
    const { rerender } = render(
      <PlusMenu
        attach={{ off: false, title: "Attach images", onAttach }}
        servers={SERVERS}
        serversOff={null}
        disabled={false}
      />,
    );
    openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Attach an image", hidden: true }));
    expect(onAttach).toHaveBeenCalledTimes(1);

    rerender(
      <PlusMenu
        attach={{ off: true, title: "An answer takes text only", onAttach }}
        servers={SERVERS}
        serversOff={null}
        disabled={false}
      />,
    );
    const off = screen.getByRole("menuitem", { name: "Attach an image", hidden: true });
    fireEvent.click(off);

    expect(off.getAttribute("aria-disabled")).toBe("true");
    expect(off.title).toBe("An answer takes text only");
    expect(onAttach).toHaveBeenCalledTimes(1);
  });

  it("draws the MCP servers row off with its reason, and opens no submenu from it", () => {
    render(
      <PlusMenu
        attach={{ off: false, title: "Attach images", onAttach: () => undefined }}
        servers={SERVERS}
        serversOff="Not while answering a question"
        disabled={false}
      />,
    );
    openMenu();

    const row = screen.getByRole("menuitem", { name: /^MCP servers/, hidden: true });
    fireEvent.click(row);

    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.title).toBe("Not while answering a question");
    expect(
      screen.queryByRole("group", { name: "Servers of this thread", hidden: true }),
    ).toBeNull();
  });
});
