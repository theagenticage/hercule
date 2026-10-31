import { useRef, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { isInvalidState, isNotFound, readErrorMessage } from "@hercule/client-core";
import type { ProviderAccount } from "@hercule/contract";
import { providerAccountsQuery } from "../../../../app/queries";
import { ConfirmDialog } from "../../../../screens/confirm-dialog";

/**
 * Renders the dialog that asks before the Provider Account `account`,
 * called `name`, is deleted (spec 17 §Settings, Providers).
 *
 * Delete calls `providerAccount.delete`. A `not_found` reply counts as
 * success, because the account is gone either way. On success `onDeleted` is
 * called, the account leaves the cached list at once, and the accounts are
 * read again.
 *
 * The controller refuses to delete an account that something still uses
 * (an Agent, an assistant, the Text Generation setting, the thread default,
 * or a running session), with a message that lists what. Asking again
 * changes nothing until the user has changed those, so the dialog then shows
 * the message and offers only Cancel. Any other failure is shown and the
 * dialog keeps Delete, so the user can try again.
 *
 * `onClose` is called whenever the dialog closes, also after a delete.
 */
export function DeleteProviderAccountDialog({
  account,
  name,
  onDeleted,
  onClose,
}: {
  readonly account: ProviderAccount;
  /** The account's name, such as "Anthropic · work". */
  readonly name: string;
  readonly onDeleted: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const remove = useMutation({
    mutationFn: async () => {
      try {
        await client.providerAccount.delete({ params: { id: account.id } });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    onSuccess: async () => {
      dialogRef.current?.close();
      // The sheet shows this account, so it closes in the same update that
      // removes the account from the list.
      onDeleted();
      const { queryKey } = providerAccountsQuery(client);
      queryClient.setQueryData(queryKey, (list) => list?.filter(({ id }) => id !== account.id));
      // Read again, so a read that started before the delete cannot bring
      // the account back.
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  const refused = remove.error !== null && isInvalidState(remove.error);
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title={`Delete ${name}?`}
      actionLabel={remove.isPending ? "Deleting…" : "Delete"}
      actionClass="danger"
      closeLabel={refused ? "Cancel" : "Keep it"}
      initialFocus="close"
      pending={remove.isPending}
      refusal={refused ? readErrorMessage(remove.error) : null}
      error={
        remove.error === null || refused
          ? null
          : `Could not delete: ${readErrorMessage(remove.error)}`
      }
      onConfirm={() => {
        remove.mutate();
      }}
      onClose={onClose}
    >
      <p>Threads that ran on it keep their history, but cannot continue.</p>
    </ConfirmDialog>
  );
}
