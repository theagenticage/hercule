/**
 * The card a node of the workflow graph opens: what the step or trigger does,
 * one label and value row per field its definition sets (spec 17
 * §Workflows, "The open workflow", "A step's card").
 *
 * The card shows the definition only. A run's page adds what the run did at
 * the node, by the same node id.
 *
 * This module is the subpath `@hercule/client-core/node-details`, not part of
 * the index, so that it stays off the desktop app's first screen.
 */
import {
  isSchedule,
  type Agent,
  type ProviderInstance,
  type Trigger,
  type TriggerFiresOn,
  type WorkflowAction,
  type WorkflowDefinition,
} from "@hercule/contract";
import type { NodeKind } from "./graph-model";
import { formatAccessMode } from "./threads/access-modes";
import { findModelName } from "./threads/model-name";
import { decideFiresOn, describeTriggerOn } from "./trigger-display";

/**
 * One row of a node's card:
 *
 * - `text`: a label and its value on one line. `isCode` is true for an
 *   expression or data, which is set in the mono face.
 * - `time`: a label and an instant, such as a trigger's next fire. The screen
 *   formats the instant with `formatListTime` in `direction` on the age
 *   clock, so the text moves on as the day does.
 */
export type NodeFact =
  | {
      readonly kind: "text";
      readonly label: string;
      readonly value: string;
      readonly isCode: boolean;
    }
  | {
      readonly kind: "time";
      readonly label: string;
      readonly at: string;
      readonly direction: "past" | "future";
    };

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
});

/** Builds a row in the mono face, for an expression or data. */
const buildCodeFact = (label: string, value: string): NodeFact => ({
  kind: "text",
  label,
  value,
  isCode: true,
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
 * Returns the rows of a trigger. A start trigger's Status, Next and Last
 * fired come from its record in `reads.triggers`; Next is left out while
 * the trigger is paused or the workflow is disabled, because then it does
 * not fire.
 */
const listTriggerFacts = (
  trigger: TriggerDeclaration,
  { triggers, isWorkflowEnabled }: NodeCardReads,
): ReadonlyArray<NodeFact> => {
  if (trigger.kind === "signal") {
    return [
      buildFact("Listens for", describeTriggerOn(trigger.on)),
      buildCodeFact("Matches", `${trigger.correlation.event} == ${trigger.correlation.run}`),
    ];
  }
  const record = triggers.find((each) => each.triggerId === trigger.id);
  const isPaused = record?.status === "paused";
  const { on } = trigger;
  return [
    // A cron expression is code; an event kind reads as words.
    isSchedule(on)
      ? buildCodeFact("Fires on", describeTriggerOn(on))
      : buildFact("Fires on", describeTriggerOn(on)),
    ...(!isSchedule(on) && on.filter !== undefined ? [buildCodeFact("Filter", on.filter)] : []),
    ...(isPaused ? [buildFact("Status", "Paused")] : []),
    ...(record?.nextFireAt === undefined || isPaused || !isWorkflowEnabled
      ? []
      : [{ kind: "time", label: "Next", at: record.nextFireAt, direction: "future" } as const]),
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
  };
};
