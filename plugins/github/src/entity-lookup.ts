/**
 * How the Add button on Work finds GitHub things: it recognizes a pull
 * request or issue in pasted text, searches GitHub by words, and reads one
 * item. The observations it returns are the ones the `entities` feed reports
 * (`entity-reads.ts`), so a thing reads the same whichever way it was found.
 */
import { Effect } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import {
  PluginError,
  type AuthError,
  type EntityLookup,
  type EntityLookupContext,
  type EntityObservation,
  type EntityRecognition,
  type EntityResolution,
} from "@hercule/plugin-host";
import { ISSUE_KIND, PULL_REQUEST_KIND } from "./entity-kinds";
import {
  buildItemObservation,
  readEntitiesByRef,
  readSearchPage,
  readTargets,
} from "./entity-reads";
import { readConnectionToken } from "./ingest";
import type { FeedError } from "./ingest/requests";
import { REPO_NAME_PATTERN } from "./repo-name";
import { buildItemPlace, buildItemRef, parseRepoRef } from "./subject";

/** The most things `recognize` returns for one text. */
const MAX_RECOGNITIONS = 20;

/**
 * Matches, in order, the two ways a text names one item: a web address
 * (`https://github.com/owner/repo/pull/87`, or `/issues/87`) and an
 * identifier (`owner/repo#87`). The identifier may not start inside a longer
 * path, so the `owner/repo` of an address is not read twice. An item number
 * has at most nine digits, which GraphQL's `Int` can hold.
 */
const MENTION = new RegExp(
  `https://github\\.com/(${REPO_NAME_PATTERN})/(pull|issues)/(\\d{1,9})(?!\\d)` +
    `|(?<![\\w/.-])(${REPO_NAME_PATTERN})#(\\d{1,9})(?!\\d)`,
  "gi",
);

/**
 * Returns the pull requests and issues `text` names, in order, each once, at
 * most 20. A web address names a pull request or an issue. `owner/repo#87`
 * names one or the other, and only a read can tell which, so it is a scoped
 * recognition without a kind. A bare `#87` names nothing without a
 * repository. Reads no page and needs no credentials.
 */
export const recognizeGithubItems = (text: string): ReadonlyArray<EntityRecognition> => {
  const recognitions: Array<EntityRecognition> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    if (recognitions.length === MAX_RECOGNITIONS) break;
    const [, urlRepo, urlKind, urlNumber, idRepo, idNumber] = match;
    const recognition: EntityRecognition =
      urlRepo !== undefined
        ? {
            recognized: "ref",
            form: "url",
            ref: buildItemRef({
              repo: urlRepo,
              kind: urlKind?.toLowerCase() === "pull" ? "pr" : "issue",
              number: Number(urlNumber),
            }),
            kind: urlKind?.toLowerCase() === "pull" ? PULL_REQUEST_KIND : ISSUE_KIND,
          }
        : {
            recognized: "scoped",
            form: "identifier",
            identifier: buildItemPlace({ repo: idRepo ?? "", number: Number(idNumber) }),
          };
    const key = recognition.recognized === "ref" ? recognition.ref : recognition.identifier;
    if (seen.has(key)) continue;
    seen.add(key);
    recognitions.push(recognition);
  }
  return recognitions;
};

/** The most results GitHub returns for one search request. */
const MAX_SEARCH_RESULTS = 100;

/** A text that is only an item number, such as `#87` or `87`. */
const ITEM_NUMBER = /^#?(\d{1,9})$/;

/** A scoped recognition's identifier, such as `owner/repo#87`. */
const ITEM_IDENTIFIER = new RegExp(`^(${REPO_NAME_PATTERN})#(\\d{1,9})$`);

/**
 * Searches issues and pull requests by words, at most `limit`. With a
 * `scopeRef`, the search is narrowed to that repository. A text that is only
 * an item number, such as `#87`, reads that item in the scope instead, since
 * a search for a number finds nothing useful. Fails as `fetchGraphql` fails,
 * and with a `PluginError` when `scopeRef` is not a repository's ref.
 */
export const searchItems = (
  token: string,
  query: { readonly text: string; readonly scopeRef?: string; readonly limit: number },
): Effect.Effect<ReadonlyArray<EntityObservation>, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const scope = query.scopeRef === undefined ? undefined : parseRepoRef(query.scopeRef);
    if (query.scopeRef !== undefined && scope === undefined) {
      return yield* new PluginError({
        message: `GitHub can search only inside a repository, and ${query.scopeRef} is not a repository's ref.`,
      });
    }
    const itemNumber = ITEM_NUMBER.exec(query.text.trim())?.[1];
    if (scope !== undefined && itemNumber !== undefined) {
      const [item] = yield* readTargets(token, [
        { kind: "item", repo: scope, number: Number(itemNumber) },
      ]);
      return item === undefined ? [] : [item];
    }
    const text = scope === undefined ? query.text : `${query.text} repo:${scope}`;
    const page = yield* readSearchPage(token, {
      query: text,
      first: Math.min(query.limit, MAX_SEARCH_RESULTS),
      after: null,
    });
    // GitHub reads two `repo:` qualifiers as "either", so a `repo:` the user typed
    // would widen the search past the scope. Only items of the scope are kept.
    return (page.search.nodes ?? [])
      .flatMap((node) =>
        node === null ||
        (scope !== undefined && node.repository.nameWithOwner.toLowerCase() !== scope)
          ? []
          : [buildItemObservation(node, page.viewer.login, [])],
      )
      .slice(0, query.limit);
  });

/**
 * Reads the item a recognition names. Returns `missing: "unknown"` when
 * GitHub answers `null`, because GitHub says the same for an item that does
 * not exist and for one the token may not see. Fails as `fetchGraphql`
 * fails, and with a `PluginError` for a scoped recognition that is not
 * `owner/repo#number`.
 */
export const resolveItem = (
  token: string,
  target: EntityRecognition,
): Effect.Effect<EntityResolution, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (target.recognized === "ref") {
      const { observations } = yield* readEntitiesByRef(token, [target.ref]);
      const found = observations[0];
      return found === undefined ? { missing: "unknown" as const } : { found };
    }
    const match = ITEM_IDENTIFIER.exec(target.identifier);
    if (match === null) {
      return yield* new PluginError({
        message: `GitHub reads an item written owner/repo#number, and ${target.identifier} is not.`,
      });
    }
    const [found] = yield* readTargets(token, [
      { kind: "item", repo: match[1]!.toLowerCase(), number: Number(match[2]) },
    ]);
    return found === undefined ? { missing: "unknown" as const } : { found };
  });

/**
 * Runs `use` with the Connection's token and a fetch client. A rate limit is
 * a `PluginError` here, because a lookup has no way to wait.
 */
const withToken = <A>(
  context: EntityLookupContext,
  use: (token: string) => Effect.Effect<A, FeedError, HttpClient.HttpClient>,
): Effect.Effect<A, AuthError | PluginError> =>
  readConnectionToken(context).pipe(
    Effect.flatMap(use),
    Effect.catchTag("GithubRateLimited", (limit) =>
      Effect.fail(
        new PluginError({
          message: `GitHub is limiting how fast this Connection may ask. Try again in ${String(limit.retryAfterSeconds)} seconds.`,
        }),
      ),
    ),
    Effect.provide(FetchHttpClient.layer),
  );

export const githubEntityLookup: EntityLookup = {
  recognize: recognizeGithubItems,
  search: (_connection, context, query) => withToken(context, (token) => searchItems(token, query)),
  resolve: (_connection, context, target) =>
    withToken(context, (token) => resolveItem(token, target)),
};
