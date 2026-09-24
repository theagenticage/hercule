import { describe, expect, it } from "vitest";
import { readPriorityGlyph, describeProvenanceTarget, shouldTaskRecede } from "./task-display";

describe("readPriorityGlyph", () => {
  it("gives every priority a different combination of bars and grey", () => {
    const readings = (["low", "normal", "high", "urgent"] as const).map((priority) => {
      const glyph = readPriorityGlyph(priority);
      return `${String(glyph.filled)}/${glyph.tone}`;
    });
    expect(new Set(readings).size).toBe(4);
  });

  it("fills at least as many bars for each higher priority", () => {
    const bars = (["low", "normal", "high", "urgent"] as const).map(
      (priority) => readPriorityGlyph(priority).filled,
    );
    expect(bars).toEqual([...bars].sort((a, b) => a - b));
  });
});

describe("shouldTaskRecede", () => {
  it("fades finished tasks whatever their priority", () => {
    expect(shouldTaskRecede({ status: "done", priority: "urgent" })).toBe(true);
    expect(shouldTaskRecede({ status: "cancelled", priority: "urgent" })).toBe(true);
  });

  it("fades low-priority tasks and leaves the rest", () => {
    expect(shouldTaskRecede({ status: "open", priority: "low" })).toBe(true);
    expect(shouldTaskRecede({ status: "open", priority: "normal" })).toBe(false);
    expect(shouldTaskRecede({ status: "in-progress", priority: "high" })).toBe(false);
  });
});

describe("describeProvenanceTarget", () => {
  const stamp = { at: "2026-09-04T15:21:31.646Z", actor: "user" } as const;

  it("shows the external ref, the event and the run", () => {
    expect(describeProvenanceTarget({ ...stamp, ref: "github:issue:rogierpennink/hydra#61" })).toBe(
      "github:issue:rogierpennink/hydra#61",
    );
    expect(describeProvenanceTarget({ ...stamp, eventId: 4242 })).toBe("event 4242");
    expect(
      describeProvenanceTarget({ ...stamp, runId: "01a06d02-beca-760b-a6b2-83af536c3c20" }),
    ).toBe("run 01a06d02-beca-760b-a6b2-83af536c3c20");
  });

  it("shows all of them when an entry has several", () => {
    expect(describeProvenanceTarget({ ...stamp, ref: "github:issue:a/b#1", eventId: 7 })).toBe(
      "github:issue:a/b#1 · event 7",
    );
  });
});
