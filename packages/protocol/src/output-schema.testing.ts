/**
 * The two schemas every structured-output test uses, written once so the three
 * adapters are tested against the same document. Imported as
 * `@hercule/protocol/testing` from a package, and by relative path from `e2e/`,
 * which depends on no Hercule package. A model can satisfy the first schema
 * and nothing can satisfy the second: `answer` has to be both `a` and `b`,
 * which is inside the subset but matches no value, so every harness has to
 * reach a schema failure its own way.
 *
 * `nestInLists` builds values for tests of the depth limit, `MAX_JSON_DEPTH`.
 * The limit is declared in this package, and every package that applies it
 * uses this helper in its tests.
 */
import type { OutputSchema } from "./output-schema";

/** Returns a string wrapped in `levels` nested arrays. */
export const nestInLists = (levels: number): unknown =>
  Array.from({ length: levels }).reduce<unknown>((inner) => [inner], "bottom");

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
 * The system prompt for a session under either schema, added to the harness's
 * own prompt. It tells the model to give the verdict the user asks for, so the
 * result depends on the schema and not on the model's judgement.
 */
export const ASSESSOR_SYSTEM_PROMPT =
  "You assess tasks and answer with a verdict. Where the user names the verdict, give that one.";

/** The prompt sent under `FIXTURE_SCHEMA`; it states the verdict to give. */
export const FIXTURE_PROMPT = "Assess this task: 'Fix a typo in the README'. Accept it.";

/**
 * The prompt sent under `IMPOSSIBLE_SCHEMA`. It asks for nothing in
 * particular: the test checks the schema failure, not the answer.
 */
export const IMPOSSIBLE_PROMPT = "Answer.";
