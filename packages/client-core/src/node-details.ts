/**
 * The card a node of the workflow graph opens: what the step or trigger does,
 * one label and value row per field its definition sets (spec 17
 * §Workflows, "The open workflow", "A step's card").
 *
 * On a run's page the card shows the run instead: where the run is at the
 * node, what its latest visit did and used, each time the run came to it, and
 * the session it opens (spec 17 §Workflows, "A node's card on a run").
 *
 * This module is the subpath `@hercule/client-core/node-details`, not part of
 * the index, so that it stays off the desktop app's first screen.
 */
import {
  isSchedule,
  type Agent,
  type ProviderInstance,
  type Run,
  type Session,
  type StepRecord,
  type Trigger,
  type TriggerFiresOn,
  type WorkflowAction,
  type WorkflowDefinition,
} from "@hercule/contract";
import {
  decideStepRunState,
  type NodeKind,
  type NodeRunState,
  type RunOverlay,
} from "./graph-model";
import { readTimestamps } from "./run-display";
import { formatTokenCount } from "./subagents/describe";
import { formatAccessMode } from "./threads/access-modes";
import { findModelName } from "./threads/model-name";
import { findOldestOpenRequest } from "./threads/oldest-request";
import { formatRequestQuestion } from "./threads/request-question";
import { countUsedTokens } from "./token-usage";
import { decideFiresOn, describeTriggerOn } from "./trigger-display";

/**
 * One row of a node's card:
 *
 * - `text`: a label and its value on one line. `isCode` is true for an
 *   expression or data, which is set in the mono face. `isError` is true for
 *   a step's error, which is set in the fail ink.
 * - `time`: a label and an instant, such as a trigger's next fire. The screen
 *   formats the instant with `formatListTime` in `direction` on the age
 *   clock, so the text moves on as the day does.
 * - `startTime`: when a step's visit started. The screen formats it with its
 *   day and clock time, "Today 09:12" or "Fri 14:00" (`formatRunStartTime`),
 *   on the age clock, as a run's page shows when the run started.
 * - `elapsed`: how long a step took, or has run so far while `finishedAt` is
 *   undefined. The screen measures it on the age clock, so "Running for"
 *   counts up.
 */
export type NodeFact =
  | {
      readonly kind: "text";
      readonly label: string;
      readonly value: string;
      readonly isCode: boolean;
      readonly isError: boolean;
    }
  | {
      readonly kind: "time";
      readonly label: string;
      readonly at: string;
      readonly direction: "past" | "future";
    }
  | { readonly kind: "startTime"; readonly label: "Started"; readonly at: string }
  | {
      readonly kind: "elapsed";
      readonly label: "Took" | "Running for";
      readonly startedAt: string;
      readonly finishedAt: string | undefined;
    };

/** One time the run came to a step. A card lists them only for a step the run came to twice or more. */
export interface NodeVisit {
  /** Counts the step's visits in the run, from 1. */
  readonly number: number;
  readonly state: NodeRunState;
  /** How the visit stands: "Done", "Failed", "Working", "Waiting on you". */
  readonly text: string;
  readonly startedAt: string | undefined;
  readonly finishedAt: string | undefined;
  /**
   * The session the visit drives, which may be the same session as other
   * visits'. `undefined` for a visit with no session yet, such as a pending
   * one, or for a visit to an action step.
   */
  readonly sessionId: string | undefined;
}

/** What a node's card adds on a run's page. */
export interface NodeRunPart {
  readonly state: NodeRunState;
  /** Where the run is at the node: "Not reached in this run", "Waiting on you", "Started this run". */
  readonly statusText: string;
  /** What the step's session asks the user, while it waits on them. */
  readonly question: string | undefined;
  /** Every time the run came to the step, oldest first, when it came twice or more; otherwise empty. */
  readonly visits: ReadonlyArray<NodeVisit>;
  /** The session the card's Open thread opens: the one the step's newest visit with a session drives. */
  readonly sessionId: string | undefined;
}

/** What a node's card shows. */
export interface NodeCard {
  /** The step's or trigger's id, which is the card's title. */
  readonly id: string;
  readonly kind: NodeKind;
  /** What kind of node it is, on the title's right: "Agent step". */
  readonly kindText: string;
  /**
   * Whether a trigger fires on a schedule or on events, which draws a clock
   * or a bolt in the card's header. Null for a step.
   */
  readonly firesOn: TriggerFiresOn | null;
  readonly facts: ReadonlyArray<NodeFact>;
  /** The prompt an agent step starts its session with, as written, shown in a section of its own. */
  readonly prompt: string | undefined;
  /** Where the run is at the node, on a run's page. Null on the workflow's own graph. */
  readonly run: NodeRunPart | null;
}

