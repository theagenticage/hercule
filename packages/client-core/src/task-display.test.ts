import { describe, expect, it } from "vitest";
import { priorityGlyph, provenanceTarget, taskRecedes } from "./task-display";

describe("priorityGlyph", () => {
  it("gives every priority its own reading out of bars and grey", () => {
    const readings = (["low", "normal", "high", "urgent"] as const).map((priority) => {
      const glyph = priorityGlyph(priority);
      return `${String(glyph.filled)}/${glyph.tone}`;
    });
    expect(new Set(readings).size).toBe(4);
  });

  it("rises with the priority and never falls", () => {
    const bars = (["low", "normal", "high", "urgent"] as const).map(
      (priority) => priorityGlyph(priority).filled,
    );
    expect(bars).toEqual([...bars].sort((a, b) => a - b));
  });
});

describe("taskRecedes", () => {
  it("steps finished work back whatever it was worth", () => {
    expect(taskRecedes({ status: "done", priority: "urgent" })).toBe(true);
    expect(taskRecedes({ status: "cancelled", priority: "urgent" })).toBe(true);
  });

  it("steps back what was never urgent, and leaves the rest standing", () => {
    expect(taskRecedes({ status: "open", priority: "low" })).toBe(true);
    expect(taskRecedes({ status: "open", priority: "normal" })).toBe(false);
    expect(taskRecedes({ status: "in-progress", priority: "high" })).toBe(false);
  });
});

describe("provenanceTarget", () => {
  const stamp = { at: "2026-09-04T15:21:31.646Z", actor: "user" } as const;

  it("names the external thing, the event and the run", () => {
    expect(provenanceTarget({ ...stamp, ref: "github:issue:rogierpennink/hydra#61" })).toBe(
      "github:issue:rogierpennink/hydra#61",
    );
    expect(provenanceTarget({ ...stamp, eventId: 4242 })).toBe("event 4242");
    expect(provenanceTarget({ ...stamp, runId: "01a06d02-beca-760b-a6b2-83af536c3c20" })).toBe(
      "run 01a06d02-beca-760b-a6b2-83af536c3c20",
    );
  });

  it("says all of them when an entry names several", () => {
    expect(provenanceTarget({ ...stamp, ref: "github:issue:a/b#1", eventId: 7 })).toBe(
      "github:issue:a/b#1 · event 7",
    );
  });
});
