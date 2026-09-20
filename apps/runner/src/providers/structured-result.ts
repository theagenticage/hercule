/**
 * Judges what a turn answered under its session's output schema. One place
 * decides this for every provider (spec 06 section 7).
 *
 * Each harness produces a value in its own way, and fails to produce one in
 * its own way: a re-prompt limit, a tool that was never called, a final
 * message that is not JSON. An adapter only has to say which of the two
 * happened. The verdict is taken here, against the declared schema. The value
 * is validated again even when the harness says the value is good, because a
 * harness that validated its own answer would be marking its own work.
 */
import { Validator, type OutputUnit } from "@cfworker/json-schema";
import { MAX_MESSAGE_LENGTH, type OutputSchema, type StructuredResult } from "@hercule/protocol";

/**
 * What the harness produced: a value, or the reason there is no value. The
 * reason is the adapter's own words, and the failure reports it.
 */
export type HarnessAnswer = { readonly value: unknown } | { readonly missing: string };

/** The dialect the subset is written in; the schema crossed the wire as JSON. */
const DRAFT = "7";

/** How deep in the value the unit sits. The root is the shallowest, a leaf the deepest. */
const measureDepth = (unit: OutputUnit): number => unit.instanceLocation.split("/").length;

/**
 * Finds the unit that is about the value itself, not about the object that
 * holds the value. The validator reports one unit per level on the way down:
 * "property x does not match schema" above "expected a number". Only the
 * deepest unit names the field a reader has to fix.
 */
const findDeepestUnit = (units: ReadonlyArray<OutputUnit>): OutputUnit | undefined =>
  units.reduce<OutputUnit | undefined>(
    (deepest, unit) =>
      deepest === undefined || measureDepth(unit) > measureDepth(deepest) ? unit : deepest,
    undefined,
  );

/**
 * Says where the value broke the schema, and how. A closed object refuses a key
 * it does not declare with a boolean schema, and that schema's own message
 * says only "false boolean schema". The real fault is that the key is not
 * allowed, and the location already names the key.
 */
const describeError = (unit: OutputUnit): string =>
  unit.keyword === "false"
    ? `${unit.instanceLocation}: the schema allows no such key`
    : `${unit.instanceLocation}: ${unit.error}`;

/**
 * Judges one answer and gives the turn's result. A value is checked against the
 * schema the session declared. The reason a failure carries is cut to the
 * length the protocol allows, because a longer reason would be an event nobody
 * can decode, and that would lose the result completely.
 */
export const judgeAnswer = (schema: OutputSchema, answer: HarnessAnswer): StructuredResult => {
  if ("missing" in answer) {
    return { outcome: "schema-failure", reason: answer.missing.slice(0, MAX_MESSAGE_LENGTH) };
  }
  // The validator short-circuits. Every unit after the first failure is the
  // same fault reported again from further up, and the run stops at the branch
  // that failed, which is the branch the reason is taken from.
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