/** The records a card names things from, beside the definition. */
export interface NodeCardReads {
  /** The workflow's triggers, whose records hold whether a start trigger is paused, and when it fires next and fired last. */
  readonly triggers: ReadonlyArray<Trigger>;
  /** The Agents, which name an agent step's Agent, and give its model and access mode when the step sets none. */
  readonly agents: ReadonlyArray<
    Pick<Agent, "id" | "name" | "instanceId" | "accessMode" | "model">
  >;
  /** The workflow actions, which name an action step's action. */
  readonly actions: ReadonlyArray<Pick<WorkflowAction, "id" | "displayName">>;
  /** The provider instances, whose catalogs name each model. */
  readonly instances: ReadonlyArray<ProviderInstance>;
  /** Whether the workflow is enabled. A disabled workflow's triggers do not fire, so they have no next fire. */
  readonly isWorkflowEnabled: boolean;
}

const KIND_TEXTS: Readonly<Record<NodeKind, string>> = {
  agent: "Agent step",
  action: "Action step",
  start: "Start trigger",
  signal: "Signal trigger",
};

/** Builds a row in the text face. */
const buildFact = (label: string, value: string): NodeFact => ({
  kind: "text",
  label,
  value,
  isCode: false,
  isError: false,
});

/** Builds a row in the mono face, for an expression or data. */
const buildCodeFact = (label: string, value: string): NodeFact => ({
  kind: "text",
  label,
  value,
  isCode: true,
  isError: false,
});

type Step = WorkflowDefinition["steps"][number];

/**
 * Returns the rows every step can have about where it sits in the graph: the
 * condition it runs on, whether it waits for every edge into it, and whether
 * the run ends when it completes.
 */
const listStepGraphFacts = (step: Step): ReadonlyArray<NodeFact> => [
  ...(step.condition === undefined ? [] : [buildCodeFact("Runs if", step.condition)]),
  ...(step.join === "all" ? [buildFact("Waits for", "Every step before it")] : []),
  ...(step.terminal === true ? [buildFact("Ends the run", "When it completes")] : []),
];

/**
 * Describes the fields an output schema declares by their names, such as
 * "verdict, notes", or returns `undefined` for a schema that names none.
 */
const describeOutputFields = (schema: unknown): string | undefined => {
  if (typeof schema !== "object" || schema === null || !("properties" in schema)) return undefined;
  const { properties } = schema;
  if (typeof properties !== "object" || properties === null) return undefined;
  const names = Object.keys(properties);
  return names.length === 0 ? undefined : names.join(", ");
};

/** Formats a parameter's value on one line: a string as written, anything else as JSON. */
const formatParam = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/**
 * Returns the rows of an agent step. The value of the Model or the Access
 * row ends in ", from the Agent" when the step leaves the value to its
 * Agent, because changing it on the Agent changes it here too. A step whose Agent no longer exists
 * shows the Agent's id, and no row for what only the Agent would give.
 */
const listAgentStepFacts = (
  step: Extract<Step, { kind: "agent" }>,
  { agents, instances }: NodeCardReads,
): ReadonlyArray<NodeFact> => {
  const agent = agents.find((each) => each.id === step.agent);
  const instance = instances.find((each) => each.id === agent?.instanceId);
  const model = step.model ?? agent?.model?.model;
  const accessMode = step.accessMode ?? agent?.accessMode;
  const outputFields = describeOutputFields(step.outputSchema);
  const markFromAgent = (value: string, isOwn: boolean): string =>
    isOwn ? value : `${value}, from the Agent`;
  return [
    buildFact("Agent", agent?.name ?? step.agent),
    ...(model === undefined
      ? []
      : [
          buildFact(
            "Model",
            markFromAgent(findModelName(instance, model), step.model !== undefined),
          ),
        ]),
    ...(accessMode === undefined
      ? []
      : [
          buildFact(
            "Access",
            markFromAgent(formatAccessMode(accessMode), step.accessMode !== undefined),
          ),
        ]),
    ...(step.freshSession === true ? [buildFact("Session", "A new one each time it runs")] : []),
    ...(outputFields === undefined ? [] : [buildCodeFact("Returns", outputFields)]),
    ...listStepGraphFacts(step),
  ];
};

