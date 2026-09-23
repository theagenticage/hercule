/**
 * The checks of meaning that a workflow's definition must pass before it is
 * stored: the inputs, the triggers, the steps with their actions, params and
 * agents, the edges, the graph as a whole, and the expression at every place.
 * The parse in `@hercule/contract` has checked the shape and the ids already.
 * The graph, which holds the nodes that an edge may join and the rules about
 * the graph as a whole, is in `./graph`, and the checks here call it.
 *
 * Every problem is named by its path into the definition, so the author can
 * correct them in one round and an editor can show each one at its place.
 * The checks read every place of the definition and name each problem they
 * find, with one exception: a template names only its first problem. Every
 * problem of a template has the path of the template, and the text after a
 * `{{` that no `}}` closes cannot be read at all. A problem that follows from
 * another one is not named a second time: the schedule of a trigger on an
 * unknown event kind is not read, and an edge that names no node is left out
 * of the graph.
 *
 * The checks read nothing themselves. What they need of the rest of the
 * controller is handed to them as `ResolvedReferences`, which the service reads
 * inside the transaction of a save, so a check and the write it allows see the
 * same rows.
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
  excerptMessage,
  isId,
  joinNames,
  limitIssues,
  listSchemaIssues,
  quoteWritten,
  type Issue,
  type WorkflowDefinition,
  type WorkflowIssues,
} from "@hercule/contract";
import { lintOutputSchema } from "@hercule/protocol";
import { CRON_TICK_EVENT_KIND, type DeclaredEventKindWithConnectionType } from "../events";
import {
  checkCondition,
  checkExpression,
  checkTemplate,
  isTemplate,
  type ExpressionError,
  type ExpressionScope,
} from "../expressions";
import type { RegisteredWorkflowAction } from "../plugins";
import { listEdgeEndIssues, listGraphIssues, type GraphEdge, type GraphNodes } from "./graph";

/**
 * What a definition names, as the controller holds it now. Each collection
 * holds only what exists: a name that is not in it names nothing.
 */
export interface ResolvedReferences {
  /** The actions a step can name, by id. */
  readonly actions: ReadonlyMap<string, RegisteredWorkflowAction>;
  /** The event kinds a trigger can name, by kind. */
  readonly eventKinds: ReadonlyMap<string, DeclaredEventKindWithConnectionType>;
  /** The ids of the Agents that the definition names and that exist. */
  readonly agentIds: ReadonlySet<string>;
  /** The qualified type of each Connection that the definition names and that exists, by the Connection's id. */
  readonly connectionTypeById: ReadonlyMap<string, string>;
  /** The qualified name of each Connection type of a plugin that runs. */
  readonly connectionTypes: ReadonlySet<string>;
}

type Input = NonNullable<WorkflowDefinition["inputs"]>[number];
type Trigger = NonNullable<WorkflowDefinition["triggers"]>[number];
type StartTrigger = Extract<Trigger, { readonly kind: "start" }>;
type Step = WorkflowDefinition["steps"][number];
type ActionStep = Extract<Step, { readonly kind: "action" }>;
type AgentStep = Extract<Step, { readonly kind: "agent" }>;
type Edge = NonNullable<WorkflowDefinition["edges"]>[number];

/** The ids of the Agents a definition names, each one once. */
export const listNamedAgentIds = (definition: WorkflowDefinition): ReadonlyArray<string> => [
  ...new Set(definition.steps.flatMap((step) => (step.kind === "agent" ? [step.agent] : []))),
];

/**
 * The ids of the Connections a definition names, each one once: in a
 * trigger's Connection selection, and as the default of a Connection input.
 * A default that is not an id names no Connection and is not read.
 */
