/**
 * Making a workspace on this machine: a primary cloned fresh under this
 * machine's own storage, and an ephemeral worktree per repository.
 *
 * Nothing here ever touches a folder the user already has. A primary is Hydra's
 * own clone, in a directory Hydra made, so no directory outside the storage
 * directory is read or written.
 */
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join as joinPath, resolve as resolvePath, sep } from "node:path";
import {
  MAX_MESSAGE_LENGTH,
  type CheckoutReport,
  type ProvisionCheckout,
  type WorkspaceProvision,
  type WorkspaceReport,
} from "@hydra/protocol";
import { tearDown } from "./dispose";
import {
  currentBranch,
  defaultBranch,
  ensureCache,
  localBranches,
  runGit,
  startPointFor,
  type GitEnv,
} from "./git";
import { stillOnDisk, type RegisteredCheckout, type RegisteredWorkspace } from "./registry";
import type { Substrate } from "./substrate";

/** The most of a setup command's output the user is shown: the tail says why. */
const SETUP_OUTPUT_LINES = 20;

/** The most of a setup command's output held while it runs, per workspace. */
const SETUP_OUTPUT_BYTES = 64 * 1024;

const failed = (workspaceId: string, message: string): WorkspaceReport => ({
  _tag: "workspaceReport",
  workspaceId,
  status: "failed",
  message: message.slice(0, MAX_MESSAGE_LENGTH),
});

const checkoutReportOf = async (
  checkoutId: string,
  dir: string,
  env: GitEnv,
): Promise<CheckoutReport> => ({
  checkoutId,
  branch: await currentBranch(dir, env),
  branches: await localBranches(dir, env),
  defaultBranch: await defaultBranch(dir, env),
});

const reportOf = async (entry: RegisteredWorkspace, env: GitEnv): Promise<WorkspaceReport> => ({
  _tag: "workspaceReport",
  workspaceId: entry.workspaceId,
  status: "ready",
  checkouts: await Promise.all(
    entry.checkouts.map((one) => checkoutReportOf(one.checkoutId, one.path, env)),
  ),
});

const remember = (substrate: Substrate, entry: RegisteredWorkspace): Promise<void> =>
  substrate.registry.update((entries) => [
    ...entries.filter((held) => held.workspaceId !== entry.workspaceId),
    entry,
  ]);

/** A primary this machine makes for itself: hardlinked off the cache, pointed at the real remote. */
const cloneFresh = async (
  substrate: Substrate,
  workspaceId: string,
  one: ProvisionCheckout,
  env: GitEnv,
): Promise<WorkspaceReport> => {
  const cache = await ensureCache({
    storageDir: substrate.storageDir,
    resourceId: one.resourceId,
    remote: one.remote,
    env,
  });
  if (cache.failure !== undefined) return failed(workspaceId, cache.failure);
  const dir = joinPath(substrate.storageDir, "primaries", one.resourceId);
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  // Nothing is registered here, so whatever stands in that directory is what an
  // earlier attempt left behind, and git will not clone into it.
  rmSync(dir, { recursive: true, force: true });
  const cloned = await runGit(["clone", "--local", "--", cache.path, dir], { env });
  if (!cloned.ok) return failed(workspaceId, cloned.stderr);
  // Fetching and pushing have to reach the real remote, not this machine's cache.
  const pointed = await runGit(["-C", dir, "remote", "set-url", "origin", one.remote], { env });
  if (!pointed.ok) return failed(workspaceId, pointed.stderr);
  // The cache's branches are as old as the cache; the remote's are current, and
  // this clone is seconds old with nothing in it to lose by taking them. A clone
  // that came up on no branch at all - an empty repository - has nothing to
  // bring forward.
  const branch = await currentBranch(dir, env);
  if (branch !== null && (await runGit(["-C", dir, "fetch", "--no-tags", "origin"], { env })).ok) {
    await runGit(["-C", dir, "reset", "--hard", `refs/remotes/origin/${branch}`], { env });
  }
  const entry: RegisteredWorkspace = {
    workspaceId,
    kind: "primary",
    root: dir,
    checkouts: [
      { checkoutId: one.checkoutId, resourceId: one.resourceId, remote: one.remote, path: dir },
    ],
  };
  await remember(substrate, entry);
  return reportOf(entry, env);
};

/**
 * What the primary's `.workspaceinclude` lists, copied in: the untracked files
 * an agent needs to run the project. One relative path per line, `#` comments;
 * a line that climbs out of the primary is not a path in it. Symlinks are
 * followed rather than copied, because a link into the primary would be an
 * agent editing the user's own files.
 */
const copyIncluded = (primaryRoot: string, dir: string): void => {
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
 * Everything a pipe produces, capped: an install log can run to megabytes and
 * only its tail is ever read, so the head is dropped as it arrives rather than
 * held. Both pipes feed one buffer, so the tail reads in the order the command
 * printed it.
 */
const drainInto = async (
  stream: ReadableStream<Uint8Array>,
  held: { text: string },
): Promise<void> => {
  const decoder = new TextDecoder();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    held.text = (held.text + decoder.decode(chunk, { stream: true })).slice(-SETUP_OUTPUT_BYTES);
  }
};

/**
 * The whole process group, not the shell alone: a setup command that starts a
 * watcher or a server leaves children behind, and killing the shell would leave
 * those holding the workspace this is giving up on. The child leads a group of
 * its own, which is what makes the negative pid safe to signal.
 */
const stopGroup = (child: Bun.Subprocess): void => {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};

/**
 * The tail of what a setup command printed, which is the part that says why it
 * stopped, or nothing at all when it succeeded. A command that never returns is
 * killed at the deadline: provisioning is what a session is waiting on.
 */
