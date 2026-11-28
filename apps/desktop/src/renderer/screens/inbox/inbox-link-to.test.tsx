/** Tests "Link to...": its combobox wiring, its keys, what it picks, and where the focus goes when it closes. */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InboxLinkTo, type InboxLinkToResult } from "./inbox-link-to";

const RESULTS: readonly InboxLinkToResult[] = [
  { ref: "linear:issue:1", identifier: "SHOP-150", title: "Slot cache", source: "linear" },
  { ref: "github:pr:2", identifier: "#6251", title: "Order schema", source: "github" },
  { ref: "slack:thread:3", identifier: "T-3", title: "Who owns the alert", source: "slack" },
];

/** Renders the popover over a row that has the focus, and returns what it called. */
const renderLinkTo = (
  options: { results?: readonly InboxLinkToResult[]; highlighted?: number } = {},
) => {
  const calls = {
    onQueryChange: vi.fn<(query: string) => void>(),
    onHighlightChange: vi.fn<(index: number) => void>(),
    onPick: vi.fn<(ref: string) => void>(),
    onClose: vi.fn<() => void>(),
  };
  const row = document.createElement("div");
  row.tabIndex = 0;
  document.body.append(row);
  row.focus();
  const view = render(
    <InboxLinkTo
      anchor={row}
      fromLabel="#6213"
      query=""
      results={options.results ?? RESULTS}
      highlighted={options.highlighted ?? 0}
      plugins={[]}
      {...calls}
    />,
  );
  return { ...calls, row, view };
};

describe("InboxLinkTo", () => {
  it("is a combobox over a listbox, with the highlighted result selected and active", () => {
    renderLinkTo({ highlighted: 1 });
    const field = screen.getByRole("combobox", {
      name: "Search for a thing to link #6213 to",
      hidden: true,
    });
    expect(field.getAttribute("aria-expanded")).toBe("true");
    expect(field.getAttribute("placeholder")).toBe("Link #6213 to…");
    expect(document.activeElement).toBe(field);
    const options = screen.getAllByRole("option", { hidden: true });
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(field.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    expect(options[0]?.querySelector(".link-to-title")?.textContent).toBe("Slot cache");
    expect(options[0]?.querySelector(".link-to-id")?.textContent).toBe("SHOP-150");
  });

  it("speaks the result count through the live region", () => {
    const { view } = renderLinkTo();
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe("3 things to link to.");
    view.rerender(
      <InboxLinkTo
        anchor={document.body}
        fromLabel="#6213"
        query="zzz"
        results={[]}
        highlighted={0}
        plugins={[]}
        onQueryChange={vi.fn()}
        onHighlightChange={vi.fn()}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe("Nothing matches.");
    expect(
      screen.getByRole("combobox", { hidden: true }).hasAttribute("aria-activedescendant"),
    ).toBe(false);
  });

  it("reports typed text", async () => {
    const { onQueryChange } = renderLinkTo();
    await userEvent.keyboard("s");
    expect(onQueryChange).toHaveBeenCalledWith("s");
  });

  it("moves the highlight with the arrow keys, wrapping at both ends", async () => {
    const { onHighlightChange } = renderLinkTo({ highlighted: 2 });
    await userEvent.keyboard("{ArrowDown}");
    expect(onHighlightChange).toHaveBeenLastCalledWith(0);
    await userEvent.keyboard("{ArrowUp}");
    expect(onHighlightChange).toHaveBeenLastCalledWith(1);
  });

  it("picks the highlighted result with Return, and the clicked one with a click", async () => {
    const { onPick } = renderLinkTo({ highlighted: 1 });
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenLastCalledWith("github:pr:2");
    await userEvent.click(screen.getAllByRole("option", { hidden: true })[2] as HTMLElement);
    expect(onPick).toHaveBeenLastCalledWith("slack:thread:3");
  });

  it("picks nothing on Return when nothing is found", async () => {
    const { onPick } = renderLinkTo({ results: [] });
    await userEvent.keyboard("{Enter}");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("closes on Esc, and gives the focus back to the row it opened from", async () => {
    const { onClose, row, view } = renderLinkTo();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    view.unmount();
    expect(document.activeElement).toBe(row);
  });

  it("keeps the keys it handles from reaching the page", async () => {
    const { row } = renderLinkTo();
    const reached = vi.fn();
    document.body.addEventListener("keydown", reached);
    await userEvent.keyboard("{ArrowDown}{Escape}");
    document.body.removeEventListener("keydown", reached);
    expect(reached).not.toHaveBeenCalled();
    row.remove();
  });
});
