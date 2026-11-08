/** Tests the words of the Inbox's moves, why one is refused, and the edits that write an answered move into the cached Inbox. */
import { describe, expect, it } from "vitest";
import { partitionOffers } from "./card-hand-off";
import { buildInbox, buildInboxCard, buildRequestCard, buildWorkflowOffer } from "./cards.testing";
import {
  applyInboxEdit,
  describeDismissal,
  describeHandOffRefusal,
  describeMoveRefusal,
  listRailTargets,
  nameCard,
  reapplyInboxEdits,
  type InboxEdit,
} from "./card-moves";

const TASK_ID = "01a1b576-c999-7000-8000-0000000000aa";
const waiting = buildInboxCard("1");
const held = buildInboxCard("2", { taskId: TASK_ID });
const AGENT = { workflowId: "wf-agent-review", name: "Agent review" };

describe("describeMoveRefusal", () => {
  it("lets take and dismiss through on a card that waits, and see-task through on one with a Task", () => {
    expect(describeMoveRefusal(waiting, "take")).toBeUndefined();
    expect(describeMoveRefusal(waiting, "dismiss")).toBeUndefined();
    expect(describeMoveRefusal(held, "see-task")).toBeUndefined();
  });

  it("refuses take and dismiss on a card with a Task, and says where the Task is", () => {
    expect(describeMoveRefusal(held, "take")).toBe("It already has a Task. Press G to see it.");
    expect(describeMoveRefusal(held, "dismiss")).toBe("It already has a Task. Press G to see it.");
  });

  it("refuses to see the Task of a card that has none, and says how to make one", () => {
    expect(describeMoveRefusal(waiting, "see-task")).toBe(
      "It has no Task yet. Press T to take it on, and G to see the Task.",
    );
  });
});

describe("describeMoveRefusal for a hand-off", () => {
  const review = buildWorkflowOffer("Review PR");
  const blocked = buildWorkflowOffer("Ship it", [], {
    reason: "repository",
    message: "Ship it works on acme/web only",
  });

  it("lets a card through when a workflow can take it, also when it has a Task", () => {
    const offers = partitionOffers([review, blocked]);
    expect(describeMoveRefusal(waiting, "hand", offers)).toBeUndefined();
    expect(describeMoveRefusal(held, "hand", offers)).toBeUndefined();
  });

  it("says how to get a workflow when none exists", () => {
    expect(describeMoveRefusal(waiting, "hand")).toBe(
      "No workflow takes a ticket. Give a workflow an entity input for acme/ticket to hand these off.",
    );
  });

  it("gives the controller's reason when workflows exist and none can take the card", () => {
    expect(describeMoveRefusal(waiting, "hand", partitionOffers([blocked]))).toBe(
      "No workflow can take it now. Ship it works on acme/web only.",
    );
  });
});

describe("describeHandOffRefusal", () => {
  it("names the card and workflow, then gives the controller's reason as a sentence", () => {
    expect(
      describeHandOffRefusal(
        buildRequestCard("87"),
        "Review PR",
        "Review PR is already working on this",
      ),
    ).toBe("Review #87 was not handed to Review PR. Review PR is already working on this.");
    expect(
      describeHandOffRefusal(
        waiting,
        "Review PR",
        "A reply to this is still running. Try again in a moment.",
      ),
    ).toBe(
      "Ticket ACME-1 was not handed to Review PR. A reply to this is still running. Try again in a moment.",
    );
  });
});

describe("nameCard", () => {
  it("names a card by its noun and identifier", () => {
    expect(nameCard(buildRequestCard("7"))).toBe("Review #7");
  });
});

describe("applyInboxEdit", () => {
  const inbox = buildInbox([waiting, held]);

  it("drops one card and leaves the rest", () => {
    expect(applyInboxEdit(inbox, { kind: "drop", id: waiting.id }).cards).toEqual([held]);
  });

  it("puts a dropped card back once, and never twice", () => {
    const dropped = applyInboxEdit(inbox, { kind: "drop", id: waiting.id });
    const back = applyInboxEdit(dropped, { kind: "put-back", card: waiting });
    expect(back.cards.map((card) => card.id)).toEqual([held.id, waiting.id]);
    expect(applyInboxEdit(back, { kind: "put-back", card: waiting })).toBe(back);
  });

  it("sets a card's Task without moving it to another side", () => {
    const taken = applyInboxEdit(inbox, { kind: "set-task", id: waiting.id, taskId: TASK_ID });
    expect(taken.cards[0]).toMatchObject({ id: waiting.id, taskId: TASK_ID, side: "ongoing" });
    expect(taken.cards[1]).toBe(held);
  });

  it("takes a card's Task away", () => {
    const freed = applyInboxEdit(inbox, { kind: "set-task", id: held.id, taskId: undefined });
    expect("taskId" in (freed.cards[1] ?? {})).toBe(false);
  });
});

