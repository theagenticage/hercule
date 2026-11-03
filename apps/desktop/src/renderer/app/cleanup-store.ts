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
 * 2. When the controller has answered, the store starts a fresh read of every
 *    workspace. Only a read that began after the answer can tell a workspace
 *    that is being removed from one that was refused: a refusal leaves its
 *    reason in `Workspace.message`, which asking again does not clear. The
 *    store does not trust the promise of that read, which resolves at once
 *    when the read is paused (the Mac is offline) and leaves the old data. It
 *    watches the query cache and opens only on the first successful read after
 *    it started the fresh one. When that read fails or is paused, the next
 *    successful read opens the gate: the live connection causes one on the
 *    next `workspace` push and on a reconnect. The store runs no timer.
 * 3. From then on, every read of the workspaces that the `workspace` topic's
 *    pushes cause settles the rows still being removed
 *    (`decideRemovalOutcome`).
 * 4. When no row is left being removed, the result is worded
 *    (`describeCleanupOutcome`) and the toast shows it, unless the dialog is
 *    open and shows it itself, in a paragraph under its title.
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
   * order of `plan.items`. Replaces any progress the machine has. The Clean
   * up… button's guard keeps it from calling this while a cleanup is in
   * progress, so the store does not check that itself.
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
   * dialog shows it under its title.
   */
  readonly watch: (runnerId: string) => () => void;
  /**
   * Ends the store's work: stops watching the query cache and forgets every
   * cleanup, so that no answer still on its way shows a toast or changes
   * anything. The shell calls it when it unmounts, for example on sign-out.
   */
  readonly dispose: () => void;
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
  /** How many calls to the controller have been sent and not yet answered. */
  readonly unansweredCalls: number;
  /**
   * Whether a call has answered and no read of the workspaces that began after
   * its answer has succeeded yet. While it is true, or while any call is
   * unanswered, the cached workspaces may still show a state from before the
   * call, so no row is settled.
   */
  readonly awaitingFreshRead: boolean;
  /**
   * The reason to show for each workspace whose removal call failed, so that
   * it is unknown whether it was asked for. See `decideRemovalOutcome`.
   */
  readonly failureMessages: ReadonlyMap<string, string>;
}

/** Checks whether two outcomes of one row are the same, so that a read that changes nothing draws nothing. */
const isSameOutcome = (a: RemovalOutcome, b: RemovalOutcome): boolean =>
  a.kind === b.kind &&
  (a.kind !== "refused" ||
    (b.kind === "refused" && a.message === b.message && a.retry === b.retry));

/** Returns the `CleanupItem` the result's words and the retry are built from. */
const toItem = (row: CleanupRow): CleanupItem => ({
  workspaceId: row.workspaceId,
  expectedLastUsedAt: row.expectedLastUsedAt,
  freesBytes: row.freesBytes ?? 0,
});

/** What the store needs from the shell. */
export interface CleanupStoreDependencies {
  readonly client: HerculeClient;
  /** Holds the workspaces the shell reads, which settle the rows. */
  readonly queryClient: QueryClient;
  /** Shows its argument as the app's toast. */
  readonly showNotice: (text: string) => void;
}

