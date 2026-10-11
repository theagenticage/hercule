import { useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import {
  describeTopicNameConflict,
  describeTopicVisibility,
  isConflict,
  readErrorMessage,
} from "@hercule/client-core";
import { MAX_MEMORY_NAME_LENGTH, type Assistant, type MemoryEntry } from "@hercule/contract";
import { memoryDocumentQuery, memoryIndexQuery } from "../../../../../app/queries";
import { ConfirmDialog } from "../../../../../screens/confirm-dialog";

/**
 * Renders the dialog that creates a topic in `assistant`'s memory: one field
 * for its name, and Create. Create writes the topic with an empty text and
 * gist, then opens its page, where they are written.
 *
 * A name that `entries` already holds, or `core`, is refused before anything
 * is sent, because a write to an existing name would replace that document.
 * The write also asks the controller to refuse it if the topic exists by
 * then, created by the assistant since the index was read; that refusal
 * reads the index again, so the Memory column lists the topic. Any refusal
 * is the controller's, and shows as it words it, such as a 25th topic.
 * `onClose` is called when the dialog closes.
 */
export function NewTopicDialog({
  assistant,
  entries,
  onClose,
}: {
  readonly assistant: Assistant;
  readonly entries: ReadonlyArray<MemoryEntry>;
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [conflict, setConflict] = useState<string | undefined>(undefined);
  const create = useMutation({
    mutationFn: (topic: string) =>
      client.memory.write({
        params: { id: assistant.id, name: topic },
        // Version 0 means the topic must not exist yet.
        payload: { body: "", gist: "", expectedVersion: 0 },
      }),
    onError: async (error) => {
      if (isConflict(error)) {
        await queryClient.invalidateQueries({
          queryKey: memoryIndexQuery(client, assistant.id).queryKey,
          exact: true,
        });
      }
    },
    onSuccess: async (created) => {
      queryClient.setQueryData(
        memoryDocumentQuery(client, assistant.id, created.name).queryKey,
        created,
      );
      dialogRef.current?.close();
      // The section reads the index again when it opens, so the topic is
      // listed when the user comes back.
      await navigate({
        to: "/settings/assistants/$id/memory/$name",
        params: { id: assistant.id, name: created.name },
      });
    },
  });
  const submit = (): void => {
    if (create.isPending) return;
    const topic = name.trim();
    const refusal =
      topic === "" ? "Name the topic first." : describeTopicNameConflict(entries, topic);
    setConflict(refusal);
    if (refusal === undefined) create.mutate(topic);
  };
  const error =
    conflict ??
    (create.error === null ? undefined : `Could not create: ${readErrorMessage(create.error)}`);
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title="New topic"
      actionLabel={create.isPending ? "Creating…" : "Create"}
      actionClass="accent"
      pending={create.isPending}
      error={error ?? null}
      onConfirm={submit}
      onClose={onClose}
    >
      <p>{describeTopicVisibility(assistant.name)}</p>
      <span className="field memory-topic-name">
        <input
          type="text"
          aria-label="Topic name"
          placeholder="Topic name"
          maxLength={MAX_MEMORY_NAME_LENGTH}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
      </span>
    </ConfirmDialog>
  );
}
