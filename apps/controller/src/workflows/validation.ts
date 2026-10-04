/**
 * Validates a parsed workflow definition before it is stored. The parser in
 * `@hercule/contract` has already checked the schema and the ids. This module
 * checks the rest: the inputs, the triggers, the steps with their actions,
 * params and Agents, the edges, and every expression and template. The rules
 * about the graph as a whole are in `./graph`.
 *
 * Every error has its path in the definition, so the author can fix all of
 * them in one round and an editor can show each one in place. The checks
 * report every error they find, with two exceptions:
 *
 * - A template reports only its first error. All errors of a template have
 *   the same path, and the text after a `{{` without a closing `}}` cannot be
 *   parsed at all.
 * - An error that follows from another error is not reported. A trigger with
 *   an unknown event kind gets no `connectionId` error, and an edge whose end
 *   is not a valid node is left out of the graph checks.
 *
 * The checks do no I/O. The service reads what they need into a
 * `ResolvedReferences` inside the save's transaction, so the checks and the
 * write see the same rows.
 */
import * as Cron from "effect/Cron";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";
import {
  ANY_CONNECTION,
  isSchedule,
  shortenLibraryMessage,
  isId,
  joinNames,
  truncateIssues,
  listSchemaIssues,
  quoteAuthorText,
  type EventSelector,
  type Issue,
  type Schedule,
  type WorkflowDefinition,
  type WorkflowIssues,
  type WorkspacePolicy,
} from "@hercule/contract";
import { lintOutputSchema } from "@hercule/protocol";
import type { AgentKind } from "../agents";
import { CRON_TICK_EVENT_KIND, type DeclaredEventKindWithConnectionType } from "../events";
import {
  validateCondition,
  validateExpression,
  validateTemplate,
  isTemplate,
  type ExpressionError,
  type ExpressionScope,
} from "../expressions";
import {
  CONNECTION_PARAM,
  separateConnectionParam,
  type BuiltInControllerActionId,
  type RegisteredWorkflowAction,
  type WorkspaceActionId,
} from "../plugins";
import { isKnownTimezone } from "../settings";
import { listEdgeEndIssues, listGraphIssues, type GraphEdge, type GraphNodes } from "./graph";

/**
 * The things a definition can refer to that exist on the controller now. If a
 * name is not in a collection, the thing it refers to does not exist.
 */
export interface ResolvedReferences {
  /** The workflow actions a step can use, by id. */
  readonly actions: ReadonlyMap<string, RegisteredWorkflowAction>;
  /** The event kinds a trigger can listen for, by kind. */
  readonly eventKinds: ReadonlyMap<string, DeclaredEventKindWithConnectionType>;
  /** The kind of each Agent that the definition refers to and that exists, by Agent id. */
  readonly agentKindById: ReadonlyMap<string, AgentKind>;
  /** The qualified type of each Connection that the definition refers to and that exists, by Connection id. */
  readonly connectionTypeById: ReadonlyMap<string, string>;
  /** The qualified name of every Connection type of an active plugin. */
  readonly connectionTypes: ReadonlySet<string>;
  /**
   * The declared inputs of each stored workflow that a `run.start` step of
   * the definition names by its id, by workflow id. A workflow that does not
   * exist is not in the map.
   */
  readonly startedWorkflowInputsById: ReadonlyMap<string, ReadonlyArray<Input>>;
}

type Input = NonNullable<WorkflowDefinition["inputs"]>[number];
type Trigger = NonNullable<WorkflowDefinition["triggers"]>[number];
type StartTrigger = Extract<Trigger, { readonly kind: "start" }>;
type Step = WorkflowDefinition["steps"][number];
type ActionStep = Extract<Step, { readonly kind: "action" }>;
type AgentStep = Extract<Step, { readonly kind: "agent" }>;
type Edge = NonNullable<WorkflowDefinition["edges"]>[number];

/**
 * The workspace actions that work in one git checkout of the run's workspace.
 * Each takes an optional `resourceId` that picks the checkout.
 */
const GIT_ACTION_IDS: ReadonlySet<string> = new Set([
  "git.commit",
  "git.push",
] satisfies ReadonlyArray<WorkspaceActionId>);

/** Checks whether an action works in one git checkout of the run's workspace, such as `git.commit`. */
export const isGitActionId = (id: string): boolean => GIT_ACTION_IDS.has(id);

/** Returns the number of checkouts a run's workspace has under a policy: one for a main workspace. */
const countPolicyCheckouts = (policy: WorkspacePolicy): number =>
  policy.kind === "primary" ? 1 : policy.checkouts.length;

/** Returns the ids of the Agents that a definition's steps refer to, without duplicates. */
export const listReferencedAgentIds = (definition: WorkflowDefinition): ReadonlyArray<string> => [
  ...new Set(definition.steps.flatMap((step) => (step.kind === "agent" ? [step.agent] : []))),
];

/** The id of the built-in action that starts a run of a stored workflow. */
const RUN_START_ACTION_ID = "run.start" satisfies BuiltInControllerActionId;

/**
 * Returns the params of a step if it is a `run.start` step, and `undefined`
 * for any other step.
 */
const readRunStartParams = (step: Step): Readonly<Record<string, unknown>> | undefined =>
  step.kind === "action" && step.action === RUN_START_ACTION_ID ? (step.params ?? {}) : undefined;

/** Checks whether a JSON value is an object, and not an array or `null`. */
const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Returns the ids of the stored workflows that a definition's `run.start`
 * steps name, without duplicates. A `workflowId` written as a template is
 * skipped, because its value is known only when a run renders it.
 */
export const listStartedWorkflowIds = (definition: WorkflowDefinition): ReadonlyArray<string> => [
  ...new Set(
    definition.steps.flatMap((step) => {
      const workflowId = readRunStartParams(step)?.["workflowId"];
      return isId(workflowId) ? [workflowId] : [];
    }),
  ),
];

