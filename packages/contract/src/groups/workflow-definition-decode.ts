/**
 * `decodeWorkflowDefinition`, the function that validates a value as a
 * workflow definition, and the error messages it writes. The schema itself is
 * in `./workflow-definition`.
 *
 * It sits in a module of its own because the desktop app builds every module
 * its first screen imports into one chunk: a client that only draws a
 * definition, and never validates one, then loads none of this code at start.
 */
import { Result, Schema, SchemaAST, SchemaIssue } from "effect";
import { listSchemaIssues, type Issue } from "../errors";
import { quoteAuthorText } from "../excerpts";
import {
  EventSelector,
  Schedule,
  TriggerFiresOn,
  TriggerOn,
  WorkflowDefinition,
} from "./workflow-definition";

/**
 * Describes a value the author wrote, for an error message. Text is quoted
 * and truncated. A list or a mapping is described as "a list" or "a mapping",
 * so a message never repeats its contents.
 */
const describeWritten = (value: unknown): string => {
  if (typeof value === "string") return quoteAuthorText(value);
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object" && value !== null) return "a mapping";
  return String(value);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Returns the value at `path` inside `value`, or `undefined` if the path does not exist. */
const readValueAt = (value: unknown, path: ReadonlyArray<PropertyKey>): unknown =>
  path.reduce<unknown>(
    (inner, key) =>
      typeof inner === "object" && inner !== null
        ? (inner as Record<PropertyKey, unknown>)[key]
        : undefined,
    value,
  );

/** Returns the `kind` literals that tell a union's members apart, in declaration order. */
const listKinds = (union: SchemaAST.Union): ReadonlyArray<string> =>
  union.types.flatMap((member) =>
    SchemaAST.isObjects(member)
      ? member.propertySignatures.flatMap((property) =>
          property.name === "kind" && SchemaAST.isLiteral(property.type)
            ? [String(property.type.literal)]
            : [],
        )
      : [],
  );

/** Joins words as a list of choices: `a, b or c`. */
const joinChoices = (words: ReadonlyArray<string>): string =>
  `${words.slice(0, -1).join(", ")} or ${String(words.at(-1))}`;

/**
 * Describes the kind of value a schema accepts, in the words an error message
 * uses, such as "text" or "true or false". Returns `undefined` for any other
 * schema.
 */
const describeValueKind = (ast: SchemaAST.AST): string | undefined => {
  if (SchemaAST.isString(ast)) return "text";
  if (SchemaAST.isNumber(ast)) return "a number";
  if (SchemaAST.isBoolean(ast)) return "true or false";
  if (SchemaAST.isUnion(ast) && ast.types.every(SchemaAST.isLiteral)) {
    return joinChoices(ast.types.map((literal) => String(literal.literal)));
  }
  return undefined;
};

/**
 * Returns the error for a key the author wrote with no value, such as
 * `action:` alone, which YAML parses as null. Returns `undefined` when the
 * expected kind of value has no short description.
 */
const describeEmptyValue = (
  ast: SchemaAST.AST,
  path: ReadonlyArray<string>,
): ReadonlyArray<Issue> | undefined => {
  const kind = describeValueKind(ast);
  return kind === undefined
    ? undefined
    : [{ path, message: `${String(path.at(-1))} has no value. It takes ${kind}.` }];
};

/**
 * Returns the error for a key the author left out. An input's `required` has
 * no default (spec 07 section 1). So the author decides it for each input,
 * and the error asks for that decision instead of naming the key alone.
 */
const describeMissingKey = (path: ReadonlyArray<string>): string =>
  path.length === 3 && path[0] === "inputs" && path[2] === "required"
    ? "Say whether this input is required: add required: true or required: false."
    : `Add ${String(path.at(-1))}. It is required here.`;

/** The event selector keys that a schedule does not take, each with the error that says why. */
const SCHEDULE_REFUSED_KEYS: ReadonlyMap<string, string> = new Map([
  [
    "filter",
    "A schedule has no filter, because the schedule already sets when the trigger fires. Remove filter.",
  ],
  ["connectionId", "A schedule comes through no Connection. Remove connectionId."],
]);

/** The first sentence of every error about a schedule on a signal trigger. */
const SIGNAL_TRIGGER_HAS_NO_SCHEDULE =
  "A signal trigger resumes a run when an event arrives, so it cannot fire on a schedule.";

/**
 * Returns which shape of `on` the author meant, judged by the keys written:
 *
 * - `event` when `kind` is written, or, without `kind` or `schedule`,
 *   `connectionId` or `filter`;
 * - `schedule` when `schedule` is written, or, without `kind` or `schedule`,
 *   `timezone`;
 * - `undefined` when both `kind` and `schedule` are written, or none of the
 *   keys above.
 */
const inferTriggerFiresOn = (on: Readonly<Record<string, unknown>>): TriggerFiresOn | undefined => {
  const has = (key: string): boolean => Object.hasOwn(on, key);
  if (has("kind") && has("schedule")) return undefined;
  if (has("kind")) return "event";
  if (has("schedule")) return "schedule";
  if (has("connectionId") || has("filter")) return "event";
  return has("timezone") ? "schedule" : undefined;
};

/**
 * Returns the error for a key a trigger had before `on` replaced it:
 * `source`, or `schedule` or `timezone` beside `kind: start`. The advice
 * depends on the rest of the trigger, so that following it does not lead to
 * the next error. For example, a signal trigger cannot move its schedule
 * under `on`, and neither can a trigger whose `on` already has one, so both
 * are told to remove it. Returns `undefined` for any other key.
 */
const describeMovedTriggerKey = (
  trigger: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  if (key === "source") {
    return Object.hasOwn(trigger, "on")
      ? "on is already written, and source is its old name. Remove source."
      : "source is now called on. Rename source to on.";
  }
  if (key !== "schedule" && key !== "timezone") return undefined;
  if (trigger["kind"] === "signal") return `${SIGNAL_TRIGGER_HAS_NO_SCHEDULE} Remove ${key}.`;
  const on = trigger["on"];
  if (isRecord(on) && Object.hasOwn(on, key)) return `on already has a ${key}. Remove this one.`;
  if (isRecord(on) && inferTriggerFiresOn(on) === "event") {
    return key === "schedule"
      ? "on already accepts events, and a trigger cannot also fire on a schedule. Remove schedule."
      : "Only a schedule has a timezone. Remove timezone.";
  }
  return key === "schedule"
    ? "A schedule goes under on, in place of an event kind. Move schedule under on."
    : "A timezone goes under on, beside the schedule. Move timezone under on.";
};

/**
 * Returns the issues for a trigger key that needs its own message, or
 * `undefined` for any other issue. `path` is where the issue is, and `value`
 * is the whole decoded value. It runs before any other description, because
 * the right message depends on the rest of the trigger, not only on the
 * issue. The cases:
 *
 * - a key of the shape before `on`: see `describeMovedTriggerKey`. The error
 *   that `on` is missing is dropped when the same move fixes it;
 * - `filter` or `connectionId` in a schedule: say that a schedule takes
 *   neither;
 * - `timezone` in an event selector: say that only a schedule has one;
 * - a schedule under a signal trigger's `on`: say that a signal trigger
 *   accepts only events, and drop the errors that follow from it: that
 *   `kind` is missing, and that `timezone` is not known;
 * - a timezone without a schedule under a signal trigger's `on`: say that a
 *   signal trigger cannot fire on a schedule.
 */
const describeTriggerKeyIssue = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<string>,
  value: unknown,
): ReadonlyArray<Issue> | undefined => {
  const [list, index, key, onKey] = path;
  if (list !== "triggers" || index === undefined || key === undefined) return undefined;
  const trigger = readValueAt(value, ["triggers", index]);
  if (!isRecord(trigger)) return undefined;
  if (path.length === 3) {
    const moved = describeMovedTriggerKey(trigger, key);
    if (moved !== undefined) return [{ path, message: moved }];
    // The error for the old key already tells the author to write on.
    const hasOldKeyInPlaceOfOn =
      Object.hasOwn(trigger, "source") ||
      (trigger["kind"] !== "signal" && Object.hasOwn(trigger, "schedule"));
    return key === "on" && issue._tag === "MissingKey" && hasOldKeyInPlaceOfOn ? [] : undefined;
  }
  const on = trigger["on"];
  if (path.length !== 4 || key !== "on" || onKey === undefined || !isRecord(on)) return undefined;
  const shape = inferTriggerFiresOn(on);
  if (trigger["kind"] === "signal" && Object.hasOwn(on, "schedule")) {
    if (onKey === "schedule") {
      const fix = Object.hasOwn(on, "kind")
        ? "Remove schedule."
        : "Write kind in place of schedule, with connectionId and filter if needed.";
      return [{ path, message: `${SIGNAL_TRIGGER_HAS_NO_SCHEDULE} ${fix}` }];
    }
    if (onKey === "kind" || (onKey === "timezone" && shape === "schedule")) return [];
  }
  if (trigger["kind"] === "signal" && onKey === "timezone") {
    return [{ path, message: `${SIGNAL_TRIGGER_HAS_NO_SCHEDULE} Remove timezone.` }];
  }
  if (onKey === "timezone" && shape === "event") {
    return [{ path, message: "Only a schedule has a timezone. Remove timezone." }];
  }
  const refused = SCHEDULE_REFUSED_KEYS.get(onKey);
  return refused !== undefined && shape === "schedule" ? [{ path, message: refused }] : undefined;
};

