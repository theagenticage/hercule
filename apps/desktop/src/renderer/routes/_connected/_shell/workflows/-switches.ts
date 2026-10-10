import {
  useMutation,
  useMutationState,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { queryKeys, readErrorMessage, type HerculeClient } from "@hercule/client-core";
import type { Trigger, Workflow } from "@hercule/contract";
import type { SavedField } from "../../../../app/saved-field";
import type { WorkflowListEntry } from "../../../../screens/workflows/proposed-contract";

/** Returns the text shown under a switch whose save failed with `error`. */
const describeSaveFailure = (error: Error): string => `Could not save: ${readErrorMessage(error)}`;

/**
 * Returns the switch that turns `workflow` on or off, saved with
 * `workflow.update` (spec 17 §Settings, Saving: a switch saves when it is
 * pressed, and goes back to the saved value when the save fails).
 *
 * Every save of the workflow shares one mutation scope, so presses made
 * while a save runs are saved after it, in order, and the switch shows the
 * newest one. The workflow the controller stores is put in the cache, and
 * so is its row in the list, so both show it before the `workflow` push
 * makes them read again.
 */
export const useWorkflowSwitch = (
  client: HerculeClient,
  workflow: Workflow,
): SavedField<boolean> => {
  const queryClient = useQueryClient();
  const update = useMutation({
    scope: { id: `workflow:${workflow.id}` },
    mutationFn: (enabled: boolean) =>
      client.workflow.update({ params: { id: workflow.id }, payload: { enabled } }),
    onSuccess: ({ workflow: saved }) => {
      queryClient.setQueryData(queryKeys.workflow(saved.id), saved);
      queryClient.setQueryData(
        queryKeys.workflows(),
        (entries: ReadonlyArray<WorkflowListEntry> | undefined) =>
          entries?.map((entry) =>
            entry.id === saved.id ? { ...entry, enabled: saved.enabled } : entry,
          ),
      );
    },
  });
  return {
    value: update.isPending ? update.variables : workflow.enabled,
    error: update.error === null ? null : describeSaveFailure(update.error),
    save: (enabled) => update.mutate(enabled),
  };
};

/** A start trigger's switch press: the trigger, and whether it should start runs. */
interface TriggerChange {
  readonly triggerId: string;
  readonly active: boolean;
}

/** The start trigger switches of one workflow. */
export interface TriggerSwitches {
  /** The workflow's triggers, each as its switch shows it: being saved while a save runs. */
  readonly triggers: ReadonlyArray<Trigger>;
  /** The trigger whose last save failed, and why, or `null` when none did. */
  readonly error: { readonly triggerId: string; readonly text: string } | null;
  /** Pauses the start trigger `triggerId`, or resumes it when it is paused. */
  readonly toggle: (triggerId: string) => void;
}

/** Puts `trigger` in place of the trigger with its ids in the cached list at `queryKey`. */
const replaceCachedTrigger = (
  queryClient: QueryClient,
  queryKey: ReturnType<typeof queryKeys.triggers>,
  trigger: Trigger,
): void => {
  queryClient.setQueryData(queryKey, (triggers: ReadonlyArray<Trigger> | undefined) =>
    triggers?.map((each) =>
      each.workflowId === trigger.workflowId && each.triggerId === trigger.triggerId
        ? trigger
        : each,
    ),
  );
};

/**
 * Returns the switches of the start triggers in `triggers`, the triggers of
 * the workflow `workflowId`, saved with `trigger.pause` and `trigger.resume`.
 * They save as the workflow's switch does (see `useWorkflowSwitch`).
 *
 * The trigger the controller returns is put in the workflow's triggers and
 * in every workflow's, which the list reads. A `workflow` push makes only
 * the workflow's own read again, so without that write the list would keep
 * showing the trigger's old state.
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
  const change = useMutation({
    mutationKey,
    scope: { id: `triggers:${workflowId}` },
    mutationFn: ({ triggerId, active }: TriggerChange) =>
      active
        ? client.trigger.resume({ params: { workflowId, triggerId } })
        : client.trigger.pause({ params: { workflowId, triggerId } }),
    onSuccess: (trigger) => {
      replaceCachedTrigger(queryClient, queryKeys.triggers(workflowId), trigger);
      replaceCachedTrigger(queryClient, queryKeys.triggers(), trigger);
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
    error:
      change.error === null
        ? null
        : { triggerId: change.variables.triggerId, text: describeSaveFailure(change.error) },
    toggle: (triggerId) => {
      const trigger = shown.find((each) => each.triggerId === triggerId);
      if (trigger !== undefined) change.mutate({ triggerId, active: trigger.status === "paused" });
    },
  };
};
