/**
 * Every read of the organization's issue list: the watched set and the
 * inventory (`listIssues`), a batch of issues by id (`lookUpIssues`), and the
 * Add button's search (`findIssues`). All of them return decoded issues.
 *
 * Sentry's list endpoint has quirks that every read here depends on. They are
 * kept in this file so that no caller builds an issue-list request itself:
 *
 * - a page holds at most 100 issues (`limit`);
 * - `groupStatsPeriod` is sent empty, which leaves out the graphs, which are
 *   large and unused. `collapse=stats` would leave them out too, but Sentry
 *   then also drops `firstSeen`, `lastSeen`, `count` and `userCount`, which
 *   every issue needs, so `collapse` is never sent;
 * - Sentry applies its default `is:unresolved` only when `query` is absent, so
 *   an empty `query` returns every status;
 * - `group=<id>` repeats to read issues by id, at most 100 per request;
 * - `shortIdLookup=1` makes a short id in the query a direct hit that comes
 *   back alone, and Sentry then ignores `limit` and returns every match.
 */
import { Effect, Schema } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import {
  callSentry,
  decodeSentryBody,
  readPages,
  type SentryFailure,
  type SentryRequest,
} from "./api";
import type { OrganizationAccess } from "./organization";
import { ApiIssue } from "./sentry-objects";

/** How many issues one page of the list holds: the most Sentry allows. */
const PAGE_SIZE = 100;

/** What a list of issues is asked for. */
export interface IssueSearch {
  /** Sentry's search query. Empty means every status, not only unresolved. */
  readonly query: string;
  /** The order of the list: newest first seen first. */
  readonly sort: "new";
  /** Ids of the projects to list; all projects when absent or empty. */
  readonly projectIds?: ReadonlyArray<string>;
  /** Names of the environments to list; all environments when absent or empty. */
  readonly environments?: ReadonlyArray<string>;
}

const issuesPath = (access: OrganizationAccess): string =>
  `/api/0/organizations/${access.organization.slug}/issues/`;

const buildListRequest = (
  access: OrganizationAccess,
  query: ReadonlyArray<readonly [string, string]>,
): SentryRequest => ({
  method: "GET",
  baseUrl: access.organization.regionUrl,
  path: issuesPath(access),
  token: access.token,
  query,
});

/** Reads one request's answer as a list of issues. */
const readIssueArray = (
  access: OrganizationAccess,
  query: ReadonlyArray<readonly [string, string]>,
): Effect.Effect<ReadonlyArray<ApiIssue>, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* callSentry(buildListRequest(access, query));
    return yield* decodeSentryBody(Schema.Array(ApiIssue), response.body, issuesPath(access));
  });

/**
 * Lists the issues `search` matches, following pages until the list ends or
 * `maxIssues` issues are read. Whole pages are read, so the result may hold
 * up to one page more than `maxIssues`. `hasMore` is true when Sentry had
 * more issues than were read. Fails as `readPages` does, so a failed page
 * returns nothing.
 */
export const listIssues = (
  access: OrganizationAccess,
  search: IssueSearch,
  maxIssues: number,
): Effect.Effect<
  { readonly issues: ReadonlyArray<ApiIssue>; readonly hasMore: boolean },
  SentryFailure,
  HttpClient.HttpClient
> =>
  Effect.map(
    readPages(
      buildListRequest(access, [
        ["query", search.query],
        ["sort", search.sort],
        ["limit", String(PAGE_SIZE)],
        ["groupStatsPeriod", ""],
        ...(search.projectIds ?? []).map((id) => ["project", id] as const),
        ...(search.environments ?? []).map((name) => ["environment", name] as const),
      ]),
      ApiIssue,
      Math.ceil(maxIssues / PAGE_SIZE),
    ),
    ({ items, hasMore }) => ({ issues: items, hasMore }),
  );

/**
 * Looks up issues by id, whatever their status, and returns the ones Sentry
 * still has by id. An id missing from the result was deleted or merged. Sends
 * one request per 100 ids.
 */
export const lookUpIssues = (
  access: OrganizationAccess,
  ids: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, ApiIssue>, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const found = new Map<string, ApiIssue>();
    for (let start = 0; start < ids.length; start += PAGE_SIZE) {
      const issues = yield* readIssueArray(access, [
        ["query", ""],
        ["limit", String(PAGE_SIZE)],
        ["groupStatsPeriod", ""],
        ...ids.slice(start, start + PAGE_SIZE).map((id) => ["group", id] as const),
      ]);
      for (const issue of issues) found.set(issue.id, issue);
    }
    return found;
  });

/**
 * Searches the organization's issues for `text`, whatever their status, and
 * returns at most `limit` of them. A short id in `text` comes back alone.
 * Reads one page only: `limit` above the page size reads the page size. The
 * result is cut to `limit` here because Sentry ignores it for a short id.
 */
export const findIssues = (
  access: OrganizationAccess,
  text: string,
  limit: number,
): Effect.Effect<ReadonlyArray<ApiIssue>, SentryFailure, HttpClient.HttpClient> =>
  Effect.map(
    readIssueArray(access, [
      ["query", text],
      ["shortIdLookup", "1"],
      ["limit", String(Math.min(limit, PAGE_SIZE))],
      ["groupStatsPeriod", ""],
    ]),
    (issues) => issues.slice(0, limit),
  );