/**
 * Returns the ids of the Connections that a definition refers to, without
 * duplicates:
 *
 * - in the `connectionId` of a trigger's event selector;
 * - as the default of a Connection input;
 * - in the `connection` param of an action step, when it is written as a
 *   literal id rather than a template;
 * - as a value in the `inputs` param of a `run.start` step, which can fill a
 *   Connection input of the workflow the step starts.
 *
 * A default or a param that is not a valid id cannot refer to a Connection,
 * so it is skipped.
 */
export const listReferencedConnectionIds = (
  definition: WorkflowDefinition,
): ReadonlyArray<string> => [
  ...new Set([
    ...(definition.triggers ?? []).flatMap((trigger) =>
      isSchedule(trigger.on) ||
      trigger.on.connectionId === undefined ||
      trigger.on.connectionId === ANY_CONNECTION
        ? []
        : [trigger.on.connectionId],
    ),
    ...(definition.inputs ?? []).flatMap((input) =>
      input.connection !== undefined && isId(input.default) ? [input.default] : [],
    ),
    ...definition.steps.flatMap((step) => {
      const connection = step.kind === "action" ? step.params?.[CONNECTION_PARAM] : undefined;
      return isId(connection) ? [connection] : [];
    }),
    ...definition.steps.flatMap((step) => {
      const inputs = readRunStartParams(step)?.["inputs"];
      return isJsonObject(inputs) ? Object.values(inputs).filter(isId) : [];
    }),
  ]),
];

/**
 * Runs the check of an expression or a template. Returns its error as one
 * issue at `path`, or no issue if the check passes.
 */
const listCheckIssues = (
  path: ReadonlyArray<string>,
  check: Effect.Effect<void, ExpressionError>,
): Effect.Effect<ReadonlyArray<Issue>> =>
  Effect.match(check, {
    onSuccess: () => [],
    onFailure: (refusal) => [{ path, message: refusal.message }],
  });

/**
 * Checks each expression in a map, such as a trigger's input mappings.
 * Returns an issue at `path` plus the key for each expression that fails.
 */
