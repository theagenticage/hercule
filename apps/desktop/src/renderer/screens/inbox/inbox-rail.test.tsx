/** Tests the Inbox's rail through what the user does: Tab, the arrows, folding, picking, pinning. */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  InboxScopeValue,
  RailFacet,
  RailFacetValue,
  RailSource,
} from "@hercule/client-core/inbox";
import { InboxRail, type InboxRailProps } from "./inbox-rail";

const VALUES: ReadonlyArray<RailFacetValue> = Array.from({ length: 8 }, (_, index) => ({
  value: `team-${String(index + 1)}`,
  label: `Team ${String(index + 1)}`,
  count: index === 7 ? 0 : index + 1,
}));

const TEAMS: RailFacet = { key: "team", plural: "Teams", values: VALUES, more: 0 };

const LINEAR: RailSource = {
  source: "linear",
  name: "Linear",
  count: 9,
  folded: false,
  accounts: [],
  facets: [TEAMS],
};

/** Returns the value at `index`, which the fixtures above always have. */
const valueAt = (index: number): RailFacetValue => VALUES[index] as RailFacetValue;

/** Renders the rail with one source, and returns what it called. */
const renderRail = (overrides: Partial<InboxRailProps> = {}) => {
  const callbacks = {
    onPick: vi.fn<InboxRailProps["onPick"]>(),
    onToggleFold: vi.fn<InboxRailProps["onToggleFold"]>(),
    onTogglePin: vi.fn<InboxRailProps["onTogglePin"]>(),
    onSearchMore: vi.fn<InboxRailProps["onSearchMore"]>(),
  };
  render(
    <InboxRail
      savedQueries={[
        { id: "waits", name: "Someone waits on me", count: 19, icon: "clock", shortcut: "1" },
        { id: "mine", name: "Mine", count: 0, icon: "user", shortcut: "2" },
      ]}
      pins={[]}
      sources={[LINEAR]}
      plugins={[]}
      current={{ kind: "saved-query", id: "mine" }}
      loading={false}
      {...callbacks}
      {...overrides}
    />,
  );
  return callbacks;
};

const countTabStops = (): number =>
  screen.getAllByRole("button", { hidden: true }).filter((button) => button.tabIndex === 0).length;

