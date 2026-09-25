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
 *   an unknown event kind gets no schedule errors, and an edge whose end is
 *   not a valid node is left out of the graph checks.
 *
 * The checks do no I/O. The service reads what they need into a
 * `ResolvedReferences` inside the save's transaction, so the checks and the
 * write see the same rows.
 */
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";
import {
  ANY_CONNECTION,
  shortenLibraryMessage,
  isId,
  joinNames,
  truncateIssues,
  listSchemaIssues,
  quoteAuthorText,
  type Issue,
  type WorkflowDefinition,
  type WorkflowIssues,
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
import type { RegisteredWorkflowAction } from "../plugins";
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
}

type Input = NonNullable<WorkflowDefinition["inputs"]>[number];
type Trigger = NonNullable<WorkflowDefinition["triggers"]>[number];
type StartTrigger = Extract<Trigger, { readonly kind: "start" }>;
type Step = WorkflowDefinition["steps"][number];
type ActionStep = Extract<Step, { readonly kind: "action" }>;
type AgentStep = Extract<Step, { readonly kind: "agent" }>;
type Edge = NonNullable<WorkflowDefinition["edges"]>[number];

/** Returns the ids of the Agents that a definition's steps refer to, without duplicates. */
export const listReferencedAgentIds = (definition: WorkflowDefinition): ReadonlyArray<string> => [
  ...new Set(definition.steps.flatMap((step) => (step.kind === "agent" ? [step.agent] : []))),
];

/**
 * Returns the ids of the Connections that a definition refers to, without
 * duplicates: in a trigger's `connectionId`, and as the default of a
 * Connection input. A default that is not a valid id cannot refer to a
 * Connection, so it is skipped.
 */
