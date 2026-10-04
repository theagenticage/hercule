/**
 * The small objects GitHub embeds in its issues, pull requests and reviews,
 * which the feeds and the workflow actions read the same way.
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

/** A label, as GitHub embeds one in an issue or a pull request. */
export const GithubLabel = Schema.Struct({ name: Schema.String });
