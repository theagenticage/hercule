import { useState } from "react";
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { buildMemoryWrite, type HerculeClient, type MemoryEdit } from "@hercule/client-core";
import type { MemoryDocument } from "@hercule/contract";
import { memoryDocumentQuery, memoryIndexQuery } from "../../../../../../../app/queries";

/** One save of a memory document: the edited fields, and whether a large cut is confirmed. */
interface MemorySave {
  readonly edit: MemoryEdit;
  readonly confirmShrink: boolean;
}

/** A memory document whose gist and text save as they are committed. */
export interface SavedMemoryDocument {
  /** The gist to show: the stored one, or the one being saved. */
  readonly gist: string;
  /** The text to show: the stored one, or the one being saved. */
  readonly body: string;
  /** The last save that failed and its error, or `null` when the last save did not fail. */
  readonly failure: { readonly edit: MemoryEdit; readonly error: Error } | null;
  /** Saves `edit`. With `confirmShrink`, the controller writes a text that cuts most of a large document. */
  readonly save: (edit: MemoryEdit, confirmShrink?: boolean) => void;
}

/**
 * Returns the document `document` of the assistant `assistantId`, with a
 * `save` that writes a changed gist or text (spec 17 §Settings, The frame,
 * Saving).
 *
 * - While a save runs, the saved fields show the value being saved.
 * - A write replaces the whole text, so a save of the gist alone first reads
 *   the document again and sends the text the controller holds. A save
 *   built on the page's copy could put back text an agent wrote since.
 * - A failed save shows the stored value again, and `failure` holds the
 *   edit and the error until the next save.
 * - The saves of one document run one after another, in the order they
 *   were made.
 * - A successful save puts the stored document in the cache, and its size
 *   and gist in the cached index, so the Memory column shows them.
 */
export function useSavedMemoryDocument(
  client: HerculeClient,
  assistantId: string,
  document: MemoryDocument,
): SavedMemoryDocument {
  const queryClient = useQueryClient();
  const { name } = document;
  const mutationKey = ["saved-memory-document", assistantId, name];
  const pending = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (each) => (each.state.variables as MemorySave).edit,
  });
  const [failure, setFailure] = useState<SavedMemoryDocument["failure"]>(null);
  const mutation = useMutation({
    mutationKey,
    scope: { id: `memory:${assistantId}:${name}` },
    mutationFn: async ({ edit, confirmShrink }: MemorySave) => {
      const params = { id: assistantId, name };
      const latest = edit.body === undefined ? await client.memory.read({ params }) : document;
      const write = buildMemoryWrite(latest, edit);
      return client.memory.write({
        params,
        payload: confirmShrink ? { ...write, confirmShrink: true } : write,
      });
    },
    onError: (error, { edit }) => {
      setFailure({ edit, error });
    },
    onSuccess: (stored) => {
      queryClient.setQueryData(memoryDocumentQuery(client, assistantId, name).queryKey, stored);
      queryClient.setQueryData(memoryIndexQuery(client, assistantId).queryKey, (entries) =>
        entries?.map((entry) =>
          entry.name === name ? { name, gist: stored.gist, size: stored.size } : entry,
        ),
      );
    },
  });
  const shown = pending.reduce<MemoryEdit>((edits, edit) => ({ ...edits, ...edit }), {});
  return {
    gist: shown.gist ?? document.gist,
    body: shown.body ?? document.body,
    failure,
    save: (edit, confirmShrink = false) => {
      setFailure(null);
      mutation.mutate({ edit, confirmShrink });
    },
  };
}
