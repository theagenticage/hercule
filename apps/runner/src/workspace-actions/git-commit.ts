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
   * - with `paths`, only those paths are staged;
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
              message: `the step's params do not fit git.commit's input: ${error.message}`,
            }),
        ),
      );
      const dir = yield* findCheckoutDir(context);
      const env = context.gitEnv;
      const branch = (yield* runGitOrFail(dir, ["branch", "--show-current"], env)).stdout;
      if (branch === "") {
        return yield* Effect.fail(
          new WorkspaceActionFailed({
            message: "the checkout is on no branch, so there is no branch to commit to",
          }),
        );
      }
      // The `--` makes git read every path as a path, even one that starts
      // with a dash or names a branch.
      yield* runGitOrFail(
        dir,
        params.paths === undefined ? ["add", "-A"] : ["add", "--", ...params.paths],
        env,
      );
      // Exit code 1 means something is staged, and 0 means nothing is.
      const diff = ["diff", "--cached", "--quiet"];
      const staged = yield* runGitProcess(dir, diff, env);
      if (staged.code > 1) return yield* Effect.fail(buildGitFailure(diff, staged));
      const committed = staged.code === 1;
      // The message is one argument after `-m`, so git never reads it as an option.
      if (committed) yield* runGitOrFail(dir, ["commit", "-m", params.message], env);
      const sha = (yield* runGitOrFail(dir, ["rev-parse", "HEAD"], env)).stdout;
      return { sha, branch, committed };
    }),
};
