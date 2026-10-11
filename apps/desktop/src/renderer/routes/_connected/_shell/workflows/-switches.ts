import { useState } from "react";
import {
  useMutation,
  useMutationState,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { queryKeys, readErrorMessage, type HerculeClient } from "@hercule/client-core";
import type { Trigger, Workflow, WorkflowSummary } from "@hercule/contract";
import type { SavedField } from "../../../../app/saved-field";

/** Returns the text shown under a switch whose save failed with `error`. */
const describeSaveFailure = (error: Error): string => `Could not save: ${readErrorMessage(error)}`;

/**
 * Checks that the save calling it is the only one with `mutationKey` still
 * running or waiting, matching `isSamePress` when given. A save counts
 * itself while its `onSuccess` runs, so one pending save means no other.
 */
const isOnlyPendingSave = (
  queryClient: QueryClient,
  mutationKey: ReadonlyArray<string>,
  isSamePress: (variables: unknown) => boolean = () => true,
): boolean =>
  queryClient
    .getMutationCache()
    .findAll({ mutationKey, status: "pending" })
    .filter((each) => isSamePress(each.state.variables)).length <= 1;

/**
 * Returns the switch that turns `workflow` on or off, saved with
 * `workflow.update { enabled }`. It saves as Settings' switches do (spec 17
 * §Settings, Saving):
 *
 * - While saves run, `value` is the newest press still saving.
 * - Every save of the workflow shares one mutation scope, so presses made
 *   while a save runs are saved after it, in the order made.
 * - A failed save puts the switch back to the saved value, and `error` says
 *   why until the next press, or until a later press saves with no other
 *   press still waiting.
 *
 * A successful save puts the stored workflow in the cache, and its row in
 * the workflow list, so both show it at once, and then reads both again.
 * The stored workflow can be older than the cache: a `workflow` push can
 * bring in another writer's newer change while the answer is on its way.
 * The new reads start after the save and replace any read that started
 * before it, so the cache ends as the controller has it. The save counts as
 * running until those reads answer, so the switch never shows the old value
 * in between.
 */
export const useWorkflowSwitch = (
  client: HerculeClient,
  workflow: Workflow,
): SavedField<boolean> => {
  const queryClient = useQueryClient();
  const mutationKey = ["workflow-switch", workflow.id];
  const pending = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (each) => each.state.variables as boolean,
  });
  // `useMutation` reports only the newest press, so the failure of an earlier
  // one would go unseen while a later one is queued, and the cache drops a
  // failed mutation nothing observes, with the app's `gcTime` of 0. So the
  // failure is kept here when it happens.
  const [failure, setFailure] = useState<Error | null>(null);
  const update = useMutation({
    mutationKey,
    scope: { id: `workflow:${workflow.id}` },
    mutationFn: (enabled: boolean) =>
      client.workflow.update({ params: { id: workflow.id }, payload: { enabled } }),
    onError: (error) => setFailure(error),
    onSuccess: async ({ workflow: saved }) => {
      if (isOnlyPendingSave(queryClient, mutationKey)) setFailure(null);
      queryClient.setQueryData(queryKeys.workflow(saved.id), saved);
      queryClient.setQueryData(
        queryKeys.workflows(),
        (entries: ReadonlyArray<WorkflowSummary> | undefined) =>
          entries?.map((entry) =>
            entry.id === saved.id ? { ...entry, enabled: saved.enabled } : entry,
          ),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.workflow(saved.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workflows() }),
      ]);
    },
  });
  return {
    value: pending.at(-1) ?? workflow.enabled,
    error: failure === null ? null : describeSaveFailure(failure),
    save: (enabled) => {
      setFailure(null);
      update.mutate(enabled);
    },
  };
};

/** A press of a start trigger's switch: the trigger, and whether it should start runs. */
interface TriggerChange {
  readonly triggerId: string;
  readonly active: boolean;
}

