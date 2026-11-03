import { useEffect, useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import {
  buildCleanupSnapshot,
  describeCleanupDialog,
  listCleanupCandidates,
  type CleanupGroupId,
  type CleanupSnapshot,
} from "@hercule/client-core/cleanup";
import { useCleanupProgress, useCleanupStore } from "../../../../app/cleanup";
import { useDoneMoves } from "../../../../app/done-moves";
import { cleanupThreadsQuery } from "../../../../app/machine-storage-queries";
import { workspacesQuery } from "../../../../app/queries";
import {
  CleanupChoices,
  CleanupDialogFrame,
  CleanupProgressView,
} from "../../../../screens/fleet/cleanup-dialog";

/**
 * Renders the Clean up… button of the machine `runnerId`, named `runnerName`,
 * and the cleanup dialog it opens (spec 17 §The cleanup dialog). Every Clean
 * up… button on the Fleet screens is this one: the machines' cards and rows
 * and the Storage section of a machine's page. `className` styles the
 * button.
 *
 * - While the machine is not `isOnline` (offline or unreachable), the button
 *   does nothing and its tooltip says why. It stays focusable
 *   (`aria-disabled`) so the tooltip shows.
 * - Pressing the button reads the Threads of the machine's idle workspaces
 *   afresh, builds the dialog's rows once from them and the shell's
 *   workspaces, and opens the dialog. The rows do not change as pushes arrive:
 *   what the user saw is what goes. When the read fails, the failure shows as
 *   a toast and no dialog opens.
 * - While the machine has a cleanup in progress (see `createCleanupStore`),
 *   pressing the button opens the dialog on that progress, without reading
 *   anything.
 */
export function CleanUpButton({
  runnerId,
  runnerName,
  isOnline,
  className,
}: {
  readonly runnerId: string;
  readonly runnerName: string;
  readonly isOnline: boolean;
  readonly className: string;
}): JSX.Element {
  const disabledHint = isOnline ? null : `${runnerName} is offline. Cleaning up needs it online.`;
  const queryClient = useQueryClient();
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { toasts } = useDoneMoves();
  const progress = useCleanupProgress(runnerId);
  // The snapshot is `null` when the dialog was opened on a cleanup already in progress.
  const [dialog, setDialog] = useState<{ readonly snapshot: CleanupSnapshot | null } | null>(null);

  // A press that reads is a command, not a screen's read: the result is a
  // snapshot of this moment that nothing keeps in the cache.
  const open = useMutation({
    mutationFn: async (): Promise<CleanupSnapshot> => {
      const workspaces = await queryClient.ensureQueryData(workspacesQuery(client));
      const now = new Date();
      const candidates = listCleanupCandidates(workspaces, runnerId, now);
      const threads =
        candidates.length === 0
          ? []
          : await queryClient.fetchQuery({
              ...cleanupThreadsQuery(
                client,
                runnerId,
                candidates.map((workspace) => workspace.id).toSorted(),
              ),
              staleTime: 0,
            });
      return buildCleanupSnapshot(runnerName, candidates, threads, now);
    },
    onSuccess: (snapshot) => {
      setDialog({ snapshot });
    },
    onError: (error) => {
      toasts.showFailure(
        `Couldn't read ${runnerName}'s workspaces: ${readErrorMessage(error)}`,
        null,
      );
    },
  });

  return (
    <>
      <button
        type="button"
        className={className}
        title={disabledHint ?? undefined}
        aria-disabled={disabledHint !== null || open.isPending || undefined}
        onClick={() => {
          if (disabledHint !== null || open.isPending) return;
          if (progress === null) open.mutate();
          else setDialog({ snapshot: null });
        }}
      >
        Clean up…
      </button>
      {dialog !== null && (
        <CleanupDialog
          runnerId={runnerId}
          runnerName={runnerName}
          snapshot={dialog.snapshot}
          onClose={() => {
            setDialog(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Renders the cleanup dialog of the machine `runnerId`. It holds the ticks,
 * which are the dialog's own state, and draws the machine's cleanup progress:
 *
 * - With no progress, or while the cleanup starts or was refused, the groups
 *   of `snapshot` with their ticks. A cleanup that was refused shows the
 *   reason over the groups, and the user may change the ticks and press again.
 * - Once the removals are asked for, one line for each workspace with where
 *   it stands. When every workspace was removed, the dialog closes: the toast
 *   says so.
 *
 * `onClose` is called whenever the dialog closes. The caller then unmounts it,
 * and the store forgets a cleanup that has ended.
 */
function CleanupDialog({
  runnerId,
  runnerName,
  snapshot,
  onClose,
}: {
  readonly runnerId: string;
  readonly runnerName: string;
  readonly snapshot: CleanupSnapshot | null;
  readonly onClose: () => void;
}): JSX.Element | null {
  const store = useCleanupStore();
  const progress = useCleanupProgress(runnerId);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => snapshot?.initialTicked ?? new Set(),
  );
  useEffect(() => store.watch(runnerId), [store, runnerId]);
  const isAllRemoved = progress?.kind === "removing" && progress.result?.allRemoved === true;
  useEffect(() => {
    if (isAllRemoved) dialogRef.current?.close();
  }, [isAllRemoved]);

  const close = (): void => {
    store.dismiss(runnerId);
    onClose();
  };
  const changeTicks = (workspaceIds: readonly string[], isTicked: boolean): void => {
    const next = new Set(ticked);
    for (const id of workspaceIds) {
      if (isTicked) next.add(id);
      else next.delete(id);
    }
    setTicked(next);
  };

  if (progress?.kind === "removing") {
    return (
      <CleanupDialogFrame
        dialogRef={dialogRef}
        title={`Clean up ${runnerName}`}
        locked={false}
        onClose={close}
      >
        <CleanupProgressView
          rows={progress.rows}
          outcomes={progress.outcomes}
          result={progress.result}
          onRetry={(workspaceId) => {
            store.retry(runnerId, workspaceId);
          }}
          onClose={() => dialogRef.current?.close()}
        />
      </CleanupDialogFrame>
    );
  }
  if (snapshot === null) return null;
  const description = describeCleanupDialog(snapshot, ticked);
  return (
    <CleanupDialogFrame
      dialogRef={dialogRef}
      title={description.head}
      locked={progress?.kind === "starting"}
      onClose={close}
    >
      <CleanupChoices
        description={description}
        error={progress?.kind === "stopped" ? progress.message : null}
        isStarting={progress?.kind === "starting"}
        onToggleRow={(workspaceId) => {
          changeTicks([workspaceId], !ticked.has(workspaceId));
        }}
        onToggleGroup={(groupId: CleanupGroupId, isTicked) => {
          changeTicks(
            snapshot.rows.filter((row) => row.group === groupId).map((row) => row.workspaceId),
            isTicked,
          );
        }}
        onConfirm={() => {
          if (description.plan === null) return;
          store.start(
            runnerId,
            snapshot.rows.filter((row) => ticked.has(row.workspaceId)),
            description.plan,
          );
        }}
        onClose={() => dialogRef.current?.close()}
      />
    </CleanupDialogFrame>
  );
}
