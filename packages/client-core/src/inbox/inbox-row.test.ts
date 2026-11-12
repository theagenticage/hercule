/** Tests what a row of the Inbox says: its sentence, its time column, who holds it, its place and its hand-off. */
import type { EntityFieldValue, InboxOrder, InboxThing } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { NO_OFFERS, partitionOffers } from "./card-hand-off";
import { buildInboxAsk, buildInboxThing, buildWorkflowOffer } from "./cards.testing";
import { describeInboxRow, type InboxRowContext } from "./inbox-row";

const NOW = new Date("2026-11-12T12:00:00.000Z");
const hoursAgo = (hours: number): string =>
  new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const text = (key: string, value: string): EntityFieldValue => ({
  type: "text",
  key,
  label: key,
  text: value,
});

/** Describes a row at `NOW` in a list of `order`, with the user "Rogier" and no workflows to hand to. */
const describe_ = (
  thing: InboxThing,
  context: Partial<InboxRowContext> & { readonly order?: InboxOrder } = {},
) =>
  describeInboxRow(thing, {
    order: "waiting",
    now: NOW,
    userName: "Rogier",
    offers: NO_OFFERS,
    ...context,
  });

/** A thing Mei has asked a review of, `hours` ago, on a kind with a patience of 24 hours. */
const asked = (hours: number, overrides: Partial<InboxThing> = {}): InboxThing =>
  buildInboxThing("1", {
    asks: [buildInboxAsk("a1", "Mei", { createdAt: hoursAgo(hours) })],
    askCount: 1,
    askKinds: ["acme/review-requested"],
    openKinds: ["acme/review-requested"],
    waitingSince: hoursAgo(hours),
    patience: 24,
    ...overrides,
  });

describe("describeInboxRow reason", () => {
  it("says the newest ask with the asker set apart, and counts the others", () => {
    const thing = asked(2, {
      asks: [
        buildInboxAsk("a2", "Omar", { say: { say: "Omar mentioned you", tone: "plain" } }),
        buildInboxAsk("a1", "Mei"),
      ],
      askCount: 2,
    });

    expect(describe_(thing).reason).toEqual({
      who: "Omar",
      rest: "mentioned you",
      more: 1,
      aside: undefined,
      quiet: false,
    });
  });

  it("keeps the whole sentence when no person is named in it", () => {
    const thing = asked(2, {
      asks: [buildInboxAsk("a1", null, { say: { say: "Checks are failing", tone: "plain" } })],
    });

    expect(describe_(thing).reason).toMatchObject({
      who: undefined,
      rest: "Checks are failing",
      more: 0,
    });
  });

  it("says a thing that asks nothing quietly: its status, its context and its fact", () => {
    const thing = buildInboxThing("1", {
      status: { label: "In progress", shape: "half", tone: "active" },
      face: {
        context: text("project", "Checkout revamp"),
        fact: { type: "number", key: "events", label: "Events", number: 1234 },
      },
    });

    expect(describe_(thing).reason).toEqual({
      rest: "In progress · Checkout revamp · 1.2k events",
      more: 0,
      quiet: true,
    });
  });

  it("falls back to the kind's noun when nothing else is known", () => {
    expect(describe_(buildInboxThing("1")).reason).toMatchObject({ rest: "Ticket", quiet: true });
  });

  it("says who has a thing that asks nothing", () => {
    const colleague = buildInboxThing("1", {
      taskId: "task-1",
      liveWorkflows: [{ workflowId: "wf-review", name: "Review PR" }],
    });
    const you = buildInboxThing("1", { taskId: "task-1" });

    expect(describe_(colleague).reason).toMatchObject({ rest: "Review PR has it", quiet: true });
    expect(describe_(you).reason).toMatchObject({ rest: "You took it on", quiet: true });
  });

  it("adds who has the rest when a workflow has the thing and an ask is left", () => {
    const thing = asked(2, {
      taskId: "task-1",
      liveWorkflows: [{ workflowId: "wf-review", name: "Review PR" }],
    });

    expect(describe_(thing).reason).toMatchObject({
      aside: "Review PR has the rest",
      quiet: false,
    });
  });

  it("adds when a thing came back after a dismissal", () => {
    const aged = asked(2, { dismissedAt: hoursAgo(26) });
    const fresh = asked(2, { dismissedAt: hoursAgo(0.01) });

    expect(describe_(aged).reason.aside).toBe("dismissed 1d ago");
    expect(describe_(fresh).reason.aside).toBe("dismissed just now");
  });
});

