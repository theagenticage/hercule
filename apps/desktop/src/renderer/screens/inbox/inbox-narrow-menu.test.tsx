/** Tests Narrow, the menu over what the list holds: its groups, its values, its picks and its keys. */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { InboxClause } from "@hercule/client-core/inbox";
import { InboxNarrowMenu, type NarrowFacet } from "./inbox-narrow-menu";

const FACETS: NarrowFacet[] = [
  {
    source: "linear",
    sourceName: "Linear",
    connectionId: "conn-linear",
    key: "project",
    label: "Project",
    values: [
      { value: "proj-1", label: "Checkout revamp", count: 4 },
      { value: "proj-2", label: "Mobile 3.0", count: 1 },
    ],
  },
  {
    source: "linear",
    sourceName: "Linear",
    connectionId: "conn-linear",
    key: "team",
    label: "Team",
    values: [{ value: "Payments", label: "Payments", count: 6 }],
  },
  {
    source: "sentry",
    sourceName: "Sentry",
    key: "level",
    label: "Level",
    values: [{ value: "error", label: "error", count: 1200 }],
  },
];

/** Renders the menu over a Narrow button, and returns what it called. */
const renderMenu = () => {
  const onPick = vi.fn<(clause: InboxClause) => void>();
  const onClose = vi.fn<() => void>();
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const { unmount } = render(
    <InboxNarrowMenu
      facets={FACETS}
      plugins={[]}
      anchor={anchor}
      onPick={onPick}
      onClose={onClose}
    />,
  );
  return { onPick, onClose, anchor, unmount };
};

describe("InboxNarrowMenu", () => {
  it("groups the facets by source under a heading", () => {
    renderMenu();
    expect(screen.getByText("Narrow what the list holds")).toBeTruthy();
    const linear = screen.getByRole("group", { name: "Linear", hidden: true });
    expect(
      within(linear)
        .getAllByRole("menuitem", { hidden: true })
        .map((item) => item.textContent),
    ).toEqual(["Project", "Team"]);
    expect(
      within(screen.getByRole("group", { name: "Sentry", hidden: true })).getByText("Level"),
    ).toBeTruthy();
  });

  it("opens a facet's values with their counts, and goes back", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("menuitem", { name: "Linear project", hidden: true }));
    expect(
      screen.getAllByRole("menuitem", { hidden: true }).map((item) => item.textContent),
    ).toEqual(["Linear project", "Checkout revamp4", "Mobile 3.01"]);
    await user.click(screen.getByRole("menuitem", { name: "Linear project", hidden: true }));
    expect(screen.getByRole("group", { name: "Sentry", hidden: true })).toBeTruthy();
  });

  it("picks a value as a clause tied to its source and account", async () => {
    const user = userEvent.setup();
    const { onPick } = renderMenu();
    await user.click(screen.getByRole("menuitem", { name: "Linear project", hidden: true }));
    await user.click(screen.getByRole("menuitem", { name: /Checkout revamp/, hidden: true }));
    expect(onPick).toHaveBeenCalledWith({
      key: "project",
      op: "is",
      value: "proj-1",
      source: "linear",
      connectionId: "conn-linear",
    });
  });

  it("leaves out the account of a source that has none", async () => {
    const user = userEvent.setup();
    const { onPick } = renderMenu();
    await user.click(screen.getByRole("menuitem", { name: "Sentry level", hidden: true }));
    await user.click(screen.getByRole("menuitem", { name: /error/, hidden: true }));
    expect(onPick).toHaveBeenCalledWith({
      key: "level",
      op: "is",
      value: "error",
      source: "sentry",
    });
  });

  it("owns the keyboard: arrows move, Return picks, Esc closes and returns the focus", async () => {
    const user = userEvent.setup();
    const keysSeenByPage = vi.fn();
    document.addEventListener("keydown", keysSeenByPage);
    const { onClose, anchor, unmount } = renderMenu();
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Linear project", hidden: true }),
    );
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Linear team", hidden: true }),
    );
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Sentry level", hidden: true }),
    );
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "Sentry level", hidden: true })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem", { hidden: true })[0]);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(keysSeenByPage).not.toHaveBeenCalled();
    unmount();
    expect(document.activeElement).toBe(anchor);
    document.removeEventListener("keydown", keysSeenByPage);
  });

  it("closes on Tab and on a press outside it", async () => {
    const user = userEvent.setup();
    const { onClose } = renderMenu();
    await user.keyboard("{Tab}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