/**
 * Lists keys the author wrote, for an error message: each one quoted and
 * truncated, and at most three, so a message stays short however many keys
 * were written.
 */
const listWrittenKeys = (keys: ReadonlyArray<string>): string => {
  const shown = keys.slice(0, 3).map(quoteAuthorText);
  const more = keys.length - shown.length;
  return more === 0 ? shown.join(", ") : `${shown.join(", ")} and ${more} more`;
};

/** The ways to write a start trigger's `on`, for an error message. */
const TRIGGER_ON_CHOICES =
  "Write kind, with connectionId and filter if needed, to accept events of that kind, " +
  "or write schedule, with timezone if needed, to fire on a schedule.";

/**
 * Returns the issues for a start trigger's `on` that is neither an event
 * selector nor a schedule. `written` is the value at `path`, and `value` is
 * the whole decoded value.
 *
 * The schema library reports the errors of both shapes, so an author who
 * wrote a schedule would also read that `kind` is missing. This function
 * decides which shape the author meant by the keys written, and reports only
 * that shape's errors. When it cannot tell, it returns one error that
 * explains the two shapes.
 */
const listTriggerOnIssues = (
  written: unknown,
  path: ReadonlyArray<string>,
  value: unknown,
): ReadonlyArray<Issue> => {
  if (!isRecord(written)) {
    const what = written === null ? "on has no value." : `on is ${describeWritten(written)}.`;
    return [{ path, message: `${what} ${TRIGGER_ON_CHOICES}` }];
  }
  const shape = inferTriggerFiresOn(written);
  if (shape === undefined) {
    const keys = Object.keys(written);
    const what =
      Object.hasOwn(written, "kind") && Object.hasOwn(written, "schedule")
        ? "on accepts events or fires on a schedule, not both."
        : keys.length === 0
          ? "on is empty."
          : `on has neither kind nor schedule, only ${listWrittenKeys(keys)}.`;
    return [{ path, message: `${what} ${TRIGGER_ON_CHOICES}` }];
  }
  const decoded = Schema.decodeUnknownResult(shape === "event" ? EventSelector : Schedule)(
    written,
    { errors: "all" },
  );
  return Result.isSuccess(decoded)
    ? []
    : listSchemaIssues(decoded.failure.issue, {
        path,
        describeIssue: (issue, issuePath) => describeDefinitionIssue(issue, issuePath, value),
      });
};

