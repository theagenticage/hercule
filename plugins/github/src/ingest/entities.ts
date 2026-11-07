/**
 * The `entities` feed: reads the pull requests and issues that concern the
 * user, and the repositories they belong to, and reports them to the host as
 * External Entity observations.
 *
 * A poll has two parts:
 *
 * 1. The inventory. One GraphQL search per concern, paged to the end
 *    (`searchAllPages`). Only when every page of every search was read does
 *    the poll report anything, so a failed page, a rate limit or a restart
 *    reports nothing and takes nothing away.
 * 2. The refresh. The host names the pull requests, issues and repositories
 *    it wants read although they are not in the inventory, such as a pull
 *    request that was merged since and so left the `is:open` searches. One
 *    GraphQL request reads them all (`readEntitiesByRef`).
 *
 * `../entity-reads.ts` does the reading and builds the observations.
 */
import { Effect } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import {
  MAX_ENTITY_OBSERVATIONS,
  PluginError,
  type EntityObservation,
  type IngestEntities,
  type PollResult,
} from "@hercule/plugin-host";
import { ISSUE_KIND, PULL_REQUEST_KIND, REPOSITORY_KIND } from "../entity-kinds";
import {
  buildItemObservation,
  buildRepositoryObservation,
  readEntitiesByRef,
  readSearchPage,
  type EntityConcern,
  type ItemNode,
  type RepositoryNode,
  type SearchPage,
} from "../entity-reads";
import { buildItemRef } from "../subject";
import type { FeedError } from "./requests";

/** How many refs of one kind the poll asks the host for, and reads, each time. */
const WANTED_REFS_PER_KIND = 50;

/** The most results GitHub returns for one page of a search. */
const SEARCH_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------

/** One search per concern, by GitHub's search words. `@me` is the token's account. */
const CONCERN_SEARCHES: ReadonlyArray<{
  readonly qualifier: string;
  readonly concern: EntityConcern;
}> = [
  { qualifier: "is:pr is:open archived:false author:@me", concern: "opened" },
  { qualifier: "is:pr is:open archived:false review-requested:@me", concern: "review-requested" },
  { qualifier: "is:issue is:open archived:false assignee:@me", concern: "assigned" },
];

/** Everything one search found. */
interface SearchResult {
  readonly viewerLogin: string;
  readonly items: ReadonlyArray<ItemNode>;
  /** False when GitHub counted more results than it let the search read: it stops at 1,000. */
  readonly complete: boolean;
}

/**
 * Runs one search and reads every page of it, one request per page.
 * Fails as `readSearchPage` fails, and with a `PluginError` when GitHub says
 * there is another page but gives no cursor for it.
 */
const searchAllPages = (
  token: string,
  qualifier: string,
): Effect.Effect<SearchResult, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const pages: Array<SearchPage> = [];
    let after: string | null | undefined = null;
    while (after !== undefined) {
      const page: SearchPage = yield* readSearchPage(token, {
        query: qualifier,
        first: SEARCH_PAGE_SIZE,
        after,
      });
      pages.push(page);
      const { hasNextPage, endCursor } = page.search.pageInfo;
      if (hasNextPage && endCursor === null) {
        return yield* new PluginError({
          message: "GitHub has another page of search results but gave no cursor for it.",
        });
      }
      after = hasNextPage ? endCursor : undefined;
    }
    const nodes = pages.flatMap((page) => page.search.nodes ?? []);
    return {
      viewerLogin: pages[0]?.viewer.login ?? "",
      items: nodes.flatMap((node) => (node === null ? [] : [node])),
      complete: (pages.at(-1)?.search.issueCount ?? 0) <= nodes.length,
    };
  });

/**
 * Reads every search and reports the result to the host: the repositories
 * first, because the pull requests and issues are part of them, then the
 * pull requests, then the issues. Nothing is reported unless every page of
 * every search was read. A kind is `complete` only when each search that
 * feeds it was.
 */
