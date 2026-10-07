/** Resolves the selected runner-local repository before any generated checkout is created. */
import { realpathSync, statSync } from "node:fs";
import * as Effect from "effect/Effect";
import {
  canonicalizeRemote,
  type ProvisionCheckout,
  type StartingRevision,
  type RepositoryMode,
} from "@hercule/protocol";
import { hasExpectedCheckoutIdentity, inspectCheckoutIdentity } from "./identity";
import { buildCacheDir, ensureCache, fetchRemote, resolveCommit, runGit, type GitEnv } from "./git";
import { isStillOnDisk } from "./registry";
import type { Substrate } from "./substrate";

export interface SelectedRepository {
  readonly commonDirectory: string;
  readonly commonDirectoryIdentity: string;
  readonly sourceRoot: string;
  readonly workingRoot: string | undefined;
  readonly remoteName: string;
  readonly mode: RepositoryMode;
}

/** Establishes managed storage or validates the selected source, serializing first bootstrap per Resource. */
export const ensureSelectedRepository = (
  substrate: Substrate,
  checkout: ProvisionCheckout,
  env: GitEnv,
): Effect.Effect<SelectedRepository, Error> =>
  substrate.coordinateRepository(
    `resource:${checkout.resourceId}`,
    Effect.gen(function* () {
      let selected = yield* substrate.registry.selectedRepository(checkout.resourceId);
      if (selected === undefined)
        return yield* Effect.fail(
          new Error(
            "The repository selection is missing. Restore the workspace registry before creating work.",
          ),
        );
      if (selected.sourceRoot === null || selected.commonDirectory === null) {
        if (selected.mode !== "managed")
          return yield* Effect.fail(
            new Error(
              "The selected existing repository is unavailable. Restore its recorded checkout.",
            ),
          );
        let cachePath: string;
        if (
          checkout.startingRevision?.kind === "current" ||
          checkout.startingRevision?.kind === "local"
        ) {
          cachePath = buildCacheDir(substrate.storageDir, checkout.resourceId);
          const known = yield* runGit(["-C", cachePath, "rev-parse", "--git-dir"], { env });
          if (!known.ok)
            return yield* Effect.fail(
              new Error(
                "This runner has no selected local repository or revision. Choose a remote starting revision to establish managed storage first.",
              ),
            );
        } else {
          const cache = yield* ensureCache({
            storageDir: substrate.storageDir,
            resourceId: checkout.resourceId,
            remote: checkout.remote,
            env,
          });
          if (cache.failure !== undefined) return yield* Effect.fail(new Error(cache.failure));
          cachePath = cache.path;
        }
        const common = yield* runGit(
          ["-C", cachePath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
          { env },
        );
        if (!common.ok)
          return yield* Effect.fail(
            new Error(`The managed repository could not be inspected: ${common.stderr}`),
          );
        const commonDirectory = yield* Effect.try({
          try: () => realpathSync(common.stdout),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        });
        const physical = yield* Effect.try({
          try: () => statSync(commonDirectory),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        });
        selected = {
          ...selected,
          sourceRoot: yield* Effect.try({
            try: () => realpathSync(cachePath),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          }),
          commonDirectory,
          commonDirectoryIdentity: `${String(physical.dev)}:${String(physical.ino)}`,
        };
        yield* substrate.registry.selectRepository(selected);
      }
      const sourceRoot = selected.sourceRoot!;
      const commonDirectory = selected.commonDirectory!;
      if (
        (yield* Effect.try({
          try: () => realpathSync(sourceRoot),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        })) !== sourceRoot
      )
        return yield* Effect.fail(
          new Error(
            "The selected repository path now points to another directory. Restore its original source before continuing.",
          ),
        );
      const physical = yield* Effect.try({
        try: () => statSync(commonDirectory),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
      if (selected.commonDirectoryIdentity !== `${String(physical.dev)}:${String(physical.ino)}`)
        return yield* Effect.fail(
          new Error(
            "The selected Git repository was replaced. Restore its original repository before continuing.",
          ),
        );
      const bare = yield* runGit(["-C", sourceRoot, "rev-parse", "--is-bare-repository"], { env });
      if (!bare.ok)
        return yield* Effect.fail(
          new Error(
            "The selected Git repository is unavailable. Restore its recorded source before continuing.",
          ),
        );
      if (bare.stdout === "false") {
        const identity = yield* inspectCheckoutIdentity(
          sourceRoot,
          selected.remoteName,
          checkout.remote,
          env,
        );
        if (
          identity.root !== sourceRoot ||
          identity.commonDirectory !== commonDirectory ||
          identity.commonDirectoryIdentity !== selected.commonDirectoryIdentity
        )
          return yield* Effect.fail(
            new Error(
              "The selected source checkout now uses another Git repository. Restore its original root and Git binding before continuing.",
            ),
          );
      } else {
        const configured = yield* runGit(
          ["-C", sourceRoot, "config", "--get", `remote.${selected.remoteName}.url`],
          { env },
        );
        const common = yield* runGit(
          ["-C", sourceRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
          { env },
        );
        if (
          !configured.ok ||
          canonicalizeRemote(configured.stdout) !== canonicalizeRemote(checkout.remote) ||
          canonicalizeRemote(checkout.remote) === undefined ||
          !common.ok ||
          (yield* Effect.try({
            try: () => realpathSync(common.stdout),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          })) !== commonDirectory
        )
          return yield* Effect.fail(
            new Error(
              "The selected Git repository or configured remote no longer matches this resource. Restore its original source and remote before continuing.",
            ),
          );
      }
      let workingRoot: string | undefined;
      if (selected.mode === "existing") {
        const source =
          selected.primaryWorkspaceId === null
            ? undefined
            : yield* substrate.registry.held(selected.primaryWorkspaceId);
        if (
          source === undefined ||
          !isStillOnDisk(source) ||
          !hasExpectedCheckoutIdentity(source, substrate.gitEnv)
        )
          return yield* Effect.fail(
            new Error(
              "The selected existing checkout is unavailable. Restore it before starting work.",
            ),
          );
        workingRoot = source.root;
      } else {
        if (bare.stdout === "false") workingRoot = sourceRoot;
        else {
          const main =
            selected.primaryWorkspaceId === null
              ? undefined
              : yield* substrate.registry.held(selected.primaryWorkspaceId);
          if (
            main !== undefined &&
            isStillOnDisk(main) &&
            hasExpectedCheckoutIdentity(main, substrate.gitEnv) &&
            (main.preparation === undefined ||
              (main.preparation.phase === "terminal" && main.preparation.report.status === "ready"))
          )
            workingRoot = main.root;
        }
      }
      return {
        sourceRoot,
        commonDirectory,
        commonDirectoryIdentity: selected.commonDirectoryIdentity,
        workingRoot,
        remoteName: selected.remoteName,
        mode: selected.mode,
      };
    }),
  );

/** Resolves the requested local or remote starting point to a commit in the selected repository. */
export const resolveStartingRevision = (
  repository: SelectedRepository,
  checkout: ProvisionCheckout,
  env: GitEnv,
): Effect.Effect<
  { startingRevision: StartingRevision; baseCommit: string; warning?: string },
  Error
> =>
  Effect.gen(function* () {
    if (checkout.startingRevision !== undefined && checkout.baseBranch !== null)
      return yield* Effect.fail(
        new Error("Supply either startingRevision or deprecated baseBranch, never both."),
      );
    const startingRevision: StartingRevision =
      checkout.startingRevision ??
      (checkout.baseBranch === null
        ? repository.mode === "existing"
          ? { kind: "current" }
          : { kind: "remote" }
        : { kind: "remote", branch: checkout.baseBranch });
    let directory = repository.commonDirectory;
    let ref: string;
    switch (startingRevision.kind) {
      case "current":
        if (repository.workingRoot === undefined)
          return yield* Effect.fail(
            new Error(
              "The selected repository has no current working copy. Choose a local or remote branch.",
            ),
          );
        directory = repository.workingRoot;
        ref = "HEAD";
        break;
      case "local":
        ref = `refs/heads/${startingRevision.branch}`;
        break;
      case "remote": {
        const defaultBranch = yield* fetchRemote(
          repository.commonDirectory,
          repository.remoteName,
          checkout.remote,
          env,
        );
        const branch = startingRevision.branch ?? defaultBranch;
        if (branch === null)
          return yield* Effect.fail(
            new Error(
              "The remote has no default committed branch. Choose an existing remote branch.",
            ),
          );
        ref = `refs/remotes/${repository.remoteName}/${branch}`;
        break;
      }
    }
    return {
      startingRevision,
      baseCommit: yield* resolveCommit(directory, ref, env),
      ...(checkout.baseBranch === null
        ? {}
        : {
            warning: `Deprecated baseBranch ${checkout.baseBranch} was interpreted as a remote branch; no local fallback is used.`,
          }),
    };
  });