export const listNamedConnectionIds = (definition: WorkflowDefinition): ReadonlyArray<string> => [
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
 * The issue of a check of an expression or a template, at the place the
 * checked text is written, or no issue where the check passes.
 */
const listCheckIssues = (
  path: ReadonlyArray<string>,
  check: Effect.Effect<void, ExpressionError>,
): Effect.Effect<ReadonlyArray<Issue>> =>
  Effect.match(check, {
    onSuccess: () => [],
    onFailure: (refusal) => [{ path, message: refusal.message }],
  });

/** Each expression of a map, such as a trigger's input mappings, checked at its own key. */
const checkExpressionsAt = (
  expressions: Readonly<Record<string, string>> | undefined,
  scope: ExpressionScope,
  path: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<Issue>> =>
  Effect.map(
    Effect.forEach(Object.entries(expressions ?? {}), ([name, source]) =>
      listCheckIssues([...path, name], checkExpression(source, scope)),
    ),
    (issues) => issues.flat(),
  );

/**
 * A Connection input's type and default: the type is one of a plugin that
 * runs, and a default, when it is present, names a Connection that exists and
 * has the input's type. A plugin that does not run acts through none of its
 * Connections, as its event kinds and its actions are not in use either.
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
    // The default is read against the type, so a type that does not exist
    // leaves the default unread: the type is the mistake, and it is named.
    return [
      {
        path: [...path, "connection", "type"],
        message:
          `${quoteWritten(wanted)} is not a Connection type of a plugin that runs, so no Connection of this type can be used. ` +
          (references.connectionTypes.size === 0
            ? "No plugin that runs declares a Connection type. Enable the plugin that declares this type, or remove the input."
            : "Enable the plugin that declares this type, or write one of the Connection types of the plugins that run: " +
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
        message: `This default names no Connection. Write the id of a Connection of type ${quoteWritten(wanted)}.`,
      },
    ];
  }
  return found === wanted
    ? []
    : [
        {
          path: [...path, "default"],
          message:
            `This default names a Connection of type ${found}, but the input takes a Connection of type ${quoteWritten(wanted)}. ` +
            `Write the id of a Connection of type ${quoteWritten(wanted)}.`,
        },
      ];
};

/**
 * A trigger's event kind and its Connection selection: the kind is one a
 * trigger can name, a plugin's kind names a Connection of its type or `any`,
 * and a core kind names none.
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
          `${quoteWritten(kind)} is not an event kind that a trigger can name. ` +
          "A trigger can name a kind of the core, or a kind of a plugin that runs. " +
          `The kinds are: ${[...references.eventKinds.keys()].join(", ")}.`,
      },
    ];
  }
  if (trigger.kind === "signal" && kind === CRON_TICK_EVENT_KIND) {
    return [
      {
        path: [...path, "kind"],
        message:
          `A signal trigger cannot listen for ${CRON_TICK_EVENT_KIND}. The Scheduler starts runs from its ticks ` +
          "and never signals a live run with one, so this trigger could never fire. " +
          "Write a start trigger with a schedule, or listen for another kind.",
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
            message: `Events of kind ${kind} come from the core and arrive through no Connection. Remove connectionId.`,
          },
        ];
  }
  const choice = `Write the id of a Connection of type ${connectionType}, or write ${ANY_CONNECTION} for each Connection of that type.`;
  if (connectionId === undefined) {
    return [
      {
        path: connectionPath,
        message: `Events of kind ${kind} arrive through a Connection of type ${connectionType}, and a trigger names which one. ${choice}`,
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
          message: `This Connection is of type ${found}, but events of kind ${kind} arrive through a Connection of type ${connectionType}. ${choice}`,
        },
      ];
};

/**
 * A start trigger's schedule and timezone: a trigger on `cron.tick` has a
 * valid schedule, and a trigger on any other kind has neither field.
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
              message: `Only a trigger on ${CRON_TICK_EVENT_KIND} has a schedule. Remove schedule.`,
            },
          ]),
      ...(trigger.timezone === undefined
        ? []
        : [
            {
              path: [...path, "timezone"],
              message: `Only a trigger on ${CRON_TICK_EVENT_KIND} has a timezone. Remove timezone.`,
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
        `${quoteWritten(trigger.timezone)} is not a timezone. ` +
        "Write an IANA timezone, such as Europe/Amsterdam, or remove timezone to use the timezone of your settings.",
    });
  }
  if (trigger.schedule === undefined) {
    issues.push({
      path: [...path, "schedule"],
      message: `A trigger on ${CRON_TICK_EVENT_KIND} needs a schedule, which says when it fires. Add schedule, such as "0 9 * * 1-5" for 09:00 on weekdays.`,
    });
    return issues;
  }
  // A cron expression has five fields. The parser also reads six, with a
  // field for seconds first, and a schedule in seconds could start a run each
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
  // The schedule is read in the trigger's timezone where that is valid. A
  // timezone that is not valid is refused above, and is not refused a second
  // time here.
  const parsed = Cron.parse(trigger.schedule, Option.getOrUndefined(zone));
  if (Result.isFailure(parsed)) {
    issues.push({
      path: [...path, "schedule"],
      message: `This schedule is not a cron expression. ${excerptMessage(parsed.failure.message)} Write five fields, such as "0 9 * * 1-5" for 09:00 on weekdays.`,
    });
  }
  return issues;
};

/**
 * A start trigger's input mappings: each one maps an input the workflow
 * declares, and the trigger maps every required input that has no default,
 * because a run it starts cannot begin without one.
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
    .map((input) => quoteWritten(input.name));
  if (unmapped.length === 0) return undeclared;
  const isSingleInput = unmapped.length === 1;
  return [
    ...undeclared,
    {
      path,
      message:
        `The start trigger ${quoteWritten(trigger.id)} does not map the ${isSingleInput ? "input" : "inputs"} ${joinNames(unmapped)}. ` +
        `${isSingleInput ? "The input is" : "The inputs are"} required and ${isSingleInput ? "has" : "have"} no default, so a run that this trigger starts could not begin. ` +
        `Map ${isSingleInput ? "the input" : "each input"} under inputs here, or give ${isSingleInput ? "it" : "each one"} a default.`,
    },
  ];
};

/**
 * A trigger's filter: it admits an event where it gives true, so it reads
 * only the event and gives true or false.
 */
const checkFilter = (trigger: Trigger, index: number): Effect.Effect<ReadonlyArray<Issue>> =>
  trigger.source.filter === undefined
    ? Effect.succeed([])
    : listCheckIssues(
        ["triggers", String(index), "source", "filter"],
        checkCondition(trigger.source.filter, "event"),
      );

/** Every problem of one trigger, its expressions included. */
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
    // A schedule is read against the kind, so an unknown kind leaves it
    // unread: the kind is the mistake, and it is named already.
    if (eventKind !== undefined) issues.push(...listScheduleIssues(trigger, index));
    issues.push(...listInputMappingIssues(trigger, index, definition.inputs ?? []));
    expressionChecks.push(checkExpressionsAt(trigger.inputs, "event", [...path, "inputs"]));
  } else {
    expressionChecks.push(
      listCheckIssues(
        [...path, "correlation", "event"],
        checkExpression(trigger.correlation.event, "event"),
      ),
      listCheckIssues(
        [...path, "correlation", "run"],
        checkExpression(trigger.correlation.run, "run"),
      ),
      checkExpressionsAt(trigger.outputs, "event", [...path, "outputs"]),
    );
  }
  return Effect.map(Effect.all(expressionChecks), (expressionIssues) => [
    ...issues,
    ...expressionIssues.flat(),
  ]);
};

