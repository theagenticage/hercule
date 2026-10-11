import { describe, expect, it } from "vitest";
import type { MemoryDocument } from "@hercule/contract";
import { ApiError } from "../errors";
import {
  buildMemoryWrite,
  computeMemoryFill,
  describeShrinkLoss,
  describeTopicCount,
  describeTopicNameConflict,
  dropSavedMemoryEdit,
  formatMemorySize,
  formatMemoryUsage,
  hasUnsavedMemoryEdits,
  isShrinkRejected,
  listMemoryTopics,
  mergeMemoryEdit,
  NO_MEMORY_EDITS,
} from "./memory";

describe("formatMemoryUsage", () => {
  it("groups thousands in both numbers", () => {
    expect(formatMemoryUsage(1284, 4000)).toBe("1,284 of 4,000");
    expect(formatMemoryUsage(0, 12_000)).toBe("0 of 12,000");
  });
});

describe("computeMemoryFill", () => {
  it("returns the share of the cap in use", () => {
    expect(computeMemoryFill(1284, 4000)).toBeCloseTo(0.321);
  });

  it("shows a document over its cap as full", () => {
    expect(computeMemoryFill(4100, 4000)).toBe(1);
  });
});

describe("formatMemorySize", () => {
  it("shows the exact count below 1,000 and thousands with one decimal above", () => {
    expect(formatMemorySize(1234)).toBe("1.2k");
    expect(formatMemorySize(600)).toBe("600");
    expect(formatMemorySize(999)).toBe("999");
    expect(formatMemorySize(1000)).toBe("1.0k");
    expect(formatMemorySize(12_000)).toBe("12.0k");
  });
});

describe("describeTopicCount", () => {
  it("names the count, the count cap and the size cap", () => {
    expect(describeTopicCount(7)).toBe("7 of 24 topics · up to 12,000 characters each");
  });
});

describe("isShrinkRejected", () => {
  it("is true only for a shrink_rejected response", () => {
    expect(
      isShrinkRejected(new ApiError("shrink_rejected", "x", { previousSize: 2000, size: 10 })),
    ).toBe(true);
    expect(isShrinkRejected(new ApiError("cap_exceeded", "x", { size: 5000, cap: 4000 }))).toBe(
      false,
    );
    expect(isShrinkRejected(new Error("x"))).toBe(false);
  });
});

const AT = "2026-10-11T09:00:00.000Z";

const DECISIONS: MemoryDocument = {
  name: "decisions",
  gist: "what we decided and why",
  size: 12,
  body: "Use SQLite.",
  updatedAt: AT,
};

const CORE: MemoryDocument = { name: "core", gist: "", size: 8, body: "Rogier.", updatedAt: AT };

describe("listMemoryTopics", () => {
  it("drops core and keeps the topics in order", () => {
    const entries = [
      { name: "core", gist: "", size: 8 },
      { name: "people", gist: "who is who", size: 30 },
      { name: "decisions", gist: "", size: 12 },
    ];
    expect(listMemoryTopics(entries).map((entry) => entry.name)).toEqual(["people", "decisions"]);
  });
});

describe("hasUnsavedMemoryEdits", () => {
  it("is false with nothing edited and no new topic", () => {
    expect(hasUnsavedMemoryEdits(NO_MEMORY_EDITS)).toBe(false);
  });

  it("is false for a new topic left empty", () => {
    expect(
      hasUnsavedMemoryEdits({ documents: {}, newTopic: { name: "", gist: "", body: "" } }),
    ).toBe(false);
  });

  it("is true for an edited document or a new topic with text in it", () => {
    expect(hasUnsavedMemoryEdits({ documents: { core: { body: "x" } }, newTopic: null })).toBe(
      true,
    );
    expect(
      hasUnsavedMemoryEdits({ documents: {}, newTopic: { name: "", gist: "", body: "x" } }),
    ).toBe(true);
  });
});

describe("mergeMemoryEdit", () => {
  it("keeps the fields that differ from the stored document", () => {
    expect(mergeMemoryEdit(DECISIONS, {}, { gist: "decisions" })).toEqual({ gist: "decisions" });
    expect(mergeMemoryEdit(DECISIONS, { gist: "decisions" }, { body: "Use Postgres." })).toEqual({
      gist: "decisions",
      body: "Use Postgres.",
    });
  });

  it("drops a field typed back to its stored value", () => {
    expect(mergeMemoryEdit(DECISIONS, { body: "Use" }, { body: "Use SQLite." })).toEqual({});
  });
});

describe("buildMemoryWrite", () => {
  it("sends the stored body when only the gist was edited", () => {
    expect(buildMemoryWrite(DECISIONS, { gist: "decisions" })).toEqual({
      body: "Use SQLite.",
      gist: "decisions",
    });
  });

  it("leaves out a gist nobody edited, so another writer's gist is kept", () => {
    expect(buildMemoryWrite(DECISIONS, { body: "Use Postgres." })).toEqual({
      body: "Use Postgres.",
    });
  });

  it("never sends a gist for core", () => {
    expect(buildMemoryWrite(CORE, { gist: "x", body: "Rogier, in Amsterdam." })).toEqual({
      body: "Rogier, in Amsterdam.",
    });
  });
});

describe("dropSavedMemoryEdit", () => {
  it("drops what the save stored and keeps text typed while it ran", () => {
    expect(
      dropSavedMemoryEdit(
        { gist: "decisions", body: "Use Postgres. And" },
        {
          gist: "decisions",
          body: "Use Postgres.",
        },
      ),
    ).toEqual({ body: "Use Postgres. And" });
  });
});

describe("describeTopicNameConflict", () => {
  const entries = [
    { name: "core", gist: "", size: 8 },
    { name: "decisions", gist: "", size: 12 },
  ];

  it("refuses the name of an existing topic and says to open it", () => {
    expect(describeTopicNameConflict(entries, "decisions")).toBe(
      'A topic named "decisions" already exists; open it to edit it.',
    );
  });

  it("refuses core, which is not a topic", () => {
    expect(describeTopicNameConflict(entries, "core")).toBe(
      '"core" is the core note; choose another name.',
    );
  });

  it("accepts a new name", () => {
    expect(describeTopicNameConflict(entries, "people")).toBeUndefined();
  });
});

describe("describeShrinkLoss", () => {
  it("names both sizes of a refused shrink", () => {
    const error = new ApiError("shrink_rejected", "refused", { previousSize: 1284, size: 312 });
    expect(describeShrinkLoss(error)).toBe(
      "This cuts the document from 1,284 to 312 characters. What it cuts cannot be brought back.",
    );
  });

  it("describes nothing for another error, or one without both sizes", () => {
    expect(describeShrinkLoss(new ApiError("cap_exceeded", "too long", { size: 1, cap: 0 }))).toBe(
      undefined,
    );
    expect(describeShrinkLoss(new ApiError("shrink_rejected", "refused"))).toBe(undefined);
  });
});
