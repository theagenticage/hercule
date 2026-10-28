/**
 * Ignore Rules: the user's rules that keep signals of one plugin kind, with
 * given match values, from being raised.
 *
 * A rule matches a signal when every one of its values equals the signal's
 * value for that match field. A rule is never edited: the user deletes it and
 * makes a new one. Each event a rule stops leaves one catch row for the
 * rule's kind, which is what "caught 142" counts.
 *
 * An Ignore Rule has no grant family of its own. It is part of how signals
 * are raised, so its operations sit under `signal.read` and `signal.write`.
 *
 * Spec 10 §9.9 owns the record and its rules; spec 11 §2 (`ignoreRule`) owns
 * the operations.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { Conflict, Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { closedRecord } from "../closed";
import { Actor, Id, Timestamp } from "../ids";
import { Authenticated } from "../security";
import type { SignalMatchFieldLabel } from "./intake-settings";
import { countJsonBytes, MAX_BOUND_INPUT_BYTES } from "./notification";
import {
  MAX_SIGNAL_MATCH_FIELD_NAME_LENGTH,
  MAX_SIGNAL_MATCH_FIELDS,
  MAX_SIGNAL_MATCH_VALUE_LENGTH,
  SignalKind,
  SignalMatch,
} from "./signal";

/**
 * The values a new rule matches on. At least one, because a rule with none
 * would stop the whole kind, and the Intake settings' switch already does that.
 * A record that dropped a malformed field name would silently stop more
 * signals than the user asked for, so the record is closed.
 */
const IgnoreRuleMatch = closedRecord(
  Schema.String.check(
    Schema.isBetweenLength(1, MAX_SIGNAL_MATCH_FIELD_NAME_LENGTH, {
      message: `A match field's name has 1 to ${MAX_SIGNAL_MATCH_FIELD_NAME_LENGTH} characters, as a kind declares its match fields.`,
    }),
  ),
  Schema.String.check(Schema.isMaxLength(MAX_SIGNAL_MATCH_VALUE_LENGTH)),
).check(
  Schema.makeFilter((match) =>
    Object.keys(match).length === 0
      ? "A rule needs at least one value to match on. To stop every signal of the kind, switch the kind off instead: hercule plugin update-intake."
      : undefined,
  ),
  Schema.makeFilter((match) =>
    Object.keys(match).length > MAX_SIGNAL_MATCH_FIELDS
      ? `A rule matches on at most ${MAX_SIGNAL_MATCH_FIELDS} values, as a kind declares at most that many match fields.`
      : undefined,
  ),
);

/**
 * An Ignore Rule. `text` is written from the kind's label and the match
 * fields' labels when the rule is created, such as "Review requested ·
 * Repository acme/webshop · Author dependabot[bot]", and never changes.
 */
export const IgnoreRule = Schema.Struct({
  id: Id,
  kind: SignalKind,
  match: SignalMatch,
  text: Schema.String,
  createdAt: Timestamp,
  /** Always `user`: only the user creates a rule. */
  actor: Actor,
});

export type IgnoreRule = Schema.Schema.Type<typeof IgnoreRule>;

/**
 * A rule as `ignoreRule.query` lists it: the rule, how many events in the log
 * it caught, and when it caught the last one. The count covers only the
 * events still in the log, because a catch is pruned with its event.
 */
export const IgnoreRuleWithCatches = Schema.Struct({
  ...IgnoreRule.fields,
  caughtCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Absent while the rule has caught nothing still in the log. */
  lastCaughtAt: Schema.optionalKey(Timestamp),
});

export type IgnoreRuleWithCatches = Schema.Schema.Type<typeof IgnoreRuleWithCatches>;

/** The query of `ignoreRule.query`. */
export const IgnoreRuleFilter = Schema.Struct({
  /** Only the rules of this kind. */
  kind: Schema.optionalKey(SignalKind),
});

export type IgnoreRuleFilter = Schema.Schema.Type<typeof IgnoreRuleFilter>;

/**
 * The payload of `ignoreRule.create`, which is also its whole input when an
 * answer on a signal runs it. So it must fit `MAX_BOUND_INPUT_BYTES` of JSON,
 * as every bound input does, or Hercule could never offer the same rule.
 */
