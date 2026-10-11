import { useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { readErrorMessage, removeMemoryEntry } from "@hercule/client-core";
import type { Assistant } from "@hercule/contract";
import { memoryDocumentQuery, memoryIndexQuery } from "../../../../../../../app/queries";
import { ConfirmDialog } from "../../../../../../../screens/confirm-dialog";
import { SettingRow } from "../../../../../../../screens/settings/setting-row";

/**
 * Renders the Delete section of a memory topic: a row whose button asks for a
 * confirmation in a dialog before the topic is deleted. Once the controller
 * has deleted it, the topic leaves the cached index and the page goes back to
 * the assistant's settings.
 */
export function DeleteTopicSection({
  assistant,
  name,
}: {
  readonly assistant: Assistant;
  readonly name: string;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => client.memory.delete({ params: { id: assistant.id, name } }),
    onSuccess: async () => {
      dialogRef.current?.close();
      queryClient.setQueryData(memoryIndexQuery(client, assistant.id).queryKey, (entries) =>
        entries === undefined ? undefined : removeMemoryEntry(entries, name),
      );
      await navigate({ to: "/settings/assistants", search: { assistant: assistant.id } });
      // Removed once the page is gone, so nothing on it reads the document again.
      queryClient.removeQueries({
        queryKey: memoryDocumentQuery(client, assistant.id, name).queryKey,
      });
    },
  });
  return (
    <section className="set-sec">
      <h2>Delete {name}</h2>
      <SettingRow
        label="Delete topic"
        hint={`Removes the topic and its text from ${assistant.name}’s memory.`}
        control={(labels) => (
          <button
            type="button"
            className="btn btn--danger"
            {...labels}
            onClick={() => {
              remove.reset();
              setConfirming(true);
            }}
          >
            Delete…
          </button>
        )}
      />
      {confirming && (
        <ConfirmDialog
          dialogRef={dialogRef}
          title={`Delete ${name}?`}
          actionLabel={remove.isPending ? "Deleting…" : "Delete"}
          actionClass="danger"
          pending={remove.isPending}
          error={
            remove.error === null ? null : `Could not delete: ${readErrorMessage(remove.error)}`
          }
          onConfirm={() => {
            remove.mutate();
          }}
          onClose={() => setConfirming(false)}
        >
          <p>{assistant.name} no longer sees this topic or its text. This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
