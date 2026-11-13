/** Tests the pane of a group: its members, its linked pairs with Unlink, its footer and its head. */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { InboxGroupPaneView } from "@hercule/client-core/inbox";
import { InboxGroupHead, InboxGroupPane } from "./inbox-group-pane";
import { TEST_PLUGINS } from "./inbox-row.testing";

const VIEW: InboxGroupPaneView = {
  title: "Show the delivery cost before the payment step",
  waiting: "2 of them wait on you",
  members: [
    {
      ref: "github:pull:6244",
      pluginId: "github",
      title: "Show the delivery cost on the payment step",
      identifier: "#6244",
      why: { who: "Omar", rest: "mentioned you", more: 1, quiet: false },
      label: "Show the delivery cost on the payment step. Omar mentioned you",
    },
    {
      ref: "github:issue:9",
      pluginId: "github",
      title: "Cache the cost",
      why: { rest: "Issue", more: 0, quiet: true },
      label: "Cache the cost. Issue",
    },
  ],
  pairs: [
    {
      fromRef: "github:pull:6244",
      toRef: "github:issue:9",
      from: { pluginId: "github", name: "#6244", isIdentifier: true },
      to: { pluginId: "github", name: "Cache the cost", isIdentifier: false },
      claim: "You linked these",
      canUnlink: true,
    },
    {
      fromRef: "github:pull:6244",
      toRef: "github:issue:10",
      from: { pluginId: "github", name: "#6244", isIdentifier: true },
      to: { pluginId: "github", name: "#10", isIdentifier: true },
      claim: "GitHub reports this",
      canUnlink: false,
    },
  ],
  isCut: false,
};

const renderPane = (view: InboxGroupPaneView = VIEW) => {
  const calls = {
    onWalkTo: vi.fn(),
    onUnlink: vi.fn(),
    onTakeOn: vi.fn(),
    onLink: vi.fn(),
    onDismiss: vi.fn(),
  };
  render(<InboxGroupPane view={view} plugins={TEST_PLUGINS} {...calls} />);
  return calls;
};

describe("InboxGroupPane", () => {
  it("draws the title and how many members wait", () => {
    renderPane();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(VIEW.title);
    expect(screen.getByText("2 of them wait on you")).toBeTruthy();
  });

  it("walks to a member when its entry is pressed", async () => {
    const calls = renderPane();
    await userEvent.click(screen.getByRole("button", { name: "Cache the cost. Issue" }));
    expect(calls.onWalkTo).toHaveBeenCalledWith("github:issue:9");
  });

  it("draws a member's ask with the asker set apart and the count of its other asks", () => {
    renderPane();
    const entry = screen.getByRole("button", { name: /Omar mentioned you/ });
    expect(within(entry).getByText("Omar").tagName).toBe("B");
    expect(within(entry).getByText("+1")).toBeTruthy();
  });

  it("offers Unlink only on a pair the user claims, and calls it with both ends", async () => {
    const calls = renderPane();
    expect(screen.getAllByRole("button", { name: /^Unlink/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Unlink #6244 and Cache the cost" }));
    expect(calls.onUnlink).toHaveBeenCalledWith("github:pull:6244", "github:issue:9");
    expect(screen.getByText("GitHub reports this")).toBeTruthy();
  });

  it("says the list was cut only when the read was", () => {
    renderPane();
    expect(screen.queryByText(/so the list is cut/)).toBeNull();
    cleanup();
    renderPane({ ...VIEW, isCut: true });
    expect(screen.getByText(/so the list is cut/)).toBeTruthy();
  });

  it("has Take on, Link and Dismiss all, and no hand-off", async () => {
    const calls = renderPane();
    await userEvent.click(screen.getByRole("button", { name: "Take on" }));
    await userEvent.click(screen.getByRole("button", { name: "Link another thing" }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss all 2" }));
    expect(calls.onTakeOn).toHaveBeenCalledOnce();
    expect(calls.onLink).toHaveBeenCalledOnce();
    expect(calls.onDismiss).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /Hand to/ })).toBeNull();
  });
});

describe("InboxGroupHead", () => {
  it("draws the words", () => {
    render(<InboxGroupHead words="Linked · 2 things in GitHub" />);
    expect(screen.getByText("Linked · 2 things in GitHub")).toBeTruthy();
  });
});
