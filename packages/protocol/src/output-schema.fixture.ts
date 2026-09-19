/**
 * The two schemas every structured-output proof runs on, written once so the
 * three adapters are held to the same document. One a model can answer, and
 * one nothing can: `answer` has to be both `a` and `b`, which is inside the
 * subset and outside what any value can satisfy, so every harness has to reach
 * a schema failure its own way.
 */
import type { OutputSchema } from "./output-schema";

export const FIXTURE_SCHEMA: OutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "summary"],
  properties: {
    verdict: { type: "string", enum: ["accept", "dismiss"] },
    confidence: { type: "number" },
    summary: { type: "string" },
  },
};

export const IMPOSSIBLE_SCHEMA: OutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: {
    answer: { type: "string", enum: ["a"], const: "b" },
  },
};
