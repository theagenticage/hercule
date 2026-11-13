/** Tests which moves of the Inbox are refused, what the rest send, and what the undo line says about them. */
import {
  MAX_INBOX_MOVED_THINGS,
  MAX_TASK_TITLE_LENGTH,
  type InboxGroupMember,
  type InboxThing,
} from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { NO_OFFERS, type CardOffers } from "./card-hand-off";
import { buildInboxAsk, buildInboxThing, buildWorkflowOffer } from "./cards.testing";
import { buildEntries, type InboxGroupView } from "./inbox-groups";
import {
  buildHandedThing,
  describeInboxLinkFailure,
  describeInboxUnlinkFailure,
  didTakeOnTogetherChange,
  describeInboxLink,
  describeInboxTakeOnTogether,
  describeInboxTakeOnTogetherUndone,
  TAKE_ON_UNDONE,
  describeInboxUnlink,
  type InboxMoveTarget,
  describeInboxDismissalFailure,
  describeInboxHandOff,
  describeInboxTakeOn,
  planInboxDrop,
  planInboxMove,
} from "./inbox-moves";

type Row = InboxThing & { readonly offers: CardOffers };

const offered = (thing: InboxThing, offers: CardOffers = NO_OFFERS): Row => ({ ...thing, offers });
const oneOffer = { available: [buildWorkflowOffer("Review PR", [])], unavailable: [] };
const thing = offered(buildInboxThing("1", { title: "Cache delivery slot lookups" }));
const held = offered(buildInboxThing("2", { taskId: "t-1", takenOn: true }));
const online = { isOffline: false } as const;

const reasonOf = (plan: { readonly kind: string; readonly reason?: string }): string =>
  plan.kind === "refuse" ? (plan.reason ?? "") : "";

const one = (row: Row, groupMemberRefs: string[] = []): InboxMoveTarget<Row> => ({
  kind: "thing",
  row,
  groupMemberRefs,
});
const selection = (...rows: Row[]): InboxMoveTarget<Row> => ({
  kind: "selection",
  rows,
  lineKey: rows.length === 1 ? rows[0]!.ref : null,
});
const memberOf = (n: number, matches = true): InboxGroupMember => ({
  id: `id-${n}`,
  ref: `acme:ticket:${n}`,
  matches,
});
/** A group of `count` members that all answer the query, the first of which the visit holds. */
const groupOf = (
  count: number,
  overrides: Partial<InboxGroupView<Row>> = {},
  isFresh = false,
): InboxMoveTarget<Row> => {
  const members = Array.from({ length: count }, (_, n) => memberOf(n));
  return {
    kind: "group",
    group: {
      key: "group:1",
      labelRef: "acme:ticket:1",
      label: "Checkout is slow",
      members,
      size: count,
      rows: [thing],
      unloadedCount: count - 1,
      isOpen: false,
      placedBy: thing,
      matchRefs: [thing.ref],
      tick: "none",
      ...overrides,
    },
    isFresh,
  };
};

