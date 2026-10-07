import { useState, type FormEvent, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  buildAssistantDraft,
  buildAssistantUpdate,
  buildIdOptions,
  describeWhenAssistantChangesApply,
  dropSavedEdits,
  mergeAssistantEdits,
  type AssistantDraft,
  type HerculeClient,
  readErrorMessage,
} from "@hercule/client-core";
import type { Assistant, AssistantReply, AssistantUpdateInput } from "@hercule/contract";
import {
  Button,
  FormCard,
  Input,
  Row,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  Textarea,
} from "@hercule/ui";
import {
  assistantQuery,
  assistantsQuery,
  profilesQuery,
  providersQuery,
} from "../../../app/queries";
import { AccessModeControl } from "../../../screens/access-mode-control";
import { InPlaceQuestion } from "../../../screens/in-place-question";
import { SaveStatus } from "../../../screens/save-status";

/**
 * The mutation key prefix of every assistant create, save and delete on the
 * Assistants screen. While any of them runs, the screen keeps the user from
 * switching assistants, so its answer, and any error in it, lands on the
 * form that sent it.
 */
export const ASSISTANT_MUTATION_KEY = ["settings", "assistant"] as const;

/** The two reply modes, and the word the form shows for each. */
const REPLIES: ReadonlyArray<{ readonly value: AssistantReply; readonly label: string }> = [
  { value: "turn-end", label: "Turn end" },
  { value: "segments", label: "Segments" },
];

/** Replaces the form's unsaved edits with what `update` returns for the current ones. */
export type ChangeAssistantEdits = (
  update: (current: Partial<AssistantDraft>) => Partial<AssistantDraft>,
) => void;

/**
 * Renders the form that edits one assistant, and the button that deletes it.
 *
 * - The unsaved edits belong to the Assistants screen, which asks before
 *   they are thrown away. The form shows each edited field's edit and every
 *   other field's stored value, so a change another writer makes while the
 *   form is open still shows.
 * - Save sends only the fields whose value differs from the stored one, so
 *   it never overwrites a field the user did not touch.
 * - `onDeleted` runs once the assistant is deleted and gone from the list.
 */
