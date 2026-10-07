/**
 * Provisions workspaces on this runner. A primary is a fresh clone in the
 * runner's storage directory, and an ephemeral workspace is one worktree per
 * repository.
 *
 * Nothing here touches a directory the user already has. A primary is
 * Hercule's own clone, in a directory Hercule created, so nothing outside the
 * storage directory is read or written.
 */
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join as joinPath, resolve as resolvePath, sep } from "node:path";
import {
  MAX_MESSAGE_LENGTH,
  type CheckoutReport,
  type ProvisionCheckout,
  type WorkspaceProvision,
  type WorkspaceReport,
} from "@hercule/protocol";
import { RUNNER_SOCKET_VARIABLE, RUNNER_WORKSPACE_VARIABLE } from "../credentials";
import { tearDown } from "./dispose";
import {
  readCurrentBranch,
  readDefaultBranch,
  ensureCache,
  listLocalBranches,
  runGit,
  findStartPoint,
  type GitEnv,
} from "./git";
import { buildTailMessage, drainTail } from "./output";
import { isStillOnDisk, type RegisteredCheckout, type RegisteredWorkspace } from "./registry";
import type { Substrate } from "./substrate";

const buildFailedReport = (workspaceId: string, message: string): WorkspaceReport => ({
  _tag: "workspaceReport",
  workspaceId,
  status: "failed",
  message: message.slice(0, MAX_MESSAGE_LENGTH),
});

const buildCheckoutReport = async (
  checkoutId: string,
  dir: string,
  env: GitEnv,
): Promise<CheckoutReport> => ({
  checkoutId,
  branch: await readCurrentBranch(dir, env),
  branches: await listLocalBranches(dir, env),
  defaultBranch: await readDefaultBranch(dir, env),
});

export const observeWorkspace = async (
  entry: RegisteredWorkspace,
  env: GitEnv,
): Promise<WorkspaceReport> => ({
  _tag: "workspaceReport",
  workspaceId: entry.workspaceId,
  status: "ready",
  checkouts: await Promise.all(
    entry.checkouts.map((one) => buildCheckoutReport(one.checkoutId, one.path, env)),
  ),
});

const registerWorkspace = (substrate: Substrate, entry: RegisteredWorkspace): Promise<void> =>
  substrate.registry.update((entries) => [
    ...entries.filter((held) => held.workspaceId !== entry.workspaceId),
    entry,
  ]);

/**
 * Creates a primary: a clone of the cache that shares its objects through
 * hardlinks, with `origin` pointed at the real remote. Returns a ready report,
 * or a failed report with git's error output.
 */
const cloneFresh = async (
  substrate: Substrate,
  entry: RegisteredWorkspace,
  one: ProvisionCheckout,
  env: GitEnv,
): Promise<WorkspaceReport> => {
  const workspaceId = entry.workspaceId;
  const cache = await ensureCache({
    storageDir: substrate.storageDir,
    resourceId: one.resourceId,
    remote: one.remote,
    env,
  });
  if (cache.failure !== undefined) return buildFailedReport(workspaceId, cache.failure);
  const dir = entry.root;
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  const cloned = await runGit(["clone", "--local", "--", cache.path, dir], { env });
  if (!cloned.ok) return buildFailedReport(workspaceId, cloned.stderr);
  // Fetching and pushing have to reach the real remote, not this runner's cache.
  const pointed = await runGit(["-C", dir, "remote", "set-url", "origin", one.remote], { env });
  if (!pointed.ok) return buildFailedReport(workspaceId, pointed.stderr);
  // The clone's branches come from the cache's own branches, which are only as
  // new as the cache's first clone. The remote's branches are current, and the
  // clone is seconds old, so resetting it to them loses nothing. A clone that
  // is on no branch (an empty repository) has nothing to update.
  const branch = await readCurrentBranch(dir, env);
  if (branch !== null && (await runGit(["-C", dir, "fetch", "--no-tags", "origin"], { env })).ok) {
    await runGit(["-C", dir, "reset", "--hard", `refs/remotes/origin/${branch}`], { env });
  }
  await registerWorkspace(substrate, {
    ...entry,
    preparation: { phase: "preparing", instruction: entry.preparation!.instruction },
  });
  if (one.setupCommand !== null) {
    const wrong = await runSetup(one.setupCommand, dir, substrate);
    if (wrong !== undefined) return buildFailedReport(workspaceId, wrong);
  }
  return observeWorkspace(entry, env);
};

/**
 * Copies the files listed in the primary's `.workspaceinclude` into `dir`.
 * These are untracked files an agent needs to run the project. Does nothing if
 * the primary has no `.workspaceinclude`.
 *
 * - The file has one relative path per line, and lines starting with `#` are
 *   comments.
 * - A path that points outside the primary is skipped.
 * - Symlinks are followed and their targets copied, because a link into the
 *   primary would let an agent edit the primary's files.
 */