/** Returns the rows of an action step: the action, then one row per parameter. */
const listActionStepFacts = (
  step: Extract<Step, { kind: "action" }>,
  { actions }: NodeCardReads,
): ReadonlyArray<NodeFact> => [
  buildFact("Action", actions.find((each) => each.id === step.action)?.displayName ?? step.action),
  ...Object.entries(step.params ?? {}).map(([name, value]) =>
    buildCodeFact(name, formatParam(value)),
  ),
  ...listStepGraphFacts(step),
];

type TriggerDeclaration = NonNullable<WorkflowDefinition["triggers"]>[number];

/**
 * Returns the rows a trigger's declaration gives: what a start trigger fires
 * on and its filter, or what a signal trigger listens for and the
 * correlation it matches.
 */
const listDeclaredTriggerFacts = (trigger: TriggerDeclaration): ReadonlyArray<NodeFact> => {
  if (trigger.kind === "signal") {
    return [
      buildFact("Listens for", describeTriggerOn(trigger.on)),
      buildCodeFact("Matches", `${trigger.correlation.event} == ${trigger.correlation.run}`),
    ];
  }
  const { on } = trigger;
  return [
    // A cron expression is code; an event kind reads as words.
    isSchedule(on)
      ? buildCodeFact("Fires on", describeTriggerOn(on))
      : buildFact("Fires on", describeTriggerOn(on)),
    ...(!isSchedule(on) && on.filter !== undefined ? [buildCodeFact("Filter", on.filter)] : []),
  ];
};

/**
 * Returns the Next row of a start trigger from its record, or no row when
 * it has no record or no next fire, or does not fire: the trigger is paused
 * or the workflow is disabled.
 */
const listNextFireFacts = (
  record: Trigger | undefined,
  isWorkflowEnabled: boolean,
): ReadonlyArray<NodeFact> =>
  record?.nextFireAt === undefined || record.status === "paused" || !isWorkflowEnabled
    ? []
    : [{ kind: "time", label: "Next", at: record.nextFireAt, direction: "future" }];

/**
 * Returns the rows of a trigger. A start trigger's Status, Next and Last
 * fired come from its record in `reads.triggers`; Next is left out while
 * the trigger is paused or the workflow is disabled, because then it does
 * not fire.
 */
const listTriggerFacts = (
  trigger: TriggerDeclaration,
  { triggers, isWorkflowEnabled }: NodeCardReads,
): ReadonlyArray<NodeFact> => {
  if (trigger.kind === "signal") return listDeclaredTriggerFacts(trigger);
  const record = triggers.find((each) => each.triggerId === trigger.id);
  return [
    ...listDeclaredTriggerFacts(trigger),
    ...(record?.status === "paused" ? [buildFact("Status", "Paused")] : []),
    ...listNextFireFacts(record, isWorkflowEnabled),
    ...(record?.lastFiredAt === undefined
      ? []
      : [
          {
            kind: "time",
            label: "Last fired",
            at: record.lastFiredAt,
            direction: "past",
          } as const,
        ]),
  ];
};

/**
 * Builds the card of the node `nodeId` of `definition`: a step's or a
 * trigger's id. Returns `undefined` when the definition has no such node.
 */
export const buildNodeCard = (
  definition: WorkflowDefinition,
  nodeId: string,
  reads: NodeCardReads,
): NodeCard | undefined => {
  const step = definition.steps.find((each) => each.id === nodeId);
  if (step !== undefined) {
    return {
      id: step.id,
      kind: step.kind,
      kindText: KIND_TEXTS[step.kind],
      firesOn: null,
      facts:
        step.kind === "agent" ? listAgentStepFacts(step, reads) : listActionStepFacts(step, reads),
      prompt: step.kind === "agent" ? step.prompt : undefined,
      run: null,
    };
  }
  const trigger = definition.triggers?.find((each) => each.id === nodeId);
  if (trigger === undefined) return undefined;
  return {
    id: trigger.id,
    kind: trigger.kind,
    kindText: KIND_TEXTS[trigger.kind],
    firesOn: decideFiresOn(trigger.on),
    facts: listTriggerFacts(trigger, reads),
    prompt: undefined,
    run: null,
  };
};

/** The records a card on a run's page reads, beside those of the workflow's own card. */
export interface RunNodeCardReads extends NodeCardReads {
  readonly run: Run;
  /** The run's sessions, which give an agent step's question, model, tokens, tool calls and cost. */
  readonly sessions: ReadonlyArray<Session>;
  /** The run's state at each node, from `buildRunOverlay`, so the card and the graph agree. */
  readonly overlay: RunOverlay;
}