const reconcileInventory = (
  token: string,
  entities: IngestEntities,
): Effect.Effect<void, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    // A pull request found by two searches is one item with both concerns.
    const found = new Map<string, { node: ItemNode; concerns: Array<EntityConcern> }>();
    let viewerLogin = "";
    let pullRequestsComplete = true;
    let issuesComplete = true;
    for (const { qualifier, concern } of CONCERN_SEARCHES) {
      const result = yield* searchAllPages(token, qualifier);
      viewerLogin = result.viewerLogin;
      for (const node of result.items) {
        const key = buildItemRef({
          repo: node.repository.nameWithOwner,
          kind: node.__typename === "PullRequest" ? "pr" : "issue",
          number: node.number,
        });
        const entry = found.get(key);
        if (entry === undefined) found.set(key, { node, concerns: [concern] });
        else entry.concerns.push(concern);
      }
      if (concern === "assigned") issuesComplete = result.complete;
      else pullRequestsComplete = pullRequestsComplete && result.complete;
    }

    const repositories = new Map<string, RepositoryNode>();
    const pullRequests: Array<EntityObservation> = [];
    const issues: Array<EntityObservation> = [];
    for (const { node, concerns } of found.values()) {
      repositories.set(node.repository.nameWithOwner.toLowerCase(), node.repository);
      (node.__typename === "PullRequest" ? pullRequests : issues).push(
        buildItemObservation(node, viewerLogin, concerns),
      );
    }

    // A complete call empties what the Connection listed before and leaves
    // out now. That holds for the concerns and for the listing itself (a
    // listed record is not asked for again by the refresh). So each kind is
    // reported whole in one call, and a second complete call would unlist
    // what the first one listed.
    //
    // Each search reads at most 1,000 items, so the repositories of three
    // searches can pass the host's limit of one call. The call lists the
    // first ones by name: the same ones every poll, so a repository does not
    // move in and out of the listing. The rest are not listed, so the host
    // wants them read, and the refresh below reads them 50 per poll.
    const repositoryObservations = [...repositories.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, MAX_ENTITY_OBSERVATIONS)
      .map(([, node]) => buildRepositoryObservation(node));
    yield* entities.reconcile({
      kind: REPOSITORY_KIND,
      complete: true,
      observations: repositoryObservations,
    });
    // Pull requests and issues fit in one call each: a search reads at most 1,000
    // items, so the two pull request searches give at most 2,000 (exactly the
    // host's limit) and the issue search at most 1,000.
    yield* entities.reconcile({
      kind: PULL_REQUEST_KIND,
      complete: pullRequestsComplete,
      observations: pullRequests,
    });
    yield* entities.reconcile({ kind: ISSUE_KIND, complete: issuesComplete, observations: issues });
  });

/**
 * Asks the host which pull requests, issues and repositories it wants read
 * now, reads them, and hands over what was found. A ref GitHub cannot show is
 * reported `inaccessible`, never `deleted`, because GitHub answers the same
 * for a thing that is gone and for one the token lost access to.
 */
const refreshWantedEntities = (
  token: string,
  entities: IngestEntities,
): Effect.Effect<void, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const refs: Array<string> = [];
    for (const kind of [PULL_REQUEST_KIND, ISSUE_KIND, REPOSITORY_KIND]) {
      refs.push(...(yield* entities.listWanted(kind, WANTED_REFS_PER_KIND)));
    }
    const { observations, missing } = yield* readEntitiesByRef(token, refs);
    if (observations.length > 0) yield* entities.refresh(observations);
    for (const ref of missing) yield* entities.reportMissing(ref, "inaccessible");
  });

/**
 * Polls the `entities` feed once: reports the inventory, then refreshes what
 * the host wants read. Costs one request per page of each of the three
 * searches, and one more for the refresh when anything is wanted. Fails as
 * `fetchGraphql` fails, and with the host's `PluginError` when it refuses
 * what was reported. The inventory is stored before the refresh starts, so
 * a refresh that fails leaves it in place.
 */
export const pollEntities = (
  token: string,
  entities: IngestEntities,
): Effect.Effect<PollResult, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    yield* reconcileInventory(token, entities);
    yield* refreshWantedEntities(token, entities);
    return {};
  });
