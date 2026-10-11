import { useId, type FormEvent, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  countCharacters,
  describeTopicNameConflict,
  describeTopicVisibility,
  isConflict,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
  type NewTopicDraft,
} from "@hercule/client-core";
import { MEMORY_TOPIC_CAP, type MemoryEntry } from "@hercule/contract";
import { Button, FormCard, Input, Row, Textarea } from "@hercule/ui";
import { assistantsQuery, memoryDocumentQuery } from "../../../app/queries";
import { SaveStatus } from "../../../screens/save-status";
import { ASSISTANT_MUTATION_KEY } from "./-assistant-form";
import { MemoryUsage } from "./-memory-usage";

/**
 * Renders the editor of a topic that is not stored yet: its name, gist and
 * body, with Cancel and Save.
 *
 * - The draft belongs to the Assistants screen, which asks before switching
 *   assistants throws it away.
 * - A name an existing document already has is refused here, before any
 *   write: a write to that name would replace the document. The write also
 *   asks the controller to refuse it if the topic exists by then; that
 *   refusal reads the index again, so the name shows as taken.
 * - Every other refusal, such as a 25th topic or a name with a slash, is the
 *   controller's or the contract's message, shown as it is.
 * - `onSaved` runs with the stored topic's name once it is written.
 */
export function NewTopicCard({
  client,
  assistantId,
  entries,
  draft,
  onDraftChange,
  onCancel,
  onSaved,
}: {
  readonly client: HerculeClient;
  readonly assistantId: string;
  /** Every document of the assistant, `core` included, to check the name against. */
  readonly entries: readonly MemoryEntry[];
  readonly draft: NewTopicDraft;
  readonly onDraftChange: (draft: NewTopicDraft) => void;
  readonly onCancel: () => void;
  readonly onSaved: (name: string) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const nameId = useId();
  const gistId = useId();
  const bodyId = useId();

  // The screen's loader read the assistants, so this never waits.
  const assistant = useSuspenseQuery(assistantsQuery(client)).data.items.find(
    (each) => each.id === assistantId,
  );

  const write = useMutation({
    mutationKey: [...ASSISTANT_MUTATION_KEY, "memory", "create"],
    mutationFn: (sent: NewTopicDraft) =>
      client.memory.write({
        params: { id: assistantId, name: sent.name },
        // Version 0 means the topic must not exist yet, so a topic the
        // assistant created since the list was read is never replaced.
        payload: { body: sent.body, gist: sent.gist, expectedVersion: 0 },
      }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(
        memoryDocumentQuery(client, assistantId, saved.name).queryKey,
        saved,
      );
      onSaved(saved.name);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.memory(assistantId),
        exact: true,
      });
    },
    onError: async (error) => {
      if (isConflict(error)) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.memory(assistantId),
          exact: true,
        });
      }
    },
  });

  const conflict = describeTopicNameConflict(entries, draft.name);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    write.mutate(draft);
  };

  return (
    <form onSubmit={submit}>
      <FormCard label={<b className="text-row font-emph text-ink">New topic</b>}>
        <Row label="Topic name" htmlFor={nameId}>
          <div className="flex flex-col gap-1.5">
            <Input
              id={nameId}
              required
              value={draft.name}
              onChange={(event) => {
                onDraftChange({ ...draft, name: event.target.value });
              }}
            />
            {conflict === undefined ? null : (
              <p className="text-fine text-fail" role="alert">
                {conflict}
              </p>
            )}
          </div>
        </Row>
        <Row label="Gist" htmlFor={gistId}>
          <Input
            id={gistId}
            value={draft.gist}
            onChange={(event) => {
              onDraftChange({ ...draft, gist: event.target.value });
            }}
          />
        </Row>
        <Row label="Text" htmlFor={bodyId}>
          <Textarea
            id={bodyId}
            rows={10}
            value={draft.body}
            onChange={(event) => {
              onDraftChange({ ...draft, body: event.target.value });
            }}
          />
        </Row>
        <MemoryUsage
          label="New topic used"
          size={countCharacters(draft.body)}
          cap={MEMORY_TOPIC_CAP}
        />
        {assistant === undefined ? null : (
          <p className="text-fine text-faint">{describeTopicVisibility(assistant.name)}</p>
        )}

        <div className="flex items-center gap-3 pt-2">
          {/* The answer that declines comes first, as everywhere in the app. */}
          <Button className="-ml-2" disabled={write.isPending} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="form"
            // The screen has a Save on every card, so each names what it saves.
            aria-label="Save new topic"
            disabled={write.isPending || draft.name === "" || conflict !== undefined}
          >
            Save
          </Button>
          <SaveStatus
            saved={false}
            failure={write.error === null ? null : readErrorMessage(write.error)}
          />
        </div>
      </FormCard>
    </form>
  );
}
