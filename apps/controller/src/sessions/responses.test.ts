import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type { OpenRequest } from "@hercule/protocol";
import { validateResponse } from "./responses";

/** A question request whose only header is also a property every object inherits. */
const OPEN: OpenRequest = {
  requestId: "r1",
  itemId: "i1",
  kind: "question",
  decisions: ["deny", "cancel"],
  detail: {
    questions: [
      { question: "Which constructor?", header: "constructor", options: [], multiSelect: false },
      { question: "Which storage?", header: "Storage", options: [], multiSelect: false },
    ],
  },
};

describe("validateResponse", () => {
  it("refuses answers that leave out a question whose header an object inherits", () => {
    const refused = Effect.runSync(
      Effect.flip(validateResponse(OPEN, { answers: { Storage: "localStorage" } })),
    );

    expect(refused.error.details.issues.map((issue) => issue.path)).toEqual([
      ["answers", "constructor"],
    ]);
  });

  it("accepts that question once it is answered", () => {
    const answers = { constructor: "the default one", Storage: "localStorage" };

    expect(Effect.runSync(validateResponse(OPEN, { answers }))).toEqual({ answers });
  });
});