describe("describeInboxRow time", () => {
  it.each([
    [0.2, "12m", "fresh", "Waiting 12 minutes"],
    [11, "11h", "fresh", "Waiting 11 hours"],
    [12, "12h", "recent", "Waiting 12 hours"],
    [24, "1d", "due", "Waiting 1 day, due"],
    [72, "3d", "over", "Waiting 3 days, overdue"],
    [24 * 15, "2w", "over", "Waiting 2 weeks, overdue"],
    [24 * 130, "4mo", "over", "Waiting 4 months, overdue"],
  ] as const)(
    "in a waiting list, a wait of %sh reads %s in tone %s",
    (hours, shown, tone, words) => {
      expect(describe_(asked(hours)).time).toEqual({ kind: "wait", text: shown, tone, words });
    },
  );

  it("reads 'now' for a wait of under a minute", () => {
    expect(describe_(asked(0)).time).toMatchObject({ kind: "wait", text: "now" });
  });

  it("measures the wait from the oldest ask, whatever the newest says", () => {
    const thing = asked(100, { asks: [buildInboxAsk("a2", "Omar", { createdAt: hoursAgo(1) })] });

    expect(describe_(thing).time).toMatchObject({ text: "4d" });
  });

  it("shows nothing for a thing that asks nothing in a waiting list", () => {
    expect(describe_(buildInboxThing("1")).time).toEqual({ kind: "none" });
  });

  it("shows when the thing last changed in a newest list, faint, and an overdue wait instead", () => {
    const changed = { sourceUpdatedAt: hoursAgo(3) };

    expect(describe_(asked(5, changed), { order: "newest" }).time).toEqual({
      kind: "wait",
      text: "3h",
      tone: "fresh",
      words: "Updated 3h ago",
    });
    expect(describe_(buildInboxThing("1", changed), { order: "newest" }).time).toMatchObject({
      text: "3h",
      words: "Updated 3h ago",
    });
    // A wait that is due but not overdue does not take the column in a newest list.
    expect(describe_(asked(30, changed), { order: "newest" }).time).toMatchObject({
      text: "3h",
      tone: "fresh",
    });
    expect(describe_(asked(80, changed), { order: "newest" }).time).toMatchObject({
      text: "3d",
      tone: "over",
    });
  });

  it("shows the holder in the time's place when no ask is left, in either order", () => {
    const colleague = buildInboxThing("1", {
      taskId: "task-1",
      liveWorkflows: [{ workflowId: "wf-review", name: "Review PR" }],
    });
    const you = buildInboxThing("1", { taskId: "task-1" });

    for (const order of ["waiting", "newest"] as const) {
      expect(describe_(colleague, { order }).time).toEqual({
        kind: "holder",
        holder: { kind: "colleague", faceSeed: "wf-review", words: "Review PR has it" },
      });
      expect(describe_(you, { order }).time).toEqual({
        kind: "holder",
        holder: { kind: "you", name: "Rogier", words: "You took it on" },
      });
    }
  });

  it("shows the wait, not the holder, while an ask is left for the user", () => {
    const thing = asked(72, {
      taskId: "task-1",
      liveWorkflows: [{ workflowId: "wf-review", name: "Review PR" }],
    });

    expect(describe_(thing).time).toMatchObject({ kind: "wait", text: "3d", tone: "over" });
  });
});

