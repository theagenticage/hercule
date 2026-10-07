/**
 * Creates managed working copies in the selected Git repository and records
 * their preparation outcomes before reporting them. Existing checkout
 * registration is handled separately without running setup.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import {
  dirname,
  join as joinPath,
  relative as relativePath,
  resolve as resolvePath,
  sep,
} from "node:path";
import {
  MAX_MESSAGE_LENGTH,
  type WorkspaceProvision,
  type WorkspaceReport,
} from "@hercule/protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { RUNNER_SOCKET_VARIABLE, RUNNER_WORKSPACE_VARIABLE } from "../credentials";
import { runGit, type GitEnv } from "./git";
import { hasExpectedCheckoutIdentity } from "./identity";
import { observeWorkspace } from "./inspection";
export { observeWorkspace } from "./inspection";
import { ensureSelectedRepository, resolveStartingRevision } from "./repositories";
import { buildTailMessage, drainTail } from "./output";
import { isStillOnDisk, type RegisteredCheckout, type RegisteredWorkspace } from "./registry";
import type { Substrate } from "./substrate";

const buildFailedReport = (workspaceId: string, message: string): WorkspaceReport => ({
  _tag: "workspaceReport",
  workspaceId,
  status: "failed",
  message: message.slice(0, MAX_MESSAGE_LENGTH),
});

const normalizeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const registerWorkspace = (
  substrate: Substrate,
  entry: RegisteredWorkspace,
): Effect.Effect<void, Error> =>
  substrate.registry.update((entries) => [
    ...entries.filter((held) => held.workspaceId !== entry.workspaceId),
    entry,
  ]);

/**
 * Copies listed untracked files from the primary's `.workspaceinclude` into
 * `dir`. Returns warnings for tracked files or Git metadata that were skipped.
 * Fails when Git cannot inspect tracked files. Does nothing if the primary has
 * no `.workspaceinclude`.
 *
 * - The file has one relative path per line, and lines starting with `#` are
 *   comments.
 * - A path that points outside the primary is skipped.
 * - Symlinks are followed and their targets copied, because a link into the
 *   primary would let an agent edit the primary's files.
 */
const copyIncludedFiles = (
  primaryRoot: string,
  dir: string,
  env: GitEnv,
): Effect.Effect<ReadonlyArray<string>, Error> =>
  Effect.gen(function* () {
    let listed: string;
    try {
      listed = readFileSync(joinPath(primaryRoot, ".workspaceinclude"), "utf8");
    } catch {
      return [];
    }
    const readGitPaths = (directory: string, args: ReadonlyArray<string>) =>
      Effect.acquireUseRelease(
        Effect.try({
          try: () =>
            Bun.spawn(["git", "-C", directory, ...args], {
              env: { ...env },
              detached: true,
              stdout: "pipe",
              stderr: "pipe",
            }),
          catch: normalizeError,
        }),
        (child) =>
          Effect.gen(function* () {
            const [stdout, stderr, code] = yield* Effect.all(
              [
                Effect.tryPromise({
                  try: () => new Response(child.stdout).text(),
                  catch: normalizeError,
                }),
                Effect.tryPromise({
                  try: () => new Response(child.stderr).text(),
                  catch: normalizeError,
                }),
                Effect.tryPromise({ try: () => child.exited, catch: normalizeError }),
              ],
              { concurrency: "unbounded" },
            );
            if (code !== 0)
              return yield* Effect.fail(
                new Error(
                  `Git could not inspect tracked files for .workspaceinclude: ${stderr.trim()}`,
                ),
              );
            return stdout.split("\0").filter((path) => path !== "");
          }),
        (child) => stopGroup(child),
      );
    // Index changes and a different starting revision must not turn tracked source files into copy candidates.
    const tracked = new Set(
      (yield* Effect.all(
        [
          readGitPaths(primaryRoot, ["ls-files", "-z"]),
          readGitPaths(primaryRoot, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]),
          readGitPaths(dir, ["ls-files", "-z"]),
        ],
        { concurrency: "unbounded" },
      )).flat(),
    );
    let skippedTrackedFiles = false;
    const sourceRoot = yield* Effect.try({
      try: () => realpathSync(primaryRoot),
      catch: normalizeError,
    });
    for (const line of listed.split("\n")) {
      const relative = line.trim();
      if (relative.length === 0 || relative.startsWith("#")) continue;
      const from = resolvePath(primaryRoot, relative);
      if (!from.startsWith(primaryRoot + sep)) continue;
      try {
        cpSync(from, joinPath(dir, relative), {
          recursive: true,
          dereference: true,
          filter: (path) => {
            const name = relativePath(primaryRoot, path).split(sep).join("/");
            const target = relativePath(sourceRoot, realpathSync(path)).split(sep).join("/");
            if (
              name === ".git" ||
              name.startsWith(".git/") ||
              tracked.has(name) ||
              target === ".git" ||
              target.startsWith(".git/") ||
              tracked.has(target)
            ) {
              skippedTrackedFiles = true;
              return false;
            }
            return true;
          },
        });
      } catch {
        // A path the user listed and then removed is not worth failing a workspace over.
      }
    }
    return skippedTrackedFiles
      ? [
          ".workspaceinclude skipped tracked files or Git metadata. The new workspace keeps its committed files; only listed untracked files are copied.",
        ]
      : [];
  });

