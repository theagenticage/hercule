/**
 * The schema of a workflow definition, and `decodeWorkflowDefinition`, the
 * function that validates a definition value.
 *
 * A workflow is stored as the YAML source the author wrote, byte for byte,
 * including comments and layout (ADR 0029). `WorkflowDefinition` is the schema
 * of what that YAML parses to. The controller parses the source on every
 * write, and clients parse it to show the same result.
 *
 * `parseWorkflowSource` (which parses YAML source) and `renderWorkflowSource`
 * (which converts a definition object to canonical YAML) are in
 * `./workflow-source`, because they need the YAML library and this module
 * does not. The workflow records and API operations are in `./workflow`.
 *
 * Every object in the schema rejects keys it does not declare. Otherwise a
 * misspelled key would be silently dropped, and the stored workflow would
 * behave differently from what its source shows.
 */
import { Result, Schema, SchemaAST, SchemaIssue } from "effect";
import {
  AccessMode,
  isNestedWithin,
  MAX_JSON_DEPTH,
  ModelSelection,
  OutputSchema,
} from "@hercule/protocol";
import { closedStruct } from "../closed";
import { listSchemaIssues, type Issue } from "../errors";
import { MAX_QUOTED_LENGTH, quoteAuthorText } from "../excerpts";
import { isId } from "../ids";
import { atMost, bounded, Timezone } from "../strings";
import { EventKind } from "./event";
import {
  EphemeralSpawnWorkspace,
  MAX_SPAWN_CHECKOUTS,
  PrimarySpawnWorkspace,
  SpawnCheckout,
  refuseInvalidCheckoutRevision,
} from "./session";
import { SignalKind } from "./signal";

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

/**
 * The pattern for step ids and trigger ids: a CEL identifier. Expressions
 * refer to an id as `steps.<id>`, and CEL parses `steps.open-pr` as
 * `steps.open - pr`. Such an expression passes validation and fails only when
 * a run evaluates it.
 */
const NODE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Converts an invalid id to snake_case, to suggest in an error message.
 * Returns `undefined` if no valid id can be built from it.
 */
const convertToSnakeCase = (id: string): string | undefined => {
  const snakeCase = id
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "")
    .join("_");
  return NODE_ID_PATTERN.test(snakeCase) ? snakeCase : undefined;
};

/**
 * Words that match the id or name pattern but that an expression cannot use
 * as a field name, each with the reason:
 *
 * - CEL parses `in` as an operator, and `true`, `false` and `null` as literal
 *   values, so `steps.in.output` does not parse.
 * - The expression evaluator the controller uses fails on an object with a
 *   field named `constructor`, so every expression that reads `inputs` or
 *   `steps` would fail at run time.
 * - The evaluator can read a field named `__proto__`, but assigning a field
 *   with that name to an object sets the object's prototype instead of adding
 *   the field. So a run that builds its inputs or outputs by assignment could
 *   not read the value.
 */
const UNREADABLE_FIELD_NAMES: ReadonlyMap<string, string> = new Map([
  ["in", "CEL parses in as an operator"],
  ["true", "CEL parses true as a literal value"],
  ["false", "CEL parses false as a literal value"],
  ["null", "CEL parses null as a literal value"],
  ["constructor", "the expression evaluator fails on an object with a field of this name"],
  [
    "__proto__",
    "assigning a field of this name to an object sets its prototype instead, so a run could not read the value",
  ],
]);

/**
 * Returns an error message if an expression cannot use `word` as a field
 * name, or `undefined` if it can. `readAs` is how an expression refers to the
 * value, such as `steps.<id>`, and `noun` is whether the word is an id or a
 * name.
 */
const describeUnreadableWord = (
  word: string,
  readAs: string,
  noun: "id" | "name",
): string | undefined => {
  const reason = UNREADABLE_FIELD_NAMES.get(word);
  return reason === undefined
    ? undefined
    : `Expressions refer to this value as ${readAs}, and cannot use ${quoteAuthorText(word)} there: ${reason}. Choose another ${noun}.`;
};

/** The id of a step or a trigger. The error message suggests a valid spelling. */
const NodeId = Schema.String.check(
  Schema.makeFilter((id: string) => {
    if (NODE_ID_PATTERN.test(id)) return describeUnreadableWord(id, "steps.<id>", "id");
    const suggestion = convertToSnakeCase(id);
    return (
      `${quoteAuthorText(id)} is not a valid id. Expressions refer to an id as steps.<id>, ` +
      "so an id must start with a lowercase letter and contain only lowercase letters, digits and underscores. " +
      (suggestion === undefined || suggestion.length > MAX_QUOTED_LENGTH
        ? "Rename the id to match."
        : `Use ${suggestion} instead.`)
    );
  }),
);