/** One param an action takes: its name, and whether a step may leave it out. */
interface ActionParam {
  readonly name: string;
  readonly optional: boolean;
}

/**
 * The params an action takes. The host registers only an action whose input
 * is a struct, so each param is one property of it.
 */
const listActionParams = (action: RegisteredWorkflowAction): ReadonlyArray<ActionParam> =>
  SchemaAST.isObjects(action.input.ast)
    ? action.input.ast.propertySignatures.flatMap((property) =>
        typeof property.name === "string"
          ? [{ name: property.name, optional: SchemaAST.isOptional(property.type) }]
          : [],
      )
    : [];

/** A text that is a template, and the path of the place it is written in the definition. */
interface PlacedTemplate {
  readonly path: ReadonlyArray<string>;
  readonly template: string;
}

/**
 * Every string in a value that is a template, however deep it sits: the value
 * itself, an item of a list, or a field of a mapping. The parse bounds how
 * deep a param's value is, so the walk cannot exhaust the call stack.
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
 * The params read against the action's input as one value, so a rule about
 * the params as a whole is checked too, such as the rule that an update names
 * a field to change. A key that the input does not declare, deeper in the
 * value, is refused, because the action would not receive it.
 */
const decodeParams = (action: RegisteredWorkflowAction, params: unknown) =>
  Schema.decodeUnknownResult(action.input as Schema.Codec<unknown>)(params, {
    errors: "all",
    onExcessProperty: "error",
  });

/**
 * Whether a decode issue at a template is about the value that a run renders
 * there: the value is not of the field's type, is not a value the field
 * takes, or fails a check of the field. That value is known only when a run
 * renders the template, so such an issue says nothing yet. Every other issue
 * at a template is named: a key that the input does not declare, and a field
 * that takes no value at all, such as a field that the core stamps.
 */
const isAboutRenderedValue = (issue: SchemaIssue.Issue): boolean => {
  switch (issue._tag) {
    case "InvalidType":
      return !SchemaAST.isNever(issue.ast);
    case "InvalidValue":
    case "Filter":
      return true;
    case "AnyOf":
      // No member of a union takes the value, such as a template in a field
      // of fixed words.
      return issue.issues.length === 0;
    default:
      return false;
  }
};

