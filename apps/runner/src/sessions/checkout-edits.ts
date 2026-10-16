/**
 * Finds the files that changed in a workspace's checkouts between two checks,
 * by asking git (spec 19 section 4.1). A shell command does not name the files
 * it changed, so after a command the runner lists what differs in each
 * checkout and subtracts what already differed at the previous check.
 *
 * No command that git runs for us may execute anything the repository
 * configures. Git commands that read file contents run clean filters, and
 * `core.fsmonitor` runs a program, both from the repository's own config. A
 * hostile checkout could use either to run commands outside the session's
 * sandbox. So the listing uses only commands that never read file contents
 * (`diff-index`, `ls-files`, `reflog`, `diff-tree`), and every call turns
 * `core.fsmonitor` off.
 *
 * The listing never compares against an old HEAD. A `git pull`, `rebase` or
 * `checkout` moves HEAD, and the files it brings in are not anyone's edits.
 * Committed changes count only when the checkout's own user made the commit:
 * HEAD's reflog says `commit:` for those, and a different verb for pulled,
 * rebased or checked-out commits.
 *
 * Who made a change is not decided here. This file lists what changed; the
 * edit watch decides which session it belongs to.
 */
import { lstat } from "node:fs/promises";
import { join as joinPath } from "node:path";
import * as Duration from "effect/Duration";
import { EditedFile } from "@hercule/protocol";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import { runGit, type GitEnv } from "../workspaces/git";
import type { SessionCheckout } from "./edited-files";

const isEditedFile = Schema.is(EditedFile);

/** How long the git commands of one listing may take before the listing is given up. */
const GIT_TIMEOUT = Duration.seconds(10);

/**
 * The most files that may differ from HEAD when observation of a checkout
 * starts. A checkout with more is not observed: its state would be too large
 * to keep and to compare after every command.
 */
const MAX_INITIAL_FILES = 10_000;

/** How many files are examined on disk at the same time. */
const FILE_STATE_CONCURRENCY = 32;

/**
 * A string that differs whenever a file's size or modification time does, or
 * "missing" when the file does not exist or cannot be read.
 */
type FileState = string;

/** What one checkout looked like at a check, which the next check is compared with. */
export interface CheckoutState {
  readonly checkout: SessionCheckout;
  /**
   * The files that differed from HEAD at the check, by path relative to the
   * checkout, each with its file state at that moment.
   */
  readonly fileStates: ReadonlyMap<string, FileState>;
  /**
   * How many entries HEAD's reflog had at the check. The reflog grows at the
   * front, so entries added since are the newest ones.
   */
  readonly reflogLength: number;
}

/**
 * The state of a workspace's checkouts when its observation starts. `taken`
 * holds one state per checkout (none for a workspace without checkouts).
 * `unavailable` holds the reason in plain words.
 */
export type InitialState =
  | { readonly _tag: "taken"; readonly checkouts: ReadonlyArray<CheckoutState> }
  | { readonly _tag: "unavailable"; readonly reason: string };

/** Returns the state of a file, without following symbolic links. */
const readFileState = (path: string): Effect.Effect<FileState> =>
  Effect.promise(() =>
    lstat(path).then(
      (stat) => `${String(stat.size)}:${String(stat.mtimeMs)}`,
      () => "missing",
    ),
  );

/** Returns the first line of git's error output, which names the problem. */
const extractFirstLine = (stderr: string): string => stderr.split("\n")[0] ?? "";

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
        : Effect.fail(`git failed in ${checkout.path}: ${extractFirstLine(outcome.stderr)}`),
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
 * its modification time no longer matches the index. Comparing file states
 * with the previous check filters those out when the touch happened earlier.
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

/**
 * Tells whether a reflog subject belongs to a commit made in this checkout, as
 * opposed to one pulled, rebased or checked out.
 */
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
 * parent would also count the files of work done before the previous check.
 * Without a previous HEAD, because the commit is the first or the reflog was
 * trimmed, the commit is compared with its parent.
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
const failAfterGitTimeout = <A>(work: Effect.Effect<A, string>): Effect.Effect<A, string> =>
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
    Effect.forEach(files, (file) => readFileState(joinPath(checkout.path, file)), {
      concurrency: FILE_STATE_CONCURRENCY,
    }),
    (states) => new Map(files.map((file, index) => [file, states[index]!])),
  );