/**
 * Stops the captured process group and waits for its child to exit. A setup
 * command that starts a watcher or a server can leave child processes behind, and
 * killing only the shell would leave them running in the workspace. The child
 * was started as the leader of its own process group, which is what makes
 * signalling the negative pid safe.
 */
const stopGroup = (child: Bun.Subprocess): Effect.Effect<void> =>
  Effect.gen(function* () {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    yield* Effect.promise(() => child.exited);
  });

/**
 * Runs a repository's setup command in `dir`. Returns undefined if it
 * succeeds. Otherwise returns a message that says why it failed, followed by
 * the last lines of its output. A command still running at the deadline is
 * killed, because a session is waiting for provisioning to finish.
 */
const runSetup = (
  command: string,
  dir: string,
  substrate: Substrate,
): Effect.Effect<string | undefined, Error> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        Bun.spawn(["/bin/sh", "-c", command], {
          cwd: dir,
          // Setup is repository code and cannot use the runner's credential socket.
          env: Object.fromEntries(
            Object.entries(substrate.gitEnv).filter(([name]) => name !== RUNNER_SOCKET_VARIABLE),
          ),
          detached: true,
          stdout: "pipe",
          stderr: "pipe",
        }),
      catch: normalizeError,
    }),
    (child) =>
      Effect.gen(function* () {
        const held = { text: "" };
        // A descendant may hold the pipes open after the shell exits. The deadline
        // covers both output drains and the child's exit, as well as the command.
        const completed = yield* Effect.timeoutOption(
          // Both pipes share the tail so output stays in arrival order.
          Effect.all(
            [
              Effect.tryPromise({
                try: () => drainTail(child.stdout, held),
                catch: normalizeError,
              }).pipe(Effect.catch(() => Effect.void)),
              Effect.tryPromise({
                try: () => drainTail(child.stderr, held),
                catch: normalizeError,
              }).pipe(Effect.catch(() => Effect.void)),
              Effect.tryPromise({ try: () => child.exited, catch: normalizeError }),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.map(([, , code]) => code)),
          substrate.setupDeadlineMs,
        );
        if (Option.isSome(completed) && completed.value === 0) return undefined;
        const why = Option.isNone(completed)
          ? `the setup command was still running after ${String(Math.round(substrate.setupDeadlineMs / 1000))}s and was stopped:`
          : `the setup command failed with exit code ${String(completed.value)}:`;
        return buildTailMessage(why, held.text);
      }),
    (child) => stopGroup(child),
  );

/** Removes only clean working copies created by the current attempt, preserving any refusal. */
const rollBackWorkingCopies = (
  substrate: Substrate,
  root: string,
  made: ReadonlyArray<RegisteredCheckout>,
  env: GitEnv,
): Effect.Effect<boolean, Error> =>
  Effect.gen(function* () {
    let removed = true;
    for (const checkout of made) {
      const directory = checkout.commonDirectory!;
      const result = yield* substrate.coordinateRepository(
        `git:${directory}`,
        runGit(["-C", directory, "worktree", "remove", "--", checkout.path], { env }),
      );
      if (!result.ok && existsSync(checkout.path)) removed = false;
    }
    if (existsSync(root)) {
      try {
        rmdirSync(root);
      } catch {
        removed = false;
      }
    }
    return removed;
  });

