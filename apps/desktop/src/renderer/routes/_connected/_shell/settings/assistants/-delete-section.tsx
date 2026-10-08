import { useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import type { Assistant } from "@hercule/contract";
import { assistantsQuery } from "../../../../../app/queries";
import { GlassDialog } from "../../../../../screens/glass-dialog";
import { SettingRow } from "../../../../../screens/settings/setting-row";

/**
 * Renders the Delete section of an assistant: a row whose button asks for a
 * confirmation in a dialog, which says what goes and what stays before
 * anything is deleted. `onDeleted` is called with the assistant's id once
 * the controller has deleted it and it is gone from the cached list.
 */
export function DeleteSection({
  assistant,
  onDeleted,
}: {
  readonly assistant: Assistant;
  readonly onDeleted: (id: string) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => client.assistant.delete({ params: { id: assistant.id } }),
    onSuccess: async () => {
      dialogRef.current?.close();
      const { queryKey } = assistantsQuery(client);
      queryClient.setQueryData(queryKey, (list) => list?.filter(({ id }) => id !== assistant.id));
      onDeleted(assistant.id);
      // Read again, so a read that started before the delete cannot bring
      // the assistant back.
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  return (
    <section className="set-sec">
      <h2>Delete {assistant.name}</h2>
      <SettingRow
        label="Delete assistant"
        hint="Removes it and its Conversation. Its sessions stay in the history."
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
        <GlassDialog
          dialogRef={dialogRef}
          className="confirm-dialog"
          label={`Delete ${assistant.name}?`}
          onClose={() => setConfirming(false)}
        >
          <div className="pop-h">
            <b>Delete {assistant.name}?</b>
          </div>
          <div className="pop-sec confirm-dialog-body">
            <p>
              This removes {assistant.name}’s Conversation and every message in it, and stops any
              session it is running. Its sessions stay in the history. This cannot be undone.
            </p>
            {remove.error !== null && (
              <p className="fl-err" role="alert">
                Could not delete: {readErrorMessage(remove.error)}
              </p>
            )}
            <div className="confirm-dialog-acts">
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => dialogRef.current?.close()}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--danger"
                aria-disabled={remove.isPending}
                onClick={() => {
                  if (!remove.isPending) remove.mutate();
                }}
              >
                {remove.isPending ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </GlassDialog>
      )}
    </section>
  );
}
