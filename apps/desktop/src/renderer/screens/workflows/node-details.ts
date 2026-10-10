/**
 * PROTOTYPE. Decides what the card of a node on a graph shows.
 *
 * - On a workflow's page the graph draws no run, and a card shows what the
 *   node does: one fact per field its definition sets, as label and value.
 *   Those rows are where a later change edits the definition in place.
 * - On a run's page a card shows where the run is at the node, what it
 *   used, and the session whose transcript it opens.
 *
 * The Workflows ticket moves it into `@hercule/client-core`, beside
 * `graph-model.ts`.
 */
import {
  countUsedTokens,
  describeTriggerOn,
  findModelName,
  findOldestOpenRequest,
  formatAccessMode,
  formatElapsed,
  formatRequestQuestion,
  formatTokenCount,
  measureElapsed,
  readTimestamps,
} from "@hercule/client-core";
import type {
  Agent,
  ProviderInstance,
  Run,
  Session,
  StepRecord,
  Trigger,
  Usage,
  WorkflowAction,
  WorkflowDefinition,
} from "@hercule/contract";
import type { MarkState } from "../../marks/mark-state";
import {
  NODE_MARKS,
  type GraphNode,
  type GraphNodeState,
  type WorkflowGraphDrawing,
} from "./graph-model";
import { readToolCalls } from "./proposed-contract";
import { formatDayAndClock, formatListTime } from "./workflow-rows";

/** One fact on a node's card: a label, and its value on one line. */
export interface NodeFact {
  readonly label: string;
  readonly value: string;
  /** Whether the value is an expression or data, which is set in the mono face. */
  readonly isCode: boolean;
  /** `fail` for a step's error. */
  readonly tone: "fail" | undefined;
}

/** One time the run came to a step, listed for a step it came to more than once. */
export interface NodeIteration {
  /** Counts the step's iterations in the run, from 1. */
  readonly number: number;
  readonly mark: MarkState;
  /** How the iteration stands: "Done", "Failed", "Working". */
  readonly text: string;
  /** How long the iteration took, or has taken so far. Empty before it starts. */
  readonly durationText: string;
  /**
   * The iteration's own session, for a step that starts a new session each
   * time it runs; `undefined` when every iteration drives the same session.
   */
  readonly sessionId: string | undefined;
}

/** Where the drawn run is at a node, as the card's status line says it. */
export interface NodeStatus {
  readonly mark: MarkState | undefined;
  readonly text: string;
  readonly tone: "you" | "fail" | undefined;
}

/** What a node's card shows. */
export interface NodeDetails {
  readonly id: string;
  readonly kind: GraphNode["kind"];
  /**
   * The card's subtitle. With no run, what kind of node it is, "Agent step",
   * because the facts below name the Agent. With a run, the Agent, the
   * action, or what the trigger fires on, as the node on the graph says.
   */
  readonly detail: string;
  /** `undefined` when the graph draws no run. */
  readonly status: NodeStatus | undefined;
  /** What the step's session asks the user, while it waits on them. */
  readonly question: string | undefined;
  readonly facts: ReadonlyArray<NodeFact>;
  /** The prompt an agent step starts its session with, as written in the source. */
  readonly prompt: string | undefined;
  /** Every time the run came to the step, oldest first, when it came more than once. */
  readonly iterations: ReadonlyArray<NodeIteration>;
  /** The session the card's link opens: the one the step's latest iteration drives. */
  readonly sessionId: string | undefined;
}