/**
 * Returns the issues for one leaf of a failed definition decode, or for a
 * union whose members all failed. Returns `undefined` to keep the schema
 * library's message for a leaf, or to report each member's issues for a
 * union. `value` is the whole decoded value, used to quote what the author
 * wrote.
 *
 * The schema library describes an expected shape as a line of TypeScript,
 * which does not help a workflow author. So this function writes its own
 * message for these cases:
 *
 * - A missing key: tell the author to add it.
 * - A key with no value where a plain value belongs: give the kind of value
 *   to write.
 * - A value that must be a mapping but is not: state that a mapping is
 *   expected.
 * - An unknown `kind` in a union whose members are told apart by `kind`:
 *   reports the error at `kind`, because the author only got that one word
 *   wrong.
 * - A start trigger's `on` that fits neither of its shapes: see
 *   `listTriggerOnIssues`.
 * - A trigger key that needs its own message: see `describeTriggerKeyIssue`.
 */
const describeDefinitionIssue = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<string>,
  value: unknown,
): ReadonlyArray<Issue> | undefined => {
  const triggerKeyIssues = describeTriggerKeyIssue(issue, path, value);
  if (triggerKeyIssues !== undefined) return triggerKeyIssues;
  switch (issue._tag) {
    case "MissingKey":
      return [{ path, message: describeMissingKey(path) }];
    case "InvalidType": {
      const written = readValueAt(value, path);
      if (!SchemaAST.isObjects(issue.ast)) {
        return written === null ? describeEmptyValue(issue.ast, path) : undefined;
      }
      return [
        { path, message: `Write a mapping of fields here, not ${describeWritten(written)}.` },
      ];
    }
    case "AnyOf": {
      // Matched by identity, so wrapping or annotating `TriggerOn` where a
      // start trigger uses it would stop this match. The tests that expect
      // only one shape's errors for a bad `on` fail when that happens.
      if (issue.ast === TriggerOn.ast) {
        return listTriggerOnIssues(readValueAt(value, path), path, value);
      }
      // Any other union with member issues is reported member by member.
      if (issue.issues.length > 0) return undefined;
      const kinds = listKinds(issue.ast);
      if (kinds.length === 0) {
        return readValueAt(value, path) === null ? describeEmptyValue(issue.ast, path) : undefined;
      }
      const choices = joinChoices(kinds);
      const written = readValueAt(value, path);
      if (!isRecord(written)) {
        return [
          {
            path,
            message: `Write a mapping of fields here, with the kind ${choices}, not ${describeWritten(written)}.`,
          },
        ];
      }
      return [
        {
          path: [...path, "kind"],
          message:
            written["kind"] === undefined
              ? `Add kind. Write ${choices}.`
              : `${describeWritten(written["kind"])} is not a kind here. Write ${choices}.`,
        },
      ];
    }
    default:
      return undefined;
  }
};

