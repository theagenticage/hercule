/**
 * `git.push`: pushes a branch of a checkout in the run's workspace to the
 * checkout's own remote.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { GitEnv } from "../workspaces";
import { WorkspaceActionFailed, type WorkspaceAction } from "./action";
import { findCheckoutDir, runGitOrFail, runGitProcess } from "./git";

/**
 * The remote every checkout is provisioned with. It points at the resource's
 * own remote, and the controller hands out credentials for that remote only,
 * so a push to anywhere else gets no credential.
 */
const REMOTE = "origin";

/**
 * The step's params. `resourceId` is read from the step frame rather than from
 * here, but it stays in the schema so that params naming it still decode.
 */
const GitPushInput = Schema.Struct({
  branch: Schema.optionalKey(Schema.NonEmptyString),
  resourceId: Schema.optionalKey(Schema.String),
});

const decodeInput = Schema.decodeUnknownEffect(GitPushInput);

/**
 * Checks that `branch` is a valid branch name, written out in full. Fails
 * with a message naming the branch otherwise.
 *
 * `git check-ref-format --branch` refuses names git cannot use as a branch,
 * such as one that starts with a dash or contains `..`. It also expands
 * shorthands such as `@{-1}` to the branch they stand for, and prints the
 * result. A name that is changed by that expansion is refused too, so the
 * step pushes exactly the branch its params name.
 */
const checkBranchName = (
  dir: string,
  branch: string,
  env: GitEnv,
): Effect.Effect<void, WorkspaceActionFailed> =>
  Effect.flatMap(runGitProcess(dir, ["check-ref-format", "--branch", branch], env), (checked) =>
    checked.code === 0 && checked.stdout === branch
      ? Effect.void
      : Effect.fail(
          new WorkspaceActionFailed({ message: `"${branch}" is not a valid branch name` }),
        ),
  );

export const gitPush: WorkspaceAction = {
  id: "git.push",
  /**
   * Pushes `branch`, or the checkout's current branch when the params name
   * none, to the branch of the same name on the checkout's remote, and sets
   * that remote branch as its upstream. Returns the branch and the commit it
   * points at.
   *
   * The push is never forced: a remote branch that has moved on refuses it,
   * and the step fails with the end of git's error output. Fails too when the
   * branch name is not valid, when the checkout is on no branch and the
   * params name none, and when the branch does not exist in the checkout.
   */
  run: (input, context) =>
    Effect.gen(function* () {
      const params = yield* decodeInput(input).pipe(
        Effect.mapError(
          (error) =>
            new WorkspaceActionFailed({
              message: `the step's params do not fit git.push's input: ${error.message}`,
            }),
        ),
      );
      const dir = yield* findCheckoutDir(context);
      const env = context.gitEnv;
      let branch = params.branch;
      if (branch === undefined) {
        branch = (yield* runGitOrFail(dir, ["branch", "--show-current"], env)).stdout;
        if (branch === "") {
          return yield* Effect.fail(
            new WorkspaceActionFailed({
              message: "the checkout is on no branch, and the step names no branch to push",
            }),
          );
        }
      } else {
        yield* checkBranchName(dir, branch, env);
      }
      const ref = `refs/heads/${branch}`;
      // A full refspec, with no leading `+`, so the push is never forced and
      // the name is never read as a tag. It comes after `--`, so git never
      // reads it as an option.
      yield* runGitOrFail(dir, ["push", "--set-upstream", "--", REMOTE, `${ref}:${ref}`], env);
      const sha = (yield* runGitOrFail(dir, ["rev-parse", "--verify", `${ref}^{commit}`], env))
        .stdout;
      return { branch, sha };
    }),
};
