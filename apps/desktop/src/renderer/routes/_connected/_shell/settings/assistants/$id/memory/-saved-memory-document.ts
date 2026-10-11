import { useRef } from "react";
import {
  useMutation,
  useMutationState,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
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
 * began, and whether a large cut is confirmed.
 */
interface MemorySave {
  readonly field: MemoryField;
  readonly text: string;
  readonly start: MemoryFieldEditStart;
  readonly confirmShrink: boolean;
}

/** Builds the mutation key the saves of one memory document are kept under. */
const buildMemorySavesKey = (assistantId: string, name: string) => [
  "saved-memory-document",
  assistantId,
  name,
];

/**
 * Removes the finished saves of the memory document `name` from the query
 * client: those of `field`, or of both fields when `field` is not given.
 * Saves still running stay. The saves are kept past the app's mutation
 * `gcTime` of 0, so they are removed here: when the field is saved again,
 * and when the document is deleted.
 */
export const dropFinishedMemorySaves = (
  queryClient: QueryClient,
  assistantId: string,
  name: string,
  field?: MemoryField,
): void => {
  const cache = queryClient.getMutationCache();
  const mutationKey = buildMemorySavesKey(assistantId, name);
  for (const each of cache.findAll({ mutationKey, exact: true })) {
    const save = each.state.variables as MemorySave | undefined;
    const isField = field === undefined || save?.field === field;
    if (isField && each.state.status !== "pending") cache.remove(each);
  }
};

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
  /**
   * Saves the failed text of `field` again, over the document the page shows
   * now. Does nothing when the field's last save did not fail.
   */
  readonly saveAnyway: (field: MemoryField) => void;
  /**
   * Saves the failed text of `field` again, against what the failed save was
   * made against, with the large cut it makes confirmed. Does nothing when
   * the field's last save did not fail.
   */
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
 *   again first, so the page shows what the agent wrote. `saveAnyway`
 *   begins a new edit on that text, so it writes the refused text over what
 *   the page shows and is refused again if an agent writes the field once
 *   more. `confirmShrink` repeats the refused save, and so is refused too
 *   when the field changed since.
 * - Both act on the field's last save as the query client holds it when
 *   they are called, so a click that comes after a newer save of the field
 *   saves nothing.
 * - Saves and their errors are kept in the query client, not the page, so
 *   they hold when the page is left and opened again while a save runs. The
 *   last finished save of each field is kept until the field is saved again
 *   or the document is deleted, so at most two are held per document.
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
  const mutationKey = buildMemorySavesKey(assistantId, name);
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
    // removed by `dropFinishedMemorySaves` instead.
    gcTime: Infinity,
    scope: { id: `memory:${assistantId}:${name}` },
    mutationFn: ({ field, text, start, confirmShrink }: MemorySave) => {
      // Read when the save runs, after the saves queued before it, so their
      // stored versions are in the cache.
      const cached = queryClient.getQueryData(documentKey) ?? document;
      const baseVersion = chooseMemoryBaseVersion(cached, start);
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
  const readField = (field: MemoryField): SavedMemoryField => {
    const last = saves.findLast((each) => each.save?.field === field);
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
  const saveField = (save: MemorySave): void => {
    dropFinishedMemorySaves(queryClient, assistantId, name, save.field);
    mutation.mutate(save);
  };
  const retry = (
    field: MemoryField,
    how: Partial<Pick<MemorySave, "start" | "confirmShrink">>,
  ): void => {
    // Read from the query client, not the last render: the click that calls
    // this can blur the field first, which saves the field's newer text.
    const last = queryClient
      .getMutationCache()
      .findAll({ mutationKey, exact: true })
      .findLast((each) => (each.state.variables as MemorySave | undefined)?.field === field);
    const failed = last?.state.status === "error" ? (last.state.variables as MemorySave) : null;
    if (failed !== null) saveField({ ...failed, ...how });
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
      retry(field, { start: noteStart(field), confirmShrink: false });
    },
    confirmShrink: (field) => {
      retry(field, { confirmShrink: true });
    },
  };
}