/** The status line of each state a node can be in on a run's page. A start trigger reads its two states differently. */
const STATUS_TEXTS: Readonly<Record<NodeRunState, string>> = {
  unreached: "Not reached in this run",
  pending: "Waiting to start",
  working: "Working",
  waiting: "Waiting on you",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped: its condition was false",
  fired: "Fired",
  listening: "Listening for its event",
  quiet: "Has not fired",
};

/**
 * Describes where a run is at a node of `nodeKind` in `state`, as the status
 * line of its card reads (spec 17 §Workflows, "A node's card on a run"):
 *
 * - a step: "Not reached in this run", "Working", "Waiting on you", "Done",
 *   "Skipped: its condition was false", and so on;
 * - a signal trigger: "Fired", "Listening for its event" or "Has not fired";
 * - a start trigger: "Started this run" or "Did not start this run".
 */
export const describeNodeRunStatus = (state: NodeRunState, nodeKind: NodeKind): string => {
  if (nodeKind === "start" && state === "fired") return "Started this run";
  if (nodeKind === "start" && state === "quiet") return "Did not start this run";
  return STATUS_TEXTS[state];
};

/**
 * Formats a value, such as a step's input or a run's output, on one line: a
 * string as it is, with its runs of white space made one space, and anything
 * else as JSON, which `isCode` marks for the mono face.
 */
export const formatValueOnOneLine = (
  value: unknown,
): { readonly text: string; readonly isCode: boolean } =>
  typeof value === "string"
    ? { text: value.replace(/\s+/g, " ").trim(), isCode: false }
    : { text: JSON.stringify(value), isCode: true };

/**
 * Builds a row for a step's input or output, or none when it has none: the
 * value is absent, or `null`, which an action that returns nothing gives.
 */
const listDataFacts = (label: string, value: unknown): ReadonlyArray<NodeFact> => {
  if (value === null || value === undefined) return [];
  const { text, isCode } = formatValueOnOneLine(value);
  return [{ kind: "text", label, value: text, isCode, isError: false }];
};

/**
 * Returns the rows of one visit to a step: when it started, how long it took
 * or has run, the input its action was called with, what it returned, and
 * why it failed.
 */
const listVisitFacts = (record: StepRecord): ReadonlyArray<NodeFact> => {
  const { startedAt, finishedAt } = readTimestamps(record);
  return [
    ...(startedAt === undefined
      ? []
      : [
          { kind: "startTime", label: "Started", at: startedAt } as const,
          {
            kind: "elapsed",
            label: finishedAt === undefined ? "Running for" : "Took",
            startedAt,
            finishedAt,
          } as const,
        ]),
    ...listDataFacts("Input", record.input),
    ...listDataFacts("Output", record.status === "completed" ? record.output : undefined),
    ...(record.status === "failed"
      ? [
          {
            kind: "text",
            label: "Error",
            value: record.error.message,
            isCode: false,
            isError: true,
          } as const,
        ]
      : []),
  ];
};

/**
 * Describes the tokens `sessions` used together:
 *
 * - every session reports exact usage: the sum, "41.7k";
 * - some report only a count that misses some model calls: the sum of what is
 *   known, "41.7k (incomplete)";
 * - any session reports nothing: "Not reported", never 0.
 */
const describeSessionTokens = (sessions: ReadonlyArray<Session>): string => {
  let total = 0;
  for (const session of sessions) {
    const counts = session.usage ?? session.usageReport?.counts;
    if (counts === undefined) return "Not reported";
    total += countUsedTokens(counts);
  }
  const text = formatTokenCount(total);
  return sessions.every((session) => session.usage !== undefined) ? text : `${text} (incomplete)`;
};

/** Describes what `sessions` cost together, "$0.42", or returns `undefined` unless every one reports its cost. */
const describeSessionCost = (sessions: ReadonlyArray<Session>): string | undefined => {
  let total = 0;
  for (const session of sessions) {
    const cost = session.usage?.costUsd;
    if (cost === undefined) return undefined;
    total += cost;
  }
  return `$${total.toFixed(2)}`;
};

/**
 * Returns what an agent step's sessions used, added up over every visit:
 * the model the newest session runs on, its tokens, its tool calls, and its
 * cost when every session reports one. Returns no rows before the step has a
 * session, because then it has used nothing.
 */
