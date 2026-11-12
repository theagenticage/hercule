/** Tests the Inbox list's head: what the list is, its count, the order or the "N new" pill, and Narrow. */
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InboxListHead } from "./inbox-list-head";
import { TEST_PLUGINS } from "./inbox-row.testing";

const renderHead = (props: Partial<Parameters<typeof InboxListHead>[0]> = {}) => {
  const onShowNew = vi.fn();
  const onNarrow = vi.fn();
  const narrowRef = createRef<HTMLButtonElement>();
  render(
    <InboxListHead
      title="Someone waits on me"
      plugins={TEST_PLUGINS}
      count={19}
      orderWords="Longest waiting first"
      newCount={0}
      empty={false}
      narrowOpen={false}
      narrowRef={narrowRef}
      onShowNew={onShowNew}
      onNarrow={onNarrow}
      {...props}
    />,
  );
  return { onShowNew, onNarrow, narrowRef };
};

describe("InboxListHead", () => {
  it("says what the list is, how many things it holds, and the order in words", () => {
    renderHead({ count: 1204 });
    expect(screen.getByRole("heading", { name: "Someone waits on me" })).toBeTruthy();
    expect(screen.getByText("1,204")).toBeTruthy();
    expect(screen.getByText("Longest waiting first")).toBeTruthy();
  });

  it("names the account beside a Browse value's title", () => {
    renderHead({ title: "Checkout revamp", mark: "github", account: "northwind" });
    expect(screen.getByText("northwind")).toBeTruthy();
  });

  it("puts the N new pill in the place of the order words", () => {
    renderHead({ newCount: 3 });
    expect(screen.queryByText("Longest waiting first")).toBeNull();
    expect(screen.getByRole("button", { name: /3 new/ })).toBeTruthy();
  });

  it("calls back when the pill is pressed, and names its key", async () => {
    const user = userEvent.setup();
    const { onShowNew } = renderHead({ newCount: 3 });
    const pill = screen.getByRole("button", { name: /3 new/ });
    expect(pill.getAttribute("title")).toBe("Show what is new (.)");
    await user.click(pill);
    expect(onShowNew).toHaveBeenCalledTimes(1);
  });

  it("calls back when Narrow is pressed, and tells whether its menu is open", async () => {
    const user = userEvent.setup();
    const { onNarrow } = renderHead({ narrowOpen: true });
    const narrow = screen.getByRole("button", { name: "Narrow" });
    expect(narrow.getAttribute("aria-expanded")).toBe("true");
    await user.click(narrow);
    expect(onNarrow).toHaveBeenCalledTimes(1);
  });

  it("gives the Narrow button to the ref the menu anchors to", () => {
    const { narrowRef } = renderHead();
    expect(narrowRef.current).toBe(screen.getByRole("button", { name: "Narrow" }));
  });

  it("hides the order, the pill and Narrow for an empty list", () => {
    renderHead({ empty: true, newCount: 3 });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Longest waiting first")).toBeNull();
    expect(screen.getByRole("heading", { name: "Someone waits on me" })).toBeTruthy();
  });
});
