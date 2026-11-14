/** Tests the pane's footer: which moves it offers, the hand-off's name, and what each press calls. */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InboxPaneFooter } from "./inbox-pane-footer";

const renderFooter = (props: Partial<Parameters<typeof InboxPaneFooter>[0]> = {}) => {
  const calls = {
    onStartThread: vi.fn(),
    onTakeOn: vi.fn(),
    onHandOff: vi.fn(),
    onLink: vi.fn(),
    onDismiss: vi.fn(),
  };
  render(
    <InboxPaneFooter
      isOnTask={false}
      handOff={{ kind: "one", name: "Review PR", faceSeed: "review-pr" }}
      isHandMenuOpen={false}
      {...calls}
      {...props}
    />,
  );
  return calls;
};

describe("InboxPaneFooter", () => {
  it("offers Thread, Take on, the hand-off, Link and Dismiss", async () => {
    const calls = renderFooter();
    await userEvent.click(screen.getByRole("button", { name: "Start a thread" }));
    await userEvent.click(screen.getByRole("button", { name: "Take on" }));
    await userEvent.click(screen.getByRole("button", { name: "Hand to Review PR" }));
    await userEvent.click(screen.getByRole("button", { name: "Link to another thing" }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(calls.onStartThread).toHaveBeenCalledOnce();
    expect(calls.onTakeOn).toHaveBeenCalledOnce();
    expect(calls.onHandOff).toHaveBeenCalledOnce();
    expect(calls.onLink).toHaveBeenCalledOnce();
    expect(calls.onDismiss).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("button")).toHaveLength(5);
  });

  it("leaves Thread and Take on out for a thing on a Task, since each would make a new Task", () => {
    renderFooter({ isOnTask: true });
    expect(screen.queryByRole("button", { name: "Start a thread" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Take on" })).toBeNull();
    expect(screen.getByRole("button", { name: "Hand to Review PR" })).toBeTruthy();
  });

  it("names the one workflow in full and opens no menu", () => {
    renderFooter();
    const hand = screen.getByRole("button", { name: "Hand to Review PR" });
    expect(hand.getAttribute("aria-haspopup")).toBeNull();
    expect(hand.textContent).toContain("Review PR");
  });

  it("says Hand to… for several workflows and tells whether its menu is open", () => {
    renderFooter({
      handOff: { kind: "several", faceSeeds: ["a", "b", "c", "d"] },
      isHandMenuOpen: true,
    });
    const hand = screen.getByRole("button", { name: "Hand to…" });
    expect(hand.getAttribute("aria-haspopup")).toBe("menu");
    expect(hand.getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves the hand-off out when no workflow takes the thing", () => {
    renderFooter({ handOff: null });
    expect(screen.queryByRole("button", { name: /Hand to/ })).toBeNull();
  });

  it("keeps each move's key in its tooltip", () => {
    renderFooter();
    expect(screen.getByRole("button", { name: "Take on" }).title).toBe("Take on (T)");
    expect(screen.getByRole("button", { name: "Hand to Review PR" }).title).toBe(
      "Hand to Review PR (H)",
    );
    expect(screen.getByRole("button", { name: "Dismiss" }).title).toBe("Dismiss (E)");
  });
});