const copyIncludedFiles = (primaryRoot: string, dir: string): void => {
  let listed: string;
  try {
    listed = readFileSync(joinPath(primaryRoot, ".workspaceinclude"), "utf8");
  } catch {
    return;
  }
  for (const line of listed.split("\n")) {
    const relative = line.trim();
    if (relative.length === 0 || relative.startsWith("#")) continue;
    const from = resolvePath(primaryRoot, relative);
    if (!from.startsWith(primaryRoot + sep)) continue;
    try {
      cpSync(from, joinPath(dir, relative), { recursive: true, dereference: true });
    } catch {
      // A path the user listed and then removed is not worth failing a workspace over.
    }
  }
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

const makeEphemeral = async (
  substrate: Substrate,
  frame: WorkspaceProvision,
  entry: RegisteredWorkspace,
  env: GitEnv,
): Promise<WorkspaceReport> => {
  const workspaceId = frame.workspaceId;
  const root = entry.root;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const held: Array<RegisteredCheckout> = [];
  const checkouts: Array<CheckoutReport> = [];
  const warnings: Array<string> = [];
  /**
   * Fails the provisioning and removes what it created: every worktree added
   * so far, the workspace directory, and the caches' records of those
   * worktrees. A failed setup command is the exception the spec names: it does
   * not call this, so its files stay for the user to inspect.
   */
  const giveUp = async (message: string): Promise<WorkspaceReport> => {
    await tearDown(substrate.storageDir, root, held, env);
    return buildFailedReport(workspaceId, message);
  };

  // Create every checkout first, so the workspace is complete before any setup
  // command runs in it.
  for (const one of frame.checkouts) {
    const dir = one.subdirectory === null ? root : joinPath(root, one.subdirectory);
    if (one.branch === null) {
      return await giveUp(`no branch was given for the worktree of ${one.remote}`);
    }
    const cache = await ensureCache({
      storageDir: substrate.storageDir,
      resourceId: one.resourceId,
      remote: one.remote,
      env,
    });
    if (cache.failure !== undefined) return await giveUp(cache.failure);
    // Use the default branch `ensureCache` returned: asking git again could
    // give a different answer.
    const base = one.baseBranch ?? cache.defaultBranch ?? "";
    const start = await findStartPoint(cache.path, base, env);
    if (start === undefined) return await giveUp(`${one.remote} has no branch ${base}`);
    const added = await runGit(
      ["-C", cache.path, "worktree", "add", "-b", one.branch, dir, start],
      {
        env,
      },
    );
    if (!added.ok) return await giveUp(added.stderr);
    held.push({
      checkoutId: one.checkoutId,
      resourceId: one.resourceId,
      remote: one.remote,
      path: dir,
    });
  }
  await registerWorkspace(substrate, {
    ...entry,
    preparation: { phase: "preparing", instruction: frame },
  });

  for (const [at, one] of frame.checkouts.entries()) {
    const dir = held[at]!.path;
    if (one.workspaceInclude) {
      const primary = substrate.registry.primaryOf(one.resourceId);
      // Copy before the setup command runs, because it may need the copied files.
      if (primary === undefined) {
        warnings.push(
          `.workspaceinclude skipped: this runner has no main workspace for resource ${one.resourceId} to copy the files from`,
        );
      } else copyIncludedFiles(primary.root, dir);
    }
    if (one.setupCommand !== null) {
      const wrong = await runSetup(one.setupCommand, dir, substrate);
      // The workspace and its worktrees are left in place: the user decides
      // whether to throw away a half-finished install.
      if (wrong !== undefined)
        return {
          ...buildFailedReport(workspaceId, wrong),
          ...(warnings.length === 0 ? {} : { warnings }),
        };
    }
    checkouts.push(await buildCheckoutReport(one.checkoutId, dir, env));
  }
  return {
    _tag: "workspaceReport",
    workspaceId,
    status: "ready",
    checkouts,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
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
    if (isStillOnDisk(entry)) return preparation.report;
  } else if (isStillOnDisk(entry)) {
    return observeWorkspace(entry, substrate.gitEnv);
  }
  return buildFailedReport(entry.workspaceId, `the workspace directory is gone: ${entry.root}`);
};

/**
 * Records a creation instruction before filesystem work and its terminal
 * result before reporting it. Fails without removing files from older attempts.
 */
export const provisionWorkspace = async (
  substrate: Substrate,
  frame: WorkspaceProvision,
): Promise<WorkspaceReport> => {
  const one = frame.checkouts[0];
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
      report =
        frame.kind === "ephemeral"
          ? await makeEphemeral(substrate, frame, entry, env)
          : await cloneFresh(substrate, entry, one!, env);
    }
  } catch (error) {
    report = buildFailedReport(
      frame.workspaceId,
      error instanceof Error ? error.message : String(error),
    );
  }
  await registerWorkspace(substrate, {
    ...entry,
    preparation: { phase: "terminal", instruction: frame, report },
  });
  return report;
};