describe("planInboxMove", () => {
  it("dismisses a thing or a selection by their ids, and refuses past the most one call takes, saying how many", () => {
    expect(planInboxMove({ move: "dismiss", target: one(thing), ...online })).toEqual({
      kind: "dismiss",
      ids: [thing.id],
      refs: [thing.ref],
      words: { text: "Dismissed", title: "Cache delivery slot lookups" },
      named: [thing],
    });
    expect(
      planInboxMove({ move: "dismiss", target: selection(thing, held), ...online }),
    ).toMatchObject({
      kind: "dismiss",
      ids: [thing.id, held.id],
      words: { text: "Dismissed 2 things", title: null },
    });
    const many = Array.from({ length: MAX_INBOX_MOVED_THINGS + 1 }, (_, n) =>
      offered(buildInboxThing(String(n))),
    );
    expect(
      reasonOf(planInboxMove({ move: "dismiss", target: selection(...many), ...online })),
    ).toBe(
      "Dismiss takes up to 1,000 things at once, and 1,001 are selected. Select fewer, then press E again.",
    );
  });

  it("dismisses every operative member of a group, held or not, and names the group by its label", () => {
    expect(planInboxMove({ move: "dismiss", target: groupOf(3), ...online })).toEqual({
      kind: "dismiss",
      ids: ["id-0", "id-1", "id-2"],
      refs: ["acme:ticket:0", "acme:ticket:1", "acme:ticket:2"],
      words: { text: "Dismissed the group “Checkout is slow”: 3 things", title: null },
      named: [{ title: "Checkout is slow" }],
    });
  });

  it("says how many of a dismissed group's things were not in this list", () => {
    const members = [memberOf(0), memberOf(1), memberOf(2), memberOf(3, false), memberOf(4, false)];
    const plan = planInboxMove({
      move: "dismiss",
      target: groupOf(5, { members }),
      ...online,
    });
    expect(plan.kind === "dismiss" && plan.words.text).toBe(
      "Dismissed the group “Checkout is slow”: 5 things, 2 of them not in this list",
    );
  });

  it("refuses Dismiss on a group the controller cut at its bound, and says what to do instead", () => {
    const reason = reasonOf(
      planInboxMove({
        move: "dismiss",
        target: groupOf(MAX_INBOX_MOVED_THINGS, { size: 1_400 }),
        ...online,
      }),
    );

    expect(reason).toBe(
      "This group has 1,400 things, and Dismiss takes up to 1,000 at once. Open the group, select some of its things, then press E.",
    );
  });

  it("refuses Dismiss on a group that came under the keys a moment ago, and says E again dismisses all", () => {
    expect(
      reasonOf(planInboxMove({ move: "dismiss", target: groupOf(3, {}, true), ...online })),
    ).toBe("The group “Checkout is slow” is under the keys now. E again dismisses all 3.");
  });

  it("takes a group on as one Task, its label's thing first and titled with its label", () => {
    expect(planInboxMove({ move: "takeOn", target: groupOf(3), ...online })).toEqual({
      kind: "takeOnTogether",
      ids: ["id-1", "id-0", "id-2"],
      refs: ["acme:ticket:1", "acme:ticket:0", "acme:ticket:2"],
      title: "Checkout is slow",
    });
    const plan = planInboxMove({
      move: "takeOn",
      target: groupOf(2, { label: "x".repeat(600) }),
      ...online,
    });
    expect(plan.kind === "takeOnTogether" && plan.title).toHaveLength(MAX_TASK_TITLE_LENGTH);
    expect(
      reasonOf(
        planInboxMove({
          move: "takeOn",
          target: groupOf(MAX_INBOX_MOVED_THINGS, { size: 1_001 }),
          ...online,
        }),
      ),
    ).toContain("Take on takes up to 1,000 at once");
  });

  it("takes a selection of several on as one Task, in order and titled with its first row", () => {
    expect(planInboxMove({ move: "takeOn", target: selection(thing, held), ...online })).toEqual({
      kind: "takeOnTogether",
      ids: [thing.id, held.id],
      refs: [thing.ref, held.ref],
      title: "Cache delivery slot lookups",
    });
  });

  it("takes one thing, or a selection of one, on by itself", () => {
    expect(planInboxMove({ move: "takeOn", target: one(thing), ...online })).toEqual({
      kind: "takeOn",
      thing,
    });
    expect(planInboxMove({ move: "takeOn", target: selection(thing), ...online })).toEqual({
      kind: "takeOn",
      thing,
    });
  });

  it("lets Take on join a Task the user did not take on, such as a signal's", () => {
    const signalsTask = offered(buildInboxThing("4", { taskId: "t-3", takenOn: false }));

    expect(planInboxMove({ move: "takeOn", target: one(signalsTask), ...online }).kind).toBe(
      "takeOn",
    );
  });

  it("refuses Take on for a thing the user took on, naming who has it", () => {
    expect(reasonOf(planInboxMove({ move: "takeOn", target: one(held), ...online }))).toBe(
      "You have this already. G goes to its Task.",
    );
    expect(reasonOf(planInboxMove({ move: "takeOn", target: selection(held), ...online }))).toBe(
      "You have this already. G goes to its Task.",
    );
    const handed = offered(
      buildInboxThing("3", {
        taskId: "t-2",
        takenOn: true,
        liveWorkflows: [{ workflowId: "w", name: "Review PR" }],
      }),
    );
    expect(reasonOf(planInboxMove({ move: "takeOn", target: one(handed), ...online }))).toBe(
      "Review PR has this already. G goes to its Task.",
    );
  });

  it("refuses the hand-off for a group or a selection, and says what to do instead", () => {
    expect(
      reasonOf(
        planInboxMove({
          move: "handOff",
          target: selection(offered(thing, oneOffer), offered(held, oneOffer)),
          ...online,
        }),
      ),
    ).toBe(
      "Hand-off takes one thing at a time. Press Esc to clear the selection, then H on the thing you want.",
    );
    expect(reasonOf(planInboxMove({ move: "handOff", target: groupOf(3), ...online }))).toBe(
      "Hand-off takes one thing at a time. Open the group and pick one.",
    );
  });

  it("hands a thing a workflow can take, even one a Task holds, and refuses one none can take", () => {
    const handable = offered(held, oneOffer);
    expect(planInboxMove({ move: "handOff", target: one(handable), ...online })).toEqual({
      kind: "handOff",
      thing: handable,
    });
    expect(reasonOf(planInboxMove({ move: "handOff", target: one(thing), ...online }))).toBe(
      "No workflow can take this ticket yet.",
    );
  });

  it("goes to the Task of a thing that has one, and refuses one with none or a group", () => {
    expect(reasonOf(planInboxMove({ move: "goToTask", target: one(thing), ...online }))).toBe(
      "This has no Task yet. T takes it on.",
    );
    expect(planInboxMove({ move: "goToTask", target: one(held), ...online })).toEqual({
      kind: "goToTask",
      taskId: "t-1",
    });
    expect(reasonOf(planInboxMove({ move: "goToTask", target: groupOf(3), ...online }))).toBe(
      "Go to its Task takes one thing at a time.",
    );
  });

  it("links a selection of two or more as a star from its first row", () => {
    const third = offered(buildInboxThing("3"));
    expect(
      planInboxMove({ move: "link", target: selection(thing, held, third), ...online }),
    ).toEqual({
      kind: "link",
      fromRef: thing.ref,
      toRefs: [held.ref, third.ref],
      named: [thing, held, third],
    });
  });

  it("opens Link to... for one thing under its line, leaving out its own group", () => {
    expect(
      planInboxMove({ move: "link", target: one(thing, [thing.ref, held.ref]), ...online }),
    ).toEqual({
      kind: "pickLink",
      from: { ref: thing.ref, identifier: thing.identifier, title: thing.title },
      fromLabel: thing.identifier,
      excludedRefs: [thing.ref, held.ref],
      anchorKey: thing.ref,
    });
    const bare = offered(buildInboxThing("5", { identifier: "", title: "No identifier here" }));
    expect(planInboxMove({ move: "link", target: one(bare), ...online })).toMatchObject({
      fromLabel: "No identifier here",
    });
  });

  it("opens Link to... for a selection of one under the line that shows it, and refuses when none does", () => {
    expect(
      planInboxMove({
        move: "link",
        target: { kind: "selection", rows: [thing], lineKey: "group:4" },
        ...online,
      }),
    ).toMatchObject({ kind: "pickLink", anchorKey: "group:4", excludedRefs: [] });
    expect(
      reasonOf(
        planInboxMove({
          move: "link",
          target: { kind: "selection", rows: [thing], lineKey: null },
          ...online,
        }),
      ),
    ).toBe("Can't open Link to... here: that thing's line is not on the list.");
  });

  it("opens Link to... for a group from the member it is named after, leaving out its members", () => {
    expect(planInboxMove({ move: "link", target: groupOf(2), ...online })).toEqual({
      kind: "pickLink",
      from: { ref: "acme:ticket:1", identifier: "", title: "Checkout is slow" },
      fromLabel: "Checkout is slow",
      excludedRefs: ["acme:ticket:0", "acme:ticket:1"],
      anchorKey: "group:1",
    });
  });

  it("refuses Link when nothing is selected to link", () => {
    expect(reasonOf(planInboxMove({ move: "link", target: selection(), ...online }))).toBe(
      "There is nothing selected to link. Select two or more with X, then press L.",
    );
  });

  it("refuses every move but Go to its Task while offline", () => {
    const handable = offered(thing, oneOffer);
    for (const move of ["dismiss", "takeOn", "handOff", "link"] as const) {
      expect(reasonOf(planInboxMove({ move, target: one(handable), isOffline: true }))).toContain(
        "You are offline",
      );
    }
    expect(planInboxMove({ move: "goToTask", target: one(held), isOffline: true }).kind).toBe(
      "goToTask",
    );
  });
});

