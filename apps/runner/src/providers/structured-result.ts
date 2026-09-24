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
import { Validator, type OutputUnit } from "@cfworker/json-schema";
import { MAX_MESSAGE_LENGTH, type OutputSchema, type StructuredResult } from "@hercule/protocol";

/**
 * What the harness produced: a value, or the reason it produced none. The
 * reason is in the adapter's own words, and the failure result includes it.
 */
export type HarnessAnswer = { readonly value: unknown } | { readonly missing: string };

/**
 * The JSON Schema draft of the supported subset. The schema arrives as plain JSON, so the validator
 * is told.
 */
const DRAFT = "7";

/**
 * Returns how deep in the value an error unit is. The root is the shallowest, a leaf the deepest.
 */
const measureDepth = (unit: OutputUnit): number => unit.instanceLocation.split("/").length;

/**
 * Returns the error unit about the value itself, not about the objects that
 * contain it. The validator reports one unit per level on the way down, for
 * example "property x does not match schema" above "expected a number". Only
 * the deepest unit names the field the reader has to fix.
 */
const findDeepestUnit = (units: ReadonlyArray<OutputUnit>): OutputUnit | undefined =>
  units.reduce<OutputUnit | undefined>(
    (deepest, unit) =>
      deepest === undefined || measureDepth(unit) > measureDepth(deepest) ? unit : deepest,
    undefined,
  );

/**
 * Formats an error unit as `<location>: <message>`. A closed object rejects an
 * undeclared key through a `false` boolean schema, whose own message is only
 * "false boolean schema". The real problem is that the key is not allowed, and
 * the location already names the key.
 */
const describeError = (unit: OutputUnit): string =>
  unit.keyword === "false"
    ? `${unit.instanceLocation}: the schema does not allow this key`
    : `${unit.instanceLocation}: ${unit.error}`;

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
  // The validator short-circuits: it stops at the first branch that fails.
  // Every unit it returns describes that one failure, reported again at each
  // level above it, so the reason comes from the deepest unit.
  const checked = new Validator(schema, DRAFT, true).validate(answer.value);
  if (checked.valid) {
    return {
      outcome: "ok",
      value: answer.value as Extract<StructuredResult, { outcome: "ok" }>["value"],
    };
  }
  const unit = findDeepestUnit(checked.errors);
  return {
    outcome: "schema-failure",
    reason: (unit === undefined
      ? "the value does not satisfy the schema"
      : describeError(unit)
    ).slice(0, MAX_MESSAGE_LENGTH),
  };
};