/**
 * The words of a key that the action's input does not declare. The schema
 * library says only that it expected no such key.
 */
const UNKNOWN_PARAM_FIELD =
  "No field has this name at this place of the action's input. Remove the field, or correct its name.";

/**
 * Each problem that a decode of the params found, at its path in the
 * definition, except a problem at a template that is about the value a run
 * renders there. `path` is the path of `issue` in the definition, and
 * `templatePaths` holds the path of each template, as JSON.
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
 * An action step's action and its params: the action is one a step can name,
 * every param it requires is present, every param is one it takes, and the
 * params have the form its input takes.
 *
 * A string that holds a `{{` is a template wherever it sits in the params,
 * and its value is known only when a run renders it. So a template is taken
 * for a field of any type, and the decode's problem with the template's value
 * is not named. A rule about the params as a whole is checked only when every
 * field decodes, so a template that its field refuses leaves that rule
 * unchecked.
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
          `${quoteWritten(step.action)} is not an action that a step can name. ` +
          "A step can name a built-in action, or an action of a plugin that runs. " +
          `The actions are: ${[...references.actions.keys()].join(", ")}.`,
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
  // A missing param and an unknown one are named above, with the params the
  // action takes, so the decode's own words about them are not repeated.
  const namedAbove = new Set([...missing, ...unknown]);
  for (const issue of listParamIssues(decoded.failure.issue, paramsPath, templatePaths)) {
    const param = issue.path[paramsPath.length];
    if (param !== undefined && namedAbove.has(param)) continue;
    issues.push({
      path: issue.path,
      message: `The action ${action.id} cannot take ${param === undefined ? "these params" : "this value"}. ${excerptMessage(issue.message)}`,
    });
  }
  return issues;
};

/**
 * An agent step's Agent and output schema: the Agent exists, and the schema
 * is in the subset that every provider accepts, with one issue for each rule
 * it breaks. The lint is the one a session's spawn runs, so a step that passes
 * here does not fail at its first turn.
 */
const listAgentIssues = (
  step: AgentStep,
  index: number,
  references: ResolvedReferences,
): ReadonlyArray<Issue> => {
  const path = ["steps", String(index)];
  return [
    ...(references.agentIds.has(step.agent)
      ? []
      : [
          {
            path: [...path, "agent"],
            message:
              "No Agent has this id. An agent step runs a session of an Agent. Write the id of an Agent that exists.",
          },
        ]),
    ...(step.outputSchema === undefined
      ? []
      : lintOutputSchema(step.outputSchema).map((finding) => ({
          path: [...path, "outputSchema"],
          message: `The output schema is not in the subset that every provider accepts. ${excerptMessage(finding)} Correct the schema at that place.`,
        }))),
  ];
};

/** Every problem of one step, its expressions and templates included. */
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
        : listCheckIssues([...path, "condition"], checkCondition(step.condition, "run")),
      ...templates.map((template) =>
        listCheckIssues(template.path, checkTemplate(template.template)),
      ),
    ]),
    (expressionIssues) => [...issues, ...expressionIssues.flat()],
  );
};

/** An edge's condition, which lets the edge fire where it gives true. */
const checkEdgeCondition = (edge: Edge, index: number): Effect.Effect<ReadonlyArray<Issue>> =>
  edge.condition === undefined
    ? Effect.succeed([])
    : listCheckIssues(["edges", String(index), "condition"], checkCondition(edge.condition, "run"));

/**
 * The one warning. A run ends by itself when a terminal step completes, or
 * when nothing runs or waits any more, and a signal trigger waits as long as
 * the run lives. So a run of a workflow with a signal trigger and no terminal
 * step ends only when someone cancels it. That can be what the author wants,
 * so it does not stop a save.
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
 * Every problem of a definition's meaning, and the one warning, against what
 * the controller holds as `references`: it reads nothing itself. The errors
 * are in definition order, the rules about the graph as a whole last, and
 * there are at most as many as one refusal names.
 */
export const checkDefinitionAgainst = (
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
    // An edge with an end that names no node it may join is refused, and it
    // is left out of the graph that the rules about the whole graph read. The
    // issues of the ends are found once, for the errors and for the graph.
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
    return { errors: limitIssues(errors), warnings: listWarnings(definition) };
  });