/**
 * Returns an issue for each trigger or step whose id an earlier trigger or
 * step already uses. Triggers and steps share one set of ids, because
 * expressions refer to a signal trigger as `steps.<id>` too. Triggers count as
 * earlier than steps, whatever order the source lists them in. The function
 * reads the raw value, so it finds repeated ids even when other fields are
 * invalid.
 */
const listRepeatedIds = (value: unknown): ReadonlyArray<Issue> => {
  if (!isRecord(value)) return [];
  const seen = new Set<string>();
  const issues: Array<Issue> = [];
  for (const list of ["triggers", "steps"]) {
    const nodes = value[list];
    if (!Array.isArray(nodes)) continue;
    for (const [index, node] of nodes.entries()) {
      const id: unknown = isRecord(node) ? node["id"] : undefined;
      if (typeof id !== "string") continue;
      if (seen.has(id)) {
        issues.push({
          path: [list, String(index), "id"],
          message:
            `The id ${quoteAuthorText(id)} is already used by an earlier trigger or step. ` +
            "Give each trigger and step a unique id.",
        });
      }
      seen.add(id);
    }
  }
  return issues;
};

const decodeDefinition = Schema.decodeUnknownResult(WorkflowDefinition);

/**
 * The maximum number of issues in one error response. A source of a few
 * hundred kilobytes can have an error on each of thousands of lines, and a
 * response that listed every one would be many times the size of the request.
 */
const MAX_ISSUES = 100;

/**
 * Returns the first `MAX_ISSUES` issues, plus one issue that counts the ones
 * left out. The YAML parse, the definition decode and the controller's
 * validation all pass their issues through this function, so no workflow
 * error response lists more.
 */
export const truncateIssues = <I extends Issue>(
  issues: ReadonlyArray<I>,
): ReadonlyArray<I | Issue> =>
  issues.length <= MAX_ISSUES
    ? issues
    : [
        ...issues.slice(0, MAX_ISSUES),
        {
          path: [],
          message:
            `There are ${String(issues.length - MAX_ISSUES)} more problems. ` +
            "Fix the problems listed, then send the workflow again to see the rest.",
        },
      ];

/**
 * Validates a value as a workflow definition. Returns the definition, or every
 * error found: a field with the wrong shape, an invalid id or name, a JSON
 * value nested too deep, or an id used twice. Definitions parsed from YAML and
 * definition objects sent as JSON are both validated here, so the same
 * mistake gets the same message at the same path either way.
 */
export const decodeWorkflowDefinition = (
  value: unknown,
): Result.Result<WorkflowDefinition, ReadonlyArray<Issue>> => {
  const decoded = decodeDefinition(value, { errors: "all" });
  const repeated = listRepeatedIds(value);
  if (Result.isSuccess(decoded) && repeated.length === 0) return Result.succeed(decoded.success);
  return Result.fail(
    truncateIssues([
      ...(Result.isFailure(decoded)
        ? listSchemaIssues(decoded.failure.issue, {
            describeIssue: (issue, path) => describeDefinitionIssue(issue, path, value),
          })
        : []),
      ...repeated,
    ]),
  );
};
