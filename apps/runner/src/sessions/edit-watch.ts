/**
 * Finds the files a session changed with shell commands, by asking git
 * (spec 19 section 4.1). A shell command does not name the files it changed,
 * so after each command the runner lists what differs in each checkout and
 * subtracts what was already different when the session started.
 *
 * No command that git runs for us may execute anything the repository
 * configures. Git commands that read file contents run clean filters, and
 * `core.fsmonitor` runs a program, both from the repository's own config. A
 * hostile checkout could use either to run commands outside the session's
 * sandbox. So the listing uses only commands that never read file contents
 * (`diff-index`, `ls-files`, `reflog`, `diff-tree`), and every call turns
 * `core.fsmonitor` off.
 *
 * The listing never compares against the HEAD of the session's start. A
 * `git pull`, `rebase` or `checkout` moves HEAD, and the files it brings in
 * are not the session's edits. Committed changes count only when the session
 * made the commit itself: HEAD's reflog says `commit:` for those, and a
 * different verb for pulled, rebased or checked-out commits.
 *
 * A checkout shared with other sessions or the user cannot be observed: git
 * cannot tell who changed a file there.
 *
 * `startEditWatch` at the end of the file ties this together for one session:
 * when to check, what was already sent, and when the watch may end.
 */
import { lstat } from "node:fs/promises";
import { join as joinPath } from "node:path";
import type { ProviderEvent, RunnerToController } from "@hercule/protocol";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { buildSubstrateEnv } from "../workspaces";
import { runGit, type GitEnv } from "../workspaces/git";
import { convertEditedFiles, type SessionCheckout } from "./edited-files";

/** How long the git commands of one listing may take before the listing is given up. */
const GIT_TIMEOUT = Duration.seconds(10);

/**
 * The most files that may differ from HEAD when a session starts. A checkout
 * with more is not observed: the baseline would be too large to keep and to
 * compare on every command.
 */
const MAX_BASELINE_FILES = 10_000;

/** How many files are examined on disk at the same time. */
const FILE_STATE_CONCURRENCY = 32;

/** The reason a session in a workspace that others also use is not observed. */
export const SHARED_WORKSPACE_REASON =
  "the workspace is shared with other sessions or the user, so git cannot tell who changed a file";

/**
 * A string that differs whenever a file's size or modification time does, or
 * "missing" when the file does not exist or cannot be read.
 */
type FileState = string;

/**
 * One checkout of a session: what it looked like when the session started,
 * and how far the checks have come since.
 */
export interface CheckoutBaseline {
  readonly checkout: SessionCheckout;
  /**
   * The files that differed from HEAD when the session started, by path
   * relative to the checkout, each with its state at that moment.
   */
  readonly startingStates: ReadonlyMap<string, FileState>;
  /**
   * How many entries HEAD's reflog had at the last successful check. The
   * reflog grows at the front, so entries added since are the newest ones.
   */
  reflogLength: number;
  /** The files, relative to the checkout, in commits the session made itself. */
  readonly committedFiles: Set<string>;
}

/**
 * Tells whether a session's edits by commands can be observed. `taken` holds
 * one baseline per checkout (none for a session without checkouts).
 * `unavailable` holds the reason in plain words.
 */
export type ChangeBaseline =
  | { readonly _tag: "taken"; readonly checkouts: ReadonlyArray<CheckoutBaseline> }
  | { readonly _tag: "unavailable"; readonly reason: string };

/** Returns the state of a file, without following symbolic links. */
const describeFileState = (path: string): Effect.Effect<FileState> =>
  Effect.promise(() =>
    lstat(path).then(
      (stat) => `${String(stat.size)}:${String(stat.mtimeMs)}`,
      () => "missing",
    ),
  );

/** Returns the first line of git's error output, which names the problem. */
const readFirstLine = (stderr: string): string => stderr.split("\n")[0] ?? "";

/**
 * Runs git in a checkout and returns its output. Fails with a message that
 * names the checkout and git's first line of error output.
 *
 * `core.fsmonitor=false` is on every call: with it on, a checkout's own
 * config could make git run a program of the repository's choosing.
 * `--no-optional-locks` keeps the listing from colliding with the agent's own
 * `git commit`.
 */
