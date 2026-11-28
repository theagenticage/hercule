import { useRef, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouteContext } from "@tanstack/react-router";
import {
  buildRetireQuestion,
  isInvalidState,
  queryKeys,
  readErrorMessage,
} from "@hercule/client-core";
import type { Runner } from "@hercule/contract";
import { runnersQuery } from "../../../../app/queries";
import { keepSavedRecord } from "../../../../app/saved-record-field";
import { ConfirmDialog } from "../../../../screens/confirm-dialog";

/**
 * Renders the dialog that asks before the machine `runner` is retired (spec
 * 17 §Fleet, A machine's page). Its question and warnings are the ones
 * `buildRetireQuestion` builds: an unreachable machine is retired with
 * `force`, and the default machine is named as such. `defaultRunnerId` is the
 * controller's default runner.
 *
 * On success the retired machine replaces the cached one at once, so the
 * Fleet page never draws it as a card while the runners are read again. The
 * dialog closes, the page goes to Fleet if it is still this machine's page,
 * and the runners and the controller's record (which may have lost its
 * default) are read again. The user may have left the machine's page while
 * the request ran, and is then not sent back.
 * When the controller refuses, because a state that asking again does not
 * change holds, the dialog shows its message and offers only Cancel. Any other
 * failure is shown and the dialog keeps Retire, so the user can try again.
 *
 * `onClose` is called whenever the dialog closes. The caller then unmounts it.
 */
export function MachineRetireDialog({
  runner,
  defaultRunnerId,
  onClose,
}: {
  readonly runner: Runner;
  readonly defaultRunnerId: string | null;
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const question = buildRetireQuestion(runner, defaultRunnerId);
  const retire = useMutation({
    mutationFn: () =>
      client.runner.retire({
        params: { id: runner.id },
        payload: question.force ? { force: true } : {},
      }),
    // This is the mutation's own `onSuccess`, not a callback of `mutate`: the
    // dialog can unmount before the answer arrives (a push from the controller
    // removes the page), and only the mutation's own callback still runs then.
    onSuccess: async (retired) => {
      const runnersRead = keepSavedRecord(queryClient, runnersQuery(client).queryKey, retired);
      dialogRef.current?.close();
      const machinePage = router.buildLocation({
        to: "/fleet/$runnerId",
        params: { runnerId: runner.id },
      }).pathname;
      // Once the runner is retired its page shows "not found", so leave it,
      // unless the user has already gone somewhere else.
      if (router.state.location.pathname === machinePage) await router.navigate({ to: "/fleet" });
      await Promise.all([
        runnersRead,
        queryClient.invalidateQueries({ queryKey: queryKeys.controller() }),
      ]);
    },
  });
  const refused = retire.error !== null && isInvalidState(retire.error);
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title={`Retire ${runner.name}?`}
      actionLabel={retire.isPending ? "Retiring…" : "Retire"}
      actionClass="danger"
      initialFocus="close"
      pending={retire.isPending}
      refusal={refused ? readErrorMessage(retire.error) : null}
      error={
        retire.error === null || refused
          ? null
          : `Could not retire: ${readErrorMessage(retire.error)}`
      }
      onConfirm={() => {
        retire.mutate();
      }}
      onClose={onClose}
    >
      <p>Forgets the machine. Its threads keep their transcripts, but cannot resume.</p>
      {question.warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
    </ConfirmDialog>
  );
}
