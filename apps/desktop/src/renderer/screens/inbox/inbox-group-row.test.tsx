/** Tests what the head of a group draws, its two separate targets, and its tree item attributes; and the members and "Show N more" line that hang under it. */
import type { InboxGroupRowView } from "@hercule/client-core/inbox";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InboxGroupMore } from "./inbox-group-more";
import { InboxGroupRow } from "./inbox-group-row";
import { InboxRow } from "./inbox-row";
import { buildInboxRowActions, buildInboxRowView, TEST_PLUGINS } from "./inbox-row.testing";

const VIEW: InboxGroupRowView = {
  key: "group:1",
  title: "Retry a failed card payment",
  time: { kind: "wait", text: "4d", tone: "over", words: "Waiting 4 days, overdue" },
  reason: { who: "Tomás", rest: "mentioned you", more: 1, quiet: false },
  sources: ["github", "linear"],
  count: "14 things",
  label: "Linked group, 14 things: Retry a failed card payment",
};

/** Renders a head with callbacks that record their calls. */
const renderHead = (
  state: {
    isOpen?: boolean;
    tick?: "none" | "some" | "all";
    isCurrent?: boolean;
    unloadedCount?: number;
  } = {},
) => {
  const onPick = vi.fn();
  const onToggleSelect = vi.fn();
  const onToggleOpen = vi.fn();
  const onTakeOn = vi.fn();
  const onDismiss = vi.fn();
  render(
    <InboxGroupRow
      view={VIEW}
      plugins={TEST_PLUGINS}
      isCurrent={state.isCurrent ?? false}
      isOpen={state.isOpen ?? false}
      tick={state.tick ?? "none"}
      unloadedCount={state.unloadedCount ?? 0}
      onPick={onPick}
      onToggleSelect={onToggleSelect}
      onToggleOpen={onToggleOpen}
      onTakeOn={onTakeOn}
      onDismiss={onDismiss}
    />,
  );
  return {
    head: screen.getByRole("treeitem"),
    onPick,
    onToggleSelect,
    onToggleOpen,
    onTakeOn,
    onDismiss,
  };
};

