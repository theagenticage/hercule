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

const registerWorkspace = (substrate: Substrate, entry: RegisteredWorkspace): Promise<void> =>
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
const copyIncludedFiles = async (
  primaryRoot: string,
  dir: string,
  env: GitEnv,
): Promise<ReadonlyArray<string>> => {
  let listed: string;
  try {
    listed = readFileSync(joinPath(primaryRoot, ".workspaceinclude"), "utf8");
  } catch {
    return [];
  }
  const readGitPaths = async (directory: string, args: ReadonlyArray<string>) => {
    const child = Bun.spawn(["git", "-C", directory, ...args], {
      env: { ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if ((await child.exited) !== 0)
      throw new Error(
        `Git could not inspect tracked files for .workspaceinclude: ${stderr.trim()}`,
      );
    return stdout.split("\0").filter((path) => path !== "");
  };
  // Index changes and a different starting revision must not turn tracked source files into copy candidates.
  const tracked = new Set(
    (
      await Promise.all([
        readGitPaths(primaryRoot, ["ls-files", "-z"]),
        readGitPaths(primaryRoot, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]),
        readGitPaths(dir, ["ls-files", "-z"]),
      ])
    ).flat(),
  );
  let skippedTrackedFiles = false;
  const sourceRoot = realpathSync(primaryRoot);
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
};

/**
 * Kills the setup command's whole process group, not just the shell. A setup
 * command that starts a watcher or a server leaves child processes behind, and
 * killing only the shell would leave them running in the workspace. The child
 * was started as the leader of its own process group, which is what makes
 * signalling the negative pid safe.
 */
const stopGroup = (child: Bun.Subprocess): void => {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};

/**
 * Runs a repository's setup command in `dir`. Returns undefined if it
 * succeeds. Otherwise returns a message that says why it failed, followed by
 * the last lines of its output. A command still running at the deadline is
 * killed, because a session is waiting for provisioning to finish.
 */
const runSetup = async (
  command: string,
  dir: string,
  substrate: Substrate,
): Promise<string | undefined> => {
  const child = Bun.spawn(["/bin/sh", "-c", command], {
    cwd: dir,
    // The scrubbed environment, without the credential socket and without the
    // workspace id that provisioning adds for git. A setup command is
    // repository code, and it must not get a credential through git. With no
    // socket in its environment, the credential helper git is configured with
    // answers nothing. That helper is git's only one, because the environment
    // clears the machine's helpers, and git may not prompt, so a fetch from a
    // private remote fails instead of getting a credential.
    env: Object.fromEntries(
      Object.entries(substrate.gitEnv).filter(([name]) => name !== RUNNER_SOCKET_VARIABLE),
    ),
    // Its own process group, so the deadline can kill everything it started.
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  const held = { text: "" };
  let timedOut = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  // The deadline races the command instead of waiting for the command to end:
  // a process the setup command left running keeps the pipes open, so waiting
  // for the pipes could take forever, which is what the deadline prevents.
  const stopped = new Promise<undefined>((resolve) => {
    deadline = setTimeout(() => {
      timedOut = true;
      stopGroup(child);
      resolve(undefined);
    }, substrate.setupDeadlineMs);
  });
  const ran = Promise.all([
    // Both pipes write into one holder, so the output stays in the order it arrived.
    drainTail(child.stdout, held).catch(() => undefined),
    drainTail(child.stderr, held).catch(() => undefined),
  ]).then(() => child.exited);
  const code = await Promise.race([ran, stopped]);
  clearTimeout(deadline);
  if (!timedOut && code === 0) return undefined;
  const why = timedOut
    ? `the setup command was still running after ${String(Math.round(substrate.setupDeadlineMs / 1000))}s and was stopped:`
    : `the setup command failed with exit code ${String(code)}:`;
  return buildTailMessage(why, held.text);
};

/** Removes only clean working copies created by the current attempt, preserving any refusal. */
const rollBackWorkingCopies = async (
  substrate: Substrate,
  root: string,
  made: ReadonlyArray<RegisteredCheckout>,
  env: GitEnv,
): Promise<boolean> => {
  let removed = true;
  for (const checkout of made) {
    const directory = checkout.commonDirectory!;
    const result = await substrate.coordinateRepository(`git:${directory}`, () =>
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
};

/** Creates all generated checkouts from stable commits before running any setup command. */
const makeWorkingCopies = async (
  substrate: Substrate,
  frame: WorkspaceProvision,
  original: RegisteredWorkspace,
  env: GitEnv,
): Promise<WorkspaceReport> => {
  let entry = original;
  const warnings: Array<string> = [];
  const made: Array<RegisteredCheckout> = [];
  try {
    for (const [at, requested] of frame.checkouts.entries()) {
      const branch =
        frame.kind === "primary" ? `hercule/main-${frame.workspaceId}` : requested.branch;
      if (branch === null)
        throw new Error(`No branch was given for the new worktree of ${requested.remote}.`);
      const repository = await ensureSelectedRepository(substrate, requested, env);
      await substrate.coordinateRepository(`git:${repository.commonDirectory}`, async () => {
        const resolved = await resolveStartingRevision(repository, requested, env);
        if (resolved.warning !== undefined) warnings.push(resolved.warning);
        const checkout: RegisteredCheckout = {
          ...entry.checkouts[at]!,
          sourceRoot: repository.sourceRoot,
          canonicalRoot: joinPath(
            realpathSync(substrate.storageDir),
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
        await registerWorkspace(substrate, entry);
        mkdirSync(dirname(checkout.path), { recursive: true, mode: 0o700 });
        const added = await runGit(
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
          throw new Error(
            /a branch named .* already exists/.test(added.stderr)
              ? `${added.stderr} Choose a different branch name for the fresh workspace. The existing branch and its commits are preserved.`
              : added.stderr,
          );
        made.push(checkout);
      });
    }
  } catch (error) {
    const removed = await rollBackWorkingCopies(substrate, entry.root, made, env);
    if (!removed)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Some created files were retained because clean removal was refused. Inspect the failed workspace before discarding it.`,
        { cause: error },
      );
    throw error;
  }
  if (frame.checkouts.length === 0) mkdirSync(entry.root, { recursive: true, mode: 0o700 });
  entry = { ...entry, preparation: { phase: "preparing", instruction: frame } };
  await registerWorkspace(substrate, entry);
  for (const [at, requested] of frame.checkouts.entries()) {
    const directory = entry.checkouts[at]!.path;
    if (requested.workspaceInclude && frame.kind !== "primary") {
      const primary = substrate.registry.primaryOf(requested.resourceId);
      if (primary === undefined)
        warnings.push(
          `.workspaceinclude skipped: no main workspace is available on this runner for resource ${requested.resourceId}; the copy source is missing.`,
        );
      else warnings.push(...(await copyIncludedFiles(primary.root, directory, env)));
    }
    if (requested.setupCommand !== null) {
      const wrong = await runSetup(requested.setupCommand, directory, substrate);
      if (wrong !== undefined)
        return {
          ...buildFailedReport(frame.workspaceId, wrong),
          ...(warnings.length === 0 ? {} : { warnings }),
        };
    }
  }
  // Inspection retains preparation failure states. Creation itself supplies the
  // successful result only after all setup commands have completed.
  const report = await observeWorkspace(
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
};

/**
 * Returns the recorded preparation outcome without repeating setup. A legacy
 * entry is observed without changing its files. An unfinished preparation is
 * recorded as interrupted; a missing ready directory is reported unavailable.
 */
export const reprovision = async (
  substrate: Substrate,
  entry: RegisteredWorkspace,
): Promise<WorkspaceReport> => {
  const preparation = entry.preparation;
  if (preparation !== undefined) {
    if (preparation.phase !== "terminal") {
      const report = buildFailedReport(
        entry.workspaceId,
        "Workspace preparation was interrupted. Create a fresh workspace to prepare it again.",
      );
      await registerWorkspace(substrate, {
        ...entry,
        preparation: { phase: "terminal", instruction: preparation.instruction, report },
      });
      return report;
    }
    if (preparation.report.status === "failed") return preparation.report;
    if (isStillOnDisk(entry) && hasExpectedCheckoutIdentity(entry, substrate.gitEnv))
      return preparation.report;
  } else if (isStillOnDisk(entry) && hasExpectedCheckoutIdentity(entry, substrate.gitEnv)) {
    return observeWorkspace(entry, substrate.gitEnv);
  }
  return buildFailedReport(
    entry.workspaceId,
    `The workspace directory is gone or its recorded Git repository is unavailable: ${entry.root}. Restore the original files before continuing.`,
  );
};

/**
 * Records a creation instruction before filesystem work and its terminal
 * result before reporting it. Fails without removing files from older attempts.
 */
export const provisionWorkspace = async (
  substrate: Substrate,
  frame: WorkspaceProvision,
): Promise<WorkspaceReport> => {
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
  await registerWorkspace(substrate, entry);
  const env = { ...substrate.gitEnv, [RUNNER_WORKSPACE_VARIABLE]: frame.workspaceId };
  let report: WorkspaceReport;
  try {
    if (existsSync(root)) {
      report = buildFailedReport(
        frame.workspaceId,
        "The workspace directory already exists without a completed preparation record. Preserve its files and create a fresh workspace.",
      );
    } else {
      report = await makeWorkingCopies(substrate, frame, entry, env);
    }
  } catch (error) {
    report = buildFailedReport(
      frame.workspaceId,
      error instanceof Error ? error.message : String(error),
    );
  }
  await registerWorkspace(substrate, {
    ...(substrate.registry.held(frame.workspaceId) ?? entry),
    preparation: { phase: "terminal", instruction: frame, report },
  });
  return report;
};