describe("InboxRail", () => {
  it("is one Tab stop, taken by the current entry", async () => {
    renderRail();
    expect(countTabStops()).toBe(1);
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Mine/ }));
    await userEvent.tab();
    expect(document.activeElement).toBe(document.body);
  });

  it("moves with the arrows, Home and End, and the tab stop follows", async () => {
    renderRail();
    await userEvent.tab();
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /^Someone waits on me/ }),
    );
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Linear/ }));
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "2 more" }));
    await userEvent.keyboard("{Home}");
    const first = screen.getByRole("button", { name: /^Someone waits on me/ });
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute("tabindex")).toBe("0");
    expect(countTabStops()).toBe(1);
  });

  it("picks with Enter and with a click", async () => {
    const { onPick } = renderRail();
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenLastCalledWith({ kind: "saved-query", id: "mine" });
    await userEvent.click(screen.getByRole("button", { name: /^Team 2/ }));
    expect(onPick).toHaveBeenLastCalledWith({
      kind: "value",
      value: { source: "linear", key: "team", value: "team-2" },
    });
  });

  it("draws nothing as current while searching, and keeps one Tab stop", () => {
    renderRail({ current: null });
    expect(document.querySelector("[aria-current]")).toBeNull();
    expect(countTabStops()).toBe(1);
  });

  it("folds an unfolded source with the left arrow, and ignores the right arrow", async () => {
    const { onToggleFold } = renderRail();
    screen.getByRole("button", { name: /^Linear/ }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onToggleFold).not.toHaveBeenCalled();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onToggleFold).toHaveBeenCalledWith("linear");
  });

  it("unfolds a folded source with the right arrow and shows no facets", async () => {
    const { onToggleFold } = renderRail({ sources: [{ ...LINEAR, folded: true, facets: [] }] });
    const fold = screen.getByRole("button", { name: /^Linear/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fold.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onToggleFold).toHaveBeenCalledWith("linear");
    expect(screen.queryByText("Teams")).toBeNull();
  });

  it("pins a value with its star and with P", async () => {
    const { onTogglePin } = renderRail();
    const team1: InboxScopeValue = { source: "linear", key: "team", value: "team-1" };
    await userEvent.click(screen.getByRole("button", { name: "Pin Team 1" }));
    expect(onTogglePin).toHaveBeenLastCalledWith(team1);
    screen.getByRole("button", { name: /^Team 3/ }).focus();
    await userEvent.keyboard("p");
    expect(onTogglePin).toHaveBeenLastCalledWith({ ...team1, value: "team-3" });
  });

  it("does nothing on other single keys", async () => {
    const callbacks = renderRail();
    screen.getByRole("button", { name: /^Team 3/ }).focus();
    await userEvent.keyboard("1jx/e");
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
  });

  it("lists pins, with the account only when given one, and unpins them by their star", async () => {
    const pin = { source: "linear", key: "team", value: "team-1", label: "Checkout", count: 4 };
    const { onTogglePin } = renderRail({
      pins: [pin, { ...pin, value: "team-2", label: "Payments", accountLabel: "northwind" }],
    });
    expect(screen.getByText("Pinned")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Checkout/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Payments · northwind/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Unpin Checkout" }));
    expect(onTogglePin).toHaveBeenCalledWith(expect.objectContaining({ value: "team-1" }));
  });

  it("shows six values, then N more, then Show fewer", async () => {
    renderRail();
    expect(screen.queryByRole("button", { name: /^Team 7/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "2 more" }));
    expect(screen.getByRole("button", { name: /^Team 7/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.queryByRole("button", { name: /^Team 7/ })).toBeNull();
  });

  it("offers the search for values past the ones sent, once all the sent ones are shown", async () => {
    const { onSearchMore } = renderRail({
      sources: [{ ...LINEAR, facets: [{ ...TEAMS, more: 340 }] }],
    });
    expect(screen.queryByRole("button", { name: /Search the other/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "2 more" }));
    await userEvent.click(screen.getByRole("button", { name: "Search the other 340" }));
    expect(onSearchMore).toHaveBeenCalledWith({ source: "linear", key: "team" });
  });

  it("marks a value with nothing of yours as faint, with no count", () => {
    renderRail({ sources: [{ ...LINEAR, facets: [{ ...TEAMS, values: [valueAt(7)] }] }] });
    const row = screen.getByRole("button", { name: "Team 8" });
    expect(row.getAttribute("title")).toBe("Nothing of yours here yet");
    expect(row.textContent).toBe("Team 8");
  });

  it("draws a count only when there is something to count", () => {
    renderRail({
      savedQueries: [
        { id: "waits", name: "Someone waits on me", count: 19, icon: "clock" },
        { id: "mine", name: "Mine", count: 0, icon: "user" },
      ],
    });
    expect(screen.getByRole("button", { name: /^Mine/ }).textContent).toBe("Mine");
    expect(screen.getByRole("button", { name: /^Someone waits on me/ }).textContent).toContain(
      "19",
    );
  });

  it("draws no counts while loading", () => {
    renderRail({ loading: true });
    expect(screen.getByRole("button", { name: /^Someone waits on me/ }).textContent).not.toContain(
      "19",
    );
  });

  it("lists accounts, each with its own facets, when several hold things", () => {
    renderRail({
      sources: [
        {
          ...LINEAR,
          accounts: [
            { connectionId: "c1", label: "northwind", count: 5 },
            { connectionId: "c2", label: "labs", count: 2 },
          ],
          facets: [
            { ...TEAMS, connectionId: "c1", values: [valueAt(0)] },
            { ...TEAMS, connectionId: "c2", values: [valueAt(1)] },
          ],
        },
      ],
    });
    expect(screen.getByText("northwind")).toBeTruthy();
    const labs = screen.getByText("labs").closest("div") as HTMLElement;
    expect(within(labs).getByRole("button", { name: /^Team 2/ })).toBeTruthy();
    expect(within(labs).queryByRole("button", { name: /^Team 1/ })).toBeNull();
  });

  it("lists no account level for one account", () => {
    renderRail({
      sources: [{ ...LINEAR, accounts: [{ connectionId: "c1", label: "northwind", count: 9 }] }],
    });
    expect(screen.queryByText("northwind")).toBeNull();
  });

  it("says when a source cannot be read", () => {
    renderRail({ sources: [{ ...LINEAR, failingChangedAt: "08:40" }] });
    expect(screen.getByRole("img", { name: "Can't be read; last changed 08:40" })).toBeTruthy();
  });

  it("names a project's health in words", () => {
    renderRail({
      sources: [
        { ...LINEAR, facets: [{ ...TEAMS, values: [{ ...valueAt(0), health: "at-risk" }] }] },
      ],
    });
    expect(screen.getByRole("img", { name: "At risk" })).toBeTruthy();
  });

  it("draws the Browse heading only when some source has things", () => {
    renderRail({ sources: [{ ...LINEAR, count: 0, facets: [] }] });
    expect(screen.queryByText("Browse")).toBeNull();
  });
});
