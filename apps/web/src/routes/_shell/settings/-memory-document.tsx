import { useId, useState, type FormEvent, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  buildMemoryWrite,
  countCharacters,
  describeShrinkLoss,
  dropSavedMemoryEdit,
  isConflict,
  mergeMemoryEdit,
  queryKeys,
  readErrorMessage,
  rebaseMemoryEdit,
  type HerculeClient,
  type MemoryEdit,
} from "@hercule/client-core";
import { chooseMemoryCap, MEMORY_CORE, type MemoryWriteInput } from "@hercule/contract";
import { Button, FormCard, Input, Row, Textarea } from "@hercule/ui";
import { memoryDocumentQuery } from "../../../app/queries";
import { InPlaceQuestion } from "../../../screens/in-place-question";
import { SaveStatus } from "../../../screens/save-status";
import { ASSISTANT_MUTATION_KEY } from "./-assistant-form";
import { MemoryUsage } from "./-memory-usage";

/** Replaces one document's unsaved edit with what `update` returns for the current one. */
export type ChangeMemoryEdit = (update: (current: MemoryEdit) => MemoryEdit) => void;

/**
 * Renders the editor of one stored memory document: `core`, or a topic.
 *
 * - `core` shows its body only. A topic also shows its gist, one line, and
 *   a button that deletes it after a question.
 * - The unsaved edit belongs to the Assistants screen, which asks before
 *   switching assistants throws it away. The editor shows the edited fields
 *   and the stored value of every other field.
 * - Save writes the whole text, and the gist only when it was edited. It
 *   sends the version the edit began on, so the controller refuses it when
 *   the assistant wrote the document since.
 * - Text typed while a save runs is kept, even when it is the text stored
 *   before the save; once the save is stored, what it did not store stays
 *   unsaved.
 * - A refused write shows the controller's message as it is. Two refusals
 *   are also asked as a question whose answer, Save anyway, writes the text
 *   again:
 *   - a write that would shrink a large document, which is written again
 *     with the shrink confirmed;
 *   - a write refused because the document changed since the edit began.
 *     The document is read again, and the user's text stays in the fields.
 *     Save anyway writes it over the newer version; Cancel keeps it
 *     unsaved.
 * - `onDeleted` runs once the topic is deleted.
 */