describe("describeInboxRow place", () => {
  const placed = (place: string, overrides: Partial<InboxThing> = {}): InboxThing =>
    asked(2, { face: { place: text("repository", place) }, identifier: "#6244", ...overrides });

  it("keeps a place that fits beside the identifier", () => {
    expect(describe_(placed("storefront-web"))).toMatchObject({
      place: "storefront-web",
      identifier: "#6244",
    });
  });

  it("drops the place when it and the identifier are over 26 characters", () => {
    // The identifier "#6244" has 5 characters, so a place of 21 fits and one of 22 does not.
    expect(describe_(placed("a".repeat(21))).place).toBe("a".repeat(21));
    expect(describe_(placed("a".repeat(22))).place).toBeUndefined();
  });

  it.each([
    [
      "says who has the rest",
      { liveWorkflows: [{ workflowId: "wf", name: "Review PR" }], taskId: "t" },
    ],
    ["says it came back", { dismissedAt: hoursAgo(26) }],
  ])("drops the place when the row %s", (_name, overrides) => {
    expect(describe_(placed("storefront-web", overrides)).place).toBeUndefined();
  });
});

describe("describeInboxRow hand-off", () => {
  const review = buildWorkflowOffer("Review PR", ["acme/review-requested"]);
  const thing = buildInboxThing("1", {
    askKinds: ["acme/review-requested"],
    asks: [buildInboxAsk("a1")],
    askCount: 1,
  });

  it("is null when no workflow can take the thing", () => {
    const stuck = buildWorkflowOffer("Ship it", [], {
      reason: "repository",
      message: "Other repo",
    });

    expect(describe_(thing).handOff).toBeNull();
    expect(describe_(thing, { offers: partitionOffers([stuck]) }).handOff).toBeNull();
  });

  it("names the one workflow that can take it", () => {
    expect(describe_(thing, { offers: partitionOffers([review]) }).handOff).toEqual({
      kind: "one",
      name: "Review PR",
      faceSeed: review.workflowId,
    });
  });

  it("shows the first three faces of the best fits when several can, never a name", () => {
    const others = ["Zed", "Yan", "Xi"].map((name) => buildWorkflowOffer(name, []));

    expect(describe_(thing, { offers: partitionOffers([...others, review]) }).handOff).toEqual({
      kind: "several",
      faceSeeds: [review.workflowId, "wf-xi", "wf-yan"],
    });
  });

  it("says whether a Task holds the thing", () => {
    expect(describe_(thing).held).toBe(false);
    expect(describe_(buildInboxThing("1", { taskId: "task-1" })).held).toBe(true);
  });
});

describe("describeInboxRow label", () => {
  it("reads the whole row for a screen reader", () => {
    const thing = asked(72, {
      title: "Drop the unused wishlist endpoints",
      status: { label: "Checks failing", shape: "cross", tone: "bad" },
      face: { place: text("repository", "platform-core") },
      identifier: "#6230",
      noun: "Pull request",
      asks: [
        buildInboxAsk("a2", "Omar", { say: { say: "Omar mentioned you", tone: "plain" } }),
        buildInboxAsk("a1", "Mei"),
      ],
      askCount: 2,
    });

    expect(describe_(thing).label).toBe(
      "Drop the unused wishlist endpoints. Omar mentioned you, and 1 more ask. waiting 3 days, overdue. Checks failing. Pull request in platform-core. #6230",
    );
  });

  it("keeps the place the row dropped, and says who has the rest", () => {
    const thing = asked(2, {
      face: { place: text("repository", "storefront-web-platform-xy") },
      taskId: "task-1",
      liveWorkflows: [{ workflowId: "wf", name: "Review PR" }],
    });

    expect(describe_(thing).label).toContain("Review PR has the rest");
    expect(describe_(thing).label).toContain("in storefront-web-platform-xy");
  });
});