/**
 * The annotation key that marks a string field of the definition whose value
 * is not plain words. The editor reads it to choose a YAML style that keeps
 * the value exactly as written:
 *
 * - Expressions and schedules often contain characters that YAML treats as
 *   syntax, such as `: ` or ` #` in the middle, or a quote, `*`, `!` or `{` at
 *   the start. So the editor writes them in double quotes.
 * - A template is text for an agent, usually on several lines. So the editor
 *   writes it as a `|` block.
 */
const NOTATION_ANNOTATION = "notation";

/** The notations of the definition's string fields. See `NOTATION_ANNOTATION` for what each is for. */
export type FieldNotation = "expression" | "schedule" | "template";

/**
 * Returns the notation of a definition field from its schema, or `undefined`
 * for plain words. Only the schemas in this file set the annotation, and each
 * sets a `FieldNotation`.
 */
export const readFieldNotation = (ast: SchemaAST.AST): FieldNotation | undefined =>
  ast.annotations?.[NOTATION_ANNOTATION] as FieldNotation | undefined;

/** A CEL expression. Which values it can read depends on where it is written. */
const Expression = Schema.String.annotate({ [NOTATION_ANNOTATION]: "expression" });

/** A cron expression that sets when a cron trigger fires. */
const CronSchedule = Schema.String.annotate({ [NOTATION_ANNOTATION]: "schedule" });

/** Text with `{{ expr }}` templates, which a run fills in from `inputs` and `steps`. */
const TemplateText = Schema.String.annotate({ [NOTATION_ANNOTATION]: "template" });

/**
 * The pattern for input names and signal trigger output names: a CEL
 * identifier. Expressions refer to an input as `inputs.<name>` and to an
 * output as `steps.<id>.output.<name>`, and CEL parses `inputs.pr-url` as
 * `inputs.pr - url`. Such an expression passes validation and fails only when
 * a run evaluates it. Uppercase letters are allowed, because these names are
 * field names, which are often camelCase.
 */
const EXPRESSION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Returns the error message for a name that is not a CEL identifier, with a
 * suggested valid spelling when one can be built. `readAs` is how an
 * expression refers to the name, such as `inputs.<name>`.
 */
const describeMalformedName = (name: string, readAs: string): string => {
  const suggestion = name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return (
    `${quoteAuthorText(name)} is not a valid name. Expressions refer to this value as ${readAs}, ` +
    "so the name must start with a letter or an underscore and contain only letters, digits and underscores. " +
    (EXPRESSION_NAME_PATTERN.test(suggestion) && suggestion.length <= MAX_QUOTED_LENGTH
      ? `Use ${suggestion} instead.`
      : "Rename it to match.")
  );
};

/**
 * Returns an error message if an expression cannot use `name`, or `undefined`
 * if it can. `readAs` is how an expression refers to the name, such as
 * `inputs.<name>`.
 */
const describeUnreadableName = (name: string, readAs: string): string | undefined =>
  EXPRESSION_NAME_PATTERN.test(name)
    ? describeUnreadableWord(name, readAs, "name")
    : describeMalformedName(name, readAs);

/** The name of an input. Expressions refer to it as `inputs.<name>`. */
const InputName = Schema.String.check(
  Schema.makeFilter((name: string) => describeUnreadableName(name, "inputs.<name>")),
);

/**
 * A signal trigger's outputs: a map from output name to an expression over
 * `event`. Each invalid name is reported at its own key.
 */
const SignalOutputs = Schema.Record(Schema.String, Expression).check(
  Schema.makeFilter((outputs: { readonly [name: string]: string }) =>
    Object.keys(outputs).flatMap((name) => {
      const message = describeUnreadableName(name, "steps.<id>.output.<name>");
      return message === undefined ? [] : [{ path: [name], issue: message }];
    }),
  ),
);

/**
 * Rejects a JSON value nested deeper than `MAX_JSON_DEPTH` levels of mappings
 * and lists, the same limit output schemas have. The database and the YAML
 * writer both recurse once per level, and the limit keeps every value far
 * below the depth at which they fail.
 */
const refuseDeepJson = Schema.makeFilter((value: unknown) =>
  isNestedWithin(value, MAX_JSON_DEPTH)
    ? undefined
    : `This value has more than ${String(MAX_JSON_DEPTH)} levels of mappings and lists. Make it less deep.`,
);

/** A JSON object with keys the author chooses. */
const JsonObject = Schema.Record(Schema.String, Schema.Json).check(refuseDeepJson);

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** The maximum length of a workflow name. The name labels the workflow in every list. */
const MAX_WORKFLOW_NAME_LENGTH = 128;

