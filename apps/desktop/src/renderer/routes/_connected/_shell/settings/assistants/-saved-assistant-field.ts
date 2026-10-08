import type { HerculeClient } from "@hercule/client-core";
import type { Assistant, AssistantUpdateInput } from "@hercule/contract";
import { assistantsQuery } from "../../../../../app/queries";
import type { SavedField } from "../../../../../app/saved-field";
import { useSavedRecordField } from "../../../../../app/saved-record-field";

/**
 * Returns one field of the assistant `assistantId`, whose control saves on
 * every change, by `useSavedRecordField`. `buildPayload` builds the
 * `assistant.update` payload that applies the change to `latest`, the
 * assistant as the cache holds it when the save starts.
 *
 * Six fields of an assistant's settings call it with the same list, record
 * kind and update, so they pass only what differs between fields.
 */
export function useSavedAssistantField<Value, Change>(
  client: HerculeClient,
  assistantId: string,
  stored: Value,
  applyChange: (value: Value, change: Change) => Value,
  buildPayload: (latest: Assistant, change: Change) => AssistantUpdateInput,
): SavedField<Value, Change> {
  return useSavedRecordField({
    listKey: assistantsQuery(client).queryKey,
    recordKind: "assistant",
    id: assistantId,
    stored,
    applyChange,
    buildPayload,
    update: (id, payload) => client.assistant.update({ params: { id }, payload }),
  });
}