/** Creates all generated checkouts from stable commits before running any setup command. */
const makeWorkingCopies = (
  substrate: Substrate,
  frame: WorkspaceProvision,
  original: RegisteredWorkspace,
  env: GitEnv,
): Effect.Effect<WorkspaceReport, Error> =>
  Effect.gen(function* () {
    let entry = original;
    const warnings: Array<string> = [];
    const made: Array<RegisteredCheckout> = [];
    yield* Effect.gen(function* () {
      for (const [at, requested] of frame.checkouts.entries()) {
        const branch =
          frame.kind === "primary" ? `hercule/main-${frame.workspaceId}` : requested.branch;
        if (branch === null)
          return yield* Effect.fail(
            new Error(`No branch was given for the new worktree of ${requested.remote}.`),
          );
        const repository = yield* ensureSelectedRepository(substrate, requested, env);
        yield* substrate.coordinateRepository(
          `git:${repository.commonDirectory}`,
          Effect.gen(function* () {
            const resolved = yield* resolveStartingRevision(repository, requested, env);
            if (resolved.warning !== undefined) warnings.push(resolved.warning);
            const checkout: RegisteredCheckout = {
              ...entry.checkouts[at]!,
              sourceRoot: repository.sourceRoot,
              canonicalRoot: joinPath(
                yield* Effect.try({
                  try: () => realpathSync(substrate.storageDir),
                  catch: normalizeError,
                }),
                relativePath(substrate.storageDir, entry.checkouts[at]!.path),
              ),
              commonDirectory: repository.commonDirectory,
              commonDirectoryIdentity: repository.commonDirectoryIdentity,
              remoteName: repository.remoteName,
              form: "worktree",
              startingRevision: resolved.startingRevision,
              baseCommit: resolved.baseCommit,
            };
            entry = {
              ...entry,
              checkouts: entry.checkouts.map((held, index) => (index === at ? checkout : held)),
            };
            yield* registerWorkspace(substrate, entry);
            yield* Effect.try({
              try: () => mkdirSync(dirname(checkout.path), { recursive: true, mode: 0o700 }),
              catch: normalizeError,
            });
            const added = yield* runGit(
              [
                "-C",
                repository.commonDirectory,
                "worktree",
                "add",
                "-b",
                branch,
                checkout.path,
                resolved.baseCommit,
              ],
              { env },
            );
            if (!added.ok)
              return yield* Effect.fail(
                new Error(
                  /a branch named .* already exists/.test(added.stderr)
                    ? `${added.stderr} Choose a different branch name for the fresh workspace. The existing branch and its commits are preserved.`
                    : added.stderr,
                ),
              );
            made.push(checkout);
          }),
        );
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const removed = yield* rollBackWorkingCopies(substrate, entry.root, made, env);
          if (!removed)
            return yield* Effect.fail(
              new Error(
                `${error.message} Some created files were retained because clean removal was refused. Inspect the failed workspace before discarding it.`,
                { cause: error },
              ),
            );
          return yield* Effect.fail(error);
        }),
      ),
    );
    if (frame.checkouts.length === 0)
      yield* Effect.try({
        try: () => mkdirSync(entry.root, { recursive: true, mode: 0o700 }),
        catch: normalizeError,
      });
    entry = { ...entry, preparation: { phase: "preparing", instruction: frame } };
    yield* registerWorkspace(substrate, entry);
    for (const [at, requested] of frame.checkouts.entries()) {
      const directory = entry.checkouts[at]!.path;
      if (requested.workspaceInclude && frame.kind !== "primary") {
        const primary = yield* substrate.registry.primaryOf(requested.resourceId);
        if (primary === undefined)
          warnings.push(
            `.workspaceinclude skipped: no main workspace is available on this runner for resource ${requested.resourceId}; the copy source is missing.`,
          );
        else warnings.push(...(yield* copyIncludedFiles(primary.root, directory, env)));
      }
      if (requested.setupCommand !== null) {
        const wrong = yield* runSetup(requested.setupCommand, directory, substrate);
        if (wrong !== undefined)
          return {
            ...buildFailedReport(frame.workspaceId, wrong),
            ...(warnings.length === 0 ? {} : { warnings }),
          };
      }
    }
    // Inspection retains preparation failure states. Creation itself supplies the
    // successful result only after all setup commands have completed.
    const report = yield* observeWorkspace(
      {
        workspaceId: entry.workspaceId,
        kind: entry.kind,
        root: entry.root,
        checkouts: entry.checkouts,
        ownership: "managed",
      },
      env,
    );
    return { ...report, ...(warnings.length === 0 ? {} : { warnings }) };
  });

