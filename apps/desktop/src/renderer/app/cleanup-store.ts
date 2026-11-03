/**
 * The state behind the cleanup dialog's progress (spec 17 §The cleanup
 * dialog), kept outside React and outside the dialog. Closing the dialog
 * while workspaces are still being removed therefore loses nothing: the store
 * goes on, shows the toast when the removals end, and the dialog shows the
 * progress again when it is reopened.
 *
 * One cleanup per machine can be in progress. The store runs the whole flow:
 *
 * 1. `start` archives the Threads and asks the controller to remove the
 *    workspaces (`archiveAndRemoveWorkspaces`).
 * 2. When the controller has answered, the store reads every workspace once
 *    more. Only a read that began after the answer can tell a workspace that
 *    is being removed from one that was refused: a refusal leaves its reason
 *    in `Workspace.message`, which asking again does not clear.
 * 3. From then on, every read of the workspaces that the `workspace` topic's
 *    pushes cause settles the rows still being removed
 *    (`decideRemovalOutcome`).
 * 4. When no row is left being removed, the result is worded
 *    (`describeCleanupOutcome`) and the toast shows it, unless the dialog is
 *    open and shows it in its own head.
 */
import { matchQuery, type QueryClient } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import {
  archiveAndRemoveWorkspaces,
  decideRemovalOutcome,
  describeCleanupOutcome,
  type CleanupItem,
  type CleanupOutcomeWords,
  type CleanupPlan,
  type CleanupRow,
  type CleanupStart,
  type RemovalOutcome,
} from "@hercule/client-core/cleanup";
import { workspacesQuery } from "./queries";

/** How long the store waits before it reads the workspaces again after a failed read. */
const READ_AGAIN_AFTER_MS = 5_000;

/** What the dialog shows of a cleanup, from the moment the button is pressed. */
export type CleanupProgress =
  /** The Threads are being archived and the removal is being asked for. */
  | { readonly kind: "starting"; readonly rows: readonly CleanupRow[] }
  /** Nothing was removed: the archive was refused or failed. `message` says why. */
  | {
      readonly kind: "stopped";
      readonly rows: readonly CleanupRow[];
      readonly message: string;
    }
  /**
   * The Threads are archived and the removals were asked for. `outcomes` has
   * one outcome for each of `rows`. `result` is `null` while any is still
   * `removing`, else the words that tell how the cleanup ended.
   */
  | {
      readonly kind: "removing";
      readonly rows: readonly CleanupRow[];
      readonly archivedCount: number;
      readonly outcomes: ReadonlyMap<string, RemovalOutcome>;
      readonly result: CleanupOutcomeWords | null;
    };

/** The progress of the cleanups of the machines, by machine. See the module comment. */
export interface CleanupStore {
  /**
   * Archives the Threads of `plan` and removes its workspaces on the machine
   * `runnerId`. `rows` are the dialog's rows of those workspaces, in the
   * order of `plan.items`. Replaces any progress that has ended.
   */
  readonly start: (runnerId: string, rows: readonly CleanupRow[], plan: CleanupPlan) => void;
  /**
   * Asks again for the removal of one workspace of the machine's cleanup that
   * was refused, with the `lastUsedAt` the dialog showed. Does nothing when
   * that workspace is not refused.
   */
  readonly retry: (runnerId: string, workspaceId: string) => void;
  /**
   * Forgets the machine's progress once it has ended: the archive was
   * refused, or every row has an outcome. Does nothing while a row is still
   * being removed.
   */
  readonly dismiss: (runnerId: string) => void;
  /**
   * Tells the store that a dialog shows the machine's progress, until the
   * returned function is called. The result of a cleanup that ends with some
   * refusals is shown as a toast only when no dialog is watching, because the
   * dialog's head shows it.
   */
  readonly watch: (runnerId: string) => () => void;
  /** Calls `listener` after every change; returns the function that stops that. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Returns the machine's progress, or `null` for none. */
  readonly read: (runnerId: string) => CleanupProgress | null;
}

/** What the store keeps for one machine beside its progress. */
interface Entry {
  readonly progress: CleanupProgress;
  /**
   * Identifies the cleanup, so that the answer of a call for an earlier
   * cleanup that was replaced is dropped.
   */
  readonly run: object;
  /**
   * How many calls have been sent and not yet followed by a fresh read of the
   * workspaces. While it is above 0, the cached workspaces may still show a
   * state from before the call, so no row is settled.
   */
  readonly callsAwaitingRead: number;
  /**
   * The reason to show for each workspace whose removal call failed, so that
   * it is unknown whether it was asked for. See `decideRemovalOutcome`.
   */
  readonly failureMessages: ReadonlyMap<string, string>;
}

