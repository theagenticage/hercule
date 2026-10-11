/**
 * The small objects GitHub embeds in its issues, pull requests and reviews,
 * the check suites and check runs on a commit, and the verdict of a review,
 * which the feeds, the signal kinds and the workflow actions read the same way.
 *
 * The issue, pull request, review and comment around them are not here: the
 * feeds and the actions read different fields of them, from different
 * endpoints, so each keeps its own schema (`ingest/feed-objects.ts` and
 * `actions/objects.ts`).
 */
import { Schema } from "effect";

/**
 * An account, as GitHub embeds one in another object. The numeric `id` stays
 * the same when the account is renamed; GitHub sends it everywhere but in a
 * few older payloads.
 */
export const GithubAccount = Schema.Struct({
  login: Schema.String,
  id: Schema.optionalKey(Schema.Number),
  avatar_url: Schema.optionalKey(Schema.String),
});

export type GithubAccount = Schema.Schema.Type<typeof GithubAccount>;

/** A list of accounts. GitHub sends null in place of an empty list in some responses. */
export const GithubAccounts = Schema.NullOr(Schema.Array(GithubAccount));

export type GithubAccounts = Schema.Schema.Type<typeof GithubAccounts>;

/** A label, as GitHub embeds one in an issue or a pull request. */
export const GithubLabel = Schema.Struct({ name: Schema.String });

/**
 * The verdict of a submitted review, in the words the plugin uses: the
 * `verdict` of the `github.pr.review-submitted` event, and of the review
 * `pr.review` returns.
 */
export const ReviewVerdict = Schema.Literals(["approved", "changes-requested", "commented"]);

export type ReviewVerdict = Schema.Schema.Type<typeof ReviewVerdict>;

/**
 * Converts the `state` GitHub gives a review into the review's verdict.
 * Returns undefined for a review that has no verdict: one that is still
 * pending, or was dismissed.
 */
export const readReviewVerdict = (state: string): ReviewVerdict | undefined => {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "COMMENTED":
      return "commented";
    default:
      return undefined;
  }
};

/** The app that ran a check suite or a check run; `slug` is `github-actions` for GitHub Actions. */
export const GithubApp = Schema.Struct({ name: Schema.String, slug: Schema.String });

/**
 * One check suite on a commit, as an entry of the `check_suites` list that
 * `GET /repos/{owner}/{repo}/commits/{sha}/check-suites` returns. `app` is
 * null for a suite whose app was deleted.
 */
export const GithubCheckSuite = Schema.Struct({
  id: Schema.Int,
  status: Schema.NullOr(Schema.String),
  conclusion: Schema.NullOr(Schema.String),
  updated_at: Schema.NullOr(Schema.String),
  latest_check_runs_count: Schema.Int,
  app: Schema.NullOr(GithubApp),
});

export type GithubCheckSuite = Schema.Schema.Type<typeof GithubCheckSuite>;

/**
 * One check run on a commit, as an entry of the `check_runs` list that
 * `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` returns. `output`
 * holds what the check reported: `summary` and `text` are markdown, and
 * `annotations_count` says how many annotations
 * `GET .../check-runs/{id}/annotations` lists.
 */
export const ListedCheckRun = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.NullOr(Schema.String),
  app: Schema.NullOr(GithubApp),
  output: Schema.Struct({
    title: Schema.NullOr(Schema.String),
    summary: Schema.NullOr(Schema.String),
    text: Schema.NullOr(Schema.String),
    annotations_count: Schema.Int,
  }),
});

export type ListedCheckRun = Schema.Schema.Type<typeof ListedCheckRun>;

/** The conclusions of a finished check that need nobody's attention. */
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

/**
 * Checks whether a check run or a check suite concluded in a way that needs
 * attention, such as `failure`, `timed_out`, `cancelled` or
 * `action_required`. A check that has not concluded yet has a null
 * conclusion and has not failed.
 */
export const isFailedConclusion = (conclusion: string | null): boolean =>
  conclusion !== null && !PASSING_CONCLUSIONS.has(conclusion);

/** Checks whether a check run or a check suite concluded `success`, `neutral` or `skipped`. */
export const isPassingConclusion = (conclusion: string | null): boolean =>
  conclusion !== null && PASSING_CONCLUSIONS.has(conclusion);