/**
 * A workflow's name: one line of plain text. The schema rejects:
 *
 * - control characters and line or paragraph separators, which cut the name
 *   short or break the line where a list shows it;
 * - text direction marks, which make the name display in a different order
 *   from its characters, so two different names could look the same.
 */
const WorkflowName = bounded(1, MAX_WORKFLOW_NAME_LENGTH).check(
  Schema.makeFilter((name: string) =>
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(name)
      ? "A name is one line of plain text. Remove the line breaks, tabs, other control characters and text direction marks."
      : undefined,
  ),
);

/**
 * A workflow's description: text on any number of lines. The schema rejects
 * control characters other than tabs and line breaks. For example, a NUL
 * character would cut the description short when a list reads it from the
 * database.
 */
const WorkflowDescription = Schema.String.check(
  Schema.makeFilter((description: string) =>
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(description)
      ? "A description cannot contain control characters other than tabs and line breaks. Remove them."
      : undefined,
  ),
);

/**
 * The `connectionId` value that makes a trigger accept events from every
 * Connection of the event kind's type.
 */
export const ANY_CONNECTION = "any";

/**
 * Which Connection an event must arrive through: one Connection by its id, or
 * `any` to accept every Connection of the event kind's type. There is no
 * default, so the author must choose `any` explicitly.
 */
export const ConnectionSelection = Schema.String.check(
  Schema.makeFilter((selection: string) =>
    selection === ANY_CONNECTION || isId(selection)
      ? undefined
      : `${quoteAuthorText(selection)} is not a Connection id. ` +
        "Write the id of a Connection, or write any to accept events from every Connection of the event kind's type.",
  ),
);

/**
 * The events a trigger accepts: the event kind, the Connection they arrive
 * through, and an optional filter.
 */
export const EventSelector = closedStruct({
  /**
   * An event kind, such as `github.issue.opened` or `task.created`. The part
   * before the first dot is a namespace, which is not always the Event
   * Source: `task.created` comes from the core.
   */
  kind: EventKind,
  /** Absent for a kind the core emits, because those events arrive through no Connection. */
  connectionId: Schema.optionalKey(ConnectionSelection),
  /** An expression over `event`. The trigger accepts the event only when it is true. */
  filter: Schema.optionalKey(Expression),
});

export type EventSelector = Schema.Schema.Type<typeof EventSelector>;

/**
 * When a cron trigger fires. It has no filter, because the cron expression
 * already sets when it fires.
 */
export const Schedule = closedStruct({
  schedule: CronSchedule,
  /** The time zone of the schedule. When absent, the user's timezone setting is used. */
  timezone: Schema.optionalKey(Timezone),
});

export type Schedule = Schema.Schema.Type<typeof Schedule>;

/**
 * What makes a start trigger start a run: an event it accepts, or its
 * schedule coming due. A schedule is the only way to fire on time, so no
 * trigger listens for the event the Scheduler emits.
 */
export const TriggerOn = Schema.Union([EventSelector, Schedule]);

export type TriggerOn = Schema.Schema.Type<typeof TriggerOn>;

/** Returns whether a trigger's `on` is a schedule rather than an event selector. */
export const isSchedule = (on: TriggerOn): on is Schedule => "schedule" in on;

/**
 * Whether a trigger fires on events or on a schedule: `event` when its `on`
 * is an event selector, `schedule` when it is a schedule.
 */
export const TriggerFiresOn = Schema.Literals(["event", "schedule"]);

export type TriggerFiresOn = Schema.Schema.Type<typeof TriggerFiresOn>;

/** A trigger that starts a new run for each event it accepts, or each time its schedule comes due. */
const StartTrigger = closedStruct({
  id: NodeId,
  kind: Schema.Literal("start"),
  on: TriggerOn,
  /** Maps each input name to an expression over `event`. */
  inputs: Schema.optionalKey(Schema.Record(Schema.String, Expression)),
  /** The maximum number of runs the trigger can start in one time window. */
  spawnBound: Schema.optionalKey(
    closedStruct({ maxRuns: PositiveInt, windowSeconds: PositiveInt }),
  ),
});

/** A trigger that resumes a live run each time an event correlates with that run. */
const SignalTrigger = closedStruct({
  id: NodeId,
  kind: Schema.Literal("signal"),
  on: EventSelector,
  /** The event is delivered to the run when both expressions give equal values. */
  correlation: closedStruct({
    /** An expression over `event`. */
    event: Expression,
    /** An expression over `inputs` and `steps`. */
    run: Expression,
  }),
  /** Maps each output name to an expression over `event`. When absent, the output is the whole event. */
  outputs: Schema.optionalKey(SignalOutputs),
});

