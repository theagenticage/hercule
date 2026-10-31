/**
 * Decides whether a turn's answer satisfies its session's output schema. This
 * module decides it for every provider (spec 06 section 7).
 *
 * Each harness produces a value, or fails to, in its own way: a re-prompt
 * limit, a tool that was never called, a final message that is not JSON. An
 * adapter only reports which of the two happened, and this module checks the
 * value against the declared schema. The value is validated here even when the
 * harness reports it as valid, because a harness validating its own answer
 * would be marking its own work.
 */
import { MAX_MESSAGE_LENGTH, type OutputSchema, type StructuredResult } from "@hercule/protocol";
import { findJsonSchemaViolation } from "@hercule/protocol/json-schema";

/**
 * What the harness produced: a value, or the reason it produced none. The
 * reason is in the adapter's own words, and the failure result includes it.
 */
export type HarnessAnswer = { readonly value: unknown } | { readonly missing: string };

/**
 * Checks a harness answer against the session's output schema and returns the
 * turn's structured result. A failure reason is cut to the length the protocol
 * allows, because a longer reason would make the event impossible to decode,
 * and the result would be lost.
 */
export const judgeAnswer = (schema: OutputSchema, answer: HarnessAnswer): StructuredResult => {
  if ("missing" in answer) {
    return { outcome: "schema-failure", reason: answer.missing.slice(0, MAX_MESSAGE_LENGTH) };
  }
  const violation = findJsonSchemaViolation(schema, answer.value);
  if (violation === undefined) {
    return {
      outcome: "ok",
      value: answer.value as Extract<StructuredResult, { outcome: "ok" }>["value"],
    };
  }
  return {
    outcome: "schema-failure",
    reason: `${violation.location}: ${violation.message}`.slice(0, MAX_MESSAGE_LENGTH),
  };
};
