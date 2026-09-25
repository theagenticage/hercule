/**
 * `git.commit`: commits the changes in a checkout of the run's workspace to
 * the branch the checkout is on.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WorkspaceActionFailed, type WorkspaceAction } from "./action";
import { buildGitFailure, findCheckoutDir, runGitOrFail, runGitProcess } from "./git";

/**
 * The step's params. `resourceId` is read from the step frame rather than from
 * here, but it stays in the schema so that params naming it still decode.
 */
const GitCommitInput = Schema.Struct({
  message: Schema.NonEmptyString,
  paths: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  resourceId: Schema.optionalKey(Schema.String),
});

const decodeInput = Schema.decodeUnknownEffect(GitCommitInput);

export const gitCommit: WorkspaceAction = {
  id: "git.commit",
  /**
   * Stages the changes, then commits them. Returns the commit's sha, the
   * branch and whether a commit was made:
   *
   * - without `paths`, every change is staged (`git add -A`);
   * - with `paths`, only those paths are staged and committed, and anything
   *   else already staged stays staged;
   * - when nothing is staged, no commit is made, and the sha is HEAD's.
   *
   * Fails when the checkout is on no branch, or when git fails.
   */
  run: (input, context) =>
    Effect.gen(function* () {
      const params = yield* decodeInput(input).pipe(
        Effect.mapError(
          (error) =>
            new WorkspaceActionFailed({
              message: `The step's params do not match the input of git.commit: ${error.message}`,
            }),
        ),
      );
      const dir = yield* findCheckoutDir(context);
      const branch = (yield* runGitOrFail(dir, ["branch", "--show-current"], context)).stdout;
      if (branch === "") {
        return yield* Effect.fail(
          new WorkspaceActionFailed({
            message:
              "The checkout is on no branch, so there is no branch to commit to. Check out a branch in the checkout before the step runs.",
          }),
        );
      }
      // With `paths`, the check and the commit are limited to those paths.
      // Something else may already be staged in a shared main workspace, and
      // it must stay staged and out of this commit. The `--` makes git read
      // every path as a path, even one that starts with a dash or names a
      // branch.
      const pathspec = params.paths === undefined ? [] : ["--", ...params.paths];
      yield* runGitOrFail(
        dir,
        params.paths === undefined ? ["add", "-A"] : ["add", ...pathspec],
        context,
      );
      // Exit code 1 means something is staged, and 0 means nothing is.
      const diff = ["diff", "--cached", "--quiet", ...pathspec];
      const staged = yield* runGitProcess(dir, diff, context);
      if (staged.code > 1) return yield* Effect.fail(buildGitFailure(diff, staged));
      const committed = staged.code === 1;
      // The message is one argument after `-m`, so git never reads it as an option.
      if (committed)
        yield* runGitOrFail(dir, ["commit", "-m", params.message, ...pathspec], context);
      const sha = (yield* runGitOrFail(dir, ["rev-parse", "HEAD"], context)).stdout;
      return { sha, branch, committed };
    }),
};
