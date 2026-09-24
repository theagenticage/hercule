/**
 * Checks a JSON value against a JSON Schema (draft 7), for the runner, which
 * checks a turn's answer against its session's output schema, and the
 * controller, which checks a run's inputs against the workflow's input
 * schemas.
 *
 * It lives in the protocol package because both roles need it, and the runner
 * may not import any controller package: the protocol is the one package the
 * two roles share. It is a subpath of its own so that a package that does not
 * check values never links the validator.
 */
import { Validator, type OutputUnit } from "@cfworker/json-schema";

/** The JSON Schema draft of the supported subset. The schema arrives as plain JSON, so the validator is told. */
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
 * Where a value breaks its schema, and why.
 *
 * `location` is a JSON Pointer into the value, `#` for the value itself and
 * `#/title` for its `title` key. `message` is the validator's sentence.
 */
export interface JsonSchemaViolation {
  readonly location: string;
  readonly message: string;
}

/**
 * Returns the violation an error unit reports. A closed object rejects an
 * undeclared key through a `false` boolean schema, whose own message is only
 * "false boolean schema". The real problem is that the key is not allowed, and
 * the location already names the key.
 */
const buildViolation = (unit: OutputUnit): JsonSchemaViolation => ({
  location: unit.instanceLocation,
  message: unit.keyword === "false" ? "the schema does not allow this key" : unit.error,
});

/**
 * Checks `value` against `schema`. Returns `undefined` when the value is
 * valid, and otherwise where the value is wrong and why.
 *
 * The validator short-circuits: it stops at the first branch that fails.
 * Every unit it returns describes that one failure, reported again at each
 * level above it, so the violation comes from the deepest unit.
 *
 * Throws when the validator cannot use the schema; a caller whose schema was
 * not checked beforehand catches that.
 */
export const findJsonSchemaViolation = (
  schema: object,
  value: unknown,
): JsonSchemaViolation | undefined => {
  const checked = new Validator(schema, DRAFT, true).validate(value);
  if (checked.valid) return undefined;
  const unit = findDeepestUnit(checked.errors);
  return unit === undefined
    ? { location: "#", message: "the value does not satisfy the schema" }
    : buildViolation(unit);
};
