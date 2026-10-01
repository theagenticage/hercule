import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type { OpenRequest } from "@hercule/protocol";
import { validateAnswers } from "./responses";

/** A question request whose only header is also a property every object inherits. */
const OPEN: OpenRequest = {
  requestId: "r1",
  itemId: "i1",
  kind: "question",
  detail: {
    questions: [
      { question: "Which constructor?", header: "constructor", options: [], multiSelect: false },
      { question: "Which storage?", header: "Storage", options: [], multiSelect: false },
    ],
  },
};

describe("validateAnswers", () => {
  it("refuses answers that leave out a question whose header an object inherits", () => {
    const refused = Effect.runSync(Effect.flip(validateAnswers(OPEN, { Storage: "localStorage" })));

    expect(refused.error.details.issues.map((issue) => issue.path)).toEqual([
      ["answers", "constructor"],
    ]);
  });

  it("accepts that question once it is answered", () => {
    const answers = { constructor: "the default one", Storage: "localStorage" };

    expect(Effect.runSync(Effect.exit(validateAnswers(OPEN, answers)))._tag).toBe("Success");
  });
});