/**
 * Takes the state of every checkout of a workspace. Returns `unavailable`
 * with the reason when any checkout is not a git repository, has no commit,
 * has more than `MAX_INITIAL_FILES` changed files, or when git fails or takes
 * too long. Never fails.
 */
export const takeInitialState = (
  checkouts: ReadonlyArray<SessionCheckout>,
  env: GitEnv,
): Effect.Effect<InitialState> =>
  failAfterGitTimeout(
    Effect.forEach(checkouts, (checkout) =>
      Effect.gen(function* () {
        const files = yield* listDifferingFiles(checkout, env);
        if (files.length > MAX_INITIAL_FILES) {
          return yield* Effect.fail(
            `${checkout.path} had more than ${String(MAX_INITIAL_FILES)} changed files when observation started, too many to tell later edits from them`,
          );
        }
        const reflog = yield* readReflog(checkout, env);
        return {
          checkout,
          fileStates: yield* readFileStates(checkout, files),
          reflogLength: reflog.length,
        } satisfies CheckoutState;
      }),
    ),
  ).pipe(
    Effect.map((taken): InitialState => ({ _tag: "taken", checkouts: taken })),
    Effect.catch((reason) => Effect.succeed<InitialState>({ _tag: "unavailable", reason })),
  );

/**
 * Lists the files of one checkout that changed since `previous`, relative to
 * the checkout, and returns the checkout's new state. The candidates are the
 * files that differ from HEAD now, the files in commits made since, and the
 * files that differed at `previous` (so a file that was restored or deleted
 * is found). A candidate counts when it did not differ at `previous`, or its
 * file state has changed since. A file in a new commit that already differed
 * at `previous` and has not changed since is not listed again.
 *
 * The state is only returned when every git command succeeded, so a failed
 * check is repeated in full.
 */
const listCheckoutChanges = (
  previous: CheckoutState,
  env: GitEnv,
): Effect.Effect<
  { readonly files: ReadonlyArray<string>; readonly state: CheckoutState },
  string
> =>
  Effect.gen(function* () {
    const { checkout } = previous;
    const differing = yield* listDifferingFiles(checkout, env);
    const reflog = yield* readReflog(checkout, env);
    // A reflog that got shorter was trimmed by git, so nothing is new.
    const newEntries = reflog.slice(0, Math.max(0, reflog.length - previous.reflogLength));
    const committed = new Set<string>();
    for (const [index, entry] of newEntries.entries()) {
      if (!isOwnCommit(entry.subject)) continue;
      // The reflog is newest first, so the entry after this one is the HEAD
      // this commit replaced.
      const replaced = reflog[index + 1]?.commit;
      for (const file of yield* listCommitFiles(checkout, entry.commit, replaced, env))
        committed.add(file);
    }

    const nowStates = yield* readFileStates(checkout, [
      ...new Set([...differing, ...previous.fileStates.keys()]),
    ]);
    const changed = new Set<string>();
    for (const file of new Set([...nowStates.keys(), ...committed])) {
      const before = previous.fileStates.get(file);
      if (before === undefined || nowStates.get(file) !== before) changed.add(file);
    }
    return {
      files: [...changed],
      state: {
        checkout,
        fileStates: new Map(differing.map((file) => [file, nowStates.get(file)!])),
        reflogLength: reflog.length,
      },
    };
  });

/**
 * Returns the files that changed in any checkout since `previous`, and the new
 * state of every checkout. A file is named by its checkout's resource id and
 * its path inside the checkout, as the controller records it, so a changed
 * symbolic link is reported as itself and never as its target. A path that is
 * not a valid `EditedFile` path is dropped. Fails with a reason when git fails
 * or takes too long, and then the previous state stays the one to compare with.
 */
export const listChangesSince = (
  previous: ReadonlyArray<CheckoutState>,
  env: GitEnv,
): Effect.Effect<
  { readonly files: ReadonlyArray<EditedFile>; readonly states: ReadonlyArray<CheckoutState> },
  string
> =>
  failAfterGitTimeout(Effect.forEach(previous, (state) => listCheckoutChanges(state, env))).pipe(
    Effect.map((listed) => ({
      files: listed.flatMap(({ files, state }) =>
        files
          .map((path) => ({ resourceId: state.checkout.resourceId, path }))
          .filter((file) => isEditedFile(file)),
      ),
      states: listed.map(({ state }) => state),
    })),
  );