export const listReferencedConnectionIds = (
  definition: WorkflowDefinition,
): ReadonlyArray<string> => [
  ...new Set([
    ...(definition.triggers ?? []).flatMap((trigger) =>
      trigger.source.connectionId === undefined || trigger.source.connectionId === ANY_CONNECTION
        ? []
        : [trigger.source.connectionId],
    ),
    ...(definition.inputs ?? []).flatMap((input) =>
      input.connection !== undefined && isId(input.default) ? [input.default] : [],
    ),
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
 * Validates a trigger's event kind and `connectionId`. `eventKind` is the
 * declared event kind, or `undefined` if no event kind has that name.
 *
 * - The event kind must exist.
 * - An event kind of a plugin needs a `connectionId`: the id of a Connection
 *   of the kind's Connection type, or `any`.
 * - A core event kind must have no `connectionId`.
 */
const listEventSourceIssues = (
  trigger: Trigger,
  index: number,
  eventKind: DeclaredEventKindWithConnectionType | undefined,
  references: ResolvedReferences,
): ReadonlyArray<Issue> => {
  const path = ["triggers", String(index), "source"];
  const { kind, connectionId } = trigger.source;
  if (eventKind === undefined) {
    return [
      {
        path: [...path, "kind"],
        message:
          `${quoteAuthorText(kind)} is not a known event kind. ` +
          "A trigger can listen for a core event kind or an event kind of an active plugin. " +
          `The known event kinds are: ${[...references.eventKinds.keys()].join(", ")}.`,
      },
    ];
  }
  if (trigger.kind === "signal" && kind === CRON_TICK_EVENT_KIND) {
    return [
      {
        path: [...path, "kind"],
        message:
          `A signal trigger cannot listen for ${CRON_TICK_EVENT_KIND}. The Scheduler uses its ticks only to start runs, ` +
          "never to signal a running run, so this trigger would never fire. " +
          "Write a start trigger with a schedule, or listen for another event kind.",
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
 * Validates a start trigger's `schedule` and `timezone`. A trigger on
 * `cron.tick` needs a valid schedule, and its timezone, if present, must be
 * valid. A trigger on any other event kind must have neither field.
 */
const listScheduleIssues = (trigger: StartTrigger, index: number): ReadonlyArray<Issue> => {
  const path = ["triggers", String(index)];
  if (trigger.source.kind !== CRON_TICK_EVENT_KIND) {
    return [
      ...(trigger.schedule === undefined
        ? []
        : [
            {
              path: [...path, "schedule"],
              message: `Only a trigger on ${CRON_TICK_EVENT_KIND} can have a schedule. Remove schedule.`,
            },
          ]),
      ...(trigger.timezone === undefined
        ? []
        : [
            {
              path: [...path, "timezone"],
              message: `Only a trigger on ${CRON_TICK_EVENT_KIND} can have a timezone. Remove timezone.`,
            },
          ]),
    ];
  }
  const zone =
    trigger.timezone === undefined ? Option.none() : DateTime.zoneMakeNamed(trigger.timezone);
  const issues: Array<Issue> = [];
  if (trigger.timezone !== undefined && Option.isNone(zone)) {
    issues.push({
      path: [...path, "timezone"],
      message:
        `${quoteAuthorText(trigger.timezone)} is not a timezone. ` +
        "Write an IANA timezone, such as Europe/Amsterdam, or remove timezone to use the timezone of your settings.",
    });
  }
  if (trigger.schedule === undefined) {
    issues.push({
      path: [...path, "schedule"],
      message: `A trigger on ${CRON_TICK_EVENT_KIND} needs a schedule that sets when it fires. Add schedule, such as "0 9 * * 1-5" for 09:00 on weekdays.`,
    });
    return issues;
  }
  // A cron expression has five fields. The parser also accepts six, with
  // seconds first, but a schedule with seconds could start a run every
  // second.
  if (trigger.schedule.trim().split(/\s+/).length === 6) {
    issues.push({
      path: [...path, "schedule"],
      message:
        "This schedule has six fields. A schedule has five fields: minute, hour, day of the month, month and day of the week, and no field for seconds. " +
        'Write five fields, such as "0 9 * * 1-5" for 09:00 on weekdays.',
    });
    return issues;
  }
  // Parse the schedule in the trigger's timezone if the timezone is valid. An
  // invalid timezone is already reported above, so it is not reported again.
  const parsed = Cron.parse(trigger.schedule, Option.getOrUndefined(zone));
  if (Result.isFailure(parsed)) {
    issues.push({
      path: [...path, "schedule"],
      message: `This schedule is not a cron expression. ${shortenLibraryMessage(parsed.failure.message)} Write five fields, such as "0 9 * * 1-5" for 09:00 on weekdays.`,
    });
  }
  return issues;
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
 * Checks a trigger's filter. The trigger accepts an event only when the filter
 * is true, so the filter must be a condition that reads only the event.
 */
const checkFilter = (trigger: Trigger, index: number): Effect.Effect<ReadonlyArray<Issue>> =>
  trigger.source.filter === undefined
    ? Effect.succeed([])
    : listCheckIssues(
        ["triggers", String(index), "source", "filter"],
        validateCondition(trigger.source.filter, "event"),
      );

/** Checks one trigger, its expressions included. Returns every issue found. */
const checkTrigger = (
  trigger: Trigger,
  index: number,
  definition: WorkflowDefinition,
  references: ResolvedReferences,
): Effect.Effect<ReadonlyArray<Issue>> => {
  const path = ["triggers", String(index)];
  const eventKind = references.eventKinds.get(trigger.source.kind);
  const issues: Array<Issue> = [...listEventSourceIssues(trigger, index, eventKind, references)];
  const expressionChecks = [checkFilter(trigger, index)];
  if (trigger.kind === "start") {
    // The schedule rules depend on the event kind. If the kind is unknown,
    // that error is already reported, so skip the schedule.
    if (eventKind !== undefined) issues.push(...listScheduleIssues(trigger, index));
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
 * `issue` in the definition, and `templatePaths` holds the path of each
 * template, as JSON.
 */
const listParamIssues = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<string>,
  templatePaths: ReadonlySet<string>,
): ReadonlyArray<Issue> =>
  listSchemaIssues(issue, {
    path,
    describeLeaf: (leaf, leafPath) => {
      if (isAboutRenderedValue(leaf) && templatePaths.has(JSON.stringify(leafPath))) return [];
      return leaf._tag === "UnexpectedKey"
        ? [{ path: leafPath, message: UNKNOWN_PARAM_FIELD }]
        : undefined;
    },
  });

/**
 * Validates an action step's action and params:
 *
 * - the action must exist;
 * - every required param must be present;
 * - every param must be one that the action takes;
 * - the params must decode against the action's input schema.
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
  const params = step.params ?? {};
  const taken = listActionParams(action);
  const takenNames = new Set(taken.map((param) => param.name));
  const missing = taken
    .filter((param) => !param.optional && !Object.hasOwn(params, param.name))
    .map((param) => param.name);
  const unknown = Object.keys(params).filter((name) => !takenNames.has(name));
  const issues: Array<Issue> = [];
  if (missing.length > 0) {
    const isSingleParam = missing.length === 1;
    issues.push({
      path: [...path, "params"],
      message: `The action ${action.id} needs the ${isSingleParam ? "param" : "params"} ${joinNames(missing)}. Add ${isSingleParam ? "it" : "them"} under params.`,
    });
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
): Effect.Effect<ReadonlyArray<Issue>> => {
  const path = ["steps", String(index)];
  let templates: ReadonlyArray<PlacedTemplate>;
  let issues: ReadonlyArray<Issue>;
  if (step.kind === "action") {
    templates = listTemplates(step.params ?? {}, [...path, "params"]);
    issues = listActionIssues(step, index, references, templates);
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
        checkStep(step, index, references),
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
