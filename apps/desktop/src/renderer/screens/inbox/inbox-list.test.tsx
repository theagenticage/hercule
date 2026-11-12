/** Tests the Inbox list: its tree semantics, the current row, the rows it draws of a long list, and what it asks for near the end. */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubElementSize } from "../../app/testing";
import { InboxList } from "./inbox-list";
import { buildInboxRowActions, buildInboxRowView, TEST_PLUGINS } from "./inbox-row.testing";

const buildRows = (count: number) =>
  Array.from({ length: count }, (_, index) => buildInboxRowView(`thing-${String(index)}`));

/** Renders the list over `count` rows. */
const renderList = (
  count: number,
  props: {
    readonly currentRef?: string | null;
    readonly selection?: ReadonlySet<string>;
    readonly onNearEnd?: () => void;
  } = {},
) => {
  const actions = buildInboxRowActions();
  const view = render(
    <InboxList
      listId="waits"
      label="Someone waits on me"
      rows={buildRows(count)}
      plugins={TEST_PLUGINS}
      currentRef={props.currentRef === undefined ? "thing-0" : props.currentRef}
      selection={props.selection ?? new Set()}
      actions={actions}
      onNearEnd={props.onNearEnd ?? (() => {})}
    />,
  );
  return { actions, ...view };
};

beforeEach(() => {
  // jsdom lays nothing out, so every element is 400 by 600: room for about eleven rows.
  stubElementSize(400, 600);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("InboxList", () => {
  it("is a tree named for the list, with several selectable rows", () => {
    renderList(3);
    const tree = screen.getByRole("tree", { name: "Someone waits on me" });
    expect(tree.getAttribute("aria-multiselectable")).toBe("true");
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
  });

  it("puts only the current row in the tab order and selects the rows of the selection", () => {
    renderList(3, { currentRef: "thing-1", selection: new Set(["thing-2"]) });
    const rows = screen.getAllByRole("treeitem");
    expect(rows.map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
    expect(rows.map((row) => row.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "true",
    ]);
  });

  it("draws no puck when no row is current", () => {
    const { container } = renderList(0, { currentRef: null });
    expect(container.querySelector(".ib-puck")?.hasAttribute("hidden")).toBe(true);
    expect(screen.queryAllByRole("treeitem")).toHaveLength(0);
  });

  it("draws a window of a long list, and the whole list's size in each row", () => {
    renderList(2000);
    const rows = screen.getAllByRole("treeitem");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    expect(rows[0]!.getAttribute("aria-setsize")).toBe("2000");
    expect(rows[0]!.getAttribute("aria-posinset")).toBe("1");
  });

  it("keeps the current row drawn when it is far from the view", () => {
    renderList(2000, { currentRef: "thing-1500" });
    expect(screen.getByRole("treeitem", { name: /thing-1500/ }).tabIndex).toBe(0);
  });

  it("asks for the next page when the rows drawn reach the end of the rows held", () => {
    const onNearEnd = vi.fn();
    renderList(5, { onNearEnd });
    expect(onNearEnd).toHaveBeenCalled();
  });

  it("does not ask for the next page while the end is far away", () => {
    const onNearEnd = vi.fn();
    renderList(2000, { onNearEnd });
    expect(onNearEnd).not.toHaveBeenCalled();
  });

  it("passes a row's clicks on with the row's reference", async () => {
    const user = userEvent.setup();
    const { actions } = renderList(3);
    await user.click(screen.getByRole("treeitem", { name: /thing-2/ }));
    expect(actions.calls).toEqual([["pick", "thing-2"]]);
  });

  it("moves the keyboard focus to the current row when a focus request comes", () => {
    const actions = buildInboxRowActions();
    const rows = buildRows(3);
    const draw = (focusRequest: number) => (
      <InboxList
        listId="waits"
        label="Someone waits on me"
        rows={rows}
        plugins={TEST_PLUGINS}
        currentRef="thing-1"
        selection={new Set()}
        actions={actions}
        focusRequest={focusRequest}
        onNearEnd={() => {}}
      />
    );
    const { rerender } = render(draw(0));
    expect(document.activeElement).toBe(document.body);
    rerender(draw(1));
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: /thing-1/ }));
  });
});
