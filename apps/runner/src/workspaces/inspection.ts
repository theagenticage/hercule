/** Observes current filesystem and Git facts without changing preparation receipts. */
import { MAX_BRANCHES, type CheckoutReport, type WorkspaceReport } from "@hercule/protocol";
import {
  readCurrentBranch,
  readDefaultBranch,
  listLocalBranches,
  runGit,
  type GitEnv,
} from "./git";
import { hasExpectedCheckoutIdentity } from "./identity";
import { isStillOnDisk, type RegisteredCheckout, type RegisteredWorkspace } from "./registry";

const inspectCheckout = async (
  checkout: RegisteredCheckout,
  env: GitEnv,
): Promise<CheckoutReport> => {
  const remoteName = checkout.remoteName ?? "origin";
  const [branch, branches, defaultBranch, head, remoteRefs, form] = await Promise.all([
    readCurrentBranch(checkout.path, env),
    listLocalBranches(checkout.path, env),
    readDefaultBranch(checkout.path, env, remoteName),
    runGit(["-C", checkout.path, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { env }),
    runGit(
      ["-C", checkout.path, "for-each-ref", "--format=%(refname)", `refs/remotes/${remoteName}`],
      { env },
    ),
    runGit(
      ["-C", checkout.path, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { env },
    ),
  ]);
  const [gitDirectory, commonDirectory] = form.stdout.split("\n");
  return {
    checkoutId: checkout.checkoutId,
    branch,
    branches: branches.slice(0, MAX_BRANCHES),
    defaultBranch,
    headCommit: head.ok ? head.stdout : null,
    baseCommit: checkout.baseCommit ?? null,
    startingRevision: checkout.startingRevision ?? null,
    remoteBranches: remoteRefs.stdout
      .split("\n")
      .filter(
        (ref) =>
          ref.startsWith(`refs/remotes/${remoteName}/`) &&
          ref !== `refs/remotes/${remoteName}/HEAD`,
      )
      .map((ref) => ref.slice(`refs/remotes/${remoteName}/`.length))
      .slice(0, MAX_BRANCHES),
    form: checkout.form ?? (gitDirectory !== commonDirectory ? "worktree" : "clone"),
  };
};

/** Returns current checkout facts and the recorded preparation state, with a fresh observation time. */
export const observeWorkspace = async (
  entry: RegisteredWorkspace,
  env: GitEnv,
): Promise<WorkspaceReport> => {
  const recorded = entry.preparation?.phase === "terminal" ? entry.preparation.report : undefined;
  const available = isStillOnDisk(entry) && hasExpectedCheckoutIdentity(entry, env);
  const incomplete =
    entry.ownership !== "existing" &&
    entry.preparation !== undefined &&
    entry.preparation.phase !== "terminal";
  const status = available && !incomplete && recorded?.status !== "failed" ? "ready" : "failed";
  const message = !available
    ? "The recorded workspace checkout or Git repository is unavailable. Restore its original files and refresh the workspace."
    : incomplete
      ? "Workspace preparation is incomplete. Wait for preparation or create a fresh workspace after interruption."
      : recorded?.message;
  return {
    _tag: "workspaceReport",
    workspaceId: entry.workspaceId,
    status,
    observedAt: new Date().toISOString(),
    available,
    ownership: entry.ownership ?? "managed",
    ...(entry.ownership === "existing" ? { path: entry.root } : {}),
    checkouts: available
      ? await Promise.all(entry.checkouts.map((checkout) => inspectCheckout(checkout, env)))
      : [],
    ...(message === undefined ? {} : { message }),
    ...(recorded?.warnings === undefined ? {} : { warnings: recorded.warnings }),
  };
};
