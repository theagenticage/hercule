/** Tests which moves a card shows on hover, above all the hand-off: named for one workflow, "Hand to…" for several, absent for none. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { partitionOffers } from "@hercule/client-core/inbox";
import { buildInboxCard, buildWorkflowOffer } from "@hercule/client-core/inbox/testing";
import { CardMoves } from "./card-moves";

const review = buildWorkflowOffer("Agent review", ["github/review-requested"]);
const repair = buildWorkflowOffer("Repair the build", ["github/checks-failed"]);
const unavailable = buildWorkflowOffer("Ship it", [], {
  reason: "repository",
  message: "Ship it works on acme/web only",
});
const WAITING = buildInboxCard("card-1");
const HELD = buildInboxCard("card-2", { taskId: "task-1" });

describe("CardMoves", () => {
  it("names the workflow when one can take the card, and hands to it at once", () => {
    render(<CardMoves card={WAITING} offers={partitionOffers([review, unavailable])} />);

    const hand = screen.getByRole("button", { name: "Hand to Agent review" });
    expect(hand.textContent).toBe("Agent review");
    expect(hand.getAttribute("data-move")).toBe("hand");
    expect(hand.getAttribute("data-workflow-id")).toBe(review.workflowId);
  });

  it("says Hand to… when several can, and leaves the choice to the menu", () => {
    render(<CardMoves card={WAITING} offers={partitionOffers([review, repair])} />);

    const hand = screen.getByRole("button", { name: "Hand to…" });
    expect(hand.getAttribute("data-move")).toBe("hand");
    expect(hand.hasAttribute("data-workflow-id")).toBe(false);
    expect(hand.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("offers no hand-off when no workflow can take the card", () => {
    const { container } = render(
      <CardMoves card={WAITING} offers={partitionOffers([unavailable])} />,
    );

    expect(container.querySelector('[data-move="hand"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Take it" })).toBeTruthy();
  });

  it("offers the hand-off beside On Work on a card with a Task, whose hand-off continues it", () => {
    const { container } = render(<CardMoves card={HELD} offers={partitionOffers([review])} />);

    const moves = [...container.querySelectorAll("[data-move]")].map((each) =>
      each.getAttribute("data-move"),
    );
    expect(moves).toEqual(["hand", "see-task"]);
  });

  it("draws no hand-off when the caller has read no offers", () => {
    const { container } = render(<CardMoves card={WAITING} />);

    expect(container.querySelector('[data-move="hand"]')).toBeNull();
  });
});