describe("planInboxDrop", () => {
  const [a, b, c] = ["a", "b", "c"].map((n) =>
    buildInboxThing(n, { ref: `acme:ticket:${n}`, identifier: `T-${n}` }),
  );
  const entries = buildEntries({
    rows: [a!, b!, c!],
    groups: [
      {
        key: "group:1",
        labelRef: a!.ref,
        label: "Group A",
        members: [a!, b!].map((row) => ({ id: row.id, ref: row.ref, matches: true })),
        size: 2,
      },
    ],
    folds: new Map(
      [a!, b!].map((row) => [row.ref, { isOpen: true, isExpanded: false, seq: 1 }] as const),
    ),
    isSearch: false,
    selection: new Set(),
    notOnList: new Set(),
  });
  const endOf = (row: InboxThing) => ({
    ref: row.ref,
    identifier: row.identifier,
    title: row.title,
  });

  it("links the line dropped on to the carried line, a head by the member it is named after", () => {
    expect(planInboxDrop(entries, c!.ref, "group:1")).toEqual({
      kind: "link",
      from: { ref: a!.ref, identifier: "", title: "Group A" },
      to: endOf(c!),
    });
    expect(planInboxDrop(entries, b!.ref, c!.ref)).toEqual({
      kind: "link",
      from: endOf(c!),
      to: endOf(b!),
    });
  });

  it("refuses a drop on a line of the carried thing's own group", () => {
    expect(planInboxDrop(entries, b!.ref, "group:1")).toEqual({
      kind: "refuse",
      reason: "These are in one group already.",
    });
    expect(planInboxDrop(entries, b!.ref, a!.ref)).toMatchObject({ kind: "refuse" });
  });

  it("does nothing for a line that is not on the list", () => {
    expect(planInboxDrop(entries, "acme:ticket:gone", c!.ref)).toBeNull();
  });
});

