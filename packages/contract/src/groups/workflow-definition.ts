/**
 * What a workflow's text says: the shape of a definition, and the one check of
 * a definition value.
 *
 * The text the author wrote is the stored form of a workflow, and it is kept
 * byte for byte, comments and layout included (ADR 0029). `WorkflowDefinition`
 * is what that text says. The controller parses the text into it on every
 * write, and a client parses the text to show the same thing.
 *
 * `decodeWorkflowDefinition` is the one check of a definition value, here
 * beside the shape. `parseWorkflowSource`, the one parse of the text, and
 * `renderWorkflowSource`, the one canonical text of a definition object, are
 * in `./workflow-source`, because they need the YAML library and this module
 * does not. The records and the operations of the API that store a workflow
 * are in `./workflow`.
 *
 * Every object in the shape refuses a key it does not declare. A key that the
 * author spelled wrong would otherwise be dropped, and the stored workflow
 * would do something other than what its text says.
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
import { MAX_QUOTED_LENGTH, quoteWritten } from "../excerpts";
import { isId } from "../ids";
import { atMost, bounded, Timezone } from "../strings";
import { EventKind } from "./event";
import {
  EphemeralSpawnWorkspace,
  MAX_SPAWN_CHECKOUTS,
  PrimarySpawnWorkspace,
  SpawnCheckout,
} from "./session";

/** A value the author wrote, as a message names it without repeating a mapping or a list. */
const describeWritten = (value: unknown): string => {
  if (typeof value === "string") return quoteWritten(value);
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object" && value !== null) return "a mapping";
  return String(value);
};

/**
 * What a step id or a trigger id may look like: a CEL identifier. An
 * expression reads an id as `steps.<id>`, and CEL reads `steps.open-pr` as
 * `steps.open - pr`. That expression passes a check and fails only when a run
 * evaluates it.
 */
const NODE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * The snake_case spelling of an id that is not one, or `undefined` where the
 * id holds no letters to spell it with.
 */
const spellInSnakeCase = (id: string): string | undefined => {
  const spelled = id
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "")
    .join("_");
  return NODE_ID_PATTERN.test(spelled) ? spelled : undefined;
};

/**
 * The words that have the form of an id or a name, but that an expression
 * cannot read as a field name, each with the reason. CEL reads `in` as an
 * operator and `true`, `false` and `null` as values, so `steps.in.output` does
 * not parse. The evaluator that the controller uses cannot read an object
 * that has a field named `constructor`, so each expression that reads
 * `inputs` or `steps` would fail when a run evaluates it. The evaluator reads
 * a field named `__proto__`, but an object that code builds by assignment
 * does not keep it: the assignment sets the object's prototype and adds no
 * field. So a run that builds its inputs or its outputs that way could not
 * read the value.
 */
const UNREADABLE_FIELD_NAMES: ReadonlyMap<string, string> = new Map([
  ["in", "CEL reads in as an operator"],
  ["true", "CEL reads true as a value"],
  ["false", "CEL reads false as a value"],
  ["null", "CEL reads null as a value"],
  ["constructor", "the expression evaluator cannot read an object that has a field with this name"],
  [
    "__proto__",
    "an object that code builds by assignment loses a field with this name, so a run could not read it",
  ],
]);

/**
 * Why an expression cannot read a word that has the form of a field name, or
 * `undefined` for a word that it can read. `readAs` is how an expression reads
 * the value, such as `steps.<id>`, and `noun` is what the word is.
 */
const describeUnreadableWord = (
  word: string,
  readAs: string,
  noun: "id" | "name",
): string | undefined => {
  const reason = UNREADABLE_FIELD_NAMES.get(word);
  return reason === undefined
    ? undefined
    : `An expression reads this value as ${readAs}, and it cannot read ${quoteWritten(word)} there: ${reason}. Write another ${noun}.`;
};

/** The id of a step or a trigger. The refusal gives the spelling to write instead. */
const NodeId = Schema.String.check(
  Schema.makeFilter((id: string) => {
    if (NODE_ID_PATTERN.test(id)) return describeUnreadableWord(id, "steps.<id>", "id");
    const suggestion = spellInSnakeCase(id);
    return (
      `${quoteWritten(id)} is not a valid id. An expression reads an id as steps.<id>. ` +
      "Thus an id starts with a lowercase letter and contains only lowercase letters, digits and underscores. " +
      (suggestion === undefined || suggestion.length > MAX_QUOTED_LENGTH
        ? "Write the id in this form."
        : `Write ${suggestion}.`)
    );
  }),
);

