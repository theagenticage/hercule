/** Observes current filesystem and Git facts without changing preparation receipts. */
import * as Effect from "effect/Effect";
import type { CheckoutReport, WorkspaceReport } from "@hercule/protocol";
import { readCurrentBranch, readDefaultBranch, runGit, type GitEnv } from "./git";
import { hasExpectedCheckoutIdentity } from "./identity";
import { isStillOnDisk, type RegisteredCheckout, type RegisteredWorkspace } from "./registry";

const inspectCheckout = (
  checkout: RegisteredCheckout,
  env: GitEnv,
): Effect.Effect<CheckoutReport, Error> =>
  Effect.gen(function* () {
    const remoteName = checkout.remoteName ?? "origin";
    const [branch, defaultBranch, head, form] = yield* Effect.all(
      [
        readCurrentBranch(checkout.path, env),
        readDefaultBranch(checkout.path, env, remoteName),
        runGit(["-C", checkout.path, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { env }),
        runGit(
          [
            "-C",
            checkout.path,
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
            "--git-common-dir",
          ],
          { env },
        ),
      ],
      { concurrency: "unbounded" },
    );
    const [gitDirectory, commonDirectory] = form.stdout.split("\n");
    return {
      checkoutId: checkout.checkoutId,
      branch,
      // A controller older than the live branch list requires the field; a
      // current one ignores it and asks for branches when the menu opens.
      branches: [],
      defaultBranch,
      headCommit: head.ok ? head.stdout : null,
      baseCommit: checkout.baseCommit ?? null,
      startingRevision: checkout.startingRevision ?? null,
      form: checkout.form ?? (gitDirectory !== commonDirectory ? "worktree" : "clone"),
    };
  });

/** Returns current checkout facts and the recorded preparation state, with a fresh observation time. */
export const observeWorkspace = (
  entry: RegisteredWorkspace,
  env: GitEnv,
): Effect.Effect<WorkspaceReport, Error> =>
  Effect.gen(function* () {
    const recorded = entry.preparation?.phase === "terminal" ? entry.preparation.report : undefined;
    const available = isStillOnDisk(entry) && (yield* hasExpectedCheckoutIdentity(entry, env));
    const incomplete =
      entry.ownership !== "adopted" &&
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
      ...(entry.ownership === "adopted" ? { path: entry.root } : {}),
      checkouts: available
        ? yield* Effect.all(
            entry.checkouts.map((checkout) => inspectCheckout(checkout, env)),
            { concurrency: "unbounded" },
          )
        : [],
      ...(message === undefined ? {} : { message }),
      ...(recorded?.warnings === undefined ? {} : { warnings: recorded.warnings }),
    };
  });
