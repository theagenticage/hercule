/** Tests which moves of the Inbox are refused, what the rest send, and what the undo line says about them. */
import {
  EntityTakeOnTogetherInput,
  InboxMove,
  MAX_INBOX_MOVED_THINGS,
  MAX_TASK_TITLE_LENGTH,
  type InboxGroupMember,
  type InboxThing,
} from "@hercule/contract";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { NO_OFFERS, type CardOffers } from "./card-hand-off";
import {
  buildActiveTask,
  buildInboxAsk,
  buildInboxThing,
  buildWorkflowOffer,
} from "./cards.testing";
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
  describeInboxThreadStart,
  describeInboxThreadStartFailure,
  planInboxDrop,
  planInboxMove,
} from "./inbox-moves";

type Row = InboxThing & { readonly offers: CardOffers };

const offered = (thing: InboxThing, offers: CardOffers = NO_OFFERS): Row => ({ ...thing, offers });
const oneOffer = { available: [buildWorkflowOffer("Review PR", [])], unavailable: [] };
const thing = offered(buildInboxThing("1", { title: "Cache delivery slot lookups" }));
const held = offered(buildInboxThing("2", { task: buildActiveTask("t-1") }));
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
/** An id the contract accepts (a UUIDv7), for the tests that validate a plan against its schema. */
const uuidOf = (n: number): string => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
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

describe("planInboxMove for Start a thread", () => {
  const start = (target: InboxMoveTarget<Row>, isOffline = false) =>
    planInboxMove({ move: "startThread", target, ...online, isOffline });
  const other = offered(buildInboxThing("3", { title: "Slow page" }));
  /** A group whose members are all held as rows, so a thread can start from them. */
  const heldGroup = (rows: Row[]): InboxMoveTarget<Row> => {
    const target = groupOf(rows.length);
    if (target.kind !== "group") throw new Error("not a group");
    const members = rows.map(({ id, ref }) => ({ id, ref, matches: true }));
    return {
      ...target,
      group: { ...target.group, members, rows, unloadedCount: 0, placedBy: rows[0]! },
    };
  };

  it("takes one thing or a selection, named after its first thing", () => {
    expect(start(one(thing))).toEqual({
      kind: "startThread",
      things: [thing],
      title: "Cache delivery slot lookups",
    });
    expect(start(selection(thing, other))).toEqual({
      kind: "startThread",
      things: [thing, other],
      title: "Cache delivery slot lookups",
    });
  });

  it("takes the operative members of a group, named after the group", () => {
    expect(start(heldGroup([thing, other]))).toEqual({
      kind: "startThread",
      things: [thing, other],
      title: "Checkout is slow",
    });
  });

  it("cuts the name to what a Task title holds", () => {
    const long = offered(buildInboxThing("6", { title: "x".repeat(MAX_TASK_TITLE_LENGTH + 20) }));
    expect(start(one(long))).toMatchObject({ title: "x".repeat(MAX_TASK_TITLE_LENGTH) });
  });

  it("starts from a group's only operative member as that thing", () => {
    expect(start(heldGroup([thing]))).toMatchObject({
      things: [thing],
      title: "Cache delivery slot lookups",
    });
  });

  it("refuses a group with members the list has not read, and says to open it", () => {
    expect(reasonOf(start(groupOf(3)))).toBe(
      "This group has things the list has not read yet. Open the group, then press N.",
    );
  });

  it("refuses offline, with the words every move uses", () => {
    expect(reasonOf(start(one(thing), true))).toContain("You are offline");
  });

  it("refuses a thing on a Task, whatever runs on it, and says where to go", () => {
    const onTask = offered(
      buildInboxThing("5", { title: "Slow page", task: buildActiveTask("t-9") }),
    );
    const reviewed = offered(
      buildInboxThing("6", {
        task: buildActiveTask("t-6"),
        liveWorkflows: [{ workflowId: "w", name: "Review PR" }],
      }),
    );
    for (const target of [onTask, reviewed, held]) {
      expect(reasonOf(start(one(target)))).toBe(
        "This is on a Task already. G views it, and you can start a thread there.",
      );
    }
    expect(reasonOf(start(selection(thing, onTask)))).toBe(
      "“Slow page” is in the selection, and it is on a Task already. Take it out of the selection, then press N again.",
    );
    expect(reasonOf(start(heldGroup([thing, onTask])))).toBe(
      "“Slow page” is in this group, and it is on a Task already. Open the group, select the others, then press N.",
    );
  });

  it("names the first thing of a selection that is on a Task", () => {
    const reviewed = offered(
      buildInboxThing("4", {
        title: "Slow page",
        task: buildActiveTask("t-4"),
        liveWorkflows: [{ workflowId: "w", name: "Mei" }],
      }),
    );
    expect(reasonOf(start(selection(thing, reviewed, held)))).toBe(
      "“Slow page” is in the selection, and it is on a Task already. Take it out of the selection, then press N again.",
    );
  });

  it("refuses more things than a thread starts from, saying how many", () => {
    const many = Array.from({ length: 51 }, (_, n) => offered(buildInboxThing(String(n + 10))));
    expect(reasonOf(start(selection(...many)))).toBe(
      "A thread starts from up to 50 things, and 51 are selected. Select fewer, then press N again.",
    );
    expect(reasonOf(start(groupOf(51)))).toBe(
      "This group has 51 things, and a thread starts from up to 50. Open the group, select some of its things, then press N.",
    );
  });
});