/** The pause switches of one workflow's start triggers. */
export interface TriggerSwitches {
  /** The workflow's triggers, each as its switch shows it: with the newest press still saving. */
  readonly triggers: ReadonlyArray<Trigger>;
  /** Why the last save of each trigger failed, by trigger id. A trigger with no failure is absent. */
  readonly errors: ReadonlyMap<string, string>;
  /** Pauses the start trigger `triggerId`, or resumes it when it is paused. */
  readonly toggle: (triggerId: string) => void;
}

/** Puts `trigger` in place of the trigger with its ids in the cached list of every trigger. */
const replaceCachedTrigger = (queryClient: QueryClient, trigger: Trigger): void => {
  queryClient.setQueryData(queryKeys.triggers(), (triggers: ReadonlyArray<Trigger> | undefined) =>
    triggers?.map((each) =>
      each.workflowId === trigger.workflowId && each.triggerId === trigger.triggerId
        ? trigger
        : each,
    ),
  );
};

/** Returns `failures` without the failure of the trigger `triggerId`. */
const dropFailure = (
  failures: ReadonlyMap<string, Error>,
  triggerId: string,
): ReadonlyMap<string, Error> => {
  if (!failures.has(triggerId)) return failures;
  const kept = new Map(failures);
  kept.delete(triggerId);
  return kept;
};

/**
 * Returns the pause switches of the start triggers in `triggers`, the
 * triggers of the workflow `workflowId`, saved with `trigger.pause` and
 * `trigger.resume`. They save as the workflow's switch does (see
 * `useWorkflowSwitch`): one at a time, in the order pressed, each showing
 * its newest press while it saves. Each trigger keeps its own failure, so a
 * failed save of one trigger shows under that trigger only, and a press on
 * another trigger leaves it.
 *
 * The trigger the controller returns is put in the cached list of every
 * trigger, which both the workflow list and the open workflow read, and the
 * list is then read again, for the reason `useWorkflowSwitch` gives.
 */
export const useTriggerSwitches = (
  client: HerculeClient,
  workflowId: string,
  triggers: ReadonlyArray<Trigger>,
): TriggerSwitches => {
  const queryClient = useQueryClient();
  const mutationKey = ["trigger-switch", workflowId];
  // Every press still saving, oldest first: a press on one trigger while
  // another saves must not hide the other's.
  const pending = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (each) => each.state.variables as TriggerChange,
  });
  const [failures, setFailures] = useState<ReadonlyMap<string, Error>>(new Map());
  const change = useMutation({
    mutationKey,
    scope: { id: `triggers:${workflowId}` },
    mutationFn: ({ triggerId, active }: TriggerChange) =>
      active
        ? client.trigger.resume({ params: { workflowId, triggerId } })
        : client.trigger.pause({ params: { workflowId, triggerId } }),
    onError: (error, { triggerId }) => {
      setFailures((current) => new Map(current).set(triggerId, error));
    },
    onSuccess: async (trigger, { triggerId }) => {
      const isSameTrigger = (variables: unknown): boolean =>
        (variables as TriggerChange).triggerId === triggerId;
      if (isOnlyPendingSave(queryClient, mutationKey, isSameTrigger)) {
        setFailures((current) => dropFailure(current, triggerId));
      }
      replaceCachedTrigger(queryClient, trigger);
      await queryClient.invalidateQueries({ queryKey: queryKeys.triggers() });
    },
  });
  const shown = triggers.map((trigger) => {
    const newest = pending.findLast((each) => each.triggerId === trigger.triggerId);
    return newest === undefined
      ? trigger
      : { ...trigger, status: newest.active ? ("active" as const) : ("paused" as const) };
  });
  return {
    triggers: shown,
    errors: new Map(
      [...failures].map(([triggerId, error]) => [triggerId, describeSaveFailure(error)]),
    ),
    toggle: (triggerId) => {
      const trigger = shown.find((each) => each.triggerId === triggerId);
      if (trigger === undefined) return;
      setFailures((current) => dropFailure(current, triggerId));
      change.mutate({ triggerId, active: trigger.status === "paused" });
    },
  };
};
