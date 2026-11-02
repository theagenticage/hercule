import { useRef, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import {
  buildRetireQuestion,
  isInvalidState,
  queryKeys,
  readErrorMessage,
} from "@hercule/client-core";
import type { Runner } from "@hercule/contract";
import { ConfirmDialog } from "../../../../screens/confirm-dialog";

/**
 * Renders the dialog that asks before the machine `runner` is retired (spec
 * 17 §Fleet, A machine's page). Its question and warnings are the ones
 * `buildRetireQuestion` builds: an unreachable machine is retired with
 * `force`, and the default machine is named as such. `defaultRunnerId` is the
 * controller's default runner.
 *
 * On success the dialog closes, the page goes to Fleet, and the runners and
 * the controller's record (which may have lost its default) are read again.
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
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const question = buildRetireQuestion(runner, defaultRunnerId);
  const retire = useMutation({
    mutationFn: () =>
      client.runner.retire({
        params: { id: runner.id },
        payload: question.force ? { force: true } : {},
      }),
    onSuccess: async () => {
      dialogRef.current?.close();
      // Leave the page first: once the runner is retired its page shows
      // "not found".
      await navigate({ to: "/fleet" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.runners() }),
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
