/**
 * Tests the card of the Work board where Initiatives and blockers reach it: a
 * card that waits on another Task goes quiet and says so, a failure or a
 * question outranks that, and a card of an Initiative draws its small flag.
 */
import type { JSX } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { WorkCard } from "@hercule/contract";
import type { WorkInitiative } from "@hercule/client-core/work";
import { buildCard, FAILURE, QUESTION } from "@hercule/client-core/work/testing";
import { WorkCardView } from "./work-card";

const BLOCKER = { id: "blocker-1", title: "Round loyalty points", stage: "building" } as const;

const INITIATIVE: WorkInitiative = {
  id: "initiative-1",
  name: "Accessible checkout",
  hue: 200,
  projectId: null,
};

/** Returns a card that waits on `BLOCKER` and, by `count`, on that many Tasks in all. */
const buildBlockedCard = (overrides: Partial<WorkCard> = {}, count = 1): WorkCard =>
  buildCard("blocked-1", {
    title: "Can coupons stack with loyalty points?",
    blockedBy: [BLOCKER],
    blockedByCount: count,
    ...overrides,
  });

function Card({
  card,
  initiative,
}: {
  readonly card: WorkCard;
  readonly initiative?: WorkInitiative;
}): JSX.Element {
  return (
    <WorkCardView
      card={card}
      laneId="lane-1"
      plugins={[]}
      alsoWords={undefined}
      alsoNames={undefined}
      initiative={initiative}
      isTabStop={false}
      isStill
      canWriteSummaries={false}
      isSelected={false}
      isSelecting={false}
      onPress={vi.fn()}
      onFocus={vi.fn()}
    />
  );
}

const findCardElement = (): HTMLElement => screen.getByRole("button");

describe("a card that waits on another Task", () => {
  it("is drawn quiet, with a lock before what it waits on, and keeps its title", () => {
    render(<Card card={buildBlockedCard()} />);
    const element = findCardElement();
    expect(element.dataset["state"]).toBe("blocked");
    expect(element.dataset["blockedBy"]).toBe("blocker-1");
    expect(element.dataset["now"]).toBe("blocked");
    expect(element.querySelector(".card-title")?.textContent).toBe(
      "Can coupons stack with loyalty points?",
    );
    const now = element.querySelector(".card-now");
    expect(now?.textContent).toBe("Waits on Round loyalty points.");
    expect(now?.querySelector(".card-lock svg")).not.toBeNull();
  });

  it("counts the other Tasks it waits on", () => {
    render(<Card card={buildBlockedCard({}, 3)} />);
    expect(findCardElement().querySelector(".card-now")?.textContent).toBe(
      "Waits on Round loyalty points and 2 more.",
    );
  });

  it("is read by a screen reader with what it waits on", () => {
    render(<Card card={buildBlockedCard()} />);
    expect(findCardElement().getAttribute("aria-label")).toContain("Waits on Round loyalty points");
  });

  it("draws as failed, not quiet, when a run on it failed", () => {
    render(<Card card={buildBlockedCard({ failure: FAILURE })} />);
    const element = findCardElement();
    expect(element.dataset["state"]).toBeUndefined();
    expect(element.dataset["blockedBy"]).toBeUndefined();
    expect(element.dataset["now"]).toBe("failed");
    expect(element.querySelector(".card-lock")).toBeNull();
  });

  it("draws as asking, not quiet, when a Thread of it asks a question", () => {
    render(<Card card={buildBlockedCard({ openQuestion: QUESTION })} />);
    const element = findCardElement();
    expect(element.dataset["state"]).toBeUndefined();
    expect(element.dataset["blockedBy"]).toBeUndefined();
    expect(element.dataset["now"]).toBe("question");
    expect(element.querySelector(".card-lock")).toBeNull();
  });

  it("draws as landed, not quiet, once it is in Landed", () => {
    render(<Card card={buildBlockedCard({ stage: "landed" })} />);
    const element = findCardElement();
    expect(element.dataset["state"]).toBe("landed");
    expect(element.dataset["blockedBy"]).toBeUndefined();
  });

  it("draws like any card when nothing holds it back", () => {
    render(<Card card={buildCard("free-1")} />);
    const element = findCardElement();
    expect(element.dataset["state"]).toBeUndefined();
    expect(element.dataset["blockedBy"]).toBeUndefined();
    expect(element.querySelector(".card-lock")).toBeNull();
  });
});

describe("the small flag of an Initiative", () => {
  it("is drawn beside the age in the Initiative's colour, named for the Initiative", () => {
    render(
      <Card card={buildCard("free-1", { initiativeId: "initiative-1" })} initiative={INITIATIVE} />,
    );
    const element = findCardElement();
    const flag = element.querySelector<HTMLElement>(".card-meta .card-plan");
    expect(flag?.getAttribute("title")).toBe("Accessible checkout");
    expect(flag?.style.getPropertyValue("--plan-hue")).toBe("200");
    expect(flag?.querySelector("svg")).not.toBeNull();
    expect(element.getAttribute("aria-label")).toContain("Initiative Accessible checkout.");
  });

  it("is not drawn on a card the screen gives no Initiative", () => {
    render(<Card card={buildCard("free-1", { initiativeId: "initiative-1" })} />);
    expect(findCardElement().querySelector(".card-plan")).toBeNull();
    expect(findCardElement().getAttribute("aria-label")).not.toContain("Initiative");
  });
});
