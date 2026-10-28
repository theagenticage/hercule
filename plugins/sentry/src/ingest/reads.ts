/**
 * The two reads about one issue that the list does not hold: its activity
 * (when it came back) and its newest event (what it looks like now). Each is
 * one request, and the poll caps how many it makes.
 */
import { Effect } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import { callSentry, decodeSentryBody, type SentryFailure } from "../api";
import type { LatestEvent } from "../kinds";
import type { OrganizationAccess } from "../organization";
import {
  ApiIssueDetail,
  ApiLatestEvent,
  buildLatestEvent,
  listRegressions,
  type Regression,
} from "../sentry-objects";

const issuePath = (access: OrganizationAccess, issueId: string): string =>
  `/api/0/organizations/${access.organization.slug}/issues/${issueId}/`;

/**
 * Reads the times an issue came back after it was resolved or archived,
 * oldest first. Returns none when Sentry no longer has the issue (a 404), so
 * an issue deleted between the list and this read does not fail the poll.
 */
export const readRegressions = (
  access: OrganizationAccess,
  issueId: string,
): Effect.Effect<ReadonlyArray<Regression>, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const path = issuePath(access, issueId);
    const response = yield* callSentry(
      { method: "GET", baseUrl: access.organization.regionUrl, path, token: access.token },
      [404],
    );
    if (response.status === 404) return [];
    return listRegressions(yield* decodeSentryBody(ApiIssueDetail, response.body, path));
  });

/**
 * Reads an issue's newest event. Returns undefined when Sentry has none (a
 * 404), such as for an issue whose events were all deleted: the event that
 * announces the issue is then emitted without it. `fallbackDate` stands in
 * for an event that has no date.
 */
export const readLatestEvent = (
  access: OrganizationAccess,
  issueId: string,
  fallbackDate: string,
): Effect.Effect<LatestEvent | undefined, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const path = `${issuePath(access, issueId)}events/latest/`;
    const response = yield* callSentry(
      { method: "GET", baseUrl: access.organization.regionUrl, path, token: access.token },
      [404],
    );
    if (response.status === 404) return undefined;
    return buildLatestEvent(
      yield* decodeSentryBody(ApiLatestEvent, response.body, path),
      fallbackDate,
    );
  });
