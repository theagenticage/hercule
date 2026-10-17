/**
 * Finds the files that changed in a workspace's checkouts between two listings,
 * by asking git (spec 19 section 4.1). A shell command does not name the files
 * it changed, so after a command the runner lists what differs in each
 * checkout and subtracts what already differed at the previous listing.
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
 * HEAD's reflog names those `commit:`, and uses a different verb for pulled,
 * rebased or checked-out commits.
 *
 * A file counts as changed when its ctime or its existence differs from the
 * previous listing. The ctime is the kernel's own stamp of the last write, so
 * it also catches a write that forged the modification time. The listing
 * returns each changed file with its ctime, and the edit watch ties the ctime
 * to the command that was running (`edit-attribution.ts`).
 *
 * Who made a change is not decided here. This file lists what changed; the
 * edit watch decides which session it belongs to.
 */
import { lstat } from "node:fs/promises";
import { closeSync, fstatSync, futimesSync, openSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import * as Duration from "effect/Duration";
import { EditedFile } from "@hercule/protocol";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import type { FileClock } from "../edit-marks";
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
const FILE_CTIME_CONCURRENCY = 32;

/**
 * The ctime of a file in nanoseconds on the kernel's file clock, or `null`
 * when the file does not exist or cannot be read. The ctime changes at every
 * write, whatever the writer does to the modification time, so a file counts
 * as changed when its ctime or its existence differs from the previous listing.
 */
export type FileCtime = bigint | null;

/** A file that changed between two listings, with its ctime at the later one. */
export interface ChangedFile {
  readonly file: EditedFile;
  /** `null` when the file is gone: a deletion has no ctime. */
  readonly ctimeNs: FileCtime;
}

/** What one checkout looked like at a listing, which the next listing is compared with. */
export interface CheckoutState {
  readonly checkout: SessionCheckout;
  /**
   * The files that differed from HEAD at the listing, by path relative to the
   * checkout, each with its ctime at that moment.
   */
  readonly fileCtimes: ReadonlyMap<string, FileCtime>;
  /**
   * How many entries HEAD's reflog had at the listing. The reflog grows at the
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
  | {
      readonly _tag: "taken";
      readonly checkouts: ReadonlyArray<CheckoutState>;
      /** The file clock when the state was taken. No change the state holds is later than this. */
      readonly takenAtNs: bigint;
    }
  | { readonly _tag: "unavailable"; readonly reason: string };

/** Returns the ctime of a file, without following symbolic links. */
const readFileCtime = (path: string): Effect.Effect<FileCtime> =>
  Effect.promise(() =>
    lstat(path, { bigint: true }).then(
      (stat) => stat.ctimeNs,
      () => null,
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
 * with the previous listing filters those out when the touch happened earlier.
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
 * parent would also count the files of work done before the previous listing.
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

/** Returns the ctime of each file of a checkout, keyed by its path relative to the checkout. */
const readFileCtimes = (
  checkout: SessionCheckout,
  files: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, FileCtime>> =>
  Effect.map(
    Effect.forEach(files, (file) => readFileCtime(joinPath(checkout.path, file)), {
      concurrency: FILE_CTIME_CONCURRENCY,
    }),
    (ctimes) => new Map(files.map((file, index) => [file, ctimes[index]!])),
  );

/** How many times the probe stamps its file between two marks. */
const PROBE_ROUNDS = 3;

/** One stamp of the probe file: the runner's mark before it, the file's ctime, and the mark after it. */
export interface ClockProbe {
  readonly beforeNs: bigint;
  readonly ctimeNs: bigint;
  readonly afterNs: bigint;
}

/**
 * Checks whether a checkout's ctimes can show which command wrote a file, from
 * probe stamps taken between marks of the runner's clock. Returns the problem
 * in plain words, or `undefined` when there is none. Two checks:
 *
 * - Every ctime falls between the marks around it. A network mount stamped by
 *   its server fails this, and so does a clock coarser than the runner's.
 * - Not every ctime is a whole second. HFS+ and FAT keep whole seconds, which
 *   pass the first check when the runner's clock is on the same filesystem.
 *   Each stamp is on a new tick, so a millisecond clock such as ext4's cannot
 *   land on whole seconds every time.
 */
export const findFileClockProblem = (probes: ReadonlyArray<ClockProbe>): string | undefined => {
  if (probes.some(({ beforeNs, ctimeNs, afterNs }) => ctimeNs < beforeNs || ctimeNs > afterNs)) {
    return "its file times do not follow the clock the runner marks commands with, as on a network mount";
  }
  if (probes.every(({ ctimeNs }) => ctimeNs % 1_000_000_000n === 0n)) {
    return "its filesystem keeps file times in whole seconds, as HFS+ and FAT do";
  }
  return undefined;
};

/**
 * Checks that the filesystem of a checkout stamps ctimes on the runner's file
 * clock, finely enough (`findFileClockProblem`). It stamps a temporary file in
 * the checkout's root, where the files that commands change live, and
 * deletes it. Runs before any watch lists the checkout, so no listing sees
 * the file. Fails with the reason in plain words.
 */
const probeFileClock = (checkout: SessionCheckout, clock: FileClock): Effect.Effect<void, string> =>
  Effect.try({
    try: () => {
      const path = joinPath(checkout.path, `.clock-probe-${crypto.randomUUID()}`);
      const fd = openSync(path, "wx", 0o600);
      try {
        const probes: Array<ClockProbe> = [];
        let afterNs = clock.takeMark();
        for (let round = 0; round < PROBE_ROUNDS; round += 1) {
          // Each round waits for a new tick of the runner's clock.
          let beforeNs = clock.takeMark();
          while (beforeNs === afterNs) beforeNs = clock.takeMark();
          futimesSync(fd, 0, 0);
          const { ctimeNs } = fstatSync(fd, { bigint: true });
          afterNs = clock.takeMark();
          probes.push({ beforeNs, ctimeNs, afterNs });
        }
        return findFileClockProblem(probes);
      } finally {
        closeSync(fd);
        rmSync(path, { force: true });
      }
    },
    catch: (error) =>
      `could not write a file in it: ${error instanceof Error ? error.message : String(error)}`,
  }).pipe(
    Effect.flatMap((problem) => (problem === undefined ? Effect.void : Effect.fail(problem))),
    Effect.mapError((problem) => `${checkout.path} cannot be observed: ${problem}`),
  );

/**
 * Takes the state of every checkout of a workspace. Returns `unavailable`
 * with the reason when any checkout is not a git repository, has no commit,
 * has more than `MAX_INITIAL_FILES` changed files, is on a filesystem whose
 * ctimes do not follow the clock (`probeFileClock`), or when git fails or
 * takes too long. Never fails.
 */
export const takeInitialState = (
  checkouts: ReadonlyArray<SessionCheckout>,
  env: GitEnv,
  clock: FileClock,
): Effect.Effect<InitialState> =>
  failAfterGitTimeout(
    Effect.gen(function* () {
      // Taken before git runs, so every change the state holds is older.
      const takenAtNs = clock.takeMark();
      const taken = yield* Effect.forEach(checkouts, (checkout) =>
        Effect.gen(function* () {
          yield* probeFileClock(checkout, clock);
          const files = yield* listDifferingFiles(checkout, env);
          if (files.length > MAX_INITIAL_FILES) {
            return yield* Effect.fail(
              `${checkout.path} had more than ${String(MAX_INITIAL_FILES)} changed files when observation started, too many to tell later edits from them`,
            );
          }
          const reflog = yield* readReflog(checkout, env);
          return {
            checkout,
            fileCtimes: yield* readFileCtimes(checkout, files),
            reflogLength: reflog.length,
          } satisfies CheckoutState;
        }),
      );
      return { _tag: "taken", checkouts: taken, takenAtNs } satisfies InitialState;
    }),
  ).pipe(Effect.catch((reason) => Effect.succeed<InitialState>({ _tag: "unavailable", reason })));

/**
 * Lists the files of one checkout that changed since `previous`, relative to
 * the checkout, each with its ctime now, and returns the checkout's new state.
 * The candidates are the files that differ from HEAD now, the files in
 * commits made since, and the files that differed at `previous` (so a file
 * that was restored or deleted is found). A candidate counts when it did not
 * differ at `previous`, or its ctime or existence has changed since.
 *
 * A commit changes the index and leaves the working tree as it is, so a file
 * in a new commit keeps the ctime of the write that made it. That ctime is
 * what ties the file to a command. A file that a commit carries without
 * change, because it was changed long ago, keeps its old ctime and matches no
 * command. A file in a commit that no longer exists is a deletion.
 *
 * The state is only returned when every git command succeeded, so a failed
 * listing is repeated in full.
 */
const listCheckoutChanges = (
  previous: CheckoutState,
  env: GitEnv,
): Effect.Effect<
  {
    readonly files: ReadonlyArray<{ readonly path: string; readonly ctimeNs: FileCtime }>;
    readonly state: CheckoutState;
  },
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

    const candidates = [...new Set([...differing, ...previous.fileCtimes.keys(), ...committed])];
    const nowCtimes = yield* readFileCtimes(checkout, candidates);
    const changed: Array<{ path: string; ctimeNs: FileCtime }> = [];
    for (const [path, ctimeNs] of nowCtimes) {
      const before = previous.fileCtimes.get(path);
      if (before === undefined || ctimeNs !== before) changed.push({ path, ctimeNs });
    }
    return {
      files: changed,
      state: {
        checkout,
        fileCtimes: new Map(differing.map((file) => [file, nowCtimes.get(file)!])),
        reflogLength: reflog.length,
      },
    };
  });

/**
 * Returns the files that changed in any checkout since `previous`, each with
 * its ctime, and the new state of every checkout. A file is named by its checkout's resource id and
 * its path inside the checkout, as the controller records it, so a changed
 * symbolic link is reported as itself and never as its target. A path that is
 * not a valid `EditedFile` path is dropped. Fails with a reason when git fails
 * or takes too long, and then the previous state stays the one to compare with.
 */
export const listChangesSince = (
  previous: ReadonlyArray<CheckoutState>,
  env: GitEnv,
): Effect.Effect<
  {
    readonly files: ReadonlyArray<ChangedFile>;
    readonly states: ReadonlyArray<CheckoutState>;
  },
  string
> =>
  failAfterGitTimeout(Effect.forEach(previous, (state) => listCheckoutChanges(state, env))).pipe(
    Effect.flatMap((listed) =>
      Effect.gen(function* () {
        const files: Array<ChangedFile> = [];
        for (const { files: changed, state } of listed) {
          for (const { path, ctimeNs } of changed) {
            const file = { resourceId: state.checkout.resourceId, path };
            if (isEditedFile(file)) files.push({ file, ctimeNs });
            else
              yield* Effect.logDebug(
                `edit listing dropped a path that is not a valid edited file: ${path}`,
              );
          }
        }
        return { files, states: listed.map(({ state }) => state) };
      }),
    ),
  );
