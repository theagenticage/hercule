import { useId, useState, type FormEvent, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  buildMemoryWrite,
  describeShrinkLoss,
  dropSavedMemoryEdit,
  isShrinkRejected,
  mergeMemoryEdit,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
  type MemoryEdit,
} from "@hercule/client-core";
import {
  chooseMemoryCap,
  countCharacters,
  MEMORY_CORE,
  type MemoryWriteInput,
} from "@hercule/contract";
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
 * - Save writes the whole body, and the gist only when it was edited. A
 *   refused write shows the controller's message as it is. When the write
 *   would shrink a large document, the message is asked as a question
 *   whose answer, Save anyway, writes it again with the shrink confirmed.
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
  const title = isCore ? "Core memory" : <b className="text-row font-emph text-ink">{name}</b>;
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
      onEditChange((current) => dropSavedMemoryEdit(current, sent));
      await queryClient.invalidateQueries({ queryKey: indexKey, exact: true });
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
  const shrinkRejected = isShrinkRejected(write.error);

  const recordEdit = (fields: MemoryEdit): void => {
    onEditChange((current) => mergeMemoryEdit(document, current, fields));
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
            aria-label="Core memory"
            // The body is not cut at the cap: an over-cap write must reach
            // the controller, whose refusal says how much to cut.
            rows={8}
            value={body}
            onChange={(event) => {
              recordEdit({ body: event.target.value });
            }}
          />
        ) : (
          <Row label="Body" htmlFor={bodyId}>
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
          label={isCore ? "Core memory used" : `${name} used`}
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
            aria-label={isCore ? "Save core memory" : `Save topic ${name}`}
            disabled={write.isPending || !hasChanges}
          >
            Save
          </Button>
          <SaveStatus
            saved={write.isSuccess && !hasChanges}
            // A shrink the controller refused is asked as a question below,
            // so its message is not shown twice.
            failure={write.error === null || shrinkRejected ? null : readErrorMessage(write.error)}
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

        {shrinkRejected && write.error !== null ? (
          <InPlaceQuestion
            // The question names the old and new sizes, which is the whole
            // point of asking, so it wraps instead of being cut short. The
            // controller's own message is written for agents and the CLI, so
            // it is shown only when the error lacks the sizes.
            stacked
            question={describeShrinkLoss(write.error) ?? readErrorMessage(write.error)}
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
        ) : null}
        {confirmingDelete ? (
          <InPlaceQuestion
            question={`Delete the topic ${name}? Its gist and body are deleted.`}
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