export function MemoryDocumentCard({
  client,
  assistantId,
  name,
  edit,
  onEditChange,
  onDeleted,
}: {
  readonly client: HerculeClient;
  readonly assistantId: string;
  readonly name: string;
  readonly edit: MemoryEdit;
  readonly onEditChange: ChangeMemoryEdit;
  readonly onDeleted: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const read = useQuery(memoryDocumentQuery(client, assistantId, name));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const gistId = useId();
  const bodyId = useId();

  const isCore = name === MEMORY_CORE;
  const title = isCore ? "Core note" : <b className="text-row font-emph text-ink">{name}</b>;
  const indexKey = queryKeys.memory(assistantId);
  const params = { id: assistantId, name };

  const write = useMutation({
    mutationKey: [...ASSISTANT_MUTATION_KEY, "memory", "write"],
    mutationFn: (payload: MemoryWriteInput) => client.memory.write({ params, payload }),
    onSuccess: async (saved, sent) => {
      // The response is the stored document, so it goes into the cache
      // before the index is read again, and the editor never shows the old
      // text in between.
      queryClient.setQueryData(memoryDocumentQuery(client, assistantId, name).queryKey, saved);
      onEditChange((current) => dropSavedMemoryEdit(current, sent, saved));
      await queryClient.invalidateQueries({ queryKey: indexKey, exact: true });
    },
    onError: async (error) => {
      // The document changed since the edit began. The cached copy is stale,
      // so the edit is kept whole, even a field typed back to the cached
      // text: the stored text is now another one. The index and the document
      // are read again, so Save anyway writes over the version stored now.
      if (isConflict(error)) {
        await queryClient.invalidateQueries({ queryKey: indexKey });
        return;
      }
      // Nothing was stored, so a field typed back to the stored text while
      // the save ran is no longer an edit.
      const stored = queryClient.getQueryData(
        memoryDocumentQuery(client, assistantId, name).queryKey,
      );
      if (stored !== undefined) {
        onEditChange((current) => mergeMemoryEdit(stored, current, {}, false));
      }
    },
  });
  const remove = useMutation({
    mutationKey: [...ASSISTANT_MUTATION_KEY, "memory", "delete"],
    mutationFn: () => client.memory.delete({ params }),
    onSuccess: async () => {
      queryClient.removeQueries({
        queryKey: memoryDocumentQuery(client, assistantId, name).queryKey,
      });
      onDeleted();
      await queryClient.invalidateQueries({ queryKey: indexKey, exact: true });
    },
  });

  if (read.data === undefined) {
    return (
      <FormCard label={title}>
        {read.error === null ? (
          <p className="text-row text-muted">Loading…</p>
        ) : (
          <p className="text-fine text-fail" role="alert">
            {readErrorMessage(read.error)}
          </p>
        )}
      </FormCard>
    );
  }

  const document = read.data;
  const gist = edit.gist ?? document.gist;
  const body = edit.body ?? document.body;
  const hasChanges = Object.keys(edit).length > 0;
  const shrinkLoss = describeShrinkLoss(write.error);
  const changedSince = isConflict(write.error);

  const recordEdit = (fields: MemoryEdit): void => {
    onEditChange((current) => mergeMemoryEdit(document, current, fields, write.isPending));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    write.mutate(buildMemoryWrite(document, edit));
  };

  return (
    <form onSubmit={submit}>
      <FormCard label={title}>
        {isCore ? null : (
          <Row label="Gist" htmlFor={gistId}>
            <Input
              id={gistId}
              // A gist is one line in the index the assistant sees, so the
              // field is a one-line input.
              value={gist}
              onChange={(event) => {
                recordEdit({ gist: event.target.value });
              }}
            />
          </Row>
        )}
        {isCore ? (
          <Textarea
            // The card's title names the note, so it has no label of its own.
            aria-label="Core note"
            // The body is not cut at the cap: an over-cap write must reach
            // the controller, whose refusal says how much to cut.
            rows={8}
            value={body}
            onChange={(event) => {
              recordEdit({ body: event.target.value });
            }}
          />
        ) : (
          <Row label="Text" htmlFor={bodyId}>
            <Textarea
              id={bodyId}
              rows={10}
              value={body}
              onChange={(event) => {
                recordEdit({ body: event.target.value });
              }}
            />
          </Row>
        )}
        <MemoryUsage
          label={isCore ? "Core note used" : `${name} used`}
          size={countCharacters(body)}
          cap={chooseMemoryCap(name)}
        />
        {isCore ? (
          <p className="text-fine text-faint">
            Given in full to every session of this assistant, at its start.
          </p>
        ) : null}

        <div className="flex items-center gap-3 pt-2">
          <Button
            type="submit"
            variant="form"
            // The screen has a Save on every card, so each names what it saves.
            aria-label={isCore ? "Save core note" : `Save topic ${name}`}
            disabled={write.isPending || !hasChanges}
          >
            Save
          </Button>
          <SaveStatus
            saved={write.isSuccess && !hasChanges}
            // A shrink the controller refused is asked as a question below,
            // so its message is not shown twice.
            failure={
              write.error === null || shrinkLoss !== undefined
                ? null
                : readErrorMessage(write.error)
            }
          />
          {isCore ? null : (
            <Button
              // Pulled right by its own padding, so its text lines up with
              // the right edge of the fields above.
              className="-mr-2 ml-auto"
              disabled={confirmingDelete || remove.isPending}
              onClick={() => {
                setConfirmingDelete(true);
              }}
            >
              {remove.isPending ? "Deleting…" : "Delete topic"}
            </Button>
          )}
        </div>

        {changedSince ? (
          <InPlaceQuestion
            question="Your text is kept. Save it over the current version?"
            declineLabel="Cancel"
            acceptLabel="Save anyway"
            // The document is being read again, and Save anyway must write
            // over the version read, not the one the edit began on.
            disabled={write.isPending || read.isFetching}
            onDecline={() => {
              write.reset();
            }}
            onAccept={() => {
              write.mutate(buildMemoryWrite(document, rebaseMemoryEdit(edit, document)));
            }}
          />
        ) : null}
        {shrinkLoss === undefined ? null : (
          <InPlaceQuestion
            // The question names the old and new sizes, which is the whole
            // point of asking, so it wraps instead of being cut short. The
            // controller's own message is written for agents and the CLI.
            stacked
            question={shrinkLoss}
            declineLabel="Cancel"
            acceptLabel="Save anyway"
            disabled={write.isPending}
            onDecline={() => {
              write.reset();
            }}
            onAccept={() => {
              write.mutate({ ...buildMemoryWrite(document, edit), confirmShrink: true });
            }}
          />
        )}
        {confirmingDelete ? (
          <InPlaceQuestion
            question={`Delete the topic ${name}? Its gist and text are deleted.`}
            declineLabel="Cancel"
            acceptLabel="Delete"
            onDecline={() => {
              setConfirmingDelete(false);
            }}
            onAccept={() => {
              setConfirmingDelete(false);
              remove.mutate();
            }}
          />
        ) : null}
        <SaveStatus
          saved={false}
          failure={remove.error === null ? null : readErrorMessage(remove.error)}
        />
      </FormCard>
    </form>
  );
}