/** Returns the `CleanupItem` the result's words and the retry are built from. */
const toItem = (row: CleanupRow): CleanupItem => ({
  workspaceId: row.workspaceId,
  expectedLastUsedAt: row.expectedLastUsedAt,
  freesBytes: row.freesBytes ?? 0,
});

/**
 * Creates the store. `showNotice` shows its argument as the app's toast.
 * `queryClient` holds the workspaces the shell reads, which settle the rows.
 */
export const createCleanupStore = ({
  client,
  queryClient,
  showNotice,
}: {
  readonly client: HerculeClient;
  readonly queryClient: QueryClient;
  readonly showNotice: (text: string) => void;
}): CleanupStore => {
  const entries = new Map<string, Entry>();
  const watchers = new Map<string, number>();
  const listeners = new Set<() => void>();
  const workspacesKey = workspacesQuery(client).queryKey;
  let stopWatchingCache: (() => void) | null = null;

  const replace = (runnerId: string, entry: Entry | null): void => {
    if (entry === null) entries.delete(runnerId);
    else entries.set(runnerId, entry);
    for (const listener of listeners) listener();
  };

  /** Returns the entry of `runnerId` when it still belongs to `run`, else `undefined`. */
  const readRun = (runnerId: string, run: object): Entry | undefined => {
    const entry = entries.get(runnerId);
    return entry?.run === run ? entry : undefined;
  };

  /** Returns whether any machine has a row being removed that the cache could settle. */
  const hasRowsBeingRemoved = (): boolean =>
    [...entries.values()].some(
      ({ progress }) => progress.kind === "removing" && progress.result === null,
    );

  /**
   * Shows the toast of a cleanup that has ended, when its words belong there:
   * always when everything was removed, and when some rows were refused only
   * if no dialog shows the words in its head.
   */
  const announce = (runnerId: string, result: CleanupOutcomeWords): void => {
    const isWatched = (watchers.get(runnerId) ?? 0) > 0;
    if (result.allRemoved || !isWatched) showNotice(result.text);
    // A cleanup that removed everything has nothing left to show once the
    // toast is up, unless a dialog is still open on it: that dialog closes
    // itself and then dismisses the progress.
    if (result.allRemoved && !isWatched) replace(runnerId, null);
  };

  /**
   * Settles the rows of `runnerId` that are being removed from the cached
   * workspaces, and words the result when none is left. Does nothing while a
   * call of the machine awaits its fresh read.
   */
  const settle = (runnerId: string): void => {
    const entry = entries.get(runnerId);
    const workspaces = queryClient.getQueryData(workspacesKey);
    if (entry === undefined || workspaces === undefined || entry.callsAwaitingRead > 0) return;
    const { progress } = entry;
    if (progress.kind !== "removing" || progress.result !== null) return;
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const outcomes = new Map(progress.outcomes);
    for (const row of progress.rows) {
      const workspace = byId.get(row.workspaceId);
      if (outcomes.get(row.workspaceId)?.kind !== "removing" || workspace === undefined) continue;
      outcomes.set(
        row.workspaceId,
        decideRemovalOutcome(workspace, entry.failureMessages.get(row.workspaceId) ?? null),
      );
    }
    const result = describeCleanupOutcome(
      progress.archivedCount,
      progress.rows.map(toItem),
      outcomes,
    );
    replace(runnerId, { ...entry, progress: { ...progress, outcomes, result } });
    if (result !== null) announce(runnerId, result);
    if (!hasRowsBeingRemoved()) {
      stopWatchingCache?.();
      stopWatchingCache = null;
    }
  };

  /** Starts settling the rows of every machine whenever the shell's workspaces have been read. */
  const startWatchingCache = (): void => {
    stopWatchingCache ??= queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      if (!matchQuery({ queryKey: workspacesKey, exact: true }, event.query)) return;
      for (const runnerId of [...entries.keys()]) settle(runnerId);
    });
  };

  /**
   * Reads the workspaces again, so that the read began after the call that
   * just answered, then settles the machine's rows from it. A failed read is
   * tried again after a pause, for as long as the cleanup stays the machine's.
   */
  const settleFromFreshRead = async (runnerId: string, run: object): Promise<void> => {
    for (;;) {
      try {
        await queryClient.refetchQueries(
          { queryKey: workspacesKey, exact: true },
          { throwOnError: true, cancelRefetch: true },
        );
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, READ_AGAIN_AFTER_MS));
        if (readRun(runnerId, run) === undefined) return;
      }
    }
    const entry = readRun(runnerId, run);
    if (entry === undefined) return;
    entries.set(runnerId, { ...entry, callsAwaitingRead: entry.callsAwaitingRead - 1 });
    settle(runnerId);
  };

  /**
   * Records what the call that asked for the removals of `asked` answered,
   * then settles from a fresh read. The call was counted in
   * `callsAwaitingRead` when it was sent.
   */
  const applyAnswer = (
    runnerId: string,
    run: object,
    asked: readonly string[],
    answer: Exclude<CleanupStart, { status: "archiveRefused" }>,
  ): void => {
    const entry = readRun(runnerId, run);
    if (entry === undefined) return;
    const failureMessages = new Map(entry.failureMessages);
    const answered = new Map<string, RemovalOutcome>();
    if (answer.status === "started") {
      for (const { workspaceId, outcome } of answer.removals) answered.set(workspaceId, outcome);
    } else {
      for (const workspaceId of asked) {
        answered.set(workspaceId, { kind: "removing" });
        failureMessages.set(workspaceId, answer.message);
      }
    }
    const previous = entry.progress.kind === "removing" ? entry.progress : null;
    replace(runnerId, {
      ...entry,
      failureMessages,
      progress: {
        kind: "removing",
        rows: entry.progress.rows,
        archivedCount: previous?.archivedCount ?? answer.archivedCount,
        outcomes: new Map([...(previous?.outcomes ?? []), ...answered]),
        result: null,
      },
    });
    startWatchingCache();
    void settleFromFreshRead(runnerId, run);
  };

  return {
    start: (runnerId, rows, plan) => {
      const run = {};
      replace(runnerId, {
        progress: { kind: "starting", rows },
        run,
        callsAwaitingRead: 1,
        failureMessages: new Map(),
      });
      const stop = (message: string): void => {
        const entry = readRun(runnerId, run);
        if (entry === undefined) return;
        replace(runnerId, {
          ...entry,
          callsAwaitingRead: 0,
          progress: { kind: "stopped", rows, message },
        });
      };
      void archiveAndRemoveWorkspaces(client, plan).then(
        (answer) => {
          if (answer.status === "archiveRefused") stop(answer.message);
          else
            applyAnswer(
              runnerId,
              run,
              plan.items.map((item) => item.workspaceId),
              answer,
            );
        },
        (error: unknown) => {
          stop(`Could not archive: ${readErrorMessage(error)}`);
        },
      );
    },

    retry: (runnerId, workspaceId) => {
      const entry = entries.get(runnerId);
      if (entry?.progress.kind !== "removing") return;
      const { progress, run } = entry;
      const row = progress.rows.find((each) => each.workspaceId === workspaceId);
      if (row === undefined || progress.outcomes.get(workspaceId)?.kind !== "refused") return;
      const failureMessages = new Map(entry.failureMessages);
      failureMessages.delete(workspaceId);
      replace(runnerId, {
        ...entry,
        failureMessages,
        callsAwaitingRead: entry.callsAwaitingRead + 1,
        progress: {
          ...progress,
          outcomes: new Map(progress.outcomes).set(workspaceId, { kind: "removing" }),
          result: null,
        },
      });
      startWatchingCache();
      // A retry archives nothing, so only a failed call to the controller can end it early.
      const refuse = (message: string): void => {
        const current = readRun(runnerId, run);
        if (current?.progress.kind !== "removing") return;
        replace(runnerId, {
          ...current,
          callsAwaitingRead: current.callsAwaitingRead - 1,
          progress: {
            ...current.progress,
            outcomes: new Map(current.progress.outcomes).set(workspaceId, {
              kind: "refused",
              message,
              retry: true,
            }),
          },
        });
        settle(runnerId);
      };
      void archiveAndRemoveWorkspaces(client, { threadIds: [], items: [toItem(row)] }).then(
        (answer) => {
          if (answer.status === "archiveRefused") refuse(answer.message);
          else applyAnswer(runnerId, run, [workspaceId], answer);
        },
        (error: unknown) => {
          refuse(readErrorMessage(error));
        },
      );
    },

    dismiss: (runnerId) => {
      const progress = entries.get(runnerId)?.progress;
      if (progress === undefined || progress.kind === "starting") return;
      if (progress.kind === "removing" && progress.result === null) return;
      replace(runnerId, null);
    },

    watch: (runnerId) => {
      watchers.set(runnerId, (watchers.get(runnerId) ?? 0) + 1);
      return () => {
        watchers.set(runnerId, Math.max(0, (watchers.get(runnerId) ?? 0) - 1));
      };
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    read: (runnerId) => entries.get(runnerId)?.progress ?? null,
  };
};