describe("what the undo line says", () => {
  it("puts the title last for a hand-off", () => {
    expect(describeInboxHandOff(thing, "Review PR")).toEqual({
      text: "Handed to Review PR",
      title: "Cache delivery slot lookups",
    });
  });

  it("says a Take on that made no Task made none", () => {
    expect(describeInboxTakeOn(thing, true).text).toBe("Took on, a Task on Work");
    expect(describeInboxTakeOn(thing, false).text).toContain("no new one was made");
  });

  it("says why a dismissal failed and that the things are back", () => {
    expect(describeInboxDismissalFailure([thing, held], "the controller is busy")).toBe(
      "2 things were not dismissed, so they are back: the controller is busy. Try again.",
    );
  });
});

describe("the undo line for linking, groups and take on together", () => {
  const shop = buildInboxThing("1", { identifier: "SHOP-150" });
  const pr = buildInboxThing("2", { identifier: "#6251" });
  const bare = buildInboxThing("3", { identifier: "", title: "No identifier here" });

  it("says what a link did by identifiers, falls back to the quoted title, and says a repeat changed nothing", () => {
    expect(describeInboxLink([shop, pr], true)).toEqual({
      text: "Linked",
      title: "SHOP-150 and #6251",
    });
    expect(describeInboxLink([shop, bare], true).title).toBe("SHOP-150 and “No identifier here”");
    expect(describeInboxLink([shop, pr, bare], true).text).toBe("Linked 3 things");
    expect(describeInboxLink([shop, pr], false).text).toBe("These are linked already.");
  });

  it("says what an unlink did, and that the source still links the pair", () => {
    expect(describeInboxUnlink(shop, pr, { removed: true })).toEqual({
      text: "Unlinked",
      title: "SHOP-150 and #6251",
    });
    expect(describeInboxUnlink(shop, pr, { removed: true, remaining: "source" }).text).toBe(
      "Unlinked, but the source still links them",
    );
    expect(describeInboxUnlink(shop, pr, { removed: false }).text).toBe(
      "You had not linked these, so nothing changed",
    );
  });

  it("says what undoing a take on together did", () => {
    expect(describeInboxTakeOnTogetherUndone(true)).toBe(TAKE_ON_UNDONE);
    expect(describeInboxTakeOnTogetherUndone(false)).toBe("Taken back off the Task.");
  });

  it("says whether a take on together made the Task or joined one, with the title last", () => {
    const made = { created: true, added: 2, taken: 2 };
    const joined = { created: false, added: 1, taken: 2 };
    expect(describeInboxTakeOnTogether("Checkout is slow", made)).toEqual({
      text: "Took on, a Task on Work",
      title: "Checkout is slow",
    });
    expect(describeInboxTakeOnTogether("Checkout is slow", joined).text).toBe(
      "Added to its Task on Work",
    );
  });

  it("says a take on together that changed nothing is on its Task already, with nothing to undo", () => {
    const nothing = { created: false, added: 0, taken: 0 };
    expect(didTakeOnTogetherChange(nothing)).toBe(false);
    expect(describeInboxTakeOnTogether("Checkout is slow", nothing).text).toBe(
      "Already on its Task on Work, so nothing changed",
    );
    expect(didTakeOnTogetherChange({ ...nothing, taken: 1 })).toBe(true);
  });
});

