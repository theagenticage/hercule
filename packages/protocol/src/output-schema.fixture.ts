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

/**
 * What the session under either schema is told it is, above the harness's own
 * prompt. It names the verdict the user asks for so the answer is the schema's
 * business and not the model's judgement.
 */
export const ASSESSOR_SYSTEM_PROMPT =
  "You assess tasks and answer with a verdict. Where the user names the verdict, give that one.";

/** The prompt asked under `FIXTURE_SCHEMA`; it names the verdict to give. */
export const FIXTURE_PROMPT = "Assess this task: 'Fix a typo in the README'. Accept it.";

/**
 * The prompt asked under `IMPOSSIBLE_SCHEMA`. It asks for nothing in
 * particular: what is being proven is the schema failure, not the answer.
 */
export const IMPOSSIBLE_PROMPT = "Answer.";
