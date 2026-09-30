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

  it("points the message at the GitHub issue or pull request the task came from", () => {
    const entry = { at: AT, actor: "user" } as const;
    const [issue, pull] = buildStartCards([
      buildTask({ id: "a", provenance: [{ ...entry, ref: "github:issue:acme/webshop#12" }] }),
      buildTask({ id: "b", provenance: [{ ...entry, ref: "github:pr:acme/webshop#87" }] }),
    ]);
    expect(issue?.message).toBe("Pick up ticket https://github.com/acme/webshop/issues/12");
    expect(pull?.message).toBe("Pick up pull request https://github.com/acme/webshop/pull/87");
  });

  it("points the message at the task itself when it came from no GitHub issue or pull request", () => {
    const entry = { at: AT, actor: "user" } as const;
    const cards = buildStartCards([
      buildTask({ id: "a", description: "EU cards fail." }),
      buildTask({ id: "b", provenance: [{ ...entry, ref: "github:repo:acme/webshop" }] }),
      buildTask({ id: "c", provenance: [{ ...entry, ref: "sentry:issue:4411" }] }),
    ]);
    expect(cards.map((card) => card.message)).toEqual([
      "Start working on task a: Cart total rounding on discounts",
      "Start working on task b: Cart total rounding on discounts",
      "Start working on task c: Cart total rounding on discounts",
    ]);
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
