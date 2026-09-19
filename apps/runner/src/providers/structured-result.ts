/**
 * What a turn answered under its session's output schema, decided in one place
 * for every provider (spec 06 section 7).
 *
 * Each harness has its own way of producing a value and its own way of failing
 * to - a re-prompt limit, a tool never called, a final message that is not
 * JSON - so an adapter's whole job is to say which of the two happened. The
 * verdict is taken here, from the declared schema, because a harness that
 * validated its own answer is a harness Hydra is trusting to mark its own
 * work: the value is re-validated even when the harness says it is good.
 */
import { Validator, type OutputUnit } from "@cfworker/json-schema";
import { MAX_MESSAGE_LENGTH, type OutputSchema, type StructuredResult } from "@hydra/protocol";

/**
 * What the harness produced: a value, or the reason there is none. The reason
 * is the adapter's own words, and it is what the failure says.
 */
export type StructuredCandidate = { readonly value: unknown } | { readonly missing: string };

/** The dialect the subset is written in; the schema crossed the wire as JSON. */
const DRAFT = "7";

/** How deep in the value a unit is about: the root is nothing, a leaf is most. */
const depthOf = (unit: OutputUnit): number => unit.instanceLocation.split("/").length;

/**
 * The unit that is about the value itself rather than about the object holding
 * it. A validator reports one unit per level on the way down - "property x
 * does not match schema" above "expected a number" - and only the deepest one
 * names the field a reader has to fix.
 */
const deepest = (units: ReadonlyArray<OutputUnit>): OutputUnit | undefined =>
  units.reduce<OutputUnit | undefined>(
    (found, unit) => (found === undefined || depthOf(unit) > depthOf(found) ? unit : found),
    undefined,
  );

/**
 * Where the value broke the schema, and how. A closed object refuses a key it
 * does not declare with a boolean schema, whose own message says only "false
 * boolean schema"; what happened is that the key is not allowed, and the
 * location already names it.
 */
const describeError = (unit: OutputUnit): string =>
  unit.keyword === "false"
    ? `${unit.instanceLocation}: the schema allows no such key`
    : `${unit.instanceLocation}: ${unit.error}`;

/**
 * The turn's result. A value is checked against the schema the session
 * declared, and what the failure says is cut to what the protocol carries: a
 * reason longer than that would be an event nobody can decode, which loses the
 * result altogether.
 */
export const structuredResultOf = (
  schema: OutputSchema,
  candidate: StructuredCandidate,
): StructuredResult => {
  if ("missing" in candidate) {
    return { outcome: "schema-failure", reason: candidate.missing.slice(0, MAX_MESSAGE_LENGTH) };
  }
  // Short-circuiting: every unit past the first failure is the same mistake
  // reported again from further up, and the run stops at the branch that
  // failed, which is the branch the reason is taken from.
  const checked = new Validator(schema, DRAFT, true).validate(candidate.value);
  if (checked.valid) {
    return {
      outcome: "ok",
      value: candidate.value as Extract<StructuredResult, { outcome: "ok" }>["value"],
    };
  }
  const unit = deepest(checked.errors);
  return {
    outcome: "schema-failure",
    reason: (unit === undefined
      ? "the value does not satisfy the schema"
      : describeError(unit)
    ).slice(0, MAX_MESSAGE_LENGTH),
  };
};