/**
 * The annotation that names the notation of a string field of the definition,
 * where the field is not plain words. An editor reads it to write the value in
 * a form that YAML keeps as written. An expression or a schedule often holds
 * characters that YAML reads as its own, such as `: ` or ` #` in the middle
 * and a quote, `*`, `!` or `{` at the start, so the editor writes it in double
 * quotes. A template is text for an agent, usually on several lines, so the
 * editor writes it as a `|` block.
 */
const NOTATION_ANNOTATION = "notation";

/** The notations of the string fields of the definition. `NOTATION_ANNOTATION` says what each is for. */
export type FieldNotation = "expression" | "schedule" | "template";

/**
 * The notation of a field of the definition, from its schema, or `undefined`
 * for plain words. Only the schemas of this file set the annotation, and each
 * sets a `FieldNotation`.
 */
export const readFieldNotation = (ast: SchemaAST.AST): FieldNotation | undefined =>
  ast.annotations?.[NOTATION_ANNOTATION] as FieldNotation | undefined;

/** A CEL expression. What it may read depends on the place it is written. */
const Expression = Schema.String.annotate({ [NOTATION_ANNOTATION]: "expression" });

/** A cron expression, which says when a `cron.tick` trigger fires. */
const CronSchedule = Schema.String.annotate({ [NOTATION_ANNOTATION]: "schedule" });

/** Text whose `{{ expr }}` templates a run renders with the values of `inputs` and `steps`. */
const TemplateText = Schema.String.annotate({ [NOTATION_ANNOTATION]: "template" });

/**
 * What an input name or a signal trigger's output name may look like: a CEL
 * identifier. An expression reads an input as `inputs.<name>` and an output as
 * `steps.<id>.output.<name>`, and CEL reads `inputs.pr-url` as
 * `inputs.pr - url`. That expression passes a check and fails only when a run
 * evaluates it. Case is free, because such a name is a field name, and a field
 * name is often written in camelCase.
 */
const EXPRESSION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Why a name that is not a CEL identifier is refused, and a spelling that an
 * expression can read, where the name holds one. `readAs` is how an
 * expression reads the name, such as `inputs.<name>`.
 */
const describeMalformedName = (name: string, readAs: string): string => {
  const suggestion = name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return (
    `${quoteWritten(name)} is not a name that an expression can read. An expression reads this value as ${readAs}. ` +
    "Thus the name starts with a letter or an underscore and contains only letters, digits and underscores. " +
    (EXPRESSION_NAME_PATTERN.test(suggestion) && suggestion.length <= MAX_QUOTED_LENGTH
      ? `Write ${suggestion}.`
      : "Write the name in this form.")
  );
};

/**
 * Why an expression cannot read a name, or `undefined` for a name that it can
 * read. `readAs` is how an expression reads the name, such as `inputs.<name>`.
 */
const describeUnreadableName = (name: string, readAs: string): string | undefined =>
  EXPRESSION_NAME_PATTERN.test(name)
    ? describeUnreadableWord(name, readAs, "name")
    : describeMalformedName(name, readAs);

/** The name of an input, which an expression reads as `inputs.<name>`. */
const InputName = Schema.String.check(
  Schema.makeFilter((name: string) => describeUnreadableName(name, "inputs.<name>")),
);

/**
 * A signal trigger's outputs: each name, to an expression over `event`. Each
 * name that an expression cannot read is refused at its own key.
 */
const SignalOutputs = Schema.Record(Schema.String, Expression).check(
  Schema.makeFilter((outputs: { readonly [name: string]: string }) =>
    Object.keys(outputs).flatMap((name) => {
      const refusal = describeUnreadableName(name, "steps.<id>.output.<name>");
      return refusal === undefined ? [] : [{ path: [name], issue: refusal }];
    }),
  ),
);

/**
 * Refuses a JSON value in a definition that has more than `MAX_JSON_DEPTH`
 * levels of mappings and lists, the bound an output schema has too. The
 * database and the YAML writer both recurse once for each level, and the bound
 * keeps each value far below the depth at which they fail.
 */
