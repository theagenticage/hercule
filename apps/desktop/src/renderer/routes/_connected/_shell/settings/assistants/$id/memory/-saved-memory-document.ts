import { useRef, useState } from "react";
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import {
  buildMemoryWrite,
  chooseMemoryBaseVersion,
  isConflict,
  updateMemoryEntry,
  type HerculeClient,
  type MemoryEdit,
  type MemoryFieldEditStart,
} from "@hercule/client-core";
import type { MemoryDocument } from "@hercule/contract";
import { memoryDocumentQuery, memoryIndexQuery } from "../../../../../../../app/queries";

/** A field of a memory document that the page edits. */
type MemoryField = MemoryFieldEditStart["field"];

/**
 * One save of a memory document: the edited fields, where the edit began,
 * and whether a large cut is confirmed. A save with no `start` is written
 * over the cached document.
 */
interface MemorySave {
  readonly edit: MemoryEdit;
  readonly start: MemoryFieldEditStart | undefined;
  readonly confirmShrink: boolean;
}

/** A save that failed, and its error. */
interface FailedSave extends MemorySave {
  readonly error: Error;
}

/** A memory document whose gist and text save as they are committed. */
export interface SavedMemoryDocument {
  /** The gist to show: the stored one, or the one being saved. */
  readonly gist: string;
  /** The text to show: the stored one, or the one being saved. */
  readonly body: string;
  /** The last save that failed and its error, or `null` when the last save did not fail. */
  readonly failure: { readonly edit: MemoryEdit; readonly error: Error } | null;
  /** Notes what an edit of `field` begins on. Call it when the user begins typing. */
  readonly startEdit: (field: MemoryField) => void;
  /** Saves `text` as `field`, against what the edit began on. */
  readonly save: (field: MemoryField, text: string) => void;
  /** Saves the failed edit again, over the document as it is cached now. */
  readonly saveAnyway: () => void;
  /** Saves the failed edit again, with the large cut it makes confirmed. */
  readonly confirmShrink: () => void;
}

/**
 * Returns the document `document` of the assistant `assistantId`, with the
 * functions that save a changed gist or text (spec 17 §Settings, The frame,
 * Saving).
 *
 * - While a save runs, the saved fields show the value being saved.
 * - A write replaces the whole text, so a save must not replace text the
 *   user did not see. The page calls `startEdit` when typing begins, which
 *   notes the text the field showed and the document's version. A save is
 *   then made against the version `chooseMemoryBaseVersion` picks: the
 *   cached one while nobody changed the field since, which includes the
 *   user's own earlier saves, and otherwise the version typing began on, so
 *   the controller refuses it with `conflict`. A read that brings an agent's
 *   text never moves the version on.
 * - A failed save shows the stored value again, and `failure` holds the
 *   edit and the error until the next save, or until a save queued behind
 *   it stores the same fields. After a `conflict` the document
 *   and the index are read again first, so the page shows what the agent
 *   wrote, and `saveAnyway` writes the user's edit over that version. When
 *   saves queued together are all refused with `conflict`, `failure` holds
 *   all their fields, so none is lost.
 * - The saves of one document run one after another, in the order they
 *   were made, even when the page is left and opened again between them.
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
  const documentKey = memoryDocumentQuery(client, assistantId, name).queryKey;
  const indexKey = memoryIndexQuery(client, assistantId).queryKey;
  const pending = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (each) => (each.state.variables as MemorySave).edit,
  });
  const [failure, setFailure] = useState<FailedSave | null>(null);
  // What the open edit of each field began on, from the first key typed.
  const starts = useRef<Partial<Record<MemoryField, MemoryFieldEditStart>>>({});
  const mutation = useMutation({
    mutationKey,
    scope: { id: `memory:${assistantId}:${name}` },
    mutationFn: ({ edit, start, confirmShrink }: MemorySave) => {
      // Read when the save runs, after the saves queued before it, so their
      // stored versions are in the cache.
      const cached = queryClient.getQueryData(documentKey) ?? document;
      const baseVersion =
        start === undefined ? cached.version : chooseMemoryBaseVersion(cached, start);
      const write = buildMemoryWrite(cached, { ...edit, baseVersion });
      return client.memory.write({
        params: { id: assistantId, name },
        payload: confirmShrink ? { ...write, confirmShrink: true } : write,
      });
    },
    onError: async (error, save) => {
      if (isConflict(error)) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: documentKey, exact: true }),
          queryClient.invalidateQueries({ queryKey: indexKey, exact: true }),
        ]);
      }
      setFailure((previous) =>
        // The saves queued together all failed the same way, so the fields
        // of each are kept for `saveAnyway`.
        previous !== null && isConflict(previous.error) && isConflict(error)
          ? {
              edit: { ...previous.edit, ...save.edit },
              start: undefined,
              confirmShrink: false,
              error,
            }
          : { ...save, error },
      );
    },
    onSuccess: (stored, save) => {
      // A save queued behind one that failed stores the fields it saves, so
      // the failure of those fields is over; the failure of another stays.
      setFailure((previous) =>
        previous !== null && Object.keys(previous.edit).every((field) => field in save.edit)
          ? null
          : previous,
      );
      queryClient.setQueryData(documentKey, stored);
      queryClient.setQueryData(indexKey, (entries) =>
        entries === undefined ? undefined : updateMemoryEntry(entries, stored),
      );
    },
  });
  const shown = pending.reduce<MemoryEdit>((edits, edit) => ({ ...edits, ...edit }), {});
  const gist = shown.gist ?? document.gist;
  const body = shown.body ?? document.body;
  const recordStart = (field: MemoryField): MemoryFieldEditStart => ({
    field,
    shown: field === "gist" ? gist : body,
    version: document.version,
  });
  const run = (save: MemorySave): void => {
    setFailure(null);
    mutation.mutate(save);
  };
  return {
    gist,
    body,
    failure,
    startEdit: (field) => {
      starts.current[field] = recordStart(field);
    },
    save: (field, text) => {
      const start = starts.current[field] ?? recordStart(field);
      delete starts.current[field];
      run({ edit: { [field]: text }, start, confirmShrink: false });
    },
    saveAnyway: () => {
      if (failure !== null) run({ edit: failure.edit, start: undefined, confirmShrink: false });
    },
    confirmShrink: () => {
      if (failure !== null) run({ edit: failure.edit, start: failure.start, confirmShrink: true });
    },
  };
}