const listSessionFacts = (
  sessions: ReadonlyArray<Session>,
  instances: ReadonlyArray<ProviderInstance>,
): ReadonlyArray<NodeFact> => {
  const newest = sessions.at(-1);
  if (newest === undefined) return [];
  const instance = instances.find((each) => each.id === newest.instanceId);
  const cost = describeSessionCost(sessions);
  return [
    buildFact("Model", findModelName(instance, newest.modelSelection.model)),
    buildFact("Tokens", describeSessionTokens(sessions)),
    buildFact("Tool calls", String(sessions.reduce((sum, session) => sum + session.toolCalls, 0))),
    ...(cost === undefined ? [] : [buildFact("Cost", cost)]),
  ];
};

/**
 * Builds the card of the node `nodeId` on the page of `reads.run`, from the
 * plan the run froze. Returns `undefined` when the plan has no such node.
 *
 * The card leads with where the run is at the node (`reads.overlay`). Its
 * rows are:
 *
 * - for a step, its current visit's: Started, Took or Running for, Input,
 *   Output and Error. The current visit is the running one, else the newest;
 * - for an agent step, then what its sessions used (Model, Tokens, Tool
 *   calls, Cost), and its prompt;
 * - for a start trigger, what it fires on and its filter, and Next from its
 *   record in `reads.triggers`. A trigger since removed from the workflow has
 *   no record, so no Next;
 * - for a signal trigger, what it listens for and what it matches.
 */
export const buildRunNodeCard = (nodeId: string, reads: RunNodeCardReads): NodeCard | undefined => {
  const { run, sessions, overlay } = reads;
  const state = overlay.nodes.get(nodeId)?.state ?? "unreached";
  const step = run.plan.steps.find((each) => each.id === nodeId);
  if (step === undefined) {
    const trigger = run.plan.triggers?.find((each) => each.id === nodeId);
    if (trigger === undefined) return undefined;
    return {
      id: trigger.id,
      kind: trigger.kind,
      kindText: KIND_TEXTS[trigger.kind],
      firesOn: decideFiresOn(trigger.on),
      facts: [
        ...listDeclaredTriggerFacts(trigger),
        ...(trigger.kind === "start"
          ? listNextFireFacts(
              reads.triggers.find((each) => each.triggerId === trigger.id),
              reads.isWorkflowEnabled,
            )
          : []),
      ],
      prompt: undefined,
      run: {
        state,
        statusText: describeNodeRunStatus(state, trigger.kind),
        question: undefined,
        visits: [],
        sessionId: undefined,
      },
    };
  }

  const records = run.steps.filter((record) => record.stepId === step.id);
  const current = records.find((record) => record.status === "running") ?? records.at(-1);
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const sessionIds = [...new Set(records.flatMap((record) => record.sessionId ?? []))];
  const stepSessions = sessionIds.flatMap((id) => sessionsById.get(id) ?? []);
  const isAsking = (record: StepRecord): boolean =>
    (sessionsById.get(record.sessionId ?? "")?.openRequests.length ?? 0) > 0;
  const askingSession =
    state === "waiting" && current !== undefined
      ? sessionsById.get(current.sessionId ?? "")
      : undefined;
  const request = askingSession === undefined ? null : findOldestOpenRequest(askingSession);

  return {
    id: step.id,
    kind: step.kind,
    kindText: KIND_TEXTS[step.kind],
    firesOn: null,
    facts: [
      ...(current === undefined ? [] : listVisitFacts(current)),
      ...(step.kind === "agent" ? listSessionFacts(stepSessions, reads.instances) : []),
    ],
    prompt: step.kind === "agent" ? step.prompt : undefined,
    run: {
      state,
      statusText: describeNodeRunStatus(state, step.kind),
      question: request === null ? undefined : formatRequestQuestion(request),
      visits:
        records.length < 2
          ? []
          : records.map((record): NodeVisit => {
              const visitState = decideStepRunState(record.status, isAsking(record));
              const { startedAt, finishedAt } = readTimestamps(record);
              return {
                number: record.iteration,
                state: visitState,
                // A visit's row has no room for why it was skipped.
                text:
                  visitState === "skipped"
                    ? "Skipped"
                    : describeNodeRunStatus(visitState, step.kind),
                startedAt,
                finishedAt,
                sessionId: record.sessionId,
              };
            }),
      sessionId: records.findLast((record) => record.sessionId !== undefined)?.sessionId,
    },
  };
};
