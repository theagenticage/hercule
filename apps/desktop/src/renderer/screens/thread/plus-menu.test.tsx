/**
 * Tests the `+` menu's rows on their own: the attach row's disabled state, and
 * the MCP servers row drawn off with its reason, which the thread's composer
 * does while it answers a question when its setting turns the servers off.
 * jsdom has no popover API, so a test sends the `toggle` event the browser sends.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { PlusAttach } from "../session/composer-frame";
import { PlusMenu } from "./plus-menu";
import { ThreadServersContext, type ThreadServers } from "./thread-servers";
import type { ThreadServerEdits } from "./use-thread-edits";

const SERVERS: ThreadServers = {
  described: {
    storedIds: [],
    mcpServerIds: [],
    start: undefined,
    row: { words: "none", failing: false },
  },
  views: undefined,
  readFailure: null,
  setEditing: () => undefined,
};

const EDITS: ThreadServerEdits = {
  apply: () => undefined,
  busy: false,
  refusal: null,
  clearRefusal: () => undefined,
};

/** Renders the `+` menu with the servers of an open thread that has none. */
const renderMenu = (props: { attach: PlusAttach; serversOff: string | null }) => (
  <ThreadServersContext value={SERVERS}>
    <PlusMenu {...props} edits={EDITS} />
  </ThreadServersContext>
);

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
      renderMenu({ attach: { off: false, title: "Attach images", onAttach }, serversOff: null }),
    );
    openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Attach an image", hidden: true }));
    expect(onAttach).toHaveBeenCalledTimes(1);

    rerender(
      renderMenu({
        attach: { off: true, title: "An answer takes text only", onAttach },
        serversOff: null,
      }),
    );
    const off = screen.getByRole("menuitem", { name: "Attach an image", hidden: true });
    fireEvent.click(off);

    expect(off.getAttribute("aria-disabled")).toBe("true");
    expect(off.title).toBe("An answer takes text only");
    expect(onAttach).toHaveBeenCalledTimes(1);
  });

  it("draws the MCP servers row off with its reason, and opens no submenu from it", () => {
    render(
      renderMenu({
        attach: { off: false, title: "Attach images", onAttach: () => undefined },
        serversOff: "Not while answering a question",
      }),
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
