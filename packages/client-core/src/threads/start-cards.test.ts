/**
 * Tests the start cards: what each card says about its task, and what a click
 * adds to the Message Draft.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "@hercule/contract";
import { appendToMessage, buildStartCards } from "./start-cards";

const AT = "2026-09-30T10:00:00.000Z";

const buildTask = (overrides: Partial<Task>): Task => ({
  id: "task-1",
  title: "Cart total rounding on discounts",
  description: "",
  status: "open",
  priority: "normal",
  labels: [],
  provenance: [],
  createdAt: AT,
  updatedAt: AT,
  statusChangedAt: AT,
  ...overrides,
});

describe("buildStartCards", () => {
  it("calls a task labelled proposed a Proposal, and any other a Task", () => {
    const [proposal, task] = buildStartCards([
      buildTask({ id: "a", labels: ["checkout", "proposed"] }),
      buildTask({ id: "b", labels: ["checkout"] }),
    ]);
    expect(proposal?.kind).toBe("Proposal");
    expect(task?.kind).toBe("Task");
  });

  it("fills one bar for low up to four for urgent", () => {
    const cards = buildStartCards(
      (["low", "normal", "high", "urgent"] as const).map((priority) =>
        buildTask({ id: priority, priority }),
      ),
    );
    expect(cards.map((card) => card.bars)).toEqual([1, 2, 3, 4]);
  });

  it("draws the GitHub mark only when the task's first external ref is a GitHub one", () => {
    const entry = { at: AT, actor: "user" } as const;
    const [github, sentry, bare] = buildStartCards([
      buildTask({
        id: "a",
        provenance: [
          { ...entry, eventId: 7 },
          { ...entry, ref: "github:issue:acme/webshop#12" },
        ],
      }),
      buildTask({ id: "b", provenance: [{ ...entry, ref: "sentry:issue:4411" }] }),
      buildTask({ id: "c", provenance: [{ ...entry, eventId: 8 }] }),
    ]);
    expect(github?.source).toBe("github");
    expect(sentry?.source).toBeNull();
    expect(bare?.source).toBeNull();
  });

  it("puts the description after the title and a blank line, or the title alone when there is none", () => {
    const [described, bare] = buildStartCards([
      buildTask({ id: "a", title: "Fix checkout", description: "  EU cards fail.\n" }),
      buildTask({ id: "b", title: "Fix checkout", description: "   " }),
    ]);
    expect(described?.message).toBe("Fix checkout\n\nEU cards fail.");
    expect(bare?.message).toBe("Fix checkout");
  });
});

describe("appendToMessage", () => {
  it("returns the text alone when the draft is empty or blank", () => {
    expect(appendToMessage("", "Fix checkout")).toBe("Fix checkout");
    expect(appendToMessage(" \n", "Fix checkout")).toBe("Fix checkout");
  });

  it("adds the text after a blank line, without the draft's trailing whitespace", () => {
    expect(appendToMessage("Look at this first.\n", "Fix checkout")).toBe(
      "Look at this first.\n\nFix checkout",
    );
  });
});
