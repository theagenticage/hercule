import { useId } from "react";
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import type { Assistant, AssistantUpdateInput } from "@hercule/contract";
import { assistantsQuery } from "../../../../../app/queries";
import type { SavedField } from "../../../../../app/saved-field";

/**
 * Returns one field of the assistant `assistantId`, whose control saves on
 * every change (spec 17 §Settings, The frame, Saving).
 *
 * - `stored` is the saved value.
 * - `applyChange` returns the value a change makes of the shown one. While
 *   saves run, the control shows every change still saving applied to
 *   `stored` in order, so a change made while an earlier one saves does not
 *   hide the earlier one.
 * - `buildPayload` builds the `assistant.update` payload that applies the
 *   change to `latest`, the assistant as the cache holds it when the save
 *   starts. An empty payload saves nothing.
 *
 * A field that holds several values, such as the heartbeat, saves only the
 * values the user changed, applied to `latest`. A save then never puts back
 * a value another writer, or an earlier save, changed in the meantime.
 *
 * - A failed save puts the control back to `stored` and returns the error,
 *   which the row shows under itself until the next save. Each field has its
 *   own save, so a failure shows under its own row only.
 * - Every save of one assistant shares one mutation scope, so its saves run
 *   one after another, in the order they were made, and each one builds on
 *   what the save before it stored.
 * - A successful save puts the assistant the controller returns in the
 *   cached list, so the sidebar and the tabs show it at once, and then reads
 *   the list again. That read replaces any read still running, which could
 *   answer with the list from before the save.
 */
export function useSavedAssistantField<Value, Change>(
  client: HerculeClient,
  assistantId: string,
  stored: Value,
  applyChange: (value: Value, change: Change) => Value,
  buildPayload: (latest: Assistant, change: Change) => AssistantUpdateInput,
): SavedField<Value, Change> {
  const queryClient = useQueryClient();
  const { queryKey } = assistantsQuery(client);
  // A key of this field's own, so the changes still saving are this field's
  // and not those of another field of the same assistant.
  const mutationKey = ["assistant-field", useId()];
  const pending = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (each) => each.state.variables as Change,
  });
  const mutation = useMutation({
    mutationKey,
    scope: { id: `assistant:${assistantId}` },
    mutationFn: async (change: Change): Promise<Assistant | null> => {
      const latest = queryClient.getQueryData(queryKey)?.find(({ id }) => id === assistantId);
      // The assistant is gone from the list once it is deleted, and then there is nothing to save.
      if (latest === undefined) return null;
      const payload = buildPayload(latest, change);
      if (Object.keys(payload).length === 0) return null;
      return client.assistant.update({ params: { id: assistantId }, payload });
    },
    onSuccess: async (updated) => {
      if (updated === null) return;
      queryClient.setQueryData(queryKey, (assistants) =>
        assistants?.map((each) => (each.id === updated.id ? updated : each)),
      );
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  return {
    value: pending.reduce(applyChange, stored),
    error: mutation.error === null ? null : `Could not save: ${readErrorMessage(mutation.error)}`,
    save: mutation.mutate,
  };
}
