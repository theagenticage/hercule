/**
 * Reads the issues the `issues` feed watches: the set the filter matches, and
 * the issues that were in the set at the last poll and may have left it.
 */
import { Effect, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { PluginError } from "@hercule/plugin-host";
import { callSentry, decodeSentryBody, readPages, type SentryFailure } from "../api";
import { MAX_LIST_PAGES, type OrganizationAccess } from "../organization";
import { ApiIssue } from "../sentry-objects";
import type { ResolvedFilter } from "./filter";

/** How many issues one page of the list holds: the most Sentry allows. */
const PAGE_SIZE = 100;

/** The most issues the feed watches: `MAX_LIST_PAGES` pages. A poll that finds more fails. */
export const MAX_WATCHED_ISSUES = PAGE_SIZE * MAX_LIST_PAGES;

/**
 * Parameters every issue list asks for. An empty `groupStatsPeriod` leaves out
 * the graphs, which are large and unused. `collapse=stats` would leave them
 * out too, but Sentry then also drops `firstSeen`, `lastSeen`, `count` and
 * `userCount`, which every issue needs, so it is never sent.
 */
const LIST_PARAMETERS: ReadonlyArray<readonly [string, string]> = [
  ["limit", String(PAGE_SIZE)],
  ["groupStatsPeriod", ""],
];

const issuesPath = (access: OrganizationAccess): string =>
  `/api/0/organizations/${access.organization.slug}/issues/`;

/**
 * Lists the issues the filter matches, newest first seen first. Fails with a
 * `PluginError` when the filter matches more than `MAX_WATCHED_ISSUES`,
 * because a partial list would look as if the rest had left the set. The
 * message tells the user to narrow the filters. Otherwise fails as
 * `readPages` does.
 */
export const listWatchedIssues = (
  access: OrganizationAccess,
  filter: ResolvedFilter,
): Effect.Effect<ReadonlyArray<ApiIssue>, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const listed = yield* readPages(
      {
        method: "GET",
        baseUrl: access.organization.regionUrl,
        path: issuesPath(access),
        token: access.token,
        query: [
          ["query", filter.query],
          ["sort", "new"],
          ...LIST_PARAMETERS,
          ...filter.projectIds.map((id) => ["project", id] as const),
          ...filter.environments.map((name) => ["environment", name] as const),
        ],
      },
      ApiIssue,
      MAX_LIST_PAGES,
    );
    if (listed.hasMore) {
      return yield* new PluginError({
        message: `The Connection's filters match more than ${String(MAX_WATCHED_ISSUES)} issues. Narrow them in the Connection's settings, so the feed can watch every issue they match.`,
      });
    }
    return listed.items;
  });

/**
 * Looks up issues by id, whatever their status, and returns the ones Sentry
 * still has by id. An id missing from the result was deleted or merged.
 *
 * The search query is sent empty on purpose: with a query, Sentry applies its
 * default `is:unresolved` and would not return a resolved issue.
 */
export const lookUpIssues = (
  access: OrganizationAccess,
  ids: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, ApiIssue>, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const found = new Map<string, ApiIssue>();
    for (let start = 0; start < ids.length; start += PAGE_SIZE) {
      const response = yield* callSentry({
        method: "GET",
        baseUrl: access.organization.regionUrl,
        path: issuesPath(access),
        token: access.token,
        query: [
          ["query", ""],
          ...LIST_PARAMETERS,
          ...ids.slice(start, start + PAGE_SIZE).map((id) => ["group", id] as const),
        ],
      });
      const issues = yield* decodeSentryBody(
        Schema.Array(ApiIssue),
        response.body,
        issuesPath(access),
      );
      for (const issue of issues) found.set(issue.id, issue);
    }
    return found;
  });