/** The most signal kinds one signal input accepts. */
export const MAX_INPUT_SIGNAL_KINDS = 32;

/**
 * The signal kinds a `signal` input accepts. It lists at least one kind, and
 * never `proposal`: a proposal is answered by Accept, which creates its Task,
 * so it cannot be handed to an agent.
 */
const InputSignalKinds = atMost(SignalKind, MAX_INPUT_SIGNAL_KINDS).check(
  Schema.isMinLength(1, { message: "A signal input lists at least one signal kind." }),
  Schema.makeFilter((kinds: ReadonlyArray<string>) =>
    kinds.flatMap((kind, index) =>
      kind === "proposal"
        ? [
            {
              path: [index],
              issue:
                "A signal input cannot accept proposal. A proposal is answered by Accept, which creates its Task, so it cannot be handed to an agent. Start the work from the Task instead.",
            },
          ]
        : [],
    ),
  ),
);

/**
 * A value a run starts with. Its type is one of three, set by exactly one
 * field:
 *
 * - `schema`: a JSON Schema the value must fit.
 * - `connection`: the value is the id of a Connection of this type.
 * - `signal`: the value is the id of a Signal of one of these kinds. Such a
 *   workflow is offered as Hand to an agent on each signal of those kinds.
 *
 * The three are fields of one object instead of a union, so an error in one
 * is reported at its own field and not at the whole input.
 */
const InputDeclaration = closedStruct({
  name: InputName,
  schema: Schema.optionalKey(JsonObject),
  /** The value is the id of a Connection of this qualified type, such as `github/github`. */
  connection: Schema.optionalKey(closedStruct({ type: Schema.String })),
  /** The value is the id of a Signal of one of these kinds, such as `github/review-requested`. */
  signal: Schema.optionalKey(closedStruct({ kinds: InputSignalKinds })),
  required: Schema.Boolean,
  default: Schema.optionalKey(Schema.Json.check(refuseDeepJson)),
}).check(
  Schema.makeFilter((input) =>
    [input.schema, input.connection, input.signal].filter((type) => type !== undefined).length === 1
      ? undefined
      : "An input sets its type with exactly one of schema, connection and signal.",
  ),
);

/** The step fields that control how a step runs within the graph. */
const STEP_GRAPH_FIELDS = {
  /** An expression over `inputs` and `steps`. The step is skipped when it is false. */
  condition: Schema.optionalKey(Expression),
  /**
   * `any` runs the step again each time an incoming edge fires. `all` runs it
   * once, after every incoming edge has fired or can no longer fire.
   */
  join: Schema.optionalKey(Schema.Literals(["any", "all"])),
  /** The run starts at this step, as it does at a step with no incoming edges. */
  entry: Schema.optionalKey(Schema.Boolean),
  /** When this step completes, the run completes. */
  terminal: Schema.optionalKey(Schema.Boolean),
};

/** A step that calls a workflow action. */
const ActionStep = closedStruct({
  id: NodeId,
  kind: Schema.Literal("action"),
  name: Schema.optionalKey(Schema.String),
  /** An operation id for a built-in action, a qualified id for a plugin's action. */
  action: Schema.String,
  /** The action's input fields. Each value is a literal, or a string with `{{ }}` templates. */
  params: Schema.optionalKey(JsonObject),
  ...STEP_GRAPH_FIELDS,
});

/**
 * The id of the Agent that an agent step runs. People who write the YAML by
 * hand often write the Agent's name here. The schema library's own message
 * reports only that a UUIDv7 was expected, so this error message explains
 * what to write and where to find it.
 */
const AgentId = Schema.String.check(
  Schema.makeFilter((agent: string) =>
    isId(agent)
      ? undefined
      : `${quoteAuthorText(agent)} is not an Agent id. Write the id of an Agent. ` +
        "Run hercule agent list to see the id of each Agent.",
  ),
);

/** A step that drives a session of an Agent until its turn completes. */
const AgentStep = closedStruct({
  id: NodeId,
  kind: Schema.Literal("agent"),
  name: Schema.optionalKey(Schema.String),
  agent: AgentId,
  /** The input of the first turn. */
  prompt: TemplateText,
  /** A model slug that overrides the Agent's model. */
  model: Schema.optionalKey(Schema.NonEmptyString),
  /** The options for that model. */
  options: Schema.optionalKey(ModelSelection.fields.options),
  /** Overrides the Agent's access mode. */
  accessMode: Schema.optionalKey(AccessMode),
  /**
   * Each iteration starts a new session instead of the next turn of the same
   * session. Either way, the session's process is stopped a few seconds after
   * each turn, so a background process the agent started, such as a dev
   * server, does not survive into the next iteration; only the workspace does.
   */
  freshSession: Schema.optionalKey(Schema.Boolean),
  /** The schema each turn's output must match. It sets the type of `steps.<id>.output`. */
  outputSchema: Schema.optionalKey(OutputSchema),
  ...STEP_GRAPH_FIELDS,
});

