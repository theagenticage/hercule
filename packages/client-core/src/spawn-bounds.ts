/**
 * Turns spawn bounds and start triggers into what the clients show about
 * them: how much of its bound a trigger used, who paused it, what stops it
 * starting runs, the rows of Settings > Bounds, and the form that edits the
 * default bound.
 *
 * A spawn bound caps how many runs a start trigger may start in any window of
 * `windowSeconds` (spec 10 section 5).
 */
import {
  describeSpawnBound,
  describeWindowLength,
  MAX_SPAWN_BOUND_RUNS,
  MAX_SPAWN_BOUND_WINDOW_SECONDS,
  type SpawnBound,
  type Trigger,
  type WorkflowSummary,
} from "@hercule/contract";
import { parseWholeNumber } from "./whole-number";

/** How much of its spawn bound a start trigger used, as both clients' pages show it. */
export interface BoundUseReading {
  /** The use and the bound, such as "12 of 30 per hour". */
  readonly text: string;
  /** What the numbers count and where the bound comes from, for a tooltip. */
  readonly title: string;
}

/**
 * Returns how much of `bound` a trigger used, `runsInWindow` runs, as
 * "12 of 30 per hour", with a tooltip such as "12 runs started in the last
 * hour, or about to start. The bound is the default from Settings > Bounds."
 */
export const describeBoundUse = (
  bound: NonNullable<Trigger["spawnBound"]>,
  runsInWindow: number,
): BoundUseReading => {
  const runs = runsInWindow === 1 ? "1 run" : `${String(runsInWindow)} runs`;
  const source = bound.isDefault
    ? "the default from Settings > Bounds"
    : "set in the workflow's source";
  return {
    text: `${String(runsInWindow)} of ${describeSpawnBound(bound)}`,
    title: `${runs} started in the last ${describeWindowLength(bound.windowSeconds)}, or about to start. The bound is ${source}.`,
  };
};

/** A start trigger's own status, as the user reads it. */
export type StartTriggerStatusText = "active" | "paused by the breaker" | "paused manually";

/**
 * Returns a start trigger's own status in words: "active", "paused by the
 * breaker" when it matched more events than its spawn bound allows, or
 * "paused manually" when a user or an agent session paused it.
 *
 * A paused trigger that does not say who paused it reads as paused manually:
 * only `trigger.pause` paused triggers before the breaker existed.
 */
export const describeStartTriggerStatus = (
  trigger: Pick<Trigger, "status" | "pausedBy">,
): StartTriggerStatusText =>
  trigger.status !== "paused"
    ? "active"
    : trigger.pausedBy === "breaker"
      ? "paused by the breaker"
      : "paused manually";

/**
 * Checks whether a start trigger is paused and holds events. Only then can
 * it be resumed with its held events discarded, and only then does its row
 * on the workflow's page list the oldest of them. An active trigger that
 * still holds events is starting them already, so its row only counts them.
 */
export const isPausedWithHeldEvents = (trigger: Pick<Trigger, "status" | "heldCount">): boolean =>
  trigger.status === "paused" && (trigger.heldCount ?? 0) > 0;

/**
 * Returns the question asked before a trigger resumes with its `heldCount`
 * held events discarded, such as "Discard the 45 held events and resume? They
 * stay in the event log, but start no runs."
 */
export const buildDiscardHeldQuestion = (heldCount: number): string =>
  `Discard the ${heldCount === 1 ? "1 held event" : `${String(heldCount)} held events`} and resume? They stay in the event log, but start no runs.`;

/**
 * Returns what a workflow's row in the Workflows list shows when the breaker
 * paused any of its start triggers in `triggers`: "paused by the breaker", and
 * a tooltip that names those triggers. Returns `undefined` when the breaker
 * paused none of them, so the row shows nothing.
 */
export const describeBreakerPauses = (
  triggers: ReadonlyArray<Trigger>,
  workflowId: string,
): { readonly text: string; readonly title: string } | undefined => {
  const ids = triggers
    .filter(
      (trigger) =>
        trigger.workflowId === workflowId &&
        trigger.status === "paused" &&
        trigger.pausedBy === "breaker",
    )
    .map((trigger) => trigger.triggerId);
  if (ids.length === 0) return undefined;
  return {
    text: "paused by the breaker",
    title:
      ids.length === 1
        ? `The breaker paused its trigger ${ids.join(", ")}, which matched more events than its spawn bound allows. Open the workflow to resume it.`
        : `The breaker paused its triggers ${ids.join(", ")}, which matched more events than their spawn bounds allow. Open the workflow to resume them.`,
  };
};

/**
 * The share of its bound a trigger may use before its row reads as near the
 * limit. At this share or more, a few more matches trip the breaker.
 */
const NEAR_LIMIT_SHARE = 0.8;

/**
 * What Settings > Bounds shows for one start trigger:
 *
 * - `key`: identifies the row. A trigger id is unique only within its
 *   workflow, so the key holds both ids.
 * - `boundUse`: how much of its spawn bound it used in the current window.
 *   See `describeBoundUse`.
 * - `isDefault`: whether that bound is the default from Settings > Bounds,
 *   because the workflow's source sets none. Otherwise the source overrides it.
 * - `isNearLimit`: whether it used `NEAR_LIMIT_SHARE` of its bound or more.
 * - `status`: what lets it start runs, or what stops it, and the tone to show
 *   it in. See `buildSpawnBoundRows` for which text wins.
 * - `isPaused`: whether it is paused, so it can be resumed.
 * - `heldCount`: how many events it holds, waiting to start a run.
 * - `canDiscardHeldEvents`: whether it can be resumed with its held events
 *   discarded. See `isPausedWithHeldEvents`.
 */