/** The status line for each state a step can be in, and each a trigger can be in, where they differ. */
const STEP_STATUS: Readonly<Record<Exclude<GraphNodeState, "none">, string>> = {
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
const START_STATUS: Partial<Record<GraphNodeState, string>> = {
  fired: "Started this run",
  quiet: "Did not start this run",
};

/** The mark of each status a step record can have, and what its row in the iteration list says. */
const RECORD_STATES: Readonly<
  Record<StepRecord["status"], { readonly mark: MarkState; readonly text: string }>
> = {
  pending: { mark: "idle", text: "Waiting to start" },
  running: { mark: "working", text: "Working" },
  completed: { mark: "done", text: "Done" },
  failed: { mark: "failed", text: "Failed" },
  cancelled: { mark: "idle", text: "Cancelled" },
  skipped: { mark: "idle", text: "Skipped" },
};

/** What each kind of node is called, the subtitle of its card when the graph draws no run. */
const KIND_WORDS: Readonly<Record<GraphNode["kind"], string>> = {
  agent: "Agent step",
  action: "Action step",
  start: "Start trigger",
  signal: "Signal trigger",
};

/** The row of a running iteration whose session waits on the user. */
const WAITING_RECORD = { mark: "waiting", text: "Waiting on you" } as const;

/** Builds a fact in the text face, with no tone. */
const buildFact = (label: string, value: string): NodeFact => ({
  label,
  value,
  isCode: false,
  tone: undefined,
});

/** Builds a fact in the mono face, for an expression or data. */
const buildCodeFact = (label: string, value: string): NodeFact => ({
  label,
  value,
  isCode: true,
  tone: undefined,
});

/** One step of a workflow definition. */
type Step = WorkflowDefinition["steps"][number];

/**
 * Returns the facts every step can set about where it sits in the graph:
 * the condition it runs on, whether it waits for every edge into it, and
 * whether the run ends when it completes.
 */
const listStepGraphFacts = (step: Step): ReadonlyArray<NodeFact> => [
  ...(step.condition === undefined ? [] : [buildCodeFact("Runs if", step.condition)]),
  ...(step.join === "all" ? [buildFact("Waits for", "Every step before it")] : []),
  ...(step.terminal === true ? [buildFact("Ends the run", "When it completes")] : []),
];

/**
 * Returns the names of the fields an output schema declares, "verdict,
 * notes", or `undefined` for a schema that declares none by name.
 */
const listOutputFields = (schema: unknown): string | undefined => {
  if (typeof schema !== "object" || schema === null || !("properties" in schema)) return undefined;
  const { properties } = schema;
  if (typeof properties !== "object" || properties === null) return undefined;
  const names = Object.keys(properties);
  return names.length === 0 ? undefined : names.join(", ");
};

/** Returns a param's value as one line: a string as written, anything else as JSON. */
const formatParam = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/**
 * Returns a step's output or input as one line: a string as it is, anything
 * else as compact JSON. Returns `undefined` for `null`, which an action that
 * returns nothing gives.
 */
const formatData = (value: unknown): { text: string; isCode: boolean } | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return { text: value.replace(/\s+/g, " ").trim(), isCode: false };
  return { text: JSON.stringify(value), isCode: true };
};

/**
 * Returns the token fact of a step's sessions:
 *
 * - every session reports exact usage: the sum, "41.7k";
 * - some report only an incomplete count: the sum of what is known, marked
 *   "(incomplete)";
 * - any session reports nothing: "Not reported", never 0.
 */
const describeStepTokens = (sessions: ReadonlyArray<Session>): string => {
  const counts = sessions.map((session) => session.usage ?? session.usageReport?.counts);
  if (counts.some((count) => count === undefined)) return "Not reported";
  const total = formatTokenCount(
    (counts as ReadonlyArray<Usage>).reduce((sum, count) => sum + countUsedTokens(count), 0),
  );
  return sessions.every((session) => session.usage !== undefined) ? total : `${total} (incomplete)`;
};

/** Returns the cost of a step's sessions, "$0.42", or `undefined` unless every session reports one. */
const describeStepCost = (sessions: ReadonlyArray<Session>): string | undefined => {
  const costs = sessions.map((session) => session.usage?.costUsd);
  if (costs.some((cost) => cost === undefined)) return undefined;
  return `$${(costs as ReadonlyArray<number>).reduce((sum, cost) => sum + cost, 0).toFixed(2)}`;
};

/** Returns the tool calls of a step's sessions added up, or "Not reported" when any session has no count. */
const describeStepToolCalls = (sessions: ReadonlyArray<Session>): string => {
  const counts = sessions.map(readToolCalls);
  if (counts.some((count) => count === undefined)) return "Not reported";
  return String((counts as ReadonlyArray<number>).reduce((sum, count) => sum + count, 0));
};

/**
 * Returns the facts of one step record: when it started, how long it took or
 * has taken, and what it returned or why it failed. An action step's record
 * also gives the input its action was called with.
 */
const listRecordFacts = (
  record: StepRecord,
  timezone: string,
  now: Date,
): ReadonlyArray<NodeFact> => {
  const { startedAt, finishedAt } = readTimestamps(record);
  const elapsed = measureElapsed(startedAt, finishedAt, now.getTime());
  const input = formatData(record.input);
  const output = record.status === "completed" ? formatData(record.output) : undefined;
  return [
    ...(startedAt === undefined
      ? []
      : [buildFact("Started", formatDayAndClock(new Date(startedAt), timezone, now))]),
    ...(elapsed === undefined
      ? []
      : [buildFact(finishedAt === undefined ? "Running for" : "Took", formatElapsed(elapsed))]),
    ...(input === undefined
      ? []
      : [{ label: "Input", value: input.text, isCode: input.isCode, tone: undefined }]),
    ...(output === undefined
      ? []
      : [{ label: "Output", value: output.text, isCode: output.isCode, tone: undefined }]),
    ...(record.status === "failed"
      ? [{ label: "Error", value: record.error.message, isCode: false, tone: "fail" as const }]
      : []),
  ];
};