const refuseDeepJson = Schema.makeFilter((value: unknown) =>
  isNestedWithin(value, MAX_JSON_DEPTH)
    ? undefined
    : `This value has more than ${String(MAX_JSON_DEPTH)} levels of mappings and lists. Make it less deep.`,
);

/** A JSON object whose keys the author chooses. */
const JsonObject = Schema.Record(Schema.String, Schema.Json).check(refuseDeepJson);

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** The longest workflow name. The name labels the workflow in every listing. */
const MAX_WORKFLOW_NAME_LENGTH = 128;

/**
 * A workflow's name: one line of plain text. A control character would cut the
 * name short, or break the line, where a listing shows it. The line and
 * paragraph separators break the line too. A text direction mark makes the
 * name show in an order other than the order of its characters, so two names
 * could look the same and be different.
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
 * A workflow's description: text on as many lines as it needs. A control
 * character other than a tab or a line break is not text, and a NUL cuts the
 * description short where a listing reads it from the database.
 */
const WorkflowDescription = Schema.String.check(
  Schema.makeFilter((description: string) =>
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(description)
      ? "A description is text. Remove the control characters from it. Tabs and line breaks can stay."
      : undefined,
  ),
);

/**
 * What a trigger's `connectionId` says to take the events of each Connection
 * of the event kind's type.
 */
export const ANY_CONNECTION = "any";

/**
 * Which Connection an event must arrive through: one Connection by its id, or
 * `any` Connection of the event kind's type, chosen on purpose.
 */
export const ConnectionSelection = Schema.String.check(
  Schema.makeFilter((selection: string) =>
    selection === ANY_CONNECTION || isId(selection)
      ? undefined
      : `${quoteWritten(selection)} names no Connection. ` +
        "Write the id of a Connection, or write any for each Connection of the event kind's type.",
  ),
);

/** What a trigger listens for. */
const EventSelector = closedStruct({
  kind: EventKind,
  /** Absent for a kind the core emits, which arrives through no Connection. */
  connectionId: Schema.optionalKey(ConnectionSelection),
  /** Over `event`. The event is admitted when it is true. */
  filter: Schema.optionalKey(Expression),
});

/** A trigger that starts a new run for each event it admits. */
const StartTrigger = closedStruct({
  id: NodeId,
  kind: Schema.Literal("start"),
  source: EventSelector,
  /** Each input by name, to an expression over `event`. */
  inputs: Schema.optionalKey(Schema.Record(Schema.String, Expression)),
  /** How many runs the trigger may start in one window. */
  spawnBound: Schema.optionalKey(
    closedStruct({ maxRuns: PositiveInt, windowSeconds: PositiveInt }),
  ),
  /** On a `cron.tick` trigger only. */
  schedule: Schema.optionalKey(CronSchedule),
  /** The zone the schedule is read in. Absent reads it in the user's timezone setting. */
  timezone: Schema.optionalKey(Timezone),
});

/** A trigger that resumes a live run each time an event correlates with that run. */
const SignalTrigger = closedStruct({
  id: NodeId,
  kind: Schema.Literal("signal"),
  source: EventSelector,
  /** The event reaches the run when the two sides give equal values. */
  correlation: closedStruct({
    /** Over `event`. */
    event: Expression,
    /** Over `inputs` and `steps`. */
    run: Expression,
  }),
  /** Each output by name, to an expression over `event`. Absent gives the whole event. */
  outputs: Schema.optionalKey(SignalOutputs),
});

/**
 * A value a run starts with. Its type is a JSON Schema, or a Connection of one
 * type. The two are one object and not a union, so a mistake in either is
 * named at its own field and not at the whole input.
 */
const InputDeclaration = closedStruct({
  name: InputName,
  schema: Schema.optionalKey(JsonObject),
  /** The value is the id of a Connection of this qualified type, such as `github/github`. */
  connection: Schema.optionalKey(closedStruct({ type: Schema.String })),
  required: Schema.Boolean,
  default: Schema.optionalKey(Schema.Json.check(refuseDeepJson)),
}).check(
  Schema.makeFilter((input) =>
    (input.schema === undefined) === (input.connection === undefined)
      ? "An input declares its type with schema or with connection. Write one of the two."
      : undefined,
  ),
);

