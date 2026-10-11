/**
 * The workflow action that re-runs the failed checks on a GitHub pull
 * request's head commit.
 */
import { Clock, Effect, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { ActionError } from "@hercule/plugin-host";
import type { GithubRequest } from "../api";
import {
  callGithub,
  convertGithubFailure,
  defineGithubAction,
  isSuccessful,
  readConnectionToken,
  sendGithubRequest,
} from "./call";
import { describeItem, nameItemBriefly } from "./describe";
import {
  ChecksRerun,
  decodeCheckSuitePage,
  decodeWorkflowRunIds,
  type GithubCheckSuite,
} from "./objects";
import { describePullRequest, fetchPullRequest, PULL_REQUEST_ADDRESS } from "./pr";

/** The app slug of the check suites GitHub Actions creates, one for each workflow. */
const GITHUB_ACTIONS_SLUG = "github-actions";

/** The conclusions of a finished check suite that need nobody's attention. */
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

/** Checks whether a check suite finished with a conclusion that needs attention. */
const hasFailed = (suite: GithubCheckSuite): boolean =>
  suite.status === "completed" &&
  suite.conclusion !== null &&
  !PASSING_CONCLUSIONS.has(suite.conclusion) &&
  // A suite with no check runs is one GitHub made for an app with nothing to
  // run on this commit; there is nothing in it to run again.
  suite.latest_check_runs_count > 0;

/** Checks whether GitHub Actions created a check suite. */
const isActionsSuite = (suite: GithubCheckSuite): boolean =>
  suite.app?.slug === GITHUB_ACTIONS_SLUG;

/**
 * Reads every check suite of a commit, following GitHub's pages. Fails with
 * the error `convertGithubFailure` builds when GitHub refuses a page.
 */
const fetchCheckSuites = (
  repo: string,
  sha: string,
  token: string,
): Effect.Effect<ReadonlyArray<GithubCheckSuite>, ActionError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const suites: Array<GithubCheckSuite> = [];
    let request: GithubRequest = {
      method: "GET",
      path: `/repos/${repo}/commits/${sha}/check-suites`,
      query: { per_page: "100" },
      token,
    };
    for (;;) {
      const response = yield* sendGithubRequest(request);
      if (!isSuccessful(response)) {
        return yield* convertGithubFailure(
          response,
          `The commit ${sha} of ${repo}`,
          yield* Clock.currentTimeMillis,
        );
      }
      suites.push(...(yield* decodeCheckSuitePage(response.body)));
      if (response.nextPageUrl === undefined) return suites;
      request = { method: "GET", path: response.nextPageUrl, token };
    }
  });

/** One check suite to run again, and the path of the request that does it. */
interface RerunTarget {
  readonly name: string;
  readonly path: string;
}

/**
 * Returns the request that runs each failed suite again. A GitHub Actions
 * suite goes through its workflow run, so that only the failed jobs run
 * again. Any other app's suite is re-requested, which sends the app a
 * `rerequested` event. Fails with `not_found` when a GitHub Actions suite has
 * no workflow run among the 100 newest of the commit, before anything is sent
 * to re-run a suite.
 */
const planReruns = (
  repo: string,
  sha: string,
  failed: ReadonlyArray<GithubCheckSuite>,
  token: string,
): Effect.Effect<ReadonlyArray<RerunTarget>, ActionError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const runIds = failed.some(isActionsSuite)
      ? yield* Effect.flatMap(
          callGithub(
            {
              method: "GET",
              path: `/repos/${repo}/actions/runs`,
              query: { head_sha: sha, per_page: "100" },
              token,
            },
            `The workflow runs of the commit ${sha} of ${repo}`,
          ),
          decodeWorkflowRunIds,
        )
      : new Map<number, number>();
    const targets: Array<RerunTarget> = [];
    for (const suite of failed) {
      const name = suite.app?.name ?? "an app that is gone";
      if (!isActionsSuite(suite)) {
        targets.push({ name, path: `/repos/${repo}/check-suites/${String(suite.id)}/rerequest` });
        continue;
      }
      const runId = runIds.get(suite.id);
      if (runId === undefined) {
        return yield* new ActionError({
          code: "not_found",
          message: `Found no GitHub Actions workflow run for the failed check suite ${String(suite.id)} on ${sha}, so nothing was re-run.`,
        });
      }
      targets.push({
        name,
        path: `/repos/${repo}/actions/runs/${String(runId)}/rerun-failed-jobs`,
      });
    }
    return targets;
  });

/**
 * Converts the error of one re-run into the step's error. Keeps the code,
 * and says which suite failed and which were already re-run, because those
 * stay re-run.
 */
const explainPartialRerun = (
  error: ActionError,
  failedName: string,
  alreadyRerun: ReadonlyArray<{ readonly name: string }>,
): ActionError =>
  new ActionError({
    code: error.code,
    message: `Could not re-run the checks of ${failedName}. ${
      alreadyRerun.length === 0
        ? "Nothing was re-run before it."
        : `Already re-run, and not undone: ${alreadyRerun.map((suite) => suite.name).join(", ")}.`
    } ${error.message}`,
  });

export const checksRerun = defineGithubAction({
  id: "checks.rerun",
  displayName: "Re-run the failed checks of a GitHub pull request",
  description:
    "Re-runs the checks that failed on a pull request's head commit. GitHub Actions workflows run only their failed jobs again; other apps are asked to run their checks again. With sha, the checks are re-run only if the pull request's branch still points at that commit, otherwise the step fails with the code conflict. The output holds the commit and the apps whose checks were re-run.",
  usableIn: ["workflow.step", "signal.answer"],
  describe: (input) => [
    { kind: "text", text: "Re-runs the failed checks on " },
    ...describeItem(input, "pull request"),
  ],
  outcome: (input) => `Re-ran the failed checks on ${nameItemBriefly(input, "pull request")}`,
  input: Schema.Struct({
    ...PULL_REQUEST_ADDRESS,
    sha: Schema.optionalKey(
      Schema.NonEmptyString.annotate({
        description:
          "The commit whose checks failed. When the pull request's branch has moved on, the step fails with the code conflict.",
      }),
    ),
  }),
  output: ChecksRerun,
  perform: (input, context) =>
    Effect.gen(function* () {
      const token = yield* readConnectionToken(context);
      const head = (yield* fetchPullRequest(input, token)).head.sha;
      if (input.sha !== undefined && input.sha !== head) {
        return yield* new ActionError({
          code: "conflict",
          message: `${describePullRequest(input)} has new commits since the checks failed on ${input.sha}: its branch is now at ${head}. Look at the checks of the new commit instead.`,
        });
      }
      const failed = (yield* fetchCheckSuites(input.repo, head, token)).filter(hasFailed);
      if (failed.length === 0) {
        return yield* new ActionError({
          code: "conflict",
          message: `No checks failed on the head commit ${head} of ${describePullRequest(input)}, so there is nothing to re-run.`,
        });
      }
      const rerun: Array<{ readonly name: string }> = [];
      for (const target of yield* planReruns(input.repo, head, failed, token)) {
        yield* callGithub(
          { method: "POST", path: target.path, token },
          `The check suite of ${target.name}`,
        ).pipe(Effect.mapError((error) => explainPartialRerun(error, target.name, rerun)));
        rerun.push({ name: target.name });
      }
      return { sha: head, rerun };
    }),
});
