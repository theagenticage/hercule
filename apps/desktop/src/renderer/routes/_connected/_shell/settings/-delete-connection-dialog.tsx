import { useRef, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage, type ConnectionType } from "@hercule/client-core";
import type { Connection } from "@hercule/contract";
import { connectionsQuery } from "../../../../app/queries";
import { ConfirmDialog } from "../../../../screens/confirm-dialog";

/**
 * Renders the dialog that asks before the Connection `connection` is
 * deleted (spec 17 §Settings, Connections). It says that Hercule forgets
 * the Connection's credentials but does not revoke them at the provider,
 * which is named by its type's display name, or by the Connection's raw
 * type when the binary no longer holds the type.
 *
 * Delete calls `connection.delete`. On success the dialog closes, the
 * Connection leaves the cached list at once, and the Connections are read
 * again. On failure the dialog stays open and shows
 * the controller's error. `onClose` is called whenever the dialog closes.
 */
export function DeleteConnectionDialog({
  connection,
  type,
  onClose,
}: {
  readonly connection: Connection;
  /** Absent when the plugin that declared the type is no longer in the binary. */
  readonly type: ConnectionType | undefined;
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const remove = useMutation({
    mutationFn: () => client.connection.delete({ params: { id: connection.id } }),
    onSuccess: async () => {
      dialogRef.current?.close();
      const { queryKey } = connectionsQuery(client);
      queryClient.setQueryData(queryKey, (list) => list?.filter(({ id }) => id !== connection.id));
      // Read again, so a read that started before the delete cannot bring
      // the Connection back.
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  const provider = type?.displayName ?? connection.type;
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title={`Delete ${connection.label}?`}
      actionLabel={remove.isPending ? "Deleting…" : "Delete"}
      actionClass="danger"
      initialFocus="close"
      pending={remove.isPending}
      error={remove.error === null ? null : `Could not delete: ${readErrorMessage(remove.error)}`}
      onConfirm={() => {
        remove.mutate();
      }}
      onClose={onClose}
    >
      <p>
        {`Hercule forgets this Connection's credentials, but does not revoke them at ${provider}. Revoke them there if they are no longer needed.`}
      </p>
    </ConfirmDialog>
  );
}