export const IgnoreRuleCreateInput = Schema.Struct({
  kind: SignalKind,
  match: IgnoreRuleMatch,
}).check(
  Schema.makeFilter((input) =>
    countJsonBytes(input) > MAX_BOUND_INPUT_BYTES
      ? {
          path: ["match"],
          issue: `The rule is larger than ${MAX_BOUND_INPUT_BYTES} bytes of JSON, and an answer binds it as its input. Match on fewer values.`,
        }
      : undefined,
  ),
);

export type IgnoreRuleCreateInput = Schema.Schema.Type<typeof IgnoreRuleCreateInput>;

/**
 * The labels a plugin declares for a signal kind, which name a rule's values:
 * the kind's own label, such as "Review requested", and the label of each of
 * its match fields, such as "Repository" for `repo`.
 */
export interface SignalKindLabels {
  readonly label: string;
  readonly matchFields: ReadonlyArray<SignalMatchFieldLabel>;
}

/**
 * Returns the value `match` holds for the field `name`, or `undefined` when it
 * holds none. Only the fields `match` itself holds count, so a field named
 * like a property every object inherits, such as `constructor`, is not read
 * from the object's prototype.
 */
export const readMatchValue = (match: SignalMatch, name: string): string | undefined =>
  Object.hasOwn(match, name) ? match[name] : undefined;

/**
 * Checks whether `match`, a signal's values, holds every one of `ruleMatch`'s
 * values. The signal may hold more values than the rule.
 */
export const isMatchedByRule = (match: SignalMatch, ruleMatch: SignalMatch): boolean =>
  Object.entries(ruleMatch).every(([name, value]) => readMatchValue(match, name) === value);

/**
 * Checks whether two sets of match values name the same fields with the same
 * values, in any order. Order is ignored because a plugin update may reorder
 * a kind's match fields after a rule was stored.
 */
export const hasSameValues = (a: SignalMatch, b: SignalMatch): boolean =>
  Object.keys(a).length === Object.keys(b).length && isMatchedByRule(a, b);

/**
 * Returns each of `match`'s fields with its label and its value, in the order
 * the kind declares its match fields. The stored order of `match` is sorted by
 * name, which is not an order a person reads. A field `labels` does not
 * declare, because a plugin update removed it or the plugin is gone, comes
 * last and is labelled with its name.
 */
export const listLabeledValues = (
  labels: SignalKindLabels,
  match: SignalMatch,
): ReadonlyArray<{ readonly field: string; readonly label: string; readonly value: string }> => {
  const declared = labels.matchFields.flatMap(({ name, label }) => {
    const value = readMatchValue(match, name);
    return value === undefined ? [] : [{ field: name, label, value }];
  });
  const undeclared = Object.entries(match)
    .filter(([field]) => !labels.matchFields.some((each) => each.name === field))
    .map(([field, value]) => ({ field, label: field, value }));
  return [...declared, ...undeclared];
};

/**
 * Returns a match value as the apps and the describe line show it. An empty
 * value reads "(empty)", so a line such as "Author (empty)" never shows a
 * label with nothing after it.
 */
export const describeMatchValue = (value: string): string => (value === "" ? "(empty)" : value);

/**
 * Builds a rule's text from the kind's label and each field's label and
 * value, such as "Review requested · Repository acme/webshop · Author
 * dependabot[bot]". The text is written once, when the rule is created.
 */
export const buildIgnoreRuleText = (labels: SignalKindLabels, match: SignalMatch): string =>
  [
    labels.label,
    ...listLabeledValues(labels, match).map(
      ({ label, value }) => `${label} ${describeMatchValue(value)}`,
    ),
  ].join(" · ");

/**
 * The Ignore Rule operations: list the rules with what they caught, create a
 * rule, and delete one.
 */
export const ignoreRule = HttpApiGroup.make("ignoreRule")
  .add(
    // The list is not paged: a user keeps a handful of rules, and Settings
    // shows them all.
    HttpApiEndpoint.get("query", "/ignore-rules", {
      query: IgnoreRuleFilter,
      success: Schema.Array(IgnoreRuleWithCatches),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.post("create", "/ignore-rules", {
      payload: IgnoreRuleCreateInput,
      success: IgnoreRule,
      error: [Unauthenticated, Forbidden, Validation, Conflict, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/ignore-rules/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);
