import { describe, expect, it } from "vitest";
import type { WorkCard } from "@hercule/contract";
import { describeCardMove } from "./describe-card-move";

const PROJECTS = [{ id: "storefront", name: "Storefront" }];

const card = (overrides: Partial<WorkCard> = {}): WorkCard => ({
  id: "task-1",
  title: "Review PR",
  stage: "building",
  priority: "normal",
  boardRank: "a",
  threadCount: 1,
  createdAt: "2026-11-01T09:00:00.000Z",
  stageChangedAt: "2026-11-01T09:00:00.000Z",
  lastActivityAt: "2026-11-01T09:00:00.000Z",
  ...overrides,
});

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
      "a new place in the same cell",
      card(),
      { taskId: "task-1", stage: "building" as const, afterTaskId: null },
      'Moved "Review PR" in Building',
    ],
  ])("names the place for %s", (_name, before, move, words) => {
    expect(describeCardMove(before, move, PROJECTS)).toBe(words);
  });

  it("cuts a long title", () => {
    const words = describeCardMove(
      card({ title: "x".repeat(50) }),
      { taskId: "task-1", stage: "planned" },
      PROJECTS,
    );

    expect(words).toBe(`Moved "${"x".repeat(31)}…" to Planned`);
  });
});
