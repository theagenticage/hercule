/**
 * Tests the relation rows as the user meets them, for an invented purchase
 * order of the Quayside plugin: what a place says about itself, the progress
 * words only when the source gives them, and the locked row with no title.
 */
import type { EntityPlace } from "@hercule/contract";
import { buildLinkedRows, buildPlaceRow } from "@hercule/client-core/desk";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RelationRows } from "./relation-rows";

const PLUGINS = [{ id: "quayside", displayName: "Quayside" }];

const place = (overrides: Partial<EntityPlace> = {}): EntityPlace => ({
  ref: "quayside:site:rotterdam",
  kind: "quayside/site",
  noun: "Site",
  title: "Rotterdam depot",
  restricted: false,
  ...overrides,
});

describe("a relation row", () => {
  it("says the place's kind, status and target date beside its title", () => {
    const row = buildPlaceRow(
      place({
        status: { shape: "half", tone: "attention", label: "At risk" },
        targetDate: "2026-11-14T00:00:00.000Z",
      }),
    );
    render(<RelationRows rows={[row]} plugins={PLUGINS} />);
    expect(screen.getByText("Rotterdam depot")).toBeTruthy();
    expect(screen.getByText("Site · At risk · 14 Nov")).toBeTruthy();
  });

  it("shows the progress words and the bar only when the source reports them", () => {
    const reported = buildPlaceRow(place({ progress: { fraction: 4 / 9, done: 4, total: 9 } }));
    const unreported = buildPlaceRow(place());
    const { rerender } = render(<RelationRows rows={[reported]} plugins={PLUGINS} />);
    expect(screen.getByText("4 of 9")).toBeTruthy();
    rerender(<RelationRows rows={[unreported]} plugins={PLUGINS} />);
    expect(screen.queryByText(/ of /)).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("says the share on a bar that has no words", () => {
    const row = buildPlaceRow(place({ progress: { fraction: 0.4 } }));
    render(<RelationRows rows={[row]} plugins={PLUGINS} />);
    expect(screen.getByRole("img", { name: "40 percent done" })).toBeTruthy();
  });

  it("walks to its place when it is a button, and is plain text when it is not", async () => {
    const onWalk = vi.fn();
    const row = buildPlaceRow(place());
    const { rerender } = render(<RelationRows rows={[row]} plugins={PLUGINS} onWalk={onWalk} />);
    await userEvent.click(screen.getByRole("button"));
    expect(onWalk).toHaveBeenCalledWith("quayside:site:rotterdam");
    rerender(<RelationRows rows={[row]} plugins={PLUGINS} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps a row plain when the caller refuses to walk to it", () => {
    const row = buildPlaceRow(place());
    render(<RelationRows rows={[row]} plugins={PLUGINS} onWalk={vi.fn()} canWalk={() => false} />);
    expect(screen.getByText("Rotterdam depot")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("leaves out the kind's noun when the caller says the title already names it", () => {
    const row = buildPlaceRow(place({ status: { shape: "ring", tone: "active", label: "Open" } }));
    render(<RelationRows rows={[row]} plugins={PLUGINS} isKindShown={false} />);
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.queryByText(/Site/)).toBeNull();
  });

  it("draws a place no Connection can read as a lock and words, with no title and no button", () => {
    const locked = buildPlaceRow(
      place({ restricted: true, noun: "Shipment", kind: "quayside/shipment" }),
    );
    render(<RelationRows rows={[locked]} plugins={PLUGINS} onWalk={vi.fn()} />);
    expect(screen.getByText("A Quayside shipment you cannot open")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
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

describe("RelationRows for linked things", () => {
  const ORDER = "quayside:order:po-1";
  const OTHER = "quayside:order:po-2";
  const other = place({
    ref: OTHER,
    kind: "quayside/order",
    noun: "Order",
    title: "Chilled crates",
    status: { shape: "fork", tone: "active", label: "Checks failed" },
  });
  const build = (claim: { type: "source" | "person" | "text" }, extra: object = {}) =>
    buildLinkedRows({
      ref: ORDER,
      links: [
        {
          fromRef: ORDER,
          toRef: OTHER,
          hasPersonClaim: claim.type === "person",
          claim: { ...claim, ...extra },
        },
      ],
      places: [other],
      peers: [],
      plugins: PLUGINS,
    });

  it("shows a linked thing's status in place of its kind, and who says it is linked", () => {
    const { confirmed } = build({ type: "source" }, { plugin: "quayside" });
    render(<RelationRows rows={confirmed} plugins={PLUGINS} isKindShown={false} />);

    expect(screen.getByText("Checks failed")).toBeTruthy();
    expect(screen.queryByText("Order")).toBeNull();
    expect(screen.getByText("Quayside reports this")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("removes a link the user made when the remove button is pressed", async () => {
    const onUnlink = vi.fn();
    const { confirmed } = build({ type: "person" });
    render(<RelationRows rows={confirmed} plugins={PLUGINS} onUnlink={onUnlink} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Remove the link to Chilled crates" }),
    );

    expect(onUnlink).toHaveBeenCalledExactlyOnceWith(confirmed[0]);
  });

  it("ignores the second click of a double click on the remove button, which a Link button may have just made appear under the pointer", () => {
    const onUnlink = vi.fn();
    const { confirmed } = build({ type: "person" });
    render(<RelationRows rows={confirmed} plugins={PLUGINS} onUnlink={onUnlink} />);
    const remove = screen.getByRole("button", { name: "Remove the link to Chilled crates" });

    fireEvent.click(remove, { detail: 2 });
    expect(onUnlink).not.toHaveBeenCalled();

    fireEvent.click(remove, { detail: 1 });
    expect(onUnlink).toHaveBeenCalledOnce();
  });

  it("offers a hint a Link button, with the words of where the reference was found", async () => {
    const onLink = vi.fn();
    const { hints } = build({ type: "text" }, { evidenceKey: "description" });
    render(<RelationRows rows={hints} plugins={PLUGINS} onLink={onLink} />);

    expect(screen.getByText("Found in the description")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(onLink).toHaveBeenCalledExactlyOnceWith(hints[0]);
  });

  it("shows what changed at the source under the title of any row", () => {
    const row = buildPlaceRow(
      place({
        latestChange: {
          reason: "reassigned",
          sentence: { say: "Now with Tessa", tone: "plain" },
          at: "2026-11-05T09:00:00.000Z",
        },
      }),
    );
    render(<RelationRows rows={[row]} plugins={PLUGINS} />);

    expect(screen.getByText("Now with Tessa")).toBeTruthy();
  });
});