/** A link in the graph, from a step or a signal trigger to a step. */
const Edge = closedStruct({
  from: Schema.String,
  to: Schema.String,
  /** An expression over `inputs` and `steps`. The edge fires only when it is true. */
  condition: Schema.optionalKey(Expression),
  /** How many times the edge can fire in one run. Every cycle needs at least one edge with this set. */
  maxTraversals: Schema.optionalKey(PositiveInt),
});

/**
 * The workspace that the agent steps and the workspace actions (such as
 * `git.commit`) of a run work in: a repo's main workspace, or an ephemeral
 * workspace created for the run. The schemas are
 * the ones `session.spawn` accepts, except that a run cannot use an existing
 * workspace.
 */
export const WorkspacePolicy = Schema.Union([
  closedStruct(PrimarySpawnWorkspace.fields),
  closedStruct({
    ...EphemeralSpawnWorkspace.fields,
    checkouts: atMost(
      closedStruct(SpawnCheckout.fields).check(refuseInvalidCheckoutRevision),
      MAX_SPAWN_CHECKOUTS,
    ),
  }),
]);

export type WorkspacePolicy = Schema.Schema.Type<typeof WorkspacePolicy>;

/**
 * The schema of a workflow definition: what a workflow's YAML source parses
 * to. At every level, the keys are declared in the order that the canonical
 * YAML writes them.
 *
 * The schema alone does not reject an id shared by two triggers or steps.
 * `decodeWorkflowDefinition` does, so always validate a value with it.
 */
export const WorkflowDefinition = closedStruct({
  name: WorkflowName,
  description: Schema.optionalKey(WorkflowDescription),
  inputs: Schema.optionalKey(Schema.Array(InputDeclaration)),
  triggers: Schema.optionalKey(Schema.Array(Schema.Union([StartTrigger, SignalTrigger]))),
  steps: Schema.Array(Schema.Union([ActionStep, AgentStep])),
  edges: Schema.optionalKey(Schema.Array(Edge)),
  /** When absent, each agent step runs with no checkout. */
  workspace: Schema.optionalKey(WorkspacePolicy),
});

export type WorkflowDefinition = Schema.Schema.Type<typeof WorkflowDefinition>;

/**
 * Returns the entry steps of a definition, in definition order: the steps a
 * run starts at. A step is an entry step when it sets `entry: true`, or when
 * no edge leads into it. Only a valid edge counts: one from a step or a signal
 * trigger, to a step. A step that only a signal trigger leads into is not an
 * entry step, because it waits for its signal. The controller's validation and
 * the editor's graph both use this function, so they always agree on where a
 * run starts.
 */
export const listEntrySteps = (
  definition: WorkflowDefinition,
): ReadonlyArray<WorkflowDefinition["steps"][number]> => {
  const stepIds = new Set(definition.steps.map((step) => step.id));
  const sourceIds = new Set([
    ...stepIds,
    ...(definition.triggers ?? []).flatMap((trigger) =>
      trigger.kind === "signal" ? [trigger.id] : [],
    ),
  ]);
  const ledInto = new Set(
    (definition.edges ?? [])
      .filter((edge) => sourceIds.has(edge.from) && stepIds.has(edge.to))
      .map((edge) => edge.to),
  );
  return definition.steps.filter((step) => step.entry === true || !ledInto.has(step.id));
};

/**
 * Returns every step in `from`, plus every step that one of them has a path
 * of edges to.
 *
 * This is only the walk along the graph: edge conditions and `maxTraversals`
 * are ignored. Each caller adds its own rules on top. The controller uses it
 * to decide which steps can still run, and the run graph uses it to show
 * which edges a live run may still follow.
 */
export const collectReachableSteps = (
  edges: ReadonlyArray<{ readonly from: string; readonly to: string }>,
  from: Iterable<string>,
): ReadonlySet<string> => {
  const reached = new Set(from);
  // A Set iterator also visits values added during the iteration, so this
  // loop is a breadth-first search.
  for (const stepId of reached) {
    for (const edge of edges) {
      if (edge.from === stepId) reached.add(edge.to);
    }
  }
  return reached;
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
