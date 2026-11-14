/** Tests what a row of the Inbox list draws in each slot, and what its buttons and tick call back with. */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { InboxRowView } from "@hercule/client-core/inbox";
import { InboxRow } from "./inbox-row";
import { buildInboxRowActions, buildInboxRowView, TEST_PLUGINS } from "./inbox-row.testing";

/** Renders one row among five, current or selected as asked, and returns what it called back. */
const renderRow = (
  overrides: Partial<InboxRowView> = {},
  state: { readonly current?: boolean; readonly selected?: boolean } = {},
) => {
  const actions = buildInboxRowActions();
  render(
    <InboxRow
      view={buildInboxRowView("a", overrides)}
      plugins={TEST_PLUGINS}
      position={2}
      size={5}
      current={state.current ?? false}
      selected={state.selected ?? false}
      actions={actions}
    />,
  );
  return { actions, row: screen.getByRole("treeitem") };
};

describe("InboxRow", () => {
  it("says the title, the sentence with the person apart, the wait, and where the thing lives", () => {
    const { row } = renderRow();
    expect(within(row).getByText("Title of a")).toBeTruthy();
    expect(within(row).getByText("Mei").tagName).toBe("B");
    expect(row.textContent).toContain("Mei asked for your review");
    expect(within(row).getByText("5d").getAttribute("title")).toBe("Waiting 5 days, overdue");
    expect(within(row).getByText("storefront-web")).toBeTruthy();
    expect(within(row).getByText("#6244")).toBeTruthy();
  });

  it("draws each wait tone as a class its stylesheet turns into ink and weight", () => {
    for (const tone of ["fresh", "recent", "due", "over"] as const) {
      const { unmount } = render(
        <InboxRow
          view={buildInboxRowView("a", {
            time: { kind: "wait", text: "1h", tone, words: "Waiting" },
          })}
          plugins={TEST_PLUGINS}
          position={1}
          size={1}
          current={false}
          selected={false}
          actions={null}
        />,
      );
      expect(screen.getByText("1h").className).toContain(`ib-wait--${tone}`);
      unmount();
    }
  });

  it("draws the face of the workflow running on the thing's Task in the wait's place", () => {
    const { row } = renderRow({
      time: { kind: "task", faceSeed: "review", words: "Review PR running" },
    });
    expect(within(row).queryByText("5d")).toBeNull();
    expect(row.querySelector('[title="Review PR running"] svg')).not.toBeNull();
  });

  it("draws the Task mark when nothing runs on the thing's Task", () => {
    const { row } = renderRow({
      time: { kind: "task", faceSeed: undefined, words: "On the Task “Fix it”" },
    });
    const mark = row.querySelector('[title="On the Task “Fix it”"]');
    expect(mark?.classList.contains("ib-row-time--task")).toBe(true);
    expect(mark?.querySelector("svg")).not.toBeNull();
  });

  it("draws the +n chip for more asks, the aside after the sentence, and nothing when there are none", () => {
    const { row } = renderRow({
      reason: {
        who: "Tomás",
        rest: "mentioned you",
        more: 1,
        aside: "Review PR has the rest",
        quiet: false,
      },
    });
    expect(within(row).getByText("+1")).toBeTruthy();
    expect(row.textContent).toContain("· Review PR has the rest");
  });

  it("keeps the place out when the row leaves it to the pane, and the identifier stays", () => {
    const { row } = renderRow({ place: undefined });
    expect(within(row).queryByText("storefront-web")).toBeNull();
    expect(within(row).getByText("#6244")).toBeTruthy();
  });

  it("marks a row that asks nothing as quiet", () => {
    const { row } = renderRow({ reason: { rest: "Open · 4 comments", more: 0, quiet: true } });
    expect(row.className).toContain("is-quiet");
  });

  it("is a tree item at level 1 with its place, its whole name, and a tab stop only when current", () => {
    const { row } = renderRow({}, { current: true, selected: true });
    expect(row.getAttribute("aria-level")).toBe("1");
    expect(row.getAttribute("aria-posinset")).toBe("2");
    expect(row.getAttribute("aria-setsize")).toBe("5");
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.getAttribute("aria-label")).toBe("Title of a. Mei asked for your review");
    expect(row.tabIndex).toBe(0);
  });

  it("takes no tab stop and is not selected when it is neither current nor picked", () => {
    const { row } = renderRow();
    expect(row.tabIndex).toBe(-1);
    expect(row.getAttribute("aria-selected")).toBe("false");
  });

  it("calls back with its reference when it is clicked, and with the modifiers held", async () => {
    const user = userEvent.setup();
    const { actions, row } = renderRow();
    await user.click(row);
    await user.keyboard("{Shift>}");
    await user.click(row);
    expect(actions.calls).toEqual([
      ["pick", "a"],
      ["pick-shift", "a"],
    ]);
  });

  it("toggles its selection from the tick, without making the row current", async () => {
    const user = userEvent.setup();
    const { actions } = renderRow();
    await user.click(screen.getByRole("button", { name: "Select" }));
    expect(actions.calls).toEqual([["toggle", "a"]]);
  });

  it("offers Unselect on the tick of a selected row", () => {
    renderRow({}, { selected: true });
    expect(screen.getByRole("button", { name: "Unselect" })).toBeTruthy();
  });

  it("offers Start a thread, Take on, the hand-off and Dismiss, each naming its key, and calls back with its reference", async () => {
    const user = userEvent.setup();
    const { actions } = renderRow({
      handOff: { kind: "one", name: "Agent review", faceSeed: "agent-review" },
    });
    expect(screen.getByTitle("Start a thread (N)")).toBeTruthy();
    expect(screen.getByTitle("Take on (T)")).toBeTruthy();
    expect(screen.getByTitle("Hand to Agent review (H)")).toBeTruthy();
    expect(screen.getByTitle("Dismiss (E)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Start a thread" }));
    await user.click(screen.getByRole("button", { name: "Take on" }));
    await user.click(screen.getByRole("button", { name: "Hand to Agent review" }));
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(actions.calls).toEqual([
      ["start", "a"],
      ["take", "a"],
      ["hand", "a"],
      ["dismiss", "a"],
    ]);
  });

  it("always shows the workflow's name beside its face on the hand-off button", () => {
    renderRow({ handOff: { kind: "one", name: "Agent review", faceSeed: "agent-review" } });
    const button = screen.getByRole("button", { name: "Hand to Agent review" });
    expect(button.textContent).toBe("Agent review");
    expect(button.querySelectorAll("svg")).toHaveLength(1);
  });

  it("shows the first three faces and Hand to… when several workflows take the thing", () => {
    renderRow({
      handOff: { kind: "several", faceSeeds: ["a", "b", "c", "d"] },
    });
    const button = screen.getByRole("button", { name: "Hand to…" });
    expect(button.textContent).toBe("Hand to…");
    expect(button.querySelectorAll("svg")).toHaveLength(3);
  });

  it("offers no hand-off when no workflow takes the thing", () => {
    renderRow();
    expect(screen.queryByRole("button", { name: /Hand to/ })).toBeNull();
  });

  it("offers View task and Dismiss, and no Start a thread, Take on or hand-off, for a thing on a Task", async () => {
    const user = userEvent.setup();
    const { actions } = renderRow({
      isOnTask: true,
      handOff: { kind: "one", name: "Agent review", faceSeed: "agent-review" },
    });
    expect(screen.queryByRole("button", { name: "Start a thread" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Take on" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Hand to/ })).toBeNull();
    expect(screen.getByTitle("View task (G)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "View task" }));
    expect(actions.calls).toEqual([["goto", "a"]]);
  });

  it("draws an inert copy with no buttons and no tick when it has no actions", () => {
    render(
      <InboxRow
        view={buildInboxRowView("a")}
        plugins={TEST_PLUGINS}
        position={1}
        size={1}
        current={false}
        selected={false}
        actions={null}
      />,
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
