/** Tests the pane of a selection: the count in its title, its member rows, and the one move it offers. */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InboxSelectionHead, InboxSelectionPane } from "./inbox-selection-pane";
import { TEST_PLUGINS } from "./inbox-row.testing";
import type { InboxRowView } from "@hercule/client-core/inbox";

const member = (ref: string, title: string): InboxRowView => ({
  ref,
  title,
  pluginId: "github",
  time: { kind: "none" },
  reason: { who: "Mei", rest: "asked for your review", more: 0, quiet: false },
  identifier: `#${ref}`,
  label: `${title}. Mei asked for your review`,
  handOff: null,
  held: false,
});

const renderPane = (count: number) => {
  const onWalk = vi.fn();
  const onDismiss = vi.fn();
  const members = Array.from({ length: count }, (_, index) =>
    member(String(index + 1), `Thing ${String(index + 1)}`),
  );
  render(
    <InboxSelectionPane
      members={members}
      plugins={TEST_PLUGINS}
      onWalk={onWalk}
      onDismiss={onDismiss}
    />,
  );
  return { onWalk, onDismiss };
};

describe("InboxSelectionPane", () => {
  it("counts the selection in its title and names Dismiss for all of it", async () => {
    const { onDismiss } = renderPane(3);
    expect(screen.getByRole("heading", { name: "3 things selected" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss all 3" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("offers Dismiss only", () => {
    renderPane(2);
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getAllByRole("button")).toHaveLength(1);
  });

  it("writes one thing in the singular", () => {
    renderPane(1);
    expect(screen.getByRole("heading", { name: "1 thing selected" })).toBeTruthy();
  });

  it("walks to a member when its row is pressed", async () => {
    const { onWalk } = renderPane(2);
    await userEvent.click(screen.getByRole("button", { name: /Thing 2/ }));
    expect(onWalk).toHaveBeenCalledWith("2");
  });

  it("names the sources of the selection in its head", () => {
    render(<InboxSelectionHead sourceNames={["GitHub", "Linear"]} />);
    expect(screen.getByText("Selected · GitHub, Linear")).toBeTruthy();
  });
});