/** Returns the status line of `node`, or `undefined` when the graph draws no run. */
const describeNodeStatus = (node: GraphNode): NodeStatus | undefined => {
  if (node.state === "none") return undefined;
  return {
    mark: NODE_MARKS[node.state],
    text: (node.kind === "start" ? START_STATUS[node.state] : undefined) ?? STEP_STATUS[node.state],
    tone: node.state === "waiting" ? "you" : node.state === "failed" ? "fail" : undefined,
  };
};

/** The records the cards of a graph are built from. */
export interface NodeRecords {
  /** The definition the graph draws: the workflow's own, or the plan a run froze. */
  readonly definition: WorkflowDefinition;
  /** The run the graph draws, or `undefined` for none. */
  readonly run: Run | undefined;
  /** The run's sessions. */
  readonly sessions: ReadonlyArray<Session>;
  /** The workflow's triggers, which say when each start trigger fires next and fired last. */
  readonly triggers: ReadonlyArray<Trigger>;
  /** The Agents, which name an agent step's Agent, and its model and access mode when the step sets none. */
  readonly agents: ReadonlyArray<Agent>;
  /** The workflow actions, which name an action step's action. */
  readonly actions: ReadonlyArray<WorkflowAction>;
  /** The provider instances, whose catalogs name each model. */
  readonly instances: ReadonlyArray<ProviderInstance>;
}

/**
 * Builds the card of every node in `drawing` from `records`, by node id.
 * Times are formatted in `timezone`, relative to `now`.
 *
 * With no run, a step's facts are the fields its definition sets, and a
 * value the step takes from its Agent says so. With a run, a step's facts
 * describe its latest iteration, and its tokens and tool calls add up every
 * session its iterations drove; its model is the one its latest session runs
 * on, and with no session, the one the step or its Agent names.
 */