const runSetup = async (
  command: string,
  dir: string,
  substrate: Substrate,
): Promise<string | undefined> => {
  const child = Bun.spawn(["/bin/sh", "-c", command], {
    cwd: dir,
    // The clean environment, without the provisioning claim: a setup command is
    // repository code and gets no credential of its own (D-16).
    env: { ...substrate.gitEnv },
    // A group of its own, so the deadline can reach everything it started.
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  const held = { text: "" };
  let timedOut = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  // Not joined with the command's own end: what a setup command left running
  // behind it holds the pipes open, and waiting for those would be waiting for
  // the very thing the deadline is there to stop waiting for.
  const stopped = new Promise<undefined>((resolve) => {
    deadline = setTimeout(() => {
      timedOut = true;
      stopGroup(child);
      resolve(undefined);
    }, substrate.setupDeadlineMs);
  });
  const ran = Promise.all([
    drainInto(child.stdout, held).catch(() => undefined),
    drainInto(child.stderr, held).catch(() => undefined),
  ]).then(() => child.exited);
  const code = await Promise.race([ran, stopped]);
  clearTimeout(deadline);
  if (!timedOut && code === 0) return undefined;
  const lines = held.text.split("\n").filter((line) => line.length > 0);
  const why = timedOut
    ? `the setup command was still running after ${String(Math.round(substrate.setupDeadlineMs / 1000))}s and was stopped:`
    : `the setup command exited ${String(code)}:`;
  return [why, ...lines.slice(-SETUP_OUTPUT_LINES)].join("\n");
};

const makeEphemeral = async (
  substrate: Substrate,
  frame: WorkspaceProvision,
  env: GitEnv,
): Promise<WorkspaceReport> => {
  const workspaceId = frame.workspaceId;
  const root = joinPath(substrate.storageDir, "workspaces", workspaceId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const held: Array<RegisteredCheckout> = [];
  const checkouts: Array<CheckoutReport> = [];
  const warnings: Array<string> = [];
  /**
   * A workspace that could not be made leaves no half of one behind: every
   * worktree already added is removed, and with it the cache's belief that a
   * directory over there is one of its own. A setup command that failed is the
   * exception the spec names: its files stay for the user to look at.
   */
  const giveUp = async (message: string): Promise<WorkspaceReport> => {
    await tearDown(substrate.storageDir, root, held, env);
    return failed(workspaceId, message);
  };

  // Every working copy first, so the workspace is a whole one before anything
  // runs in it.
  for (const one of frame.checkouts) {
    const dir = one.subdirectory === null ? root : joinPath(root, one.subdirectory);
    if (one.branch === null) {
      return await giveUp(`${one.remote} was asked for a worktree on no branch`);
    }
    const cache = await ensureCache({
      storageDir: substrate.storageDir,
      resourceId: one.resourceId,
      remote: one.remote,
      env,
    });
    if (cache.failure !== undefined) return await giveUp(cache.failure);
    // The cache just said what the default branch is; asking git again here
    // would be a second derivation of the one answer.
    const base = one.baseBranch ?? cache.defaultBranch ?? "";
    const start = await startPointFor(cache.path, base, env);
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
  // Registered before a setup command runs, and before the report goes out: the
  // branch is made and the directory is the workspace, so a frame the
  // controller resends - to a runner that dialled in again, or because the
  // report was lost - must find this and re-report it. Making it again would
  // fail on the branch that now exists and throw away what is in there.
  await remember(substrate, { workspaceId, kind: "ephemeral", root, checkouts: held });

  for (const [at, one] of frame.checkouts.entries()) {
    const dir = held[at]!.path;
    if (one.workspaceInclude) {
      const primary = substrate.registry.primaryOf(one.resourceId);
      // Before the setup command, which is the thing that reads what was copied.
      if (primary === undefined) {
        warnings.push(`no primary of ${one.resourceId} on this runner; .workspaceinclude skipped`);
      } else copyIncluded(primary.root, dir);
    }
    if (one.setupCommand !== null) {
      const wrong = await runSetup(one.setupCommand, dir, substrate);
      // Left in place, worktree and all: the user is the one who decides to
      // throw away what an install got half way through.
      if (wrong !== undefined) return failed(workspaceId, wrong);
    }
    checkouts.push(await checkoutReportOf(one.checkoutId, dir, env));
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
 * What a workspace this machine already holds is worth: a re-report, unless the
 * directory it named is gone, which is a workspace nobody can be placed in.
 */
export const reprovision = async (
  substrate: Substrate,
  entry: RegisteredWorkspace,
): Promise<WorkspaceReport> => {
  if (stillOnDisk(entry)) return reportOf(entry, substrate.gitEnv);
  await substrate.registry.update((entries) =>
    entries.filter((held) => held.workspaceId !== entry.workspaceId),
  );
  return failed(entry.workspaceId, `the workspace directory is gone: ${entry.root}`);
};

export const provisionWorkspace = async (
  substrate: Substrate,
  frame: WorkspaceProvision,
): Promise<WorkspaceReport> => {
  // The machine proves itself to the controller as the workspace it is making,
  // for as long as it is making it.
  const env = { ...substrate.gitEnv, HYDRA_WORKSPACE_PROVISIONING: frame.workspaceId };
  if (frame.kind === "ephemeral") return makeEphemeral(substrate, frame, env);
  const one = frame.checkouts[0];
  if (one === undefined) {
    return failed(frame.workspaceId, "a primary is one checkout of a repository");
  }
  return cloneFresh(substrate, frame.workspaceId, one, env);
};