describe("InboxGroupRow", () => {
  it("draws the label, the time, the ask with its +n, and the count of things", () => {
    const { head } = renderHead();
    expect(within(head).getByText("Retry a failed card payment")).toBeTruthy();
    expect(within(head).getByText("4d")).toBeTruthy();
    expect(within(head).getByText("Tomás").tagName).toBe("B");
    expect(within(head).getByText("+1")).toBeTruthy();
    expect(within(head).getByText("14 things")).toBeTruthy();
    expect(head.querySelectorAll(".ib-row-marks svg")).toHaveLength(2);
  });

  it("is a tree item at level 1 named for the whole row, with aria-expanded written as a word", () => {
    const closed = renderHead();
    expect(closed.head.getAttribute("aria-label")).toBe(VIEW.label);
    expect(closed.head.getAttribute("aria-level")).toBe("1");
    expect(closed.head.getAttribute("aria-expanded")).toBe("false");
    expect(closed.head.getAttribute("aria-selected")).toBe("false");
  });

  it("says it is expanded when open, and selected only when the selection holds the whole group", () => {
    const { head } = renderHead({ isOpen: true, tick: "all" });
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(head.getAttribute("aria-selected")).toBe("true");
  });

  it("is in the tab order only when current", () => {
    expect(renderHead({ isCurrent: true }).head.tabIndex).toBe(0);
  });

  it("draws a partly selected group as a picked row with a dash in its tick", () => {
    const { head } = renderHead({ tick: "some" });
    expect(head.className).toContain("is-picked");
    expect(head.querySelector(".ib-row-tick.is-on")).not.toBeNull();
    expect(head.getAttribute("aria-selected")).toBe("false");
  });

  it("selects from the lead and unfolds from the chevron, as two separate buttons", async () => {
    const { head, onPick, onToggleSelect, onToggleOpen } = renderHead();
    const user = userEvent.setup();
    await user.click(within(head).getByRole("button", { name: "Select the group" }));
    expect(onToggleSelect).toHaveBeenCalledWith("group:1", false);
    expect(onToggleOpen).not.toHaveBeenCalled();
    await user.click(within(head).getByRole("button", { name: "Unfold the group" }));
    expect(onToggleOpen).toHaveBeenCalledWith("group:1");
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("asks for the whole group, members outside the query too, when the tick is pressed with Shift", async () => {
    const { head, onToggleSelect } = renderHead();
    const user = userEvent.setup();
    await user.keyboard("{Shift>}");
    await user.click(within(head).getByRole("button", { name: "Select the group" }));
    expect(onToggleSelect).toHaveBeenCalledWith("group:1", true);
  });

  it("makes the row current when pressed outside its buttons", async () => {
    const { head, onPick } = renderHead();
    await userEvent.setup().click(within(head).getByText("Retry a failed card payment"));
    expect(onPick).toHaveBeenCalledWith("group:1", {
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
    });
  });

  it("passes the modifier keys of a click on the row, so Shift and Command select as on a thing's row", async () => {
    const { head, onPick } = renderHead();
    const user = userEvent.setup();
    await user.keyboard("{Shift>}");
    await user.click(within(head).getByText("Retry a failed card payment"));
    await user.keyboard("{/Shift}{Meta>}");
    await user.click(within(head).getByText("Retry a failed card payment"));
    const modifiersOf = (call: readonly unknown[]): unknown => call[1];
    expect(onPick.mock.calls.map(modifiersOf)).toEqual([
      { shiftKey: true, metaKey: false, ctrlKey: false },
      { shiftKey: false, metaKey: true, ctrlKey: false },
    ]);
  });

  it("offers Take on and Dismiss all under the pointer, each acting on the group's key and not selecting or unfolding it", async () => {
    const { head, onTakeOn, onDismiss, onPick, onToggleOpen } = renderHead();
    const user = userEvent.setup();
    await user.click(within(head).getByRole("button", { name: "Take on" }));
    await user.click(within(head).getByRole("button", { name: "Dismiss all 14 things" }));
    expect(onTakeOn).toHaveBeenCalledWith("group:1");
    expect(onDismiss).toHaveBeenCalledWith("group:1");
    expect(onPick).not.toHaveBeenCalled();
    expect(onToggleOpen).not.toHaveBeenCalled();
    expect(within(head).getByRole("button", { name: "Take on" }).title).toBe("Take on (T)");
  });

  it("says how many members are not loaded yet, apart from its count, and says nothing when all are", () => {
    const all = renderHead();
    expect(all.head.getAttribute("aria-label")).toBe(VIEW.label);
    cleanup();
    const cut = renderHead({ unloadedCount: 3 });
    expect(cut.head.getAttribute("aria-label")).toBe(`${VIEW.label}. 3 not loaded yet`);
    expect(within(cut.head).getByText("14 things").title).toBe("3 not loaded yet");
  });

  it("names the fold for what pressing it does", () => {
    const { head } = renderHead({ isOpen: true });
    expect(within(head).getByRole("button", { name: "Fold the group" })).toBeTruthy();
  });
});

describe("InboxRow as a member of a group", () => {
  const renderMember = (member: {
    isQuiet: boolean;
    isLast: boolean;
    position?: number;
    of?: number;
  }) => {
    render(
      <InboxRow
        view={buildInboxRowView("m")}
        plugins={TEST_PLUGINS}
        position={9}
        size={40}
        current={false}
        selected={false}
        actions={buildInboxRowActions()}
        member={{ position: 1, of: 2, ...member }}
      />,
    );
    return screen.getByRole("treeitem");
  };

  it("is a tree item at level 2, and marks a quiet member and the last one", () => {
    const row = renderMember({ isQuiet: true, isLast: true });
    expect(row.getAttribute("aria-level")).toBe("2");
    expect(row.className).toContain("ib-row--member");
    expect(row.className).toContain("is-outside-query");
    expect(row.className).toContain("is-last");
  });

  it("counts its place within its group, not within the whole list", () => {
    const row = renderMember({ isQuiet: false, isLast: false, position: 3, of: 5 });
    expect(row.getAttribute("aria-posinset")).toBe("3");
    expect(row.getAttribute("aria-setsize")).toBe("5");
  });

  it("is drawn in full when it answers the query and is not the last", () => {
    const row = renderMember({ isQuiet: false, isLast: false });
    expect(row.className).not.toContain("is-outside-query");
    expect(row.className).not.toContain("is-last");
  });
});

describe("InboxGroupMore", () => {
  it("says quietly how many members are not loaded yet, and nothing when all are", () => {
    const { rerender } = render(
      <InboxGroupMore
        groupKey="group:1"
        hiddenCount={9}
        unloadedCount={0}
        isCurrent={false}
        onShowMore={() => {}}
      />,
    );
    expect(screen.queryByText(/not loaded yet/)).toBeNull();
    rerender(
      <InboxGroupMore
        groupKey="group:1"
        hiddenCount={9}
        unloadedCount={4}
        isCurrent={false}
        onShowMore={() => {}}
      />,
    );
    expect(screen.getByText("· 4 not loaded yet")).toBeTruthy();
  });

  it("says how many members are hidden and shows them when pressed", async () => {
    const onShowMore = vi.fn();
    render(
      <InboxGroupMore
        groupKey="group:1"
        hiddenCount={9}
        unloadedCount={0}
        isCurrent={false}
        onShowMore={onShowMore}
      />,
    );
    const line = screen.getByRole("treeitem", { name: "Show 9 more in this group" });
    expect(line.getAttribute("aria-level")).toBe("2");
    expect(line.getAttribute("data-ref")).toBe("group:1:more");
    await userEvent.setup().click(line);
    expect(onShowMore).toHaveBeenCalledWith("group:1");
  });
});