export interface SpawnBoundRow {
  readonly key: string;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly triggerId: string;
  readonly boundUse: BoundUseReading;
  readonly isDefault: boolean;
  readonly isNearLimit: boolean;
  readonly status: {
    readonly text: StartTriggerStatusText | "workflow invalid" | "workflow disabled";
    readonly tone: "muted" | "attn" | "fail";
  };
  readonly isPaused: boolean;
  readonly heldCount: number;
  readonly canDiscardHeldEvents: boolean;
}

/**
 * Returns one row per start trigger in `triggers`, ordered by workflow name
 * and then by trigger id, so a row keeps its place while its numbers change.
 * A trigger with no spawn bound is a signal trigger, which starts no runs, so
 * it gets no row.
 *
 * `workflows` holds the triggers' workflows. A row's status is the first of
 * these that holds:
 *
 * - "paused by the breaker" or "paused manually", in the attention tone,
 *   because only a resume starts the trigger again, whatever its workflow;
 * - "workflow invalid", in the failure tone, while the workflow has stopped
 *   validating;
 * - "workflow disabled", muted, while the workflow is turned off;
 * - "active", muted.
 *
 * A trigger whose workflow is not in `workflows` reads as if its workflow
 * were enabled and valid: the two lists are read apart, and the next read of
 * both corrects it.
 */
export const buildSpawnBoundRows = (
  triggers: ReadonlyArray<Trigger>,
  workflows: ReadonlyArray<Pick<WorkflowSummary, "id" | "enabled" | "invalidSince">>,
): ReadonlyArray<SpawnBoundRow> => {
  const workflowsById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  return triggers
    .flatMap((trigger): ReadonlyArray<SpawnBoundRow> => {
      const bound = trigger.spawnBound;
      if (bound === undefined) return [];
      const runsInWindow = trigger.runsInWindow ?? 0;
      const isPaused = trigger.status === "paused";
      const workflow = workflowsById.get(trigger.workflowId);
      return [
        {
          key: `${trigger.workflowId}/${trigger.triggerId}`,
          workflowId: trigger.workflowId,
          workflowName: trigger.workflowName,
          triggerId: trigger.triggerId,
          boundUse: describeBoundUse(bound, runsInWindow),
          isDefault: bound.isDefault,
          isNearLimit: runsInWindow >= bound.maxRuns * NEAR_LIMIT_SHARE,
          status: isPaused
            ? { text: describeStartTriggerStatus(trigger), tone: "attn" }
            : workflow?.invalidSince !== undefined
              ? { text: "workflow invalid", tone: "fail" }
              : workflow?.enabled === false
                ? { text: "workflow disabled", tone: "muted" }
                : { text: "active", tone: "muted" },
          isPaused,
          heldCount: trigger.heldCount ?? 0,
          canDiscardHeldEvents: isPausedWithHeldEvents(trigger),
        },
      ];
    })
    .toSorted(
      (a, b) =>
        a.workflowName.localeCompare(b.workflowName) || a.triggerId.localeCompare(b.triggerId),
    );
};

/** The two fields of the default spawn bound's form, as the user typed them. */
export interface SpawnBoundDraft {
  readonly maxRuns: string;
  readonly windowSeconds: string;
}

/**
 * The default spawn bound's form, read: the bound to save, or the error to
 * show under each field that does not hold one.
 */
export type SpawnBoundDraftReading =
  | { readonly ok: true; readonly bound: SpawnBound }
  | {
      readonly ok: false;
      readonly errors: { readonly maxRuns?: string; readonly windowSeconds?: string };
    };

/** Parses a whole number from 1 to `maximum`, or returns `undefined`. */
const parseCountUpTo = (text: string, maximum: number): number | undefined => {
  const value = parseWholeNumber(text);
  return value !== undefined && value >= 1 && value <= maximum ? value : undefined;
};

/**
 * Parses the default spawn bound's form. Returns the bound, or an error for
 * each field that fails. Each field must hold a whole number within the
 * range the controller accepts:
 *
 * - runs from 1 to `MAX_SPAWN_BOUND_RUNS`;
 * - seconds from 1 to `MAX_SPAWN_BOUND_WINDOW_SECONDS`, a window of 30 days.
 */
export const parseSpawnBoundDraft = (draft: SpawnBoundDraft): SpawnBoundDraftReading => {
  const maxRuns = parseCountUpTo(draft.maxRuns, MAX_SPAWN_BOUND_RUNS);
  const windowSeconds = parseCountUpTo(draft.windowSeconds, MAX_SPAWN_BOUND_WINDOW_SECONDS);
  if (maxRuns !== undefined && windowSeconds !== undefined) {
    return { ok: true, bound: { maxRuns, windowSeconds } };
  }
  return {
    ok: false,
    errors: {
      ...(maxRuns === undefined
        ? {
            maxRuns: `Enter a whole number of runs from 1 to ${MAX_SPAWN_BOUND_RUNS.toLocaleString("en-US")}.`,
          }
        : {}),
      ...(windowSeconds === undefined
        ? {
            windowSeconds: `Enter a whole number of seconds from 1 to ${MAX_SPAWN_BOUND_WINDOW_SECONDS.toLocaleString("en-US")}, which is ${String(MAX_SPAWN_BOUND_WINDOW_SECONDS / 86_400)} days.`,
          }
        : {}),
    },
  };
};