const readGit = (
  checkout: SessionCheckout,
  args: ReadonlyArray<string>,
  env: GitEnv,
): Effect.Effect<string, string> =>
  runGit(["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", checkout.path, ...args], {
    env,
    keepWhitespace: true,
  }).pipe(
    Effect.mapError((error) => `git could not run in ${checkout.path}: ${error.message}`),
    Effect.flatMap((outcome) =>
      outcome.ok
        ? Effect.succeed(outcome.stdout)
        : Effect.fail(`git failed in ${checkout.path}: ${readFirstLine(outcome.stderr)}`),
    ),
  );

/** Splits git's NUL-separated output into paths. */
const splitPaths = (output: string): ReadonlyArray<string> =>
  output.split("\0").filter((path) => path !== "");

/**
 * Lists the files of a checkout that differ from the current HEAD: tracked
 * files that changed or were deleted, and untracked files that are not
 * ignored. Paths are relative to the checkout directory. Fails with git's
 * error output.
 *
 * `diff-index` does not refresh the index and never reads file contents. A
 * file that was only touched, with the same contents, can be listed because
 * its modification time no longer matches the index. The baseline's file
 * states filter those out when the touch happened before the session.
 * `--no-renames` lists a rename as a deletion and an addition, so the old path
 * is not lost.
 */
const listDifferingFiles = (
  checkout: SessionCheckout,
  env: GitEnv,
): Effect.Effect<ReadonlyArray<string>, string> =>
  Effect.gen(function* () {
    const tracked = yield* readGit(
      checkout,
      ["diff-index", "--name-only", "-z", "--no-renames", "--relative", "HEAD", "--"],
      env,
    );
    const untracked = yield* readGit(
      checkout,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      env,
    );
    return [...new Set([...splitPaths(tracked), ...splitPaths(untracked)])];
  });

/** Returns the subjects of HEAD's reflog entries, newest first, each with its commit. */
const readReflog = (
  checkout: SessionCheckout,
  env: GitEnv,
): Effect.Effect<ReadonlyArray<{ readonly commit: string; readonly subject: string }>, string> =>
  Effect.map(readGit(checkout, ["reflog", "--format=%H %gs", "HEAD"], env), (output) =>
    output
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const space = line.indexOf(" ");
        return { commit: line.slice(0, space), subject: line.slice(space + 1) };
      }),
  );

/** Tells whether a reflog subject belongs to a commit made in this checkout, as opposed to one pulled, rebased or checked out. */
const isOwnCommit = (subject: string): boolean =>
  subject.startsWith("commit:") ||
  subject.startsWith("commit (amend):") ||
  subject.startsWith("commit (initial):");

/**
 * Returns the files, relative to the checkout, that one commit changed
 * compared with `previous`, the commit HEAD pointed at before it.
 *
 * Comparing with the previous HEAD rather than with the parent matters for an
 * amended commit: its parent is older than the commit it replaced, so the
 * parent would also count the files of work done before the session. Without
 * a previous HEAD, because the commit is the first or the reflog was trimmed,
 * the commit is compared with its parent.
 */
const listCommitFiles = (
  checkout: SessionCheckout,
  commit: string,
  previous: string | undefined,
  env: GitEnv,
): Effect.Effect<ReadonlyArray<string>, string> =>
  Effect.map(
    readGit(
      checkout,
      [
        "diff-tree",
        "--name-only",
        "-r",
        "-z",
        "--no-renames",
        "--relative",
        ...(previous === undefined ? ["--no-commit-id", "--root", commit] : [previous, commit]),
      ],
      env,
    ),
    splitPaths,
  );

/** Fails with a readable reason when `work` takes longer than `GIT_TIMEOUT`. */
const withTimeout = <A>(work: Effect.Effect<A, string>): Effect.Effect<A, string> =>
  work.pipe(
    Effect.timeoutOrElse({
      duration: GIT_TIMEOUT,
      orElse: () => Effect.fail("git took too long"),
    }),
  );

