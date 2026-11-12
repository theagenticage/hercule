/**
 * Tests the Inbox's states: what each empty state says and calls, that its
 * heading takes the focus without a ring, the offline pill, the line for a
 * source that cannot be read, and the selection bar.
 */
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InboxEmpty, InboxFailingSource, InboxOfflinePill, InboxReadFailed } from "./inbox-states";
import { InboxSelectionBar } from "./inbox-selection-bar";

describe("InboxEmpty", () => {
  it("says all is clear when nothing is anywhere", () => {
    render(<InboxEmpty isRising={false} state={{ kind: "all-clear" }} />);

    expect(screen.getByRole("heading", { name: "All clear" })).toBeTruthy();
    expect(
      screen.getByText(
        "Nothing out there needs you. New things arrive here as your sources see them.",
      ),
    ).toBeTruthy();
  });

  it("tells how many things changed without asking, and opens Updates from its link", async () => {
    const onOpenUpdates = vi.fn();
    render(
      <InboxEmpty
        isRising={false}
        state={{ kind: "nobody-waits", updatesCount: 26, onOpenUpdates }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Nobody waits on you" })).toBeTruthy();
    expect(
      screen.getByText(/26 things changed without asking anything\. They are in/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Updates" }));
    expect(onOpenUpdates).toHaveBeenCalledOnce();
  });

  it("names one thing in the singular", () => {
    render(
      <InboxEmpty
        isRising={false}
        state={{ kind: "nobody-waits", updatesCount: 1, onOpenUpdates: vi.fn() }}
      />,
    );

    expect(screen.getByText(/^1 thing changed without asking anything\./)).toBeTruthy();
  });

  it("names the saved query that holds nothing", () => {
    render(
      <InboxEmpty isRising={false} state={{ kind: "nothing-in-list", title: "Review requests" }} />,
    );

    expect(screen.getByRole("heading", { name: "Nothing in Review requests" })).toBeTruthy();
    expect(screen.getByText("Nothing of yours here yet.")).toBeTruthy();
  });

  it("says what the search looked for and clears it from its button", async () => {
    const onClearSearch = vi.fn();
    render(
      <InboxEmpty
        isRising={false}
        state={{
          kind: "nothing-matches",
          scopeTitle: "Mine",
          tokens: ["team:payments"],
          text: "checkout",
          widerCount: 0,
          onSearchEverything: vi.fn(),
          onClearSearch,
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Nothing in Mine matches" })).toBeTruthy();
    expect(screen.getByText("team:payments").tagName).toBe("CODE");
    expect(screen.getByText(/No thing here has/).textContent).toBe(
      "No thing here has team:payments and “checkout”.",
    );
    await userEvent.click(screen.getByRole("button", { name: /Clear the search/ }));
    expect(onClearSearch).toHaveBeenCalledOnce();
  });

  it("offers to search Everything only when Everything finds something", async () => {
    const onSearchEverything = vi.fn();
    const search = {
      kind: "nothing-matches" as const,
      scopeTitle: "Mine",
      tokens: [],
      text: "kestrel",
      onSearchEverything,
      onClearSearch: vi.fn(),
    };
    const { rerender } = render(
      <InboxEmpty isRising={false} state={{ ...search, widerCount: 0 }} />,
    );

    expect(screen.queryByRole("button", { name: /Search Everything/ })).toBeNull();

    rerender(<InboxEmpty isRising={false} state={{ ...search, widerCount: 3 }} />);
    await userEvent.click(screen.getByRole("button", { name: /Search Everything · 3/ }));
    expect(onSearchEverything).toHaveBeenCalledOnce();
  });

  it("says what waits behind the new pill when the last row left, and takes it in from its button", async () => {
    const onShowNew = vi.fn();
    render(<InboxEmpty isRising={false} state={{ kind: "new-waiting", count: 2, onShowNew }} />);

    expect(screen.getByRole("heading", { name: "Nothing left here" })).toBeTruthy();
    expect(screen.getByText("2 new things arrived while you worked.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Show what is new/ }));
    expect(onShowNew).toHaveBeenCalledOnce();
  });

  it("draws the sunrise rising only when the user's own move emptied the list", () => {
    const { container, rerender } = render(<InboxEmpty isRising state={{ kind: "all-clear" }} />);
    expect(container.querySelector(".ib-em--rises")).not.toBeNull();

    rerender(<InboxEmpty isRising={false} state={{ kind: "all-clear" }} />);
    expect(container.querySelector(".ib-em--rises")).toBeNull();
  });

  it("lets the heading take the focus, and keeps it when the words change", () => {
    const headingRef = createRef<HTMLHeadingElement>();
    const { rerender } = render(
      <InboxEmpty
        isRising={false}
        state={{ kind: "nothing-in-list", title: "Mine" }}
        headingRef={headingRef}
      />,
    );

    headingRef.current?.focus();
    expect(document.activeElement).toBe(headingRef.current);

    rerender(
      <InboxEmpty
        isRising={false}
        state={{ kind: "nothing-in-list", title: "Updates" }}
        headingRef={headingRef}
      />,
    );
    expect(document.activeElement).toBe(headingRef.current);
    expect(headingRef.current?.textContent).toBe("Nothing in Updates");
  });
});

describe("InboxOfflinePill", () => {
  it("shows when the connection was lost, and the whole sentence in its tooltip", () => {
    render(<InboxOfflinePill sinceLabel="09:12" />);

    const pill = screen.getByRole("status");
    expect(pill.textContent).toBe("Offline · 09:12");
    expect(pill.getAttribute("title")).toMatch(/^Offline since 09:12\./);
    expect(pill.textContent).not.toMatch(/waiting/);
  });
});

describe("InboxFailingSource", () => {
  it("names the source and since when, and opens Connections", async () => {
    const onOpenConnections = vi.fn();
    render(
      <InboxFailingSource
        sourceName="GitHub"
        sinceLabel="08:40"
        onOpenConnections={onOpenConnections}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "GitHub can’t be read since 08:40. Its things show what it said then.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Connections" }));
    expect(onOpenConnections).toHaveBeenCalledOnce();
  });
});

describe("InboxSelectionBar", () => {
  it("counts the selection and clears it", async () => {
    const onClear = vi.fn();
    render(<InboxSelectionBar count={3} onClear={onClear} />);

    expect(screen.getByRole("group", { name: "Selection" }).textContent).toBe("3 selected");
    await userEvent.click(screen.getByRole("button", { name: "Clear the selection" }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("takes neither the pointer nor the focus with nothing selected, and keeps its last count while it leaves", () => {
    const { rerender } = render(<InboxSelectionBar count={2} onClear={vi.fn()} />);

    rerender(<InboxSelectionBar count={0} onClear={vi.fn()} />);

    const bar = document.querySelector(".ib-selbar");
    expect(bar?.hasAttribute("inert")).toBe(true);
    expect(bar?.textContent).toBe("2 selected");
  });
});

describe("InboxReadFailed", () => {
  it("says why the read failed and reads again from Try again", async () => {
    const onTryAgain = vi.fn();
    render(<InboxReadFailed reason="The controller did not answer." onTryAgain={onTryAgain} />);

    expect(screen.getByRole("alert").textContent).toContain("The Inbox could not be read");
    expect(screen.getByText("The controller did not answer.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onTryAgain).toHaveBeenCalledTimes(1);
  });
});