/** The fields of a step that say how the step sits in the graph. */
const STEP_GRAPH_FIELDS = {
  /** Over `inputs` and `steps`. The step is skipped when it is false. */
  condition: Schema.optionalKey(Expression),
  /**
   * `any` runs the step again for each incoming edge that fires. `all` runs
   * it once, when each incoming edge has fired or can no longer fire.
   */
  join: Schema.optionalKey(Schema.Literals(["any", "all"])),
  /** The run starts here, as it does at a step with no incoming edges. */
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
  /** Each field of the action's input: a literal, or a string with `{{ }}` templates. */
  params: Schema.optionalKey(JsonObject),
  ...STEP_GRAPH_FIELDS,
});

/**
 * The id of the Agent that an agent step runs. A person who writes the text by
 * hand often writes the name of the Agent here. The schema library would say
 * only that it expected a UUIDv7, so the refusal says what to write and where
 * the author finds it.
 */
const AgentId = Schema.String.check(
  Schema.makeFilter((agent: string) =>
    isId(agent)
      ? undefined
      : `${quoteWritten(agent)} is not the id of an Agent. Write the id of an Agent. ` +
        "The command hercule agent list shows the id of each Agent.",
  ),
);

/** A step that drives a session of an Agent until its turn completes. */
const AgentStep = closedStruct({
  id: NodeId,
  kind: Schema.Literal("agent"),
  name: Schema.optionalKey(Schema.String),
  agent: AgentId,
  /** The first turn's input. */
  prompt: TemplateText,
  /** A model slug, in place of the Agent's model. */
  model: Schema.optionalKey(Schema.NonEmptyString),
  /** The choices of that model. */
  options: Schema.optionalKey(ModelSelection.fields.options),
  /** In place of the Agent's access mode. */
  accessMode: Schema.optionalKey(AccessMode),
  /** Each iteration starts a new session, and not the next turn of the same one. */
  freshSession: Schema.optionalKey(Schema.Boolean),
  /** What each turn must answer with. It declares `steps.<id>.output`. */
  outputSchema: Schema.optionalKey(OutputSchema),
  ...STEP_GRAPH_FIELDS,
});

/** A way through the graph, from a step or a signal trigger to a step. */
const Edge = closedStruct({
  from: Schema.String,
  to: Schema.String,
  /** Over `inputs` and `steps`. The edge fires only when it is true. */
  condition: Schema.optionalKey(Expression),
  /** How many times the edge may fire in one run. A cycle needs one such edge. */
  maxTraversals: Schema.optionalKey(PositiveInt),
});

/**
 * The one workspace each agent step of a run works in: a repo's main
 * workspace, or an ephemeral workspace made for the run. The shapes are the
 * ones `session.spawn` takes, except a workspace that stands already, which a
 * run cannot name.
 */
const WorkspacePolicy = Schema.Union([
  closedStruct(PrimarySpawnWorkspace.fields),
  closedStruct({
    ...EphemeralSpawnWorkspace.fields,
    checkouts: atMost(closedStruct(SpawnCheckout.fields), MAX_SPAWN_CHECKOUTS),
  }),
]);

/**
 * What a workflow's text says. The keys are declared in the order the
 * canonical text writes them, at every level.
 *
 * The shape alone does not refuse an id that two triggers or steps share:
 * `decodeWorkflowDefinition` does, and it is the one way to check a value.
 */
export const WorkflowDefinition = closedStruct({
  name: WorkflowName,
  description: Schema.optionalKey(WorkflowDescription),
  inputs: Schema.optionalKey(Schema.Array(InputDeclaration)),
  triggers: Schema.optionalKey(Schema.Array(Schema.Union([StartTrigger, SignalTrigger]))),
  steps: Schema.Array(Schema.Union([ActionStep, AgentStep])),
  edges: Schema.optionalKey(Schema.Array(Edge)),
  /** Absent runs each agent step with no checkout. */
  workspace: Schema.optionalKey(WorkspacePolicy),
});

export type WorkflowDefinition = Schema.Schema.Type<typeof WorkflowDefinition>;

/**
 * The entry steps of a definition, in definition order: the steps that a run
 * starts at. A step is an entry step when it says `entry: true`, or when no
 * edge leads into it. Only an edge that may join its two ends leads into a
 * step: an edge from a step or a signal trigger, to a step. A step that only
 * a signal trigger leads into is not an entry step, because it waits for its
 * signal. The controller's check and the editor's graph both read the entry
 * steps here, so the two cannot disagree about where a run begins.
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value at a path inside a value, or `undefined` where the path leads nowhere. */
const readValueAt = (value: unknown, path: ReadonlyArray<PropertyKey>): unknown =>
  path.reduce<unknown>(
    (inner, key) =>
      typeof inner === "object" && inner !== null
        ? (inner as Record<PropertyKey, unknown>)[key]
        : undefined,
    value,
  );

