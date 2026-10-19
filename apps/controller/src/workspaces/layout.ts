/**
 * The rules for which resources a new workspace can check out, and for laying
 * several repos side by side in it. Starting a session and previewing the
 * skills of a draft Thread both apply them, so a preview never describes a
 * Thread that cannot start.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { extractRepoName, Subdirectory } from "@hercule/protocol";
import { createValidationError, type Validation } from "@hercule/contract";
import { isCheckedOut, NOT_CHECKED_OUT, type StoredRepo, type StoredResource } from "../resources";

const REPO_TWICE = "a workspace can hold only one checkout of each repo: list each repo once";

const SAME_NAME =
  "two of those repos have the same name, and each checkout's directory is named after its repo, so they cannot share a workspace";

/** The rule the runner uses to name each directory in a multi-repo workspace, checked here too. */
const isDirectoryName = Schema.is(Subdirectory);

const describeUnnameableRepo = (name: string): string =>
  `${name} is not a valid directory name, so that repo cannot be checked out beside other repos in a workspace`;

/**
 * Returns the resource as a repo, or fails with a validation error when it is
 * a folder or a mailbox: only a repo is checked out.
 */
export const requireCheckedOut = (
  resource: StoredResource,
): Effect.Effect<StoredRepo, Validation> =>
  isCheckedOut(resource)
    ? Effect.succeed(resource)
    : Effect.fail(createValidationError([{ path: ["workspace"], message: NOT_CHECKED_OUT }]));

/**
 * Checks that these repos, in this order, can share one workspace, and returns
 * each repo's name: the directory its checkout gets when there is more than one
 * repo. Fails with a validation error when:
 *
 * - a repo is listed twice;
 * - two repos have the same name, so their directories would clash;
 * - a repo's name is not a valid directory name (only checked with more than
 *   one repo, because a single repo is checked out at the workspace root).
 *
 * This is checked before anything is sent to a runner. A frame that carries an
 * unusable name fails to encode, which is a defect the user could not act on.
 */
export const validateCheckoutDirectories = (
  repos: ReadonlyArray<StoredRepo>,
): Effect.Effect<ReadonlyArray<string>, Validation> =>
  Effect.gen(function* () {
    const names = repos.map((repo) => extractRepoName(repo.canonicalRemote));
    if (new Set(repos.map((repo) => repo.id)).size !== repos.length) {
      return yield* Effect.fail(
        createValidationError([{ path: ["workspace", "checkouts"], message: REPO_TWICE }]),
      );
    }
    if (repos.length > 1 && new Set(names).size !== names.length) {
      return yield* Effect.fail(
        createValidationError([{ path: ["workspace", "checkouts"], message: SAME_NAME }]),
      );
    }
    const unusable = repos.length > 1 ? names.find((name) => !isDirectoryName(name)) : undefined;
    if (unusable !== undefined) {
      return yield* Effect.fail(
        createValidationError([
          { path: ["workspace", "checkouts"], message: describeUnnameableRepo(unusable) },
        ]),
      );
    }
    return names;
  });