export function AssistantForm({
  client,
  assistant,
  edits,
  onEditsChange,
  onDeleted,
}: {
  readonly client: HerculeClient;
  readonly assistant: Assistant;
  readonly edits: Partial<AssistantDraft>;
  readonly onEditsChange: ChangeAssistantEdits;
  readonly onDeleted: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const profiles = useSuspenseQuery(profilesQuery(client)).data.items;

  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const draft: AssistantDraft = { ...buildAssistantDraft(assistant), ...edits };
  const changes = buildAssistantUpdate(assistant, draft);

  const params = { id: assistant.id };
  const update = useMutation({
    mutationKey: [...ASSISTANT_MUTATION_KEY, "save"],
    mutationFn: (payload: AssistantUpdateInput) => client.assistant.update({ params, payload }),
    onSuccess: async (updated, sent) => {
      // The response is the stored assistant, so it goes into the cache
      // before the refetch. A refetch that fails then still leaves the saved
      // values on screen, not the old ones.
      queryClient.setQueryData(assistantsQuery(client).queryKey, (page) =>
        page === undefined
          ? page
          : { ...page, items: page.items.map((each) => (each.id === updated.id ? updated : each)) },
      );
      queryClient.setQueryData(assistantQuery(client, updated.id).queryKey, (stored) =>
        stored === undefined ? stored : updated,
      );
      onEditsChange((current) => dropSavedEdits(current, sent));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: assistantsQuery(client).queryKey }),
        queryClient.invalidateQueries({ queryKey: assistantQuery(client, updated.id).queryKey }),
      ]);
    },
  });
  const remove = useMutation({
    mutationKey: [...ASSISTANT_MUTATION_KEY, "delete"],
    mutationFn: () => client.assistant.delete({ params }),
    onSuccess: async () => {
      queryClient.setQueryData(assistantsQuery(client).queryKey, (page) =>
        page === undefined
          ? page
          : { ...page, items: page.items.filter((each) => each.id !== assistant.id) },
      );
      onDeleted();
      await queryClient.invalidateQueries({ queryKey: assistantsQuery(client).queryKey });
    },
  });

  const recordEdits = (fields: Partial<AssistantDraft>): void => {
    onEditsChange((current) => mergeAssistantEdits(assistant, current, fields));
  };
  const hasChanges = Object.keys(changes).length > 0;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    update.mutate(changes);
  };

  return (
    <form onSubmit={submit}>
      <FormCard label={<b className="text-row font-emph text-ink">{assistant.name}</b>}>
        <Row label="Name" htmlFor="assistant-name">
          <Input
            id="assistant-name"
            value={draft.name}
            onChange={(event) => {
              recordEdits({ name: event.target.value });
            }}
          />
        </Row>
        <Row label="Persona" htmlFor="assistant-persona">
          <Textarea
            id="assistant-persona"
            // Eight rows show the six-line default persona whole, with room
            // to add to it before the box scrolls.
            rows={8}
            value={draft.systemPrompt}
            onChange={(event) => {
              recordEdits({ systemPrompt: event.target.value });
            }}
          />
        </Row>
        <Row label="Provider instance" htmlFor="assistant-instance">
          <Select
            id="assistant-instance"
            value={draft.instanceId}
            onChange={(event) => {
              recordEdits({ instanceId: event.target.value });
            }}
          >
            {buildIdOptions(
              instances.map((instance) => ({ id: instance.id, label: instance.displayName })),
              assistant.instanceId,
            ).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Permission profile" htmlFor="assistant-profile">
          <Select
            id="assistant-profile"
            value={draft.permissionProfileId}
            onChange={(event) => {
              recordEdits({ permissionProfileId: event.target.value });
            }}
          >
            {buildIdOptions(
              profiles.map((profile) => ({ id: profile.id, label: profile.name })),
              assistant.permissionProfileId,
            ).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Access mode">
          <AccessModeControl
            value={draft.accessMode}
            onChange={(accessMode) => {
              recordEdits({ accessMode });
            }}
          />
        </Row>
        <Row label="Reply">
          <SegmentedControl
            aria-label="Reply"
            compact
            value={draft.reply}
            onValueChange={(next) => {
              recordEdits({ reply: next as AssistantReply });
            }}
          >
            {REPLIES.map((reply) => (
              <SegmentedControlItem key={reply.value} value={reply.value}>
                {reply.label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </Row>
        {/* A running harness keeps what it was started with, so the form says
            when each kind of change takes effect rather than letting a saved
            access mode look like it already applies. */}
        <p className="text-fine text-faint">{describeWhenAssistantChangesApply(assistant.name)}</p>

        <div className="flex items-center gap-3 pt-2">
          <Button type="submit" variant="form" disabled={update.isPending || !hasChanges}>
            Save
          </Button>
          <SaveStatus
            // "Saved." describes the last save, so it goes as soon as there
            // is something new to save, including text typed while the save
            // ran.
            saved={update.isSuccess && !hasChanges}
            failure={update.error === null ? null : readErrorMessage(update.error)}
          />
          <Button
            // Pulled right by its own padding, so its text lines up with the
            // right edge of the fields above.
            className="-mr-2 ml-auto"
            disabled={confirmingDelete || remove.isPending}
            onClick={() => {
              setConfirmingDelete(true);
            }}
          >
            {remove.isPending ? "Deleting…" : "Delete assistant"}
          </Button>
        </div>

        {confirmingDelete ? (
          <InPlaceQuestion
            // Every word of this question matters: it says what is lost and
            // what is kept, so it wraps instead of being cut short.
            stacked
            question={`Delete ${assistant.name}? Its conversation and messages are deleted. Its sessions and transcripts stay.`}
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
