/** Tests the words the undo line uses for a move: which place it names, and how a long title is cut. */
import { describe, expect, it } from "vitest";
import type { WorkCard } from "@hercule/contract";
import { buildCard } from "./cards.testing";
import { describeCardMove, describeCardsMove, describeMoveFailure } from "./describe-card-move";

const PROJECTS = [{ id: "storefront", name: "Storefront" }];

const INITIATIVES = [{ id: "platform", name: "Platform", hue: 245 as const }];

const card = (overrides: Partial<WorkCard> = {}): WorkCard =>
  buildCard("task-1", { title: "Review PR", stage: "building", ...overrides });

describe("describeCardMove", () => {
  it.each([
    [
      "a new stage",
      card(),
      { taskId: "task-1", stage: "in-review" as const },
      'Moved "Review PR" to In review',
    ],
    [
      "a new Project",
      card({ projectId: "other" }),
      { taskId: "task-1", projectId: "storefront" },
      'Moved "Review PR" to Storefront',
    ],
    [
      "no Project",
      card({ projectId: "storefront" }),
      { taskId: "task-1", projectId: null },
      'Moved "Review PR" to No project',
    ],
    [
      "a new stage in a new Project",
      card(),
      { taskId: "task-1", stage: "planned" as const, projectId: "storefront" },
      'Moved "Review PR" to Planned in Storefront',
    ],
    [
      "a new Initiative",
      card(),
      { taskId: "task-1", initiativeId: "platform" },
      'Moved "Review PR" to Platform',
    ],
    [
      "a new stage on an Initiative",
      card(),
      { taskId: "task-1", stage: "planned" as const, initiativeId: "platform" },
      'Moved "Review PR" to Planned in Platform',
    ],
    [
      "an Initiative that is not listed",
      card(),
      { taskId: "task-1", initiativeId: "closed" },
      'Moved "Review PR" to another initiative',
    ],
    [
      "taking the card off its Initiative",
      card({ initiativeId: "platform" }),
      { taskId: "task-1", initiativeId: null },
      'Moved "Review PR" out of Platform',
    ],
    [
      "a new stage and taking the card off its Initiative",
      card({ initiativeId: "platform" }),
      { taskId: "task-1", stage: "planned" as const, projectId: "storefront", initiativeId: null },
      'Moved "Review PR" to Planned in Storefront out of Platform',
    ],
    [
      "a no-op clearing of no Initiative",
      card(),
      { taskId: "task-1", initiativeId: null },
      'Moved "Review PR" in Building',
    ],
    [
      "a new place in the same cell",
      card(),
      { taskId: "task-1", stage: "building" as const, afterTaskId: null },
      'Moved "Review PR" in Building',
    ],
  ])("names the place for %s", (_name, before, move, words) => {
    expect(describeCardMove(before, move, PROJECTS, INITIATIVES)).toBe(words);
  });

  it("cuts a long title", () => {
    const words = describeCardMove(
      card({ title: "x".repeat(50) }),
      { taskId: "task-1", stage: "planned" },
      PROJECTS,
      INITIATIVES,
    );

    expect(words).toBe(`Moved "${"x".repeat(31)}…" to Planned`);
  });
});

describe("describeCardsMove", () => {
  it.each([
    [
      "cards that change only their stage",
      [
        { taskId: "a", stage: "in-review" as const, afterTaskId: null },
        { taskId: "b", stage: "in-review" as const, afterTaskId: "a" },
      ],
      "in-review" as const,
      "Moved 2 Tasks to In review",
    ],
    [
      "a card that changes Project",
      [
        { taskId: "a", stage: "planned" as const },
        { taskId: "b", stage: "planned" as const, projectId: "storefront" },
        { taskId: "c", stage: "planned" as const, projectId: "storefront" },
      ],
      "planned" as const,
      "Moved 3 Tasks to Planned in Storefront",
    ],
    [
      "cards that go to No project",
      [
        { taskId: "a", stage: "planned" as const, projectId: null },
        { taskId: "b", stage: "planned" as const, projectId: null, afterTaskId: "a" },
      ],
      "planned" as const,
      "Moved 2 Tasks to Planned in No project",
    ],
    [
      "cards that join an Initiative",
      [
        { taskId: "a", stage: "planned" as const, initiativeId: "platform" },
        { taskId: "b", stage: "planned" as const },
      ],
      "planned" as const,
      "Moved 2 Tasks to Planned in Platform",
    ],
  ])("names the place for %s", (_name, moves, stage, words) => {
    expect(describeCardsMove(moves, stage, PROJECTS, INITIATIVES)).toBe(words);
  });
});

describe("describeMoveFailure", () => {
  it("says the card went back and why, ending in one full stop", () => {
    expect(describeMoveFailure("The Task is gone.")).toBe(
      "The move did not save, so the card went back: The Task is gone. Try the move again.",
    );
  });
});