/** Creates the store. */
export const createCleanupStore = ({
  client,
  queryClient,
  showNotice,
}: CleanupStoreDependencies): CleanupStore => {
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
   * if no dialog shows the words under its title.
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
   * call of the machine awaits its answer or its fresh read, and draws
   * nothing when the read changed no row.
   */
  const settle = (runnerId: string): void => {
    const entry = entries.get(runnerId);
    const workspaces = queryClient.getQueryData(workspacesKey);
    if (entry === undefined || workspaces === undefined) return;
    if (entry.unansweredCalls > 0 || entry.awaitingFreshRead) return;
    const { progress } = entry;
    if (progress.kind !== "removing" || progress.result !== null) return;
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const outcomes = new Map(progress.outcomes);
    let isChanged = false;
    for (const row of progress.rows) {
      const workspace = byId.get(row.workspaceId);
      const current = outcomes.get(row.workspaceId);
      if (current?.kind !== "removing" || workspace === undefined) continue;
      const decided = decideRemovalOutcome(
        workspace,
        entry.failureMessages.get(row.workspaceId) ?? null,
      );
      if (isSameOutcome(decided, current)) continue;
      outcomes.set(row.workspaceId, decided);
      isChanged = true;
    }
    const result = describeCleanupOutcome(
      progress.archivedCount,
      progress.rows.map(toItem),
      outcomes,
    );
    if (!isChanged && result === null) return;
    replace(runnerId, { ...entry, progress: { ...progress, outcomes, result } });
    if (result !== null) announce(runnerId, result);
    if (!hasRowsBeingRemoved()) {
      stopWatchingCache?.();
      stopWatchingCache = null;
    }
  };

  /**
   * Starts settling the rows of every machine whenever the shell's workspaces
   * have been read. A read that succeeds while a machine awaits its fresh read
   * began after that machine's answer (see `startFreshRead`), so it opens the
   * machine's gate. Writes made with `setQueryData` are ignored: only a real
   * read can open the gate.
   */
  const startWatchingCache = (): void => {
    stopWatchingCache ??= queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      // A `setQueryData` write is not a read: it carries whatever list the
      // writer held, which may be from before the answer.
      if (event.action.manual === true) return;
      if (!matchQuery({ queryKey: workspacesKey, exact: true }, event.query)) return;
      for (const [runnerId, entry] of [...entries]) {
        if (entry.awaitingFreshRead) entries.set(runnerId, { ...entry, awaitingFreshRead: false });
        settle(runnerId);
      }
    });
  };

  /**
   * Starts a read of the workspaces that cancels one already running, so that
   * every successful read after this call began after it. The promise is
   * ignored on purpose: it resolves at once, with the old data, when the read
   * is paused. The cache watch (`startWatchingCache`) hears the success.
   */
  const startFreshRead = (): void => {
    startWatchingCache();
    void queryClient
      .refetchQueries({ queryKey: workspacesKey, exact: true }, { cancelRefetch: true })
      .catch(() => undefined);
  };

  /**
   * Records what the call that asked for the removals of `asked` answered,
   * then starts a fresh read to settle from. The call was counted in
   * `unansweredCalls` when it was sent.
   */
  const applyAnswer = (
    runnerId: string,
    run: object,
    asked: readonly string[],
    answer: Exclude<CleanupStart, { status: "archiveRefused" | "archiveUnconfirmed" }>,
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
      unansweredCalls: entry.unansweredCalls - 1,
      awaitingFreshRead: true,
      failureMessages,
      progress: {
        kind: "removing",
        rows: entry.progress.rows,
        archivedCount: previous?.archivedCount ?? answer.archivedCount,
        outcomes: new Map([...(previous?.outcomes ?? []), ...answered]),
        result: null,
      },
    });
    startFreshRead();
  };

  return {
    start: (runnerId, rows, plan) => {
      const run = {};
      replace(runnerId, {
        progress: { kind: "starting", rows },
        run,
        unansweredCalls: 1,
        awaitingFreshRead: false,
        failureMessages: new Map(),
      });
      const stop = (message: string): void => {
        const entry = readRun(runnerId, run);
        if (entry === undefined) return;
        // A dialog that is closed cannot show the reason, so the toast does,
        // and there is nothing left to reopen.
        if ((watchers.get(runnerId) ?? 0) === 0) {
          showNotice(message);
          replace(runnerId, null);
          return;
        }
        replace(runnerId, {
          ...entry,
          unansweredCalls: 0,
          progress: { kind: "stopped", rows, message },
        });
      };
      void archiveAndRemoveWorkspaces(client, plan).then(
        (answer) => {
          if (answer.status === "archiveRefused" || answer.status === "archiveUnconfirmed")
            stop(answer.message);
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
        unansweredCalls: entry.unansweredCalls + 1,
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
          unansweredCalls: current.unansweredCalls - 1,
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
          if (answer.status === "archiveRefused" || answer.status === "archiveUnconfirmed")
            refuse(answer.message);
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

    dispose: () => {
      stopWatchingCache?.();
      stopWatchingCache = null;
      entries.clear();
      watchers.clear();
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