describe("applyInboxEdit for a hand-off", () => {
  const other = { workflowId: "wf-other", name: "Other" };

  it("puts the workflow first among the card's live workflows, once", () => {
    const busy = buildInboxCard("3", { liveWorkflows: [other] });
    const inbox = buildInbox([waiting, busy]);
    const handed = applyInboxEdit(inbox, { kind: "hand-off", id: busy.id, workflow: AGENT });
    expect(handed.cards[1]?.liveWorkflows).toEqual([AGENT, other]);
    expect(handed.cards[0]).toBe(waiting);
    expect(
      applyInboxEdit(handed, { kind: "hand-off", id: busy.id, workflow: AGENT }).cards[1]
        ?.liveWorkflows,
    ).toEqual([AGENT, other]);
  });

  it("takes the workflow away and sets the Task the card has after a hand-off is taken back", () => {
    const handed = buildInboxCard("3", { taskId: TASK_ID, liveWorkflows: [AGENT, other] });
    const inbox = buildInbox([handed]);
    const kept = applyInboxEdit(inbox, {
      kind: "take-back-hand-off",
      id: handed.id,
      workflowId: AGENT.workflowId,
      taskId: TASK_ID,
    });
    expect(kept.cards[0]).toMatchObject({ taskId: TASK_ID, liveWorkflows: [other] });
    const gone = applyInboxEdit(inbox, {
      kind: "take-back-hand-off",
      id: handed.id,
      workflowId: AGENT.workflowId,
      taskId: undefined,
    });
    expect("taskId" in (gone.cards[0] ?? {})).toBe(false);
  });
});

describe("reapplyInboxEdits", () => {
  it("makes the edits in order, so a card dropped and put back is there once", () => {
    const inbox = buildInbox([waiting]);
    const edits: readonly InboxEdit[] = [
      { kind: "drop", id: waiting.id },
      { kind: "put-back", card: waiting },
      { kind: "set-task", id: waiting.id, taskId: TASK_ID },
    ];
    expect(reapplyInboxEdits(inbox, edits).cards).toEqual([{ ...waiting, taskId: TASK_ID }]);
  });

  it("returns the Inbox itself when there is no edit", () => {
    const inbox = buildInbox([waiting]);
    expect(reapplyInboxEdits(inbox, [])).toBe(inbox);
  });
});

describe("describeDismissal", () => {
  const lead = buildInboxCard("1");
  const review = buildRequestCard("2");

  it.each([
    ["nothing rode on it", [], "Dismissed Ticket ACME-1."],
    ["one card rode on it", [review], "Dismissed Ticket ACME-1. Review #2 stands alone now."],
    [
      "two cards rode on it",
      [review, buildRequestCard("3")],
      "Dismissed Ticket ACME-1. 2 things that rode on it stand alone now.",
    ],
  ])("says what becomes of what rode on it when %s", (_name, riders, words) => {
    expect(describeDismissal(lead, riders)).toBe(words);
  });
});

describe("listRailTargets", () => {
  const review = buildWorkflowOffer("Review PR");
  const blocked = buildWorkflowOffer("Ship it", [], { reason: "repository", message: "No" });
  const offers = partitionOffers([review, blocked]);
  const hand = { kind: "hand", workflowId: review.workflowId, name: "Review PR" };

  it("offers a card that waits the workflows that can take it, then Take and Dismiss", () => {
    expect(listRailTargets(waiting, offers)).toEqual([hand, { kind: "take" }, { kind: "dismiss" }]);
  });

  it.each([
    ["a Task holds", held],
    ["a workflow is working on", buildInboxCard("3", { liveWorkflows: [AGENT] })],
  ])("offers only the workflows for a card %s", (_name, card) => {
    expect(listRailTargets(card, offers)).toEqual([hand]);
  });

  it("names the first five workflows and stands for the rest with a target that shows two of them", () => {
    const many = Array.from({ length: 8 }, (_unused, index) =>
      buildWorkflowOffer(`Agent ${index}`),
    );
    const targets = listRailTargets(waiting, partitionOffers(many));

    expect(targets.map((target) => target.kind)).toEqual([
      ...Array.from({ length: 5 }, () => "hand"),
      "more",
      "take",
      "dismiss",
    ]);
    expect(targets[5]).toEqual({
      kind: "more",
      workflowIds: [many[5]!.workflowId, many[6]!.workflowId],
    });
  });

  it("has no target for the rest when every workflow fits, and keeps it on a held card", () => {
    const five = Array.from({ length: 5 }, (_unused, index) =>
      buildWorkflowOffer(`Agent ${index}`),
    );
    expect(listRailTargets(waiting, partitionOffers(five)).map((each) => each.kind)).toEqual([
      "hand",
      "hand",
      "hand",
      "hand",
      "hand",
      "take",
      "dismiss",
    ]);
    const six = [...five, buildWorkflowOffer("Agent 5")];
    expect(listRailTargets(held, partitionOffers(six)).map((each) => each.kind)).toEqual([
      "hand",
      "hand",
      "hand",
      "hand",
      "hand",
      "more",
    ]);
  });
});