describe("the words after starting a thread", () => {
  it("puts the title last, and names it in a failure", () => {
    expect(describeInboxThreadStart("Fix the cart")).toEqual({
      text: "Started a thread on",
      title: "Fix the cart",
    });
    expect(
      describeInboxThreadStartFailure(
        "Fix the cart",
        "it changed while the Task was made. Try again",
      ),
    ).toBe(
      "“Fix the cart” was not started as a thread: it changed while the Task was made. Try again.",
    );
    expect(
      describeInboxThreadStartFailure(
        "Fix the cart",
        "it is already on the Task “X”. Leave it out",
      ),
    ).toBe(
      "“Fix the cart” was not started as a thread: it is already on the Task “X”. Leave it out.",
    );
  });
});

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

  it("takes a group with one operative member on alone, never as a take on together", () => {
    const plan = planInboxMove({
      move: "takeOn",
      target: groupOf(1, { members: [memberOf(1)], size: 1, unloadedCount: 0 }),
      ...online,
    });
    expect(plan).toEqual({ kind: "takeOn", thing });
  });

  it("refuses to take a group of one operative member on when that member is not held", () => {
    const plan = planInboxMove({
      move: "takeOn",
      target: groupOf(1, { members: [memberOf(7)], size: 1, unloadedCount: 1 }),
      ...online,
    });
    expect(reasonOf(plan)).toContain("nothing on the list to take on");
  });

  it("dismisses a group of one operative member by that one id", () => {
    const plan = planInboxMove({
      move: "dismiss",
      target: groupOf(1, { members: [{ ...memberOf(1), id: uuidOf(1) }], size: 1 }),
      ...online,
    });
    if (plan.kind !== "dismiss") throw new Error(plan.kind);
    expect(plan.ids).toEqual([uuidOf(1)]);
    Schema.decodeUnknownSync(InboxMove)({ ids: plan.ids });
  });

  it("refuses E and T on a group with more operative members than one call takes, even when its size matches", () => {
    const count = MAX_INBOX_MOVED_THINGS + 1;
    for (const [move, verb] of [
      ["dismiss", "Dismiss"],
      ["takeOn", "Take on"],
    ] as const) {
      expect(reasonOf(planInboxMove({ move, target: groupOf(count), ...online }))).toBe(
        `This group has 1,001 things to move, and ${verb} takes up to 1,000 at once. Open the group, select some of its things, then press ${move === "dismiss" ? "E" : "T"}.`,
      );
    }
  });

  it("plans a take on together that the contract accepts, at the most one call takes", () => {
    const members = Array.from({ length: MAX_INBOX_MOVED_THINGS }, (_, n) => ({
      ...memberOf(n),
      id: uuidOf(n),
    }));
    const plan = planInboxMove({
      move: "takeOn",
      target: groupOf(MAX_INBOX_MOVED_THINGS, { members }),
      ...online,
    });
    if (plan.kind !== "takeOnTogether") throw new Error(plan.kind);
    Schema.decodeUnknownSync(EntityTakeOnTogetherInput)({ ids: plan.ids, title: plan.title });
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

  it("refuses Take on for a thing on a Task, whatever made the Task, and points to View task", () => {
    const handed = offered(
      buildInboxThing("3", {
        task: buildActiveTask("t-2"),
        liveWorkflows: [{ workflowId: "w", name: "Review PR" }],
      }),
    );
    for (const target of [one(held), selection(held), one(handed)]) {
      expect(reasonOf(planInboxMove({ move: "takeOn", target, ...online }))).toBe(
        "This is on a Task already. G views it.",
      );
    }
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
      "This is on no Task yet. T takes it on.",
    );
    expect(planInboxMove({ move: "goToTask", target: one(held), ...online })).toEqual({
      kind: "goToTask",
      taskId: "t-1",
    });
    expect(reasonOf(planInboxMove({ move: "goToTask", target: groupOf(3), ...online }))).toBe(
      "View task takes one thing at a time.",
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