const checkExpressionMap = (
  expressions: Readonly<Record<string, string>> | undefined,
  scope: ExpressionScope,
  path: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<Issue>> =>
  Effect.map(
    Effect.forEach(Object.entries(expressions ?? {}), ([name, source]) =>
      listCheckIssues([...path, name], validateExpression(source, scope)),
    ),
    (issues) => issues.flat(),
  );

/**
 * Validates a Connection input. Its type must be a Connection type of an
 * active plugin, and its default, if present, must be the id of an existing
 * Connection of that type. Returns no issues for any other kind of input.
 *
 * A plugin that is not active cannot act through its Connections, in the same
 * way that its event kinds and actions cannot be used.
 */
const listInputIssues = (
  input: Input,
  index: number,
  references: ResolvedReferences,
): ReadonlyArray<Issue> => {
  if (input.connection === undefined) return [];
  const path = ["inputs", String(index)];
  const wanted = input.connection.type;
  if (!references.connectionTypes.has(wanted)) {
    // The default can only be checked against a valid type. If the type is
    // unknown, report the type and skip the default.
    return [
      {
        path: [...path, "connection", "type"],
        message:
          `${quoteAuthorText(wanted)} is not a Connection type of an active plugin. ` +
          (references.connectionTypes.size === 0
            ? "No active plugin declares a Connection type. Enable the plugin that declares this type, or remove the input."
            : "Enable the plugin that declares this type, or use one of the Connection types of the active plugins: " +
              `${[...references.connectionTypes].join(", ")}.`),
      },
    ];
  }
  if (input.default === undefined) return [];
  const found = isId(input.default) ? references.connectionTypeById.get(input.default) : undefined;
  if (found === undefined) {
    return [
      {
        path: [...path, "default"],
        message: `No Connection has this id. Write the id of a Connection of type ${quoteAuthorText(wanted)}.`,
      },
    ];
  }
  return found === wanted
    ? []
    : [
        {
          path: [...path, "default"],
          message:
            `This Connection is of type ${found}, but the input needs a Connection of type ${quoteAuthorText(wanted)}. ` +
            `Write the id of a Connection of type ${quoteAuthorText(wanted)}.`,
        },
      ];
};

/**
 * Validates the event kind and `connectionId` of a trigger's event selector.
 * `path` is the path of the selector in the definition, and `triggerKind` is
 * the kind of the trigger that holds it.
 *
 * - The event kind must exist. `cron.tick` is not one: the Scheduler emits it
 *   only for cron triggers. Its error tells the author of a start trigger to
 *   write a schedule. A signal trigger cannot fire on a schedule, so its error
 *   tells the author to name the kind of an event the run waits for.
 * - An event kind of a plugin needs a `connectionId`: the id of a Connection
 *   of the kind's Connection type, or `any`.
 * - A core event kind must have no `connectionId`.
 *
 * An unknown event kind gets no `connectionId` error, because which
 * `connectionId` is right depends on the kind.
 */
const listEventSelectorIssues = (
  selector: EventSelector,
  path: ReadonlyArray<string>,
  triggerKind: Trigger["kind"],
  references: ResolvedReferences,
): ReadonlyArray<Issue> => {
  const { kind, connectionId } = selector;
  const eventKind = references.eventKinds.get(kind);
  if (eventKind === undefined) {
    return [
      {
        path: [...path, "kind"],
        message:
          `${quoteAuthorText(kind)} is not a known event kind. ` +
          (kind !== CRON_TICK_EVENT_KIND
            ? "A trigger can listen for a platform event kind or an event kind of an active plugin. " +
              `The known event kinds are: ${[...references.eventKinds.keys()].join(", ")}.`
            : triggerKind === "start"
              ? `No trigger can listen for ${CRON_TICK_EVENT_KIND}: the Scheduler emits it only for cron triggers. ` +
                'To fire on a schedule, write schedule under on in place of kind, such as schedule: "0 9 * * 1-5" for 09:00 on weekdays.'
              : "A signal trigger resumes a run when an event arrives, so it names the kind of an event the run waits for. " +
                `The known event kinds are: ${[...references.eventKinds.keys()].join(", ")}.`),
      },
    ];
  }
  const connectionPath = [...path, "connectionId"];
  const connectionType = eventKind.connectionType;
  if (connectionType === undefined) {
    return connectionId === undefined
      ? []
      : [
          {
            path: connectionPath,
            message: `Events of kind ${kind} are core events and do not come through a Connection. Remove connectionId.`,
          },
        ];
  }
  const choice = `Write the id of a Connection of type ${connectionType}, or write ${ANY_CONNECTION} to listen on every Connection of that type.`;
  if (connectionId === undefined) {
    return [
      {
        path: connectionPath,
        message: `Events of kind ${kind} come through a Connection of type ${connectionType}, so the trigger must say which Connection to listen on. ${choice}`,
      },
    ];
  }
  if (connectionId === ANY_CONNECTION) return [];
  const found = references.connectionTypeById.get(connectionId);
  if (found === undefined)
    return [{ path: connectionPath, message: `No Connection has this id. ${choice}` }];
  return found === connectionType
    ? []
    : [
        {
          path: connectionPath,
          message: `This Connection is of type ${found}, but events of kind ${kind} come through a Connection of type ${connectionType}. ${choice}`,
        },
      ];
};

/**
 * Validates a cron trigger's schedule. `path` is the path of the schedule's
 * `on` in the definition.
 *
 * - The timezone, if present, must be an IANA timezone.
 * - The cron expression must have five fields, parse, and come due at least
 *   once.
 */
const listScheduleIssues = (
  schedule: Schedule,
  path: ReadonlyArray<string>,
): ReadonlyArray<Issue> => {
  const zone =
    schedule.timezone !== undefined && isKnownTimezone(schedule.timezone)
      ? schedule.timezone
      : undefined;
  const issues: Array<Issue> = [];
  if (schedule.timezone !== undefined && zone === undefined) {
    issues.push({
      path: [...path, "timezone"],
      message:
        `${quoteAuthorText(schedule.timezone)} is not a timezone. ` +
        "Write an IANA timezone, such as Europe/Amsterdam, or remove timezone to use the timezone of your settings.",
    });
  }
  const schedulePath = [...path, "schedule"];
  // A cron expression has five fields. The parser also accepts six, with
  // seconds first, but a schedule with seconds could start a run every
  // second.
  if (schedule.schedule.trim().split(/\s+/).length === 6) {
    issues.push({
      path: schedulePath,
      message:
        "This schedule has six fields. A schedule has five fields: minute, hour, day of the month, month and day of the week, and no field for seconds. " +
        'Write five fields, such as "0 9 * * 1-5" for 09:00 on weekdays.',
    });
    return issues;
  }
  // Parse the schedule in its timezone if the timezone is valid. An invalid
  // timezone is already reported above, so it is not reported again.
  const parsed = Cron.parse(schedule.schedule, zone);
  if (Result.isFailure(parsed)) {
    issues.push({
      path: schedulePath,
      message: `This schedule is not a cron expression. ${shortenLibraryMessage(parsed.failure.message)} Write five fields, such as "0 9 * * 1-5" for 09:00 on weekdays.`,
    });
  } else if (!comesDue(parsed.success)) {
    issues.push({
      path: schedulePath,
      message:
        "This schedule never comes due: no date matches it, such as the 31st of February. " +
        'Write a date that exists, such as "0 9 1 * *" for 09:00 on the first of each month.',
    });
  }
  return issues;
};

/**
 * Checks that a cron schedule matches at least one future time. A schedule
 * can parse and still never match, such as one for the 31st of February, and
 * the Scheduler could then never compute the trigger's next time.
 */
const comesDue = (cron: Cron.Cron): boolean => {
  try {
    Cron.next(cron);
    return true;
  } catch {
    // `Cron.next` throws when it finds no matching date.
    return false;
  }
};

/**
 * Validates a start trigger's input mappings. Each mapping must be for an
 * input that the workflow declares. Every required input without a default
 * must be mapped, because a run that the trigger starts cannot begin without
 * it.
 */
const listInputMappingIssues = (
  trigger: StartTrigger,
  index: number,
  inputs: ReadonlyArray<Input>,
): ReadonlyArray<Issue> => {
  const path = ["triggers", String(index), "inputs"];
  const mapped = trigger.inputs ?? {};
  const declared = new Set(inputs.map((input) => input.name));
  const undeclared = Object.keys(mapped)
    .filter((name) => !declared.has(name))
    .map((name) => ({
      path: [...path, name],
      message:
        "The workflow declares no input with this name. Declare the input under inputs, or remove this mapping.",
    }));
  const unmapped = inputs
    .filter(
      (input) =>
        input.required && input.default === undefined && !Object.hasOwn(mapped, input.name),
    )
    .map((input) => quoteAuthorText(input.name));
  if (unmapped.length === 0) return undeclared;
  const isSingleInput = unmapped.length === 1;
  return [
    ...undeclared,
    {
      path,
      message:
        `The start trigger ${quoteAuthorText(trigger.id)} does not map the ${isSingleInput ? "input" : "inputs"} ${joinNames(unmapped)}. ` +
        `${isSingleInput ? "The input is" : "The inputs are"} required and ${isSingleInput ? "has" : "have"} no default, so a run that this trigger starts could not begin. ` +
        `Map ${isSingleInput ? "the input" : "each input"} under inputs here, or give ${isSingleInput ? "it" : "each one"} a default.`,
    },
  ];
};

/**
 * Checks the filter of a trigger's event selector. `path` is the path of the
 * selector. The trigger accepts an event only when the filter is true, so the
 * filter must be a condition that reads only the event.
 */
const checkFilter = (
  selector: EventSelector,
  path: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<Issue>> =>
  selector.filter === undefined
    ? Effect.succeed([])
    : listCheckIssues([...path, "filter"], validateCondition(selector.filter, "event"));

/** Checks one trigger, its expressions included. Returns every issue found. */
const checkTrigger = (
  trigger: Trigger,
  index: number,
  definition: WorkflowDefinition,
  references: ResolvedReferences,
): Effect.Effect<ReadonlyArray<Issue>> => {
  const path = ["triggers", String(index)];
  const onPath = [...path, "on"];
  const issues: Array<Issue> = [];
  const expressionChecks: Array<Effect.Effect<ReadonlyArray<Issue>>> = [];
  if (isSchedule(trigger.on)) {
    issues.push(...listScheduleIssues(trigger.on, onPath));
  } else {
    issues.push(...listEventSelectorIssues(trigger.on, onPath, trigger.kind, references));
    expressionChecks.push(checkFilter(trigger.on, onPath));
  }
  if (trigger.kind === "start") {
    issues.push(...listInputMappingIssues(trigger, index, definition.inputs ?? []));
    expressionChecks.push(checkExpressionMap(trigger.inputs, "event", [...path, "inputs"]));
  } else {
    expressionChecks.push(
      listCheckIssues(
        [...path, "correlation", "event"],
        validateExpression(trigger.correlation.event, "event"),
      ),
      listCheckIssues(
        [...path, "correlation", "run"],
        validateExpression(trigger.correlation.run, "run"),
      ),
      checkExpressionMap(trigger.outputs, "event", [...path, "outputs"]),
    );
  }
  return Effect.map(Effect.all(expressionChecks), (expressionIssues) => [
    ...issues,
    ...expressionIssues.flat(),
  ]);
};

/** A param that an action takes: its name, and whether a step may omit it. */
interface ActionParam {
  readonly name: string;
  readonly optional: boolean;
}

/**
 * Returns the params that an action takes. The plugin host registers an action
 * only if its input schema is a struct, so each param is one property of that
 * struct.
 */
const listActionParams = (action: RegisteredWorkflowAction): ReadonlyArray<ActionParam> =>
  SchemaAST.isObjects(action.input.ast)
    ? action.input.ast.propertySignatures.flatMap((property) =>
        typeof property.name === "string"
          ? [{ name: property.name, optional: SchemaAST.isOptional(property.type) }]
          : [],
      )
    : [];

/** A template string and its path in the definition. */
interface PlacedTemplate {
  readonly path: ReadonlyArray<string>;
  readonly template: string;
}

/**
 * Returns every template string in a value, at any depth: the value itself,
 * an array item, or an object field. The parser limits how deeply a param
 * value can nest, so the recursion cannot overflow the call stack.
 */
const listTemplates = (
  value: unknown,
  path: ReadonlyArray<string>,
): ReadonlyArray<PlacedTemplate> => {
  if (typeof value === "string") return isTemplate(value) ? [{ path, template: value }] : [];
  if (typeof value !== "object" || value === null) return [];
  return Array.isArray(value)
    ? value.flatMap((item, index) => listTemplates(item, [...path, String(index)]))
    : Object.entries(value).flatMap(([key, item]) => listTemplates(item, [...path, key]));
};

/**
 * Decodes a step's params against the action's input schema as one value, so
 * that rules which span several fields are checked too, such as the rule that
 * an update must set at least one field. An unknown key at any depth is an
 * error, because the action would never receive it.
 */
const decodeParams = (action: RegisteredWorkflowAction, params: unknown) =>
  Schema.decodeUnknownResult(action.input as Schema.Codec<unknown>)(params, {
    errors: "all",
    onExcessProperty: "error",
  });

/**
 * Returns whether a schema issue at a template is about the value that a run
 * will render there: a wrong type, a value the field does not allow, or a
 * failed check. That value is unknown until a run renders the template, so
 * such an issue is ignored. Other issues at a template are still reported,
 * such as an unknown key, or a field that accepts no value at all (for
 * example a field that the core fills in).
 */
const isAboutRenderedValue = (issue: SchemaIssue.Issue): boolean => {
  switch (issue._tag) {
    case "InvalidType":
      return !SchemaAST.isNever(issue.ast);
    case "InvalidValue":
    case "Filter":
      return true;
    case "AnyOf":
      // No member of the union accepts the value, for example a template in
      // a field that only allows fixed literals.
      return issue.issues.length === 0;
    default:
      return false;
  }
};

/**
 * The message for a key that the action's input schema does not declare. The
 * schema library's own message only reports that the key is unexpected.
 */
const UNKNOWN_PARAM_FIELD =
  "The action's input has no field with this name at this level. Remove the field, or fix its name.";

/**
 * Converts the schema issue from decoding a step's params into a list of
 * issues at their paths in the definition. Skips an issue at a template if it
 * is about the value that a run will render there. `path` is the path of
 * `paramsIssue` in the definition, and `templatePaths` holds the path of each
 * template, as JSON.
 */
const listParamIssues = (
  paramsIssue: SchemaIssue.Issue,
  path: ReadonlyArray<string>,
  templatePaths: ReadonlySet<string>,
): ReadonlyArray<Issue> =>
  listSchemaIssues(paramsIssue, {
    path,
    describeIssue: (issue, issuePath) => {
      if (isAboutRenderedValue(issue) && templatePaths.has(JSON.stringify(issuePath))) return [];
      return issue._tag === "UnexpectedKey"
        ? [{ path: issuePath, message: UNKNOWN_PARAM_FIELD }]
        : undefined;
    },
  });

/**
 * Matches a template that is exactly one input, such as `{{ inputs.account }}`,
 * and captures the input's name.
 */
const SINGLE_INPUT_TEMPLATE = /^\{\{\s*inputs\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

/**
 * Returns the name of the input a value reads when the value is a template
 * that is exactly one input, such as `{{ inputs.account }}`. Returns
 * `undefined` for any other value, such as a literal Connection id.
 */
export const readConnectionInputName = (connection: unknown): string | undefined =>
  typeof connection === "string" ? SINGLE_INPUT_TEMPLATE.exec(connection)?.[1] : undefined;

/**
 * What a connection param fills:
 *
 * - `connection`: the `connection` param of an action that acts through a
 *   Connection of type `type`;
 * - `started-input`: the Connection input `name`, of type `type`, of the
 *   stored workflow that a `run.start` step starts;
 * - `unknown-started-input`: the input `name` of the workflow that a
 *   `run.start` step starts, when the step names it with a template or with
 *   an id no workflow has. Which of its inputs are Connection inputs is then
 *   unknown, so every value the step gives counts;
 * - `started-inputs`: the whole `inputs` param of a `run.start` step, written
 *   as a template, when the workflow the step starts may have a Connection
 *   input.
 */
export type ConnectionParamTarget =
  | { readonly kind: "connection"; readonly type: string }
  | { readonly kind: "started-input"; readonly name: string; readonly type: string }
  | { readonly kind: "unknown-started-input"; readonly name: string }
  | { readonly kind: "started-inputs" };

/**
 * A value in a definition that chooses the Connection a step acts through:
 * the `connection` param of an action that acts through a Connection, or a
 * value that a `run.start` step gives for a Connection input of the workflow
 * it starts. A step of the child run then acts through that Connection, so
 * the value chooses it as much as a `connection` param does.
 */
export interface ConnectionParam {
  /** The value's path in the definition. */
  readonly path: ReadonlyArray<string>;
  /** The value as written: a literal, or a template. */
  readonly value: unknown;
  /** What the value fills. */
  readonly target: ConnectionParamTarget;
}

/** What `listConnectionParams` reads besides the definition. */
export type ConnectionParamReferences = Pick<
  ResolvedReferences,
  "actions" | "startedWorkflowInputsById"
>;

/**
 * Returns the connection params in a `run.start` step's params. `paramsPath`
 * is the path of the params in the definition.
 *
 * When the step names a stored workflow by its id, each value it gives for
 * one of that workflow's Connection inputs is a connection param. When the
 * workflow is not known before a run, because `workflowId` is a template or
 * an id no workflow has, every value the step gives is one: the controller
 * cannot tell which inputs take a Connection, so it treats each as one that
 * may. An `inputs` param written as a template is one connection param in
 * both cases, unless the workflow is known to have no Connection input.
 */
const listStartedConnectionParams = (
  params: Readonly<Record<string, unknown>>,
  paramsPath: ReadonlyArray<string>,
  startedWorkflowInputsById: ReadonlyMap<string, ReadonlyArray<Input>>,
): ReadonlyArray<ConnectionParam> => {
  const workflowId = params["workflowId"];
  const inputs = params["inputs"];
  const inputsPath = [...paramsPath, "inputs"];
  const declared =
    typeof workflowId === "string" ? startedWorkflowInputsById.get(workflowId) : undefined;
  const connectionInputs = declared?.filter((input) => input.connection !== undefined);
  if (connectionInputs?.length === 0) return [];
  if (typeof inputs === "string" && isTemplate(inputs)) {
    return [{ path: inputsPath, value: inputs, target: { kind: "started-inputs" } }];
  }
  // A missing `inputs` gives no values. Any other value that is not an object
  // fails to decode, and validation reports that.
  if (!isJsonObject(inputs)) return [];
  if (connectionInputs === undefined) {
    return Object.entries(inputs).map(([name, value]) => ({
      path: [...inputsPath, name],
      value,
      target: { kind: "unknown-started-input", name },
    }));
  }
  return connectionInputs.flatMap((input) =>
    input.connection !== undefined && Object.hasOwn(inputs, input.name)
      ? [
          {
            path: [...inputsPath, input.name],
            value: inputs[input.name],
            target: { kind: "started-input", name: input.name, type: input.connection.type },
          },
        ]
      : [],
  );
};

/**
 * Returns the connection params of one step, in the order they are written.
 * `index` is the step's index in the definition. A step whose action is not
 * in the catalog has none, because validation reports it as unknown.
 */
const listStepConnectionParams = (
  step: Step,
  index: number,
  references: ConnectionParamReferences,
): ReadonlyArray<ConnectionParam> => {
  if (step.kind !== "action") return [];
  const paramsPath = ["steps", String(index), "params"];
  const action = references.actions.get(step.action);
  if (action?.connection !== undefined) {
    return [
      {
        path: [...paramsPath, CONNECTION_PARAM],
        value: step.params?.[CONNECTION_PARAM],
        target: { kind: "connection", type: action.connection.type },
      },
    ];
  }
  const runStartParams = readRunStartParams(step);
  return runStartParams === undefined
    ? []
    : listStartedConnectionParams(runStartParams, paramsPath, references.startedWorkflowInputsById);
};

/**
 * Returns the connection params of `definition`, in step order, each as
 * written (see `ConnectionParam`). A `connection` param that is missing is
 * returned with the value `undefined`.
 *
 * The controller uses the list to decide who chose the Connection a step
 * acts through: the author of the definition for a literal, or the caller
 * who fills in the input for a template that is exactly one input.
 * Validation allows no other template, so the list holds every way a caller
 * can choose a Connection. Choosing one needs the `connection.use` grant.
 *
 * This holds at every depth of nesting: a `run.start` step that gives a
 * value for a Connection input counts here, so a workflow cannot hand a
 * child run a Connection that its author or its starter could not have
 * chosen themselves.
 */
export const listConnectionParams = (
  definition: WorkflowDefinition,
  references: ConnectionParamReferences,
): ReadonlyArray<ConnectionParam> =>
  definition.steps.flatMap((step, index) => listStepConnectionParams(step, index, references));

/**
 * Describes the two forms a connection param takes, for one that must name a
 * Connection of type `type`. Every message about such a param ends with it,
 * so the author always learns what to write instead.
 */
const describeConnectionParamForms = (type: string): string =>
  `the id of a Connection of type ${type}, or a template that is exactly one Connection input of that type, such as {{ inputs.account }}`;

/** Names the value a connection param holds, as the subject of a message. */
const describeConnectionParamValue = (target: ConnectionParamTarget): string => {
  switch (target.kind) {
    case "connection":
      return "The param connection";
    case "started-input":
    case "unknown-started-input":
      return `The value for the input ${target.name}`;
    case "started-inputs":
      return "The param inputs";
  }
};

/** Says why a connection param chooses a Connection, as a clause of a message. */
const describeConnectionNeed = (target: ConnectionParamTarget): string => {
  switch (target.kind) {
    case "connection":
      return `the action acts through a Connection of type ${target.type}`;
    case "started-input":
      return `the input ${target.name} of the workflow this step starts takes a Connection of type ${target.type}`;
    case "unknown-started-input":
    case "started-inputs":
      return "the workflow this step starts may take a Connection in its inputs";
  }
};

/** Says what to write instead of a refused connection param. */
const describeConnectionParamFix = (target: ConnectionParamTarget): string => {
  switch (target.kind) {
    case "connection":
    case "started-input":
      return `Write ${describeConnectionParamForms(target.type)}.`;
    case "unknown-started-input":
      return "Write the value itself, or a template that is exactly one input, such as {{ inputs.account }}. Or name the workflow to start by its id, so that only its Connection inputs are checked.";
    case "started-inputs":
      return "Write inputs as an object with a value for each input.";
  }
};

/**
 * Checks a connection param. Returns the issues at the param's path, or none
 * when the param is missing: `listActionIssues` reports a missing param
 * together with the action's other missing params. `inputs` are the inputs
 * of the workflow the param is written in.
 *
 * A param that must name a Connection of a known type takes one of two
 * forms:
 *
 * - a literal, which must be the id of an existing Connection of that type;
 * - a template that is exactly one input, such as `{{ inputs.account }}`,
 *   which must read a Connection input of that type.
 *
 * Any other template is refused. With only these two forms, the Connection a
 * step acts through is known before a run starts: it is fixed in the
 * definition, or it is the value of an input. So the controller can check
 * who chose the Connection, and whether that actor holds `connection.use`.
 *
 * A value for an input of a workflow that is not known before a run may be
 * any literal, or a template that is exactly one input of any kind. There is
 * no type to check it against, but who chose it is still known. An `inputs`
 * param written as a template is always refused, because it hides which
 * values the child run gets.
 *
 * Whether the Connection is disabled is not checked here, in the same way as
 * the default of a Connection input: a disabled Connection can be enabled
 * again before the workflow runs. A run is refused when it starts with one.
 */
const listConnectionParamIssues = (
  param: ConnectionParam,
  inputs: ReadonlyArray<Input>,
  references: ResolvedReferences,
): ReadonlyArray<Issue> => {
  const { path, value, target } = param;
  if (value === undefined) return [];
  const subject = describeConnectionParamValue(target);
  const need = describeConnectionNeed(target);
  const refuse = (message: string): ReadonlyArray<Issue> => [
    { path, message: `${message} ${describeConnectionParamFix(target)}` },
  ];
  if (target.kind === "started-inputs") {
    return refuse(
      `${subject} cannot be a template here: ${need}, and that Connection must be known before a run starts.`,
    );
  }
  if (typeof value !== "string") {
    return target.kind === "unknown-started-input"
      ? []
      : refuse(`${subject} must be text, because ${need}.`);
  }
  if (isTemplate(value)) {
    const name = readConnectionInputName(value);
    if (name === undefined) {
      return refuse(
        `${subject} cannot be computed by a template: ${need}, and that Connection must be known before a run starts.`,
      );
    }
    const input = inputs.find((candidate) => candidate.name === name);
    if (input === undefined) return refuse(`The workflow has no input named ${name}.`);
    if (target.kind === "unknown-started-input") return [];
    if (input.connection === undefined) {
      return refuse(`The input ${name} is not a Connection input, and ${need}.`);
    }
    return input.connection.type === target.type
      ? []
      : refuse(
          `The input ${name} is a Connection of type ${quoteAuthorText(input.connection.type)}, but ${need}.`,
        );
  }
  if (target.kind === "unknown-started-input") return [];
  const found = isId(value) ? references.connectionTypeById.get(value) : undefined;
  if (found === undefined) return refuse("No Connection has this id.");
  return found === target.type ? [] : refuse(`This Connection is of type ${found}, but ${need}.`);
};

/**
 * Validates an action step's action and params:
 *
 * - the action must exist;
 * - every required param must be present;
 * - every param must be one that the action takes;
 * - the params must decode against the action's input schema;
 * - an action that acts through a Connection needs the param `connection`,
 *   which `listConnectionParamIssues` checks. That param is not in the
 *   action's input schema, so it is left out of the decode;
 * - a `run.start` step's values for Connection inputs of the workflow it
 *   starts are checked in the same way (see `listConnectionParams`).
 *
 * A string that contains `{{` is a template, wherever it is in the params, and
 * its value is known only when a run renders it. So a template is accepted
 * for a field of any type, and a schema error about its value is ignored. A
 * rule that spans several fields is checked only when every field decodes, so
 * a template in a field that rejects strings leaves that rule unchecked.
 */
const listActionIssues = (
  step: ActionStep,
  index: number,
  references: ResolvedReferences,
  templates: ReadonlyArray<PlacedTemplate>,
  definition: WorkflowDefinition,
): ReadonlyArray<Issue> => {
  const path = ["steps", String(index)];
  const action = references.actions.get(step.action);
  if (action === undefined) {
    return [
      {
        path: [...path, "action"],
        message:
          `${quoteAuthorText(step.action)} is not a known action. ` +
          "A step can use a built-in action or an action of an active plugin. " +
          `The known actions are: ${[...references.actions.keys()].join(", ")}.`,
      },
    ];
  }
  const { connection, actionParams: params } =
    action.connection === undefined
      ? { connection: undefined, actionParams: step.params ?? {} }
      : separateConnectionParam(step.params ?? {});
  const taken = [
    ...(action.connection === undefined ? [] : [{ name: CONNECTION_PARAM, optional: false }]),
    ...listActionParams(action),
  ];
  const takenNames = new Set(taken.map((param) => param.name));
  const given = new Set([
    ...Object.keys(params),
    ...(connection === undefined ? [] : [CONNECTION_PARAM]),
  ]);
  const missing = taken
    .filter((param) => !param.optional && !given.has(param.name))
    .map((param) => param.name);
  const unknown = Object.keys(params).filter((name) => !takenNames.has(name));
  const issues: Array<Issue> = [...listWorkspaceIssues(step, index, action, definition.workspace)];
  if (missing.length > 0) {
    const isSingleParam = missing.length === 1;
    const connectionHint =
      action.connection !== undefined && missing.includes(CONNECTION_PARAM)
        ? ` The param connection names the Connection the action acts through: ${describeConnectionParamForms(action.connection.type)}.`
        : "";
    issues.push({
      path: [...path, "params"],
      message: `The action ${action.id} needs the ${isSingleParam ? "param" : "params"} ${joinNames(missing)}. Add ${isSingleParam ? "it" : "them"} under params.${connectionHint}`,
    });
  }
  for (const param of listStepConnectionParams(step, index, references)) {
    issues.push(...listConnectionParamIssues(param, definition.inputs ?? [], references));
  }
  for (const name of unknown) {
    issues.push({
      path: [...path, "params", name],
      message: `The action ${action.id} has no param with this name. Its params are: ${[...takenNames].join(", ")}.`,
    });
  }
  const decoded = decodeParams(action, params);
  if (Result.isSuccess(decoded)) return issues;
  const paramsPath = [...path, "params"];
  const templatePaths = new Set(templates.map((template) => JSON.stringify(template.path)));
  // Missing and unknown params are reported above, together with the list of
  // params the action takes, so skip the decoder's errors about them.
  const namedAbove = new Set([...missing, ...unknown]);
  for (const issue of listParamIssues(decoded.failure.issue, paramsPath, templatePaths)) {
    const param = issue.path[paramsPath.length];
    if (param !== undefined && namedAbove.has(param)) continue;
    issues.push({
      path: issue.path,
      message: `The action ${action.id} cannot take ${param === undefined ? "these params" : "this value"}. ${shortenLibraryMessage(issue.message)}`,
    });
  }
  return issues;
};

/**
 * Checks the Agent an agent step names. Returns one issue if no Agent has the
 * id, or if the Agent is an assistant, and none otherwise. An assistant's
 * sessions belong to its conversation, so a step that named one would save
 * cleanly and then fail every run when the session is placed.
 */
const listAgentReferenceIssues = (
  agentId: string,
  path: ReadonlyArray<string>,
  references: ResolvedReferences,
): ReadonlyArray<Issue> => {
  switch (references.agentKindById.get(agentId)) {
    case "agent":
      return [];
    case "assistant":
      return [
        {
          path,
          message:
            "This id is an assistant's. An agent step runs a session of an Agent, and an assistant's sessions belong to its conversation. Write the id of an Agent that is not an assistant.",
        },
      ];
    case undefined:
      return [
        {
          path,
          message:
            "No Agent has this id. An agent step runs a session of an Agent. Write the id of an Agent that exists.",
        },
      ];
  }
};

/**
 * Checks that an action which runs in the run's workspace has a workspace to
 * run in. Returns an issue when:
 *
 * - the workflow has no `workspace`, so a run of it has no workspace at all;
 * - a git action runs in a workspace with no checkout (`ephemeral` with
 *   `checkouts: []`), so it has nothing to work in;
 * - a git action names no `resourceId` while the workspace has more than one
 *   checkout, so a run could not tell which checkout to work in.
 *
 * All three are decided by the definition alone: the checkouts of a policy
 * are written out, never rendered from a template. A `resourceId` that names
 * a repo the workspace has no checkout of is checked when the step runs,
 * because the param can be a template.
 */
const listWorkspaceIssues = (
  step: ActionStep,
  index: number,
  action: RegisteredWorkflowAction,
  workspace: WorkspacePolicy | undefined,
): ReadonlyArray<Issue> => {
  if (action.runsIn !== "workspace") return [];
  const path = ["steps", String(index)];
  if (workspace === undefined) {
    return [
      {
        path: [...path, "action"],
        message: `The action ${action.id} runs in the run's workspace, and this workflow has no workspace. Add a workspace to the workflow: the repo's main workspace (kind: primary), or a workspace of its own for each run (kind: ephemeral).`,
      },
    ];
  }
  const checkouts = countPolicyCheckouts(workspace);
  if (isGitActionId(action.id) && checkouts === 0) {
    return [
      {
        path: [...path, "action"],
        message: `The action ${action.id} works in a checkout, and the workflow's workspace has none. Add the repo it works in under workspace.checkouts.`,
      },
    ];
  }
  if (
    isGitActionId(action.id) &&
    checkouts > 1 &&
    !Object.hasOwn(step.params ?? {}, "resourceId")
  ) {
    return [
      {
        path: [...path, "params"],
        message: `The workflow's workspace has ${String(checkouts)} checkouts, so the action ${action.id} must say which one it works in. Add resourceId under params, set to the id of one of the workspace's repos.`,
      },
    ];
  }
  return [];
};

/**
 * Validates an agent step's Agent and output schema. The Agent must exist and
 * must not be an assistant. The output schema must stay within the JSON
 * Schema subset that every provider accepts, with one issue per broken rule.
 * A session runs the same lint when it spawns, so a step that passes here
 * does not fail at its first turn.
 */
const listAgentIssues = (
  step: AgentStep,
  index: number,
  references: ResolvedReferences,
): ReadonlyArray<Issue> => {
  const path = ["steps", String(index)];
  return [
    ...listAgentReferenceIssues(step.agent, [...path, "agent"], references),
    ...(step.outputSchema === undefined
      ? []
      : lintOutputSchema(step.outputSchema).map((finding) => ({
          path: [...path, "outputSchema"],
          message: `The output schema is outside the JSON Schema subset that every provider accepts. ${shortenLibraryMessage(finding)} Fix that part of the schema.`,
        }))),
  ];
};

/** Checks one step, its expressions and templates included. Returns every issue found. */
const checkStep = (
  step: Step,
  index: number,
  references: ResolvedReferences,
  definition: WorkflowDefinition,
): Effect.Effect<ReadonlyArray<Issue>> => {
  const path = ["steps", String(index)];
  let templates: ReadonlyArray<PlacedTemplate>;
  let issues: ReadonlyArray<Issue>;
  if (step.kind === "action") {
    templates = listTemplates(step.params ?? {}, [...path, "params"]);
    issues = listActionIssues(step, index, references, templates, definition);
  } else {
    templates = [{ path: [...path, "prompt"], template: step.prompt }];
    issues = listAgentIssues(step, index, references);
  }
  return Effect.map(
    Effect.all([
      step.condition === undefined
        ? Effect.succeed([])
        : listCheckIssues([...path, "condition"], validateCondition(step.condition, "run")),
      ...templates.map((template) =>
        listCheckIssues(template.path, validateTemplate(template.template)),
      ),
    ]),
    (expressionIssues) => [...issues, ...expressionIssues.flat()],
  );
};

/** Checks an edge's condition. A run follows the edge only when its condition is true. */
const checkEdgeCondition = (edge: Edge, index: number): Effect.Effect<ReadonlyArray<Issue>> =>
  edge.condition === undefined
    ? Effect.succeed([])
    : listCheckIssues(
        ["edges", String(index), "condition"],
        validateCondition(edge.condition, "run"),
      );

/**
 * Returns the only warning a definition can get: it has a signal trigger and
 * no terminal step. A run ends by itself when a terminal step completes, or
 * when nothing is running or waiting any more. A signal trigger keeps waiting
 * as long as the run lives, so such a run ends only when someone cancels it.
 * That may be what the author wants, so it is a warning and not an error.
 */
const listWarnings = (definition: WorkflowDefinition): ReadonlyArray<Issue> =>
  (definition.triggers ?? []).some((trigger) => trigger.kind === "signal") &&
  !definition.steps.some((step) => step.terminal === true)
    ? [
        {
          path: ["steps"],
          message:
            "This workflow has a signal trigger and no step with terminal: true, so a run of it can end only when someone cancels it. " +
            "If a run must end by itself, write terminal: true on the step whose completion ends it.",
        },
      ]
    : [];

/**
 * Validates a definition against `references`, which describe what exists on
 * the controller now. Does no I/O. Returns the errors and the warnings. The
 * errors are in definition order with the whole-graph errors last, and capped
 * by `truncateIssues`.
 */
export const validateDefinition = (
  definition: WorkflowDefinition,
  references: ResolvedReferences,
): Effect.Effect<WorkflowIssues> =>
  Effect.gen(function* () {
    const triggers = definition.triggers ?? [];
    const definedEdges = definition.edges ?? [];
    const listTriggerIds = (kind: Trigger["kind"]): ReadonlySet<string> =>
      new Set(triggers.flatMap((trigger) => (trigger.kind === kind ? [trigger.id] : [])));
    const nodes: GraphNodes = {
      stepIds: new Set(definition.steps.map((step) => step.id)),
      signalIds: listTriggerIds("signal"),
      startIds: listTriggerIds("start"),
    };
    // An edge whose end is not a valid node is reported, and it is left out
    // of the graph that the whole-graph rules check. The end issues are
    // computed once and used for both.
    const edgeEndIssues = definedEdges.map((edge, index) => listEdgeEndIssues(edge, index, nodes));
    const edges: ReadonlyArray<GraphEdge> = definedEdges.flatMap((edge, index) =>
      edgeEndIssues[index]!.length === 0
        ? [{ index, from: edge.from, to: edge.to, capped: edge.maxTraversals !== undefined }]
        : [],
    );
    const errors: ReadonlyArray<Issue> = [
      ...(definition.inputs ?? []).flatMap((input, index) =>
        listInputIssues(input, index, references),
      ),
      ...(yield* Effect.forEach(triggers, (trigger, index) =>
        checkTrigger(trigger, index, definition, references),
      )).flat(),
      ...(yield* Effect.forEach(definition.steps, (step, index) =>
        checkStep(step, index, references, definition),
      )).flat(),
      ...(yield* Effect.forEach(definedEdges, (edge, index) =>
        Effect.map(checkEdgeCondition(edge, index), (conditionIssues) => [
          ...edgeEndIssues[index]!,
          ...conditionIssues,
        ]),
      )).flat(),
      ...listGraphIssues(definition, edges, nodes),
    ];
    return { errors: truncateIssues(errors), warnings: listWarnings(definition) };
  });
