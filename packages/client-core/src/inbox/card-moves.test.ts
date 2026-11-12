/** Tests the words of the Inbox moves and why one is refused. */
import { describe, expect, it } from "vitest";
import { partitionOffers } from "./card-hand-off";
import { buildInboxCard, buildRequestCard, buildWorkflowOffer } from "./cards.testing";
import { describeHandOffRefusal, describeMoveRefusal, nameCard } from "./card-moves";

const TASK_ID = "01a1b576-c999-7000-8000-0000000000aa";
const waiting = buildInboxCard("1");
const held = buildInboxCard("2", { taskId: TASK_ID });

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
