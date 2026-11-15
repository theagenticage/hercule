/**
 * Reads the issues the `issues` feed watches: the set the filter matches.
 */
import { Effect } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import { PluginError } from "@hercule/plugin-host";
import type { SentryFailure } from "../api";
import { listIssues } from "../issue-list";
import type { OrganizationAccess } from "../organization";
import type { ApiIssue } from "../sentry-objects";
import type { ResolvedFilter } from "./filter";

/** The most issues the feed watches. A poll that finds more fails. */
export const MAX_WATCHED_ISSUES = 1000;

/**
 * Lists the issues the filter matches, newest first seen first. Fails with a
 * `PluginError` when the filter matches more than `MAX_WATCHED_ISSUES`,
 * because a partial list would look as if the rest had left the set. The
 * message tells the user to narrow the filters. Otherwise fails as
 * `listIssues` does.
 */
export const listWatchedIssues = (
  access: OrganizationAccess,
  filter: ResolvedFilter,
): Effect.Effect<ReadonlyArray<ApiIssue>, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const listed = yield* listIssues(
      access,
      {
        query: filter.query,
        sort: "new",
        projectIds: filter.projectIds,
        environments: filter.environments,
      },
      MAX_WATCHED_ISSUES,
    );
    if (listed.hasMore) {
      return yield* new PluginError({
        message: `The Connection's filters match more than ${String(MAX_WATCHED_ISSUES)} issues. Narrow them in the Connection's settings, so the feed can watch every issue they match.`,
      });
    }
    return listed.issues;
  });
