/**
 * Tests the relation rows as the user meets them, for an invented purchase
 * order of the Quayside plugin: what a place says about itself, the progress
 * words only when the source gives them, the locked row with no title, and who
 * claims a link, which assistive technology reads on a row's button.
 */
import type { EntityPlace } from "@hercule/contract";
import { buildPlaceRow } from "@hercule/client-core/desk";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RelationRow, RelationRows } from "./relation-rows";

const PLUGINS = [{ id: "quayside", displayName: "Quayside" }];

const place = (overrides: Partial<EntityPlace> = {}): EntityPlace => ({
  ref: "quayside:site:rotterdam",
  kind: "quayside/site",
  noun: "Site",
  title: "Rotterdam depot",
  restricted: false,
  ...overrides,
});

describe("RelationRow", () => {
  it("says the place's kind, status and target date beside its title", () => {
    const row = buildPlaceRow(
      place({
        status: { shape: "half", tone: "attention", label: "At risk" },
        targetDate: "2026-11-14T00:00:00.000Z",
      }),
    );
    render(
      <ul>
        <RelationRow row={row} plugins={PLUGINS} />
      </ul>,
    );
    expect(screen.getByText("Rotterdam depot")).toBeTruthy();
    expect(screen.getByText("Site · At risk · 14 Nov")).toBeTruthy();
  });

  it("shows the progress words and the bar only when the source reports them", () => {
    const reported = buildPlaceRow(place({ progress: { fraction: 4 / 9, done: 4, total: 9 } }));
    const unreported = buildPlaceRow(place());
    const { rerender } = render(
      <ul>
        <RelationRow row={reported} plugins={PLUGINS} />
      </ul>,
    );
    expect(screen.getByText("4 of 9")).toBeTruthy();
    rerender(
      <ul>
        <RelationRow row={unreported} plugins={PLUGINS} />
      </ul>,
    );
    expect(screen.queryByText(/ of /)).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("says the share on a bar that has no words", () => {
    const row = buildPlaceRow(place({ progress: { fraction: 0.4 } }));
    render(
      <ul>
        <RelationRow row={row} plugins={PLUGINS} />
      </ul>,
    );
    expect(screen.getByRole("img", { name: "40 percent done" })).toBeTruthy();
  });

  it("walks to its place when it is a button, and is plain text when it is not", async () => {
    const onWalk = vi.fn();
    const row = buildPlaceRow(place());
    const { rerender } = render(
      <ul>
        <RelationRow row={row} plugins={PLUGINS} onWalk={onWalk} />
      </ul>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onWalk).toHaveBeenCalledWith("quayside:site:rotterdam");
    rerender(
      <ul>
        <RelationRow row={row} plugins={PLUGINS} />
      </ul>,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("gives the button the claim as its description, so it is read on focus", () => {
    const row = buildPlaceRow(place());
    render(
      <ul>
        <RelationRow row={row} plugins={PLUGINS} onWalk={vi.fn()} claim="Quayside reports this" />
      </ul>,
    );
    expect(screen.getByRole("button").getAttribute("aria-describedby")).toBe(
      screen.getByText("Quayside reports this").id,
    );
  });

  it("draws a place no Connection can read as a lock and words, with no title and no button", () => {
    const locked = buildPlaceRow(
      place({ restricted: true, title: undefined, noun: "Shipment", kind: "quayside/shipment" }),
    );
    render(
      <ul>
        <RelationRow row={locked} plugins={PLUGINS} onWalk={vi.fn()} claim="Noa linked this" />
      </ul>,
    );
    expect(screen.getByText("A Quayside shipment you cannot open")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Noa linked this")).toBeTruthy();
  });
});

describe("RelationRows", () => {
  it("draws one list item per place, in the order given", () => {
    const rows = [
      buildPlaceRow(place({ ref: "quayside:round:a", title: "Round A" })),
      buildPlaceRow(place({ ref: "quayside:round:b", title: "Round B" })),
    ];
    render(<RelationRows rows={rows} plugins={PLUGINS} />);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Round A"),
      expect.stringContaining("Round B"),
    ]);
  });
});