/** The kinds a union of the definition tells its members apart by, in declaration order. */
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

/**
 * The problems that one leaf of a failed decode of the definition stands for,
 * or `undefined` for a leaf that the schema library words well enough. `value`
 * is the whole value that was decoded, where a message reads what was written.
 *
 * Three problems are said here and not by the schema library, which describes
 * a shape it expected as a line of TypeScript. A key that is missing is named
 * with what to do. A value that must be a mapping and is not one says so. A
 * union whose members are told apart by `kind` refuses an unknown kind at
 * `kind`, because the author only wrote one wrong word.
 */
const describeDefinitionLeaf = (
  leaf: SchemaIssue.Issue,
  path: ReadonlyArray<string>,
  value: unknown,
): ReadonlyArray<Issue> | undefined => {
  switch (leaf._tag) {
    case "MissingKey":
      return [{ path, message: `Add ${String(path.at(-1))}. It is necessary here.` }];
    case "InvalidType": {
      if (!SchemaAST.isObjects(leaf.ast)) return undefined;
      const written = describeWritten(readValueAt(value, path));
      return [{ path, message: `Write a mapping of fields here, not ${written}.` }];
    }
    case "AnyOf": {
      const kinds = listKinds(leaf.ast);
      if (kinds.length === 0) return undefined;
      const choices = `${kinds.slice(0, -1).join(", ")} or ${String(kinds.at(-1))}`;
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
 * Refuses an id that an earlier trigger or step has already. Triggers and
 * steps share one set of ids, because an expression reads a signal trigger as
 * `steps.<id>` too. The later of the two is refused, in the order of the
 * definition: triggers first, then steps, in whichever order the text writes
 * them. It reads the value as it was written, so it finds a repeated id also
 * where other fields have the wrong shape.
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
            `A trigger or step before this one has the id ${quoteWritten(id)} already. ` +
            "Give each trigger and each step an id of its own.",
        });
      }
      seen.add(id);
    }
  }
  return issues;
};

const decodeDefinition = Schema.decodeUnknownResult(WorkflowDefinition);

/**
 * The most issues one refusal names. A text of a few hundred kilobytes can
 * hold a mistake on each of thousands of lines, and a refusal that named each
 * one would be many times the size of the request.
 */
const MAX_ISSUES = 100;

/**
 * The first `MAX_ISSUES` issues, and one more issue that says how many are
 * left out. The parse of a text, the check of a definition object and the
 * controller's checks of meaning all refuse through this, so no refusal of a
 * workflow names more.
 */
export const limitIssues = <I extends Issue>(issues: ReadonlyArray<I>): ReadonlyArray<I | Issue> =>
  issues.length <= MAX_ISSUES
    ? issues
    : [
        ...issues.slice(0, MAX_ISSUES),
        {
          path: [],
          message:
            `There are ${String(issues.length - MAX_ISSUES)} more problems. ` +
            "Correct the problems before this one, then send the workflow again to see the others.",
        },
      ];

/**
 * The definition a value holds, or the problems that stop it from being one:
 * a field of the wrong shape, an id that is not a CEL identifier, a JSON value
 * nested too deep, and an id used twice. A definition parsed from a text and a
 * definition object sent as JSON are checked here alike, so the same mistake
 * is named the same way, at the same path, whichever way it arrived.
 */
export const decodeWorkflowDefinition = (
  value: unknown,
): Result.Result<WorkflowDefinition, ReadonlyArray<Issue>> => {
  const decoded = decodeDefinition(value, { errors: "all" });
  const repeated = listRepeatedIds(value);
  if (Result.isSuccess(decoded) && repeated.length === 0) return Result.succeed(decoded.success);
  return Result.fail(
    limitIssues([
      ...(Result.isFailure(decoded)
        ? listSchemaIssues(decoded.failure.issue, {
            describeLeaf: (leaf, path) => describeDefinitionLeaf(leaf, path, value),
          })
        : []),
      ...repeated,
    ]),
  );
};
