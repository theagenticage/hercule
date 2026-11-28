/**
 * Tests the Filter button, its menu and the chips as the user meets them, for
 * a list of items that is not the Work board's: the counts of each value, the
 * menu of a facet with Back and a Find box, and Clear. jsdom has no popover
 * API, so a menu's rows are always in the page and the tests find them with
 * `hidden: true`.
 */
import { useState, type JSX } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  buildFilterChips,
  EMPTY_FILTER,
  type Filter,
  type FilterFacet,
} from "@hercule/client-core/desk";
import { FilterChips, FilterControl } from "./filter-control";

/** An item of the invented Northwind Market world: a shipment, in one depot, in one state. */
interface Shipment {
  readonly id: string;
  readonly state: "late" | "on-time";
  readonly depot: string;
}

const SHIPMENTS: readonly Shipment[] = [
  { id: "s1", state: "late", depot: "depot-1" },
  { id: "s2", state: "on-time", depot: "depot-1" },
  { id: "s3", state: "on-time", depot: "depot-2" },
];

const STATE_FACET: FilterFacet<Shipment> = {
  id: "state",
  caption: "",
  values: [
    { id: "late", name: "Late" },
    { id: "on-time", name: "On time" },
  ],
  hasValue: (shipment, valueId) => shipment.state === valueId,
};

/** Returns a facet of depots named "Depot 1" to "Depot `count`". */
const buildDepotFacet = (count: number): FilterFacet<Shipment> => ({
  id: "depot",
  caption: "Depot",
  values: Array.from({ length: count }, (_, index) => ({
    id: `depot-${index + 1}`,
    name: `Depot ${index + 1}`,
  })),
  hasValue: (shipment, valueId) => shipment.depot === valueId,
});

/** Draws the control and the chips over `items` with a filter it keeps itself. */
function Harness({
  depotCount = 2,
  items = SHIPMENTS,
  initialFilter = EMPTY_FILTER,
}: {
  readonly depotCount?: number;
  readonly items?: readonly Shipment[];
  readonly initialFilter?: Filter;
}): JSX.Element {
  const [filter, setFilter] = useState(initialFilter);
  const facets = [STATE_FACET, buildDepotFacet(depotCount)];
  return (
    <>
      <FilterControl
        facets={facets}
        filter={filter}
        items={items}
        marks={{ depot: <i data-testid="depot-mark" /> }}
        onFilterChange={setFilter}
      />
      <FilterChips
        chips={buildFilterChips(filter, facets)}
        filter={filter}
        onFilterChange={setFilter}
      />
    </>
  );
}

/** Returns the one row of a menu named `name`: a row that opens, or a checkbox. */
const getRow = (name: RegExp | string): HTMLElement => {
  const rows = (["menuitem", "menuitemcheckbox"] as const).flatMap((role) =>
    screen.queryAllByRole(role, { name, hidden: true }),
  );
  const [row] = rows;
  if (row === undefined || rows.length > 1) {
    throw new Error(`Expected one menu row named ${String(name)}, found ${rows.length}.`);
  }
  return row;
};

/** Returns the name of a row that ends in the number of items it would leave. */
const withCount = (name: string, count: number): RegExp => new RegExp(`^${name}\\s*${count}$`);

describe("FilterControl", () => {
  it("opens on the values of the facet with no caption, each with the count it would leave", () => {
    render(<Harness />);

    expect(getRow(withCount("Late", 1))).toBeTruthy();
    expect(getRow(withCount("On time", 2))).toBeTruthy();
    // The other facet is one row that opens, not a list of values.
    expect(getRow("Depot")).toBeTruthy();
    expect(screen.queryByRole("menuitemcheckbox", { name: /Depot 1/, hidden: true })).toBeNull();
  });

  it("shows a chosen value as a chip, and counts the values of other facets within it", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(getRow(withCount("Late", 1)));

    expect(screen.getByRole("button", { name: "Remove filter Late" })).toBeTruthy();
    expect(getRow(withCount("Late", 1)).getAttribute("aria-checked")).toBe("true");
    await user.click(getRow("Depot"));
    // Only the late shipment is left: it is in Depot 1, so Depot 2 adds nothing.
    expect(getRow(withCount("Depot 1", 1))).toBeTruthy();
    expect(getRow(withCount("Depot 2", 0))).toBeTruthy();
  });

  it("opens a facet's values in the same menu, and Back returns to the row that opened them", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(getRow("Depot"));
    await user.click(getRow(withCount("Depot 1", 2)));

    // A chosen value counts on its facet's row and shows as a chip with the facet's caption.
    expect(screen.getByRole("button", { name: "Remove filter Depot Depot 1" })).toBeTruthy();
    expect(screen.queryByRole("menuitemcheckbox", { name: /Late/, hidden: true })).toBeNull();
    await user.click(getRow("Depot"));
    expect(getRow(/Late/)).toBeTruthy();
    expect(document.activeElement).toBe(getRow(withCount("Depot", 1)));
  });

  it("puts the facet's mark in front of its row, and leaves the caption-less facet's values bare", () => {
    render(<Harness />);

    expect(getRow("Depot").querySelector('[data-testid="depot-mark"]')).not.toBeNull();
    expect(getRow(/^Late/).querySelector('[data-testid="depot-mark"]')).toBeNull();
  });

  it("puts a Find box over a facet that has more than seven values, and narrows the values by it", async () => {
    const user = userEvent.setup();
    render(<Harness depotCount={8} />);

    await user.click(getRow("Depot"));
    await user.type(
      screen.getByRole("textbox", { name: "Find in Depot", hidden: true }),
      "depot 3",
    );

    expect(getRow(/^Depot 3/)).toBeTruthy();
    expect(screen.queryByRole("menuitemcheckbox", { name: /Depot 4/, hidden: true })).toBeNull();
  });

  it("has no Find box over seven values or fewer", async () => {
    const user = userEvent.setup();
    render(<Harness depotCount={7} />);

    await user.click(getRow("Depot"));

    expect(screen.queryByRole("textbox", { name: "Find in Depot", hidden: true })).toBeNull();
  });
});

describe("FilterChips", () => {
  it("offers Clear from two chips, and Clear turns every filter off", async () => {
    const user = userEvent.setup();
    render(<Harness initialFilter={{ state: ["late", "on-time"] }} />);

    expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove filter Late" }));
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove filter On time" })).toBeTruthy();

    await user.click(getRow(withCount("Late", 1)));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("button", { name: /Remove filter/ })).toBeNull();
  });
});