/** Returns the state of each file of a checkout, keyed by its path relative to the checkout. */
const readFileStates = (
  checkout: SessionCheckout,
  files: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, FileState>> =>
  Effect.map(
    Effect.forEach(files, (file) => describeFileState(joinPath(checkout.path, file)), {
      concurrency: FILE_STATE_CONCURRENCY,
    }),
    (states) => new Map(files.map((file, index) => [file, states[index]!])),
  );

/**
 * Takes the baseline of every checkout of a session. Returns `unavailable`
 * with the reason when any checkout is not a git repository, has no commit,
 * has more than `MAX_BASELINE_FILES` changed files, or when git fails or takes
 * too long. Never fails.
 */
export const takeChangeBaseline = (
  checkouts: ReadonlyArray<SessionCheckout>,
  env: GitEnv,
): Effect.Effect<ChangeBaseline> =>
  withTimeout(
    Effect.forEach(checkouts, (checkout) =>
      Effect.gen(function* () {
        const files = yield* listDifferingFiles(checkout, env);
        if (files.length > MAX_BASELINE_FILES) {
          return yield* Effect.fail(
            `${checkout.path} had more than ${String(MAX_BASELINE_FILES)} changed files when the session started, too many to tell the session's edits from them`,
          );
        }
        const reflog = yield* readReflog(checkout, env);
        return {
          checkout,
          startingStates: yield* readFileStates(checkout, files),
          reflogLength: reflog.length,
          committedFiles: new Set<string>(),
        } satisfies CheckoutBaseline;
      }),
    ),
  ).pipe(
    Effect.map((taken): ChangeBaseline => ({ _tag: "taken", checkouts: taken })),
    Effect.catch((reason) => Effect.succeed<ChangeBaseline>({ _tag: "unavailable", reason })),
  );

/**
 * Lists the files of one checkout that the session changed, relative to the
 * checkout. The candidates are the files that differ from HEAD now, the files
 * in the session's own commits, and the files that differed at the start (so a
 * file the session restored or deleted is found). A candidate counts when it
 * was not different at the start, or its state has changed since.
 *
 * Remembers the reflog position and the committed files only when every git
 * command succeeded, so a failed check is repeated in full.
 */
const listCheckoutEdits = (
  baseline: CheckoutBaseline,
  env: GitEnv,
): Effect.Effect<ReadonlyArray<string>, string> =>
  Effect.gen(function* () {
    const { checkout } = baseline;
    const differing = yield* listDifferingFiles(checkout, env);
    const reflog = yield* readReflog(checkout, env);
    // A reflog that got shorter was trimmed by git, so nothing is new.
    const newEntries = reflog.slice(0, Math.max(0, reflog.length - baseline.reflogLength));
    const committedNow = new Set<string>();
    for (const [index, entry] of newEntries.entries()) {
      if (!isOwnCommit(entry.subject)) continue;
      // The reflog is newest first, so the entry after this one is the HEAD
      // this commit replaced.
      const previous = reflog[index + 1]?.commit;
      for (const file of yield* listCommitFiles(checkout, entry.commit, previous, env))
        committedNow.add(file);
    }
    baseline.reflogLength = reflog.length;
    for (const file of committedNow) baseline.committedFiles.add(file);

    const candidates = new Set([
      ...differing,
      ...baseline.committedFiles,
      ...baseline.startingStates.keys(),
    ]);
    const unchanged = new Set<string>();
    const startedDifferent = [...candidates].filter((file) => baseline.startingStates.has(file));
    const nowStates = yield* readFileStates(checkout, startedDifferent);
    for (const [file, state] of nowStates) {
      if (baseline.startingStates.get(file) === state) unchanged.add(file);
    }
    return [...candidates].filter((file) => !unchanged.has(file));
  });

/**
 * Returns the absolute paths of the files the session changed since its
 * baseline, in every checkout. Fails with a reason when git fails or takes too
 * long.
 */
export const listSessionEdits = (
  baselines: ReadonlyArray<CheckoutBaseline>,
  env: GitEnv,
): Effect.Effect<ReadonlyArray<string>, string> =>
  withTimeout(
    Effect.forEach(baselines, (baseline) =>
      Effect.map(listCheckoutEdits(baseline, env), (files) =>
        files.map((file) => joinPath(baseline.checkout.path, file)),
      ),
    ),
  ).pipe(Effect.map((perCheckout) => perCheckout.flat()));

/**
 * Tells whether `event` reports a command that ran to its end. A failed
 * command can still have changed files. A declined one never ran.
 */
export const isFinishedCommand = (event: ProviderEvent): boolean =>
  event._tag === "item.completed" &&
  event.kind === "command_execution" &&
  event.status !== "declined";

/** What a watch needs from the connection it reports on. */
export interface EditWatchConnection {
  /** Closes when the connection ends. A check runs in this scope and is cut off with it. */
  readonly scope: Scope.Scope;
  readonly machine: { readonly baseEnv: Readonly<Record<string, string | undefined>> };
  /** The error type is left to the transport. A failed write means the connection is closing. */
  readonly send: (frame: RunnerToController) => Effect.Effect<void, unknown>;
}

/**
 * The observation of one session's edits made by shell commands. It belongs
 * to the session, and outlives it until the last check it owes has reached a
 * controller.
 */
export interface EditWatch {
  /**
   * Call it after a command ran to its end (see `isFinishedCommand`). Warns
   * once when the session's edits by commands are not observed, and otherwise
   * starts a check without waiting for it, or queues one more while a check
   * runs. Without a connection, the check waits for the next one.
   */
  readonly commandFinished: () => Effect.Effect<void>;
  /**
   * Call it when another live session starts in the session's workspace. Git
   * cannot tell which session changed a file, so the watch stops observing
   * for good. The warning goes out with the next finished command.
   */
  readonly workspaceShared: () => void;
  /**
   * Call it when a connection attaches, with whether its controller reads
   * `filesEdited` frames. Every file is sent again on the new connection,
   * because frames are never replayed, and a command may never come to ask
   * for a check.
   */
  readonly connectionAttached: (
    connection: EditWatchConnection,
    readsFilesEdited: boolean,
  ) => Effect.Effect<void>;
  /**
   * Call it when the session has exited. A check that is running, or that was
   * cut off or asked for while no connection was up, still runs to the end.
   * The watch then ends and calls `onEnded`.
   */
  readonly sessionExited: () => void;
}

/**
 * Starts the watch of a session that works in `checkouts`, measured against
 * `baseline`. `cwd` is the session's working directory, which the paths of
 * edited files are resolved against. A session without checkouts is never
 * observed, and never warned about.
 *
 * - `attachedTo` is the connection that is up when the session starts, if any,
 *   and whether its controller reads `filesEdited`. It starts no check: the
 *   session has run no command yet.
 * - `warn` sends the one warning, with the reason in plain words.
 * - `onEnded` is called once, when the session has exited and nothing is owed.
 *
 * A check lists the files the session changed and sends the ones not yet sent
 * on this connection, in `filesEdited` frames. A listing that fails or times
 * out is dropped, and the next command tries again. At most one check runs at
 * a time. It runs forked in the connection's scope, outside the session's
 * event loop, because git can take a while.
 */
export const startEditWatch = (
  checkouts: ReadonlyArray<SessionCheckout>,
  baseline: ChangeBaseline,
  options: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly attachedTo:
      | { readonly connection: EditWatchConnection; readonly readsFilesEdited: boolean }
      | undefined;
    readonly warn: (message: string) => Effect.Effect<void>;
    readonly onEnded: () => void;
  },
): Effect.Effect<EditWatch> => {
  const { sessionId, cwd, attachedTo, warn, onEnded } = options;
  let measuredAgainst = baseline;
  // The connection the watch reports on, and whether its controller reads
  // `filesEdited`. Undefined once the connection's scope has closed.
  let connection: EditWatchConnection | undefined;
  let readsFilesEdited = false;
  // The paths sent on one connection. On any other connection, none were sent,
  // because a frame lost with its connection is never replayed.
  let reported:
    | { readonly connection: EditWatchConnection; readonly paths: Set<string> }
    | undefined;
  // Where the check is. `queued` means a command finished during the running
  // check, so one more check follows it.
  let check: "idle" | "running" | "queued" = "idle";
  // Whether a check was asked for and has not finished on a connection that is
  // still up. A watch of an exited session ends only when this is false.
  let owed = false;
  let warned = false;
  let exited = false;
  let ended = false;

  /** Ends the watch once the session has exited and nothing is owed. */
  const endIfDone = (): void => {
    if (!exited || owed || ended) return;
    ended = true;
    onEnded();
  };

  /**
   * Checks once for files the session changed and sends the ones not sent
   * before, `MAX_EDITED_FILES` at a time. A file counts as sent only once its
   * frame has been written, so nothing is lost when a listing is longer than
   * one frame holds.
   */
  const sendNewEdits = (on: EditWatchConnection): Effect.Effect<void> =>
    Effect.gen(function* () {
      const before = measuredAgainst;
      if (before._tag !== "taken") return;
      const listed = yield* Effect.result(
        listSessionEdits(before.checkouts, buildSubstrateEnv(on.machine.baseEnv)),
      );
      if (listed._tag === "Failure") {
        return yield* Effect.logDebug(`edit check dropped for ${sessionId}: ${listed.failure}`);
      }
      // The session may have lost its observation while git ran.
      if (measuredAgainst._tag !== "taken") return;
      // On a connection the watch has not reported on, nothing was sent yet.
      if (reported?.connection !== on) reported = { connection: on, paths: new Set() };
      const sent = reported.paths;
      // Distinct, because the conversion counts what it did not check among
      // distinct paths, and the slicing below relies on the same count.
      let remaining = [...new Set(listed.success)].filter((path) => !sent.has(path));
      while (remaining.length > 0) {
        const { files, unchecked } = convertEditedFiles(cwd, checkouts, remaining);
        // The paths the conversion looked at are done, including the ones it
        // dropped as invalid. The rest go into the next frame.
        const examined = remaining.slice(0, remaining.length - unchecked);
        remaining = remaining.slice(remaining.length - unchecked);
        if (files.length > 0) {
          yield* Effect.ignoreCause(
            on.send({ _tag: "filesEdited", sessionId, editedFiles: files }),
          );
        }
        for (const path of examined) sent.add(path);
      }
    });

  /**
   * Runs `sendNewEdits` and repeats it while commands finish meanwhile.
   *
   * Whether to run again or to stop is decided in one synchronous step, so a
   * request that comes in between cannot be lost. A check cut off with its
   * connection leaves `owed` set, so the next connection checks again.
   */
  const runChecks = (on: EditWatchConnection): Effect.Effect<void> =>
    Effect.gen(function* () {
      let again = true;
      while (again) {
        yield* sendNewEdits(on);
        again = yield* Effect.sync(() => {
          if (check === "queued") {
            check = "running";
            return true;
          }
          check = "idle";
          // A connection that ended may have dropped the frames.
          if (connection === on) owed = false;
          endIfDone();
          return false;
        });
      }
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          check = "idle";
        }),
      ),
    );

  /**
   * Asks for a check without delaying the caller. Does nothing for a session
   * without checkouts or whose edits are not observed. Without a connection,
   * the check is owed to the next one. A controller that does not read
   * `filesEdited` is owed nothing.
   */
  const requestCheck = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      const on = connection;
      if (checkouts.length === 0 || measuredAgainst._tag !== "taken") return Effect.void;
      if (on === undefined) {
        owed = true;
        return Effect.void;
      }
      if (!readsFilesEdited) {
        owed = false;
        endIfDone();
        return Effect.void;
      }
      owed = true;
      if (check !== "idle") {
        check = "queued";
        return Effect.void;
      }
      check = "running";
      return Effect.asVoid(Effect.forkIn(runChecks(on), on.scope));
    });

  /**
   * Sends one warning when edits made by shell commands cannot be observed:
   * no baseline could be taken, the workspace is shared, or the controller does
   * not read `filesEdited`. Does nothing without a connection, for a session
   * whose edits are observed, or after the first warning.
   */
  const warnWhenUnobserved = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (connection === undefined || checkouts.length === 0) return Effect.void;
      const reason =
        measuredAgainst._tag === "unavailable"
          ? measuredAgainst.reason
          : readsFilesEdited
            ? undefined
            : "the controller does not read them";
      if (reason === undefined || warned) return Effect.void;
      warned = true;
      return warn(
        `Edits made by shell commands are not observed for this session: ${reason}. Edits made with the edit tools still are.`,
      );
    });

  /**
   * Makes `attached` the connection to report on, until its scope closes.
   * Does not ask for a check.
   */
  const follow = (attached: EditWatchConnection, reads: boolean): Effect.Effect<void> =>
    Effect.suspend(() => {
      connection = attached;
      readsFilesEdited = reads;
      return Scope.addFinalizer(
        attached.scope,
        Effect.sync(() => {
          if (connection === attached) connection = undefined;
        }),
      );
    });

  const watch: EditWatch = {
    commandFinished: () => Effect.andThen(warnWhenUnobserved(), requestCheck()),
    workspaceShared: () => {
      measuredAgainst = { _tag: "unavailable", reason: SHARED_WORKSPACE_REASON };
      // Nothing is observed any more, so nothing is owed.
      owed = false;
      endIfDone();
    },
    connectionAttached: (attached, reads) =>
      Effect.andThen(follow(attached, reads), requestCheck()),
    sessionExited: () => {
      exited = true;
      endIfDone();
    },
  };

  return attachedTo === undefined
    ? Effect.succeed(watch)
    : Effect.as(follow(attachedTo.connection, attachedTo.readsFilesEdited), watch);
};
