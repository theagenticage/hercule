/**
 * The small objects GitHub embeds in its issues, pull requests and reviews,
 * and the verdict of a review, which the feeds and the workflow actions read
 * the same way.
 *
 * The issue, pull request, review and comment around them are not here: the
 * feeds and the actions read different fields of them, from different
 * endpoints, so each keeps its own schema (`ingest/feed-objects.ts` and
 * `actions/objects.ts`).
 */
import { Schema } from "effect";

/** An account, as GitHub embeds one in another object. */
export const GithubAccount = Schema.Struct({ login: Schema.String });

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