/**
 * Returns the recorded preparation outcome without repeating setup. A legacy
 * entry is observed without changing its files. An unfinished preparation is
 * recorded as interrupted; a missing ready directory is reported unavailable.
 */
export const reprovision = (
  substrate: Substrate,
  entry: RegisteredWorkspace,
): Effect.Effect<WorkspaceReport, Error> =>
  Effect.gen(function* () {
    const preparation = entry.preparation;
    if (preparation !== undefined) {
      if (preparation.phase !== "terminal") {
        const report = buildFailedReport(
          entry.workspaceId,
          "Workspace preparation was interrupted. Create a fresh workspace to prepare it again.",
        );
        yield* registerWorkspace(substrate, {
          ...entry,
          preparation: { phase: "terminal", instruction: preparation.instruction, report },
        });
        return report;
      }
      if (preparation.report.status === "failed") return preparation.report;
      if (isStillOnDisk(entry) && hasExpectedCheckoutIdentity(entry, substrate.gitEnv))
        return preparation.report;
    } else if (isStillOnDisk(entry) && hasExpectedCheckoutIdentity(entry, substrate.gitEnv)) {
      return yield* observeWorkspace(entry, substrate.gitEnv);
    }
    return buildFailedReport(
      entry.workspaceId,
      `The workspace directory is gone or its recorded Git repository is unavailable: ${entry.root}. Restore the original files before continuing.`,
    );
  });

/**
 * Records a creation instruction before filesystem work and its terminal
 * result before reporting it. Fails without removing files from older attempts.
 */
export const provisionWorkspace = (
  substrate: Substrate,
  frame: WorkspaceProvision,
): Effect.Effect<WorkspaceReport, Error> =>
  Effect.gen(function* () {
    if (frame.kind === "primary" && frame.checkouts.length !== 1) {
      return buildFailedReport(frame.workspaceId, "a main workspace needs exactly one checkout");
    }
    const root =
      frame.kind === "primary"
        ? joinPath(substrate.storageDir, "primaries", frame.workspaceId)
        : joinPath(substrate.storageDir, "workspaces", frame.workspaceId);
    const entry: RegisteredWorkspace = {
      workspaceId: frame.workspaceId,
      kind: frame.kind,
      root,
      checkouts: frame.checkouts.map((checkout) => ({
        checkoutId: checkout.checkoutId,
        resourceId: checkout.resourceId,
        remote: checkout.remote,
        path: checkout.subdirectory === null ? root : joinPath(root, checkout.subdirectory),
      })),
      preparation: { phase: "creating", instruction: frame },
      ownership: "managed",
    };
    yield* registerWorkspace(substrate, entry);
    const env = { ...substrate.gitEnv, [RUNNER_WORKSPACE_VARIABLE]: frame.workspaceId };
    const report = yield* (
      existsSync(root)
        ? Effect.succeed(
            buildFailedReport(
              frame.workspaceId,
              "The workspace directory already exists without a completed preparation record. Preserve its files and create a fresh workspace.",
            ),
          )
        : makeWorkingCopies(substrate, frame, entry, env)
    ).pipe(
      Effect.catch((error) => Effect.succeed(buildFailedReport(frame.workspaceId, error.message))),
    );
    yield* registerWorkspace(substrate, {
      ...((yield* substrate.registry.held(frame.workspaceId)) ?? entry),
      preparation: { phase: "terminal", instruction: frame, report },
    });
    return report;
  });