export const buildNodeDetails = (
  drawing: WorkflowGraphDrawing,
  { definition, run, sessions, triggers, agents, actions, instances }: NodeRecords,
  timezone: string,
  now: Date,
): ReadonlyMap<string, NodeDetails> => {
  const steps = new Map(definition.steps.map((step) => [step.id, step]));
  const declaredTriggers = new Map(
    (definition.triggers ?? []).map((trigger) => [trigger.id, trigger]),
  );
  const triggersById = new Map(triggers.map((trigger) => [trigger.triggerId, trigger]));
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const findInstance = (id: string | undefined) => instances.find((instance) => instance.id === id);

  /** Returns the display name of the model an agent step runs on, or `undefined` when nothing names one. */
  const nameStepModel = (
    step: Extract<WorkflowDefinition["steps"][number], { kind: "agent" }>,
    session: Session | undefined,
  ): string | undefined => {
    if (session !== undefined) {
      return findModelName(findInstance(session.instanceId), session.modelSelection.model);
    }
    const agent = agents.find((each) => each.id === step.agent);
    const model = step.model ?? agent?.model?.model;
    return model === undefined ? undefined : findModelName(findInstance(agent?.instanceId), model);
  };

  /**
   * Returns what `step` does, one fact per field its definition sets, in
   * the order a person reads a step: who runs it, on what, and where it
   * sits in the graph. An agent step's prompt is not a fact: the card shows
   * it in a section of its own.
   */
  const listStepFacts = (step: Step): ReadonlyArray<NodeFact> => {
    if (step.kind === "action") {
      const action = actions.find((each) => each.id === step.action);
      return [
        buildFact("Action", action?.displayName ?? step.action),
        ...Object.entries(step.params ?? {}).map(([name, value]) =>
          buildCodeFact(name, formatParam(value)),
        ),
        ...listStepGraphFacts(step),
      ];
    }
    const agent = agents.find((each) => each.id === step.agent);
    const model = nameStepModel(step, undefined);
    const accessMode = step.accessMode ?? agent?.accessMode;
    const outputFields = listOutputFields(step.outputSchema);
    // A value the step leaves to its Agent says so, because changing it on
    // the Agent changes it here too.
    const fromAgent = (value: string, isOwn: boolean): string =>
      isOwn ? value : `${value}, from the Agent`;
    return [
      buildFact("Agent", agent?.name ?? step.agent),
      ...(model === undefined
        ? []
        : [buildFact("Model", fromAgent(model, step.model !== undefined))]),
      ...(accessMode === undefined
        ? []
        : [
            buildFact(
              "Access",
              fromAgent(formatAccessMode(accessMode), step.accessMode !== undefined),
            ),
          ]),
      ...(step.freshSession === true ? [buildFact("Session", "A new one each time it runs")] : []),
      ...(outputFields === undefined ? [] : [buildCodeFact("Returns", outputFields)]),
      ...listStepGraphFacts(step),
    ];
  };

  const describeNode = (node: GraphNode): NodeDetails => {
    const records = run?.steps.filter((record) => record.stepId === node.id) ?? [];
    const latest = records.at(-1);
    const sessionIds = [...new Set(records.flatMap((record) => record.sessionId ?? []))];
    const stepSessions = sessionIds.flatMap((id) => sessionsById.get(id) ?? []);
    const latestSession =
      latest?.sessionId === undefined ? undefined : sessionsById.get(latest.sessionId);
    const request =
      node.state === "waiting" && latestSession !== undefined
        ? findOldestOpenRequest(latestSession)
        : null;
    const step = steps.get(node.id);
    const trigger = declaredTriggers.get(node.id);

    const facts: Array<NodeFact> = [];
    if (run === undefined && step !== undefined) facts.push(...listStepFacts(step));
    if (run !== undefined && step?.kind === "agent") {
      const model = nameStepModel(step, latestSession);
      if (model !== undefined) facts.push(buildFact("Model", model));
      if (stepSessions.length > 0) {
        facts.push(buildFact("Tokens", describeStepTokens(stepSessions)));
        facts.push(buildFact("Tool calls", describeStepToolCalls(stepSessions)));
        const cost = describeStepCost(stepSessions);
        if (cost !== undefined) facts.push(buildFact("Cost", cost));
      }
    }
    if (latest !== undefined) facts.push(...listRecordFacts(latest, timezone, now));
    if (trigger?.kind === "start") {
      const record = triggersById.get(node.id);
      // A schedule is a cron expression, which is code; an event kind reads as words.
      facts.push({
        label: "Fires on",
        value: describeTriggerOn(trigger.on),
        isCode: "schedule" in trigger.on,
        tone: undefined,
      });
      if (!("schedule" in trigger.on) && trigger.on.filter !== undefined) {
        facts.push({ label: "Filter", value: trigger.on.filter, isCode: true, tone: undefined });
      }
      if (record?.status === "paused") facts.push(buildFact("Status", "Paused"));
      if (record?.nextFireAt !== undefined && record.status !== "paused") {
        facts.push(
          buildFact("Next", formatListTime(new Date(record.nextFireAt), timezone, now, "future")),
        );
      }
      if (record?.lastFiredAt !== undefined) {
        facts.push(
          buildFact(
            "Last fired",
            formatListTime(new Date(record.lastFiredAt), timezone, now, "past"),
          ),
        );
      }
    }
    if (trigger?.kind === "signal") {
      facts.push(buildFact("Listens for", describeTriggerOn(trigger.on)));
      facts.push({
        label: "Matches",
        value: `${trigger.correlation.event} == ${trigger.correlation.run}`,
        isCode: true,
        tone: undefined,
      });
    }

    const ownSessions = sessionIds.length > 1;
    const iterations =
      records.length < 2
        ? []
        : records.map((record): NodeIteration => {
            const { startedAt, finishedAt } = readTimestamps(record);
            const elapsed = measureElapsed(startedAt, finishedAt, now.getTime());
            // The latest iteration's session is the one that can ask the user something.
            const state =
              record === latest && node.state === "waiting"
                ? WAITING_RECORD
                : RECORD_STATES[record.status];
            return {
              number: record.iteration,
              mark: state.mark,
              text: state.text,
              durationText: elapsed === undefined ? "" : formatElapsed(elapsed),
              sessionId: ownSessions ? record.sessionId : undefined,
            };
          });

    return {
      id: node.id,
      kind: node.kind,
      detail: run === undefined ? KIND_WORDS[node.kind] : node.detail,
      status: describeNodeStatus(node),
      question: request === null ? undefined : formatRequestQuestion(request),
      facts,
      prompt: step?.kind === "agent" ? step.prompt : undefined,
      iterations,
      sessionId: latest?.sessionId,
    };
  };

  return new Map(drawing.nodes.map((node) => [node.id, describeNode(node)]));
};
