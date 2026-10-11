import { useRef } from "react";
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import {
  buildMemoryWrite,
  chooseMemoryBaseVersion,
  isConflict,
  updateMemoryEntry,
  type HerculeClient,
  type MemoryFieldEditStart,
} from "@hercule/client-core";
import type { MemoryDocument } from "@hercule/contract";
import { memoryDocumentQuery, memoryIndexQuery } from "../../../../../../../app/queries";

/** A field of a memory document that the page edits. */
export type MemoryField = MemoryFieldEditStart["field"];

/**
 * One save of one field of a memory document: its new text, where the edit
 * began, and whether a large cut is confirmed. A save with no `start` is
 * written over the cached document.
 */
interface MemorySave {
  readonly field: MemoryField;
  readonly text: string;
  readonly start: MemoryFieldEditStart | undefined;
  readonly confirmShrink: boolean;
}

/** What the page shows of one field. */
export interface SavedMemoryField {
  /** The stored text, or the text being saved. */
  readonly text: string;
  /** True while a save of the field runs or waits for an earlier one. */
  readonly saving: boolean;
  /** The error of the field's last save, or `null` when it did not fail. */
  readonly error: Error | null;
}

/** A memory document whose gist and text save as they are committed. */
export interface SavedMemoryDocument {
  readonly gist: SavedMemoryField;
  readonly body: SavedMemoryField;
  /** Notes what an edit of `field` begins on. Call it when the user begins typing. */
  readonly startEdit: (field: MemoryField) => void;
  /** Saves `text` as `field`, against what the edit began on. */
  readonly save: (field: MemoryField, text: string) => void;
  /** Saves the failed text of `field` again, over the document as it is cached now. */
  readonly saveAnyway: (field: MemoryField) => void;
  /** Saves the failed text of `field` again, with the large cut it makes confirmed. */
  readonly confirmShrink: (field: MemoryField) => void;
}

/**
 * Returns the document `document` of the assistant `assistantId`, with the
 * functions that save a changed gist or text (spec 17 §Settings, The frame,
 * Saving).
 *
 * - While a save of a field runs, the field shows the text being saved and
 *   is `saving`; the page makes it read-only then, so no edit begins on
 *   text that is not stored yet. The other field can be edited and saved;
 *   its save waits for the running one.
 * - A write replaces the whole text, so a save must not replace text the
 *   user did not see. The page calls `startEdit` when typing begins, which
 *   notes the text the field showed and the document's version. A save is
 *   then made against the version `chooseMemoryBaseVersion` picks: the
 *   cached one while nobody changed the field since, and otherwise the one
 *   typing began on, so the controller refuses it with `conflict`.
 * - A field's `error` is the error of its last save, until the field is
 *   saved again. After a `conflict` the document and the index are read
 *   again first, so the page shows what the agent wrote, and `saveAnyway`
 *   writes the refused text over that version.
 * - Saves and their errors are kept in the query client, not the page, so
 *   they hold when the page is left and opened again while a save runs. The
 *   last finished save of each field is kept until the field is saved again,
 *   so at most two are held per document.
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
  // Every save of this document still in the query client, oldest first.
  const saves = useMutationState({
    filters: { mutationKey, exact: true },
    select: (each) => ({
      save: each.state.variables as MemorySave | undefined,
      status: each.state.status,
      error: each.state.error,
    }),
  });
  // What the open edit of each field began on, from the first key typed.
  const starts = useRef<Partial<Record<MemoryField, MemoryFieldEditStart>>>({});
  const mutation = useMutation({
    mutationKey,
    // The app removes a finished mutation nothing observes at once, and the
    // page observes only its latest save. A field's failed save must outlive
    // a later save of the other field, so finished saves are kept here and
    // removed by `dropFinishedSaves` instead.
    gcTime: Infinity,
    scope: { id: `memory:${assistantId}:${name}` },
    mutationFn: ({ field, text, start, confirmShrink }: MemorySave) => {
      // Read when the save runs, after the saves queued before it, so their
      // stored versions are in the cache.
      const cached = queryClient.getQueryData(documentKey) ?? document;
      const baseVersion =
        start === undefined ? cached.version : chooseMemoryBaseVersion(cached, start);
      const write = buildMemoryWrite(cached, { [field]: text, baseVersion });
      return client.memory.write({
        params: { id: assistantId, name },
        payload: confirmShrink ? { ...write, confirmShrink: true } : write,
      });
    },
    onError: async (error) => {
      if (!isConflict(error)) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: documentKey, exact: true }),
        queryClient.invalidateQueries({ queryKey: indexKey, exact: true }),
      ]);
    },
    onSuccess: (stored) => {
      queryClient.setQueryData(documentKey, stored);
      queryClient.setQueryData(indexKey, (entries) =>
        entries === undefined ? undefined : updateMemoryEntry(entries, stored),
      );
    },
  });
  const findLastSave = (field: MemoryField) => saves.findLast((each) => each.save?.field === field);
  const readField = (field: MemoryField): SavedMemoryField => {
    const last = findLastSave(field);
    const saving = last?.status === "pending";
    return {
      text: saving && last.save !== undefined ? last.save.text : document[field],
      saving,
      error: last?.status === "error" ? last.error : null,
    };
  };
  const gist = readField("gist");
  const body = readField("body");
  const noteStart = (field: MemoryField): MemoryFieldEditStart => ({
    field,
    shown: field === "gist" ? gist.text : body.text,
    version: document.version,
  });
  const dropFinishedSaves = (field: MemoryField): void => {
    const cache = queryClient.getMutationCache();
    for (const each of cache.findAll({ mutationKey, exact: true })) {
      const save = each.state.variables as MemorySave | undefined;
      if (save?.field === field && each.state.status !== "pending") cache.remove(each);
    }
  };
  const saveField = (save: MemorySave): void => {
    dropFinishedSaves(save.field);
    mutation.mutate(save);
  };
  const retry = (
    field: MemoryField,
    how: Partial<Pick<MemorySave, "start" | "confirmShrink">>,
  ): void => {
    const failed = findLastSave(field)?.save;
    if (failed !== undefined) saveField({ ...failed, ...how });
  };
  return {
    gist,
    body,
    startEdit: (field) => {
      starts.current[field] = noteStart(field);
    },
    save: (field, text) => {
      const start = starts.current[field] ?? noteStart(field);
      delete starts.current[field];
      saveField({ field, text, start, confirmShrink: false });
    },
    saveAnyway: (field) => {
      retry(field, { start: undefined, confirmShrink: false });
    },
    confirmShrink: (field) => {
      retry(field, { confirmShrink: true });
    },
  };
}
