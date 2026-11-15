/**
 * The `entities` feed: reports the issues that concern the user to the host as
 * External Entity observations.
 *
 * A poll has two parts:
 *
 * 1. The inventory: one issue search, `is:unresolved assigned:[me, my_teams]
 *    lastSeen:-<lastSeenDays>d`, newest first seen first, paged up to
 *    `MAX_ENTITY_OBSERVATIONS`. It ignores the Connection's `assignees`,
 *    `projects` and `environments`, which decide events only, and honours only
 *    `lastSeenDays`, the user's own setting for how far back an error counts.
 * 2. The refresh: issues the host wants read although the inventory did not
 *    list them, such as a resolved one, read by id.
 *
 * Nothing is reported for the inventory unless every page it asks for was read, so a
 * failed page or a rate limit takes nothing away.
 */
import { Effect } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import {
  MAX_ENTITY_OBSERVATIONS,
  type EntityObservation,
  type IngestEntities,
  type PollResult,
} from "@hercule/plugin-host";
import { readPages, type SentryFailure } from "../api";
import { ISSUE_KIND } from "../entity-kinds";
import {
  buildIssueObservation,
  isDeletedInSentry,
  readIssueObservationContext,
  type IssueObservationContext,
} from "../entity-reads";
import type { OrganizationAccess } from "../organization";
import { parseIssueRef } from "../refs";
import { ApiIssue } from "../sentry-objects";
import { issuesPath, LIST_PARAMETERS, lookUpIssues, PAGE_SIZE } from "./list";

/** How many wanted refs the poll asks the host for, and reads, each time. */
const WANTED_REFS = 100;

/** What the poll needs to know about the user and the Connection's setting. */
export interface EntitiesPollInput {
  /** The id of the Sentry user the Connection belongs to. */
  readonly userId: string;
  /** How many days back the inventory looks for an event. */
  readonly lastSeenDays: number;
}

/**
 * Reads the inventory and reports it in one `reconcile` call. When Sentry has
 * more issues than the host takes, the poll reports the ones first seen most
 * recently, a stable subset, with `complete: false`. An issue listed twice
 * (a merge between two pages can do that) is reported once. Fails as
 * `readPages` does, before anything is reported.
 */
const reconcileInventory = (
  access: OrganizationAccess,
  lastSeenDays: number,
  context: IssueObservationContext,
  entities: IngestEntities,
): Effect.Effect<void, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const listed = yield* readPages(
      {
        method: "GET",
        baseUrl: access.organization.regionUrl,
        path: issuesPath(access),
        token: access.token,
        query: [
          ["query", `is:unresolved assigned:[me, my_teams] lastSeen:-${String(lastSeenDays)}d`],
          ["sort", "new"],
          ...LIST_PARAMETERS,
        ],
      },
      ApiIssue,
      MAX_ENTITY_OBSERVATIONS / PAGE_SIZE,
    );
    // The core refuses a reconcile that lists a ref twice. An issue Sentry is
    // deleting just stays out of the inventory.
    const uniqueIssues = [...new Map(listed.items.map((issue) => [issue.id, issue])).values()];
    const observations = uniqueIssues
      .flatMap((issue) => {
        const observation = buildIssueObservation(issue, context, ["assigned"]);
        return observation === undefined ? [] : [observation];
      })
      .slice(0, MAX_ENTITY_OBSERVATIONS);
    // A complete call is the whole kind: a second complete call for the same
    // kind would unlist what the first one listed.
    yield* entities.reconcile({
      kind: ISSUE_KIND,
      complete: !listed.hasMore,
      observations,
    });
  });

/**
 * Reads the issues the host wants and hands over what was found. A ref this
 * organization cannot read (not an issue ref, or another organization's) is
 * reported `inaccessible` without a request. So is an issue Sentry does not
 * return: the list leaves out issues the token cannot see, so absence is not
 * proof of deletion. An issue Sentry says it is deleting or merging
 * (`isDeletedInSentry`) is reported `deleted`. An issue being reprocessed is
 * reported as nothing: that is temporary, and the host wants it again.
 */
const refreshWantedIssues = (
  access: OrganizationAccess,
  context: IssueObservationContext,
  entities: IngestEntities,
): Effect.Effect<void, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const wanted = yield* entities.listWanted(ISSUE_KIND, WANTED_REFS);
    const readable = new Map<string, string>();
    for (const ref of wanted) {
      const parsed = parseIssueRef(ref);
      if (parsed !== undefined && parsed.organizationId === access.organization.id) {
        readable.set(parsed.issueId, ref);
      } else {
        yield* entities.reportMissing(ref, "inaccessible");
      }
    }
    if (readable.size === 0) return;
    const found = yield* lookUpIssues(access, [...readable.keys()]);
    const refreshed: Array<EntityObservation> = [];
    for (const [id, ref] of readable) {
      const issue = found.get(id);
      if (issue === undefined) {
        yield* entities.reportMissing(ref, "inaccessible");
      } else if (isDeletedInSentry(issue)) {
        yield* entities.reportMissing(ref, "deleted");
      } else {
        const observation = buildIssueObservation(issue, context, []);
        if (observation !== undefined) refreshed.push(observation);
      }
    }
    // At most WANTED_REFS observations, well under what the host takes at once.
    if (refreshed.length > 0) yield* entities.refresh(refreshed);
  });

/**
 * Polls the `entities` feed once: reports the inventory, then refreshes what
 * the host wants read. Returns an empty `PollResult`. Fails as `callSentry`
 * does, and with the host's `PluginError` when it refuses what was reported.
 * The inventory is stored before the refresh starts, so a refresh that fails
 * leaves it in place.
 *
 * The cost of a poll, with the organization lookup the caller has already
 * made: one request for the projects (their teams), one per page of 100
 * issues of the inventory, and one per 100 wanted issues. Never one request
 * per issue.
 */
export const pollSentryEntities = (
  access: OrganizationAccess,
  input: EntitiesPollInput,
  entities: IngestEntities,
): Effect.Effect<PollResult, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const context = yield* readIssueObservationContext(access, input.userId);
    yield* reconcileInventory(access, input.lastSeenDays, context, entities);
    yield* refreshWantedIssues(access, context, entities);
    return {};
  });