describe("failure lines", () => {
  it("words link and unlink failures with one full stop before the advice", () => {
    expect(describeInboxLinkFailure("the controller is busy")).toBe(
      "The link did not save: the controller is busy. Try again.",
    );
    expect(describeInboxUnlinkFailure("the controller is busy")).toBe(
      "The link was not removed: the controller is busy. Try again.",
    );
  });
});

describe("buildHandedThing", () => {
  const asking = buildInboxThing("4", {
    asks: [buildInboxAsk("a1")],
    askCount: 1,
    askKinds: ["acme/review-requested"],
    waitingSince: "2026-11-01T09:00:00.000Z",
  });

  it("takes the asks the workflow answers away, so the thing no longer waits and the workflow has it", () => {
    const handed = buildHandedThing(
      asking,
      buildWorkflowOffer("Review PR", ["acme/review-requested"]),
    );

    expect(handed.asks).toEqual([]);
    expect(handed.askCount).toBe(0);
    expect(handed.waitingSince).toBeUndefined();
    expect(handed.liveWorkflows.map((workflow) => workflow.name)).toEqual(["Review PR"]);
  });

  it("keeps the asks the workflow does not answer, and the wait they hold", () => {
    const handed = buildHandedThing(
      asking,
      buildWorkflowOffer("Repair the build", ["acme/failed"]),
    );

    expect(handed.asks).toHaveLength(1);
    expect(handed.waitingSince).toBe(asking.waitingSince);
    expect(handed.liveWorkflows.map((workflow) => workflow.name)).toEqual(["Repair the build"]);
  });

  it("counts the asks that stay and takes the wait from the oldest of them", () => {
    const thing = buildInboxThing("5", {
      asks: [
        buildInboxAsk("a1", "Mei", { kind: "acme/failed", createdAt: "2026-11-03T09:00:00.000Z" }),
        buildInboxAsk("a2", "Mei", {
          kind: "acme/review-requested",
          createdAt: "2026-11-02T09:00:00.000Z",
        }),
      ],
      askCount: 2,
      askKinds: ["acme/failed", "acme/review-requested"],
      waitingSince: "2026-11-02T09:00:00.000Z",
    });
    const handed = buildHandedThing(
      thing,
      buildWorkflowOffer("Review PR", ["acme/review-requested"]),
    );

    expect(handed.askCount).toBe(1);
    expect(handed.waitingSince).toBe("2026-11-03T09:00:00.000Z");
  });

  it("keeps the wait when older asks are not listed, and lowers the count by what it saw end", () => {
    const thing = buildInboxThing("6", {
      asks: [buildInboxAsk("a1", "Mei", { kind: "acme/review-requested" })],
      askCount: 4,
      askKinds: ["acme/failed", "acme/review-requested"],
      waitingSince: "2026-11-01T09:00:00.000Z",
    });
    const handed = buildHandedThing(
      thing,
      buildWorkflowOffer("Review PR", ["acme/review-requested"]),
    );

    expect(handed.askCount).toBe(3);
    expect(handed.waitingSince).toBe("2026-11-01T09:00:00.000Z");
  });
});
