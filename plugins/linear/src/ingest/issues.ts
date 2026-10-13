/**
 * One poll of the `issues` feed. It checks the config, lists the issues the
 * Connection's filters match (the watched set), compares the set with the one
 * the last poll stored, and emits an event for each change:
 *
 * - `linear.issue.entered`: an issue joined the set;
 * - `linear.issue.changed`: an issue in the set changed in a compared field;
 * - `linear.issue.closed`: an issue left the set because it closed, was
 *   archived or trashed, or is gone; or a followed issue closed;
 * - `linear.issue.left`: an issue left the set but is still open;
 * - `linear.issue.unassigned`: an issue with an open `linear/assigned` signal
 *   is no longer assigned to the user.
 *
 * A followed issue is one the Connection has an open `linear/mention` or
 * `linear/assigned` signal on. It may be outside the watched set, and it
 * raises only `closed` and `unassigned`.
 *
 * A poll first emits the events an earlier poll left in the outbox. It then
 * reads everything, computes its events, checks each against the host's
 * limits, writes the new state and those events in one write, emits them, and
 * empties the outbox. A poll that fails before that write leaves the state as
 * it was and has emitted nothing; one that fails after it loses nothing,
 * because the next poll emits the outbox again.
 */
import { Clock, Effect, Option } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import {
  checkEmittedEvent,
  PluginError,
  type AuthError,
  type EmittedEvent,
  type IngestContext,
  type PollResult,
} from "@hercule/plugin-host";
import { MAX_PAGE_SIZE, readPages, type LinearRateLimited } from "../api";
import type { LinearConnectionConfig } from "../connection-type";
import type { IssueBlock, IssueChanges, WorkspaceBlock } from "../kinds";
import {
  ApiIssue,
  buildDescription,
  buildIssueBlock,
  decideClosedHow,
  ISSUE_FRAGMENT,
} from "../linear-objects";
import { LINEAR_EVENT_KINDS } from "../kinds";
import { buildIssueEvent, buildIssueRef } from "./events";
import { buildWatchFilter, checkConfiguredValues } from "./filter";
import {
  ISSUES_STATE,
  readFeedState,
  writeFeedState,
  type FollowedIssue,
  type OutboxEvent,
} from "./state";

/** The most pages of the watched set a poll reads: 1,000 issues. */
const MAX_WATCHED_PAGES = 4;

/** The signal kinds whose issues the feed follows. */
const MENTION_SIGNAL_KIND = "linear/mention";
const ASSIGNED_SIGNAL_KIND = "linear/assigned";

/** The query that lists the watched set. */
const WATCHED_QUERY = `query LinearWatchedIssues($filter: IssueFilter, $first: Int, $after: String) {
  issues(filter: $filter, first: $first, after: $after) {
    nodes { ...IssueFields }
    pageInfo { hasNextPage endCursor }
  }
}
${ISSUE_FRAGMENT}`;

/** The query that looks issues up by id, archived and trashed ones included. */
const LOOKUP_QUERY = `query LinearIssueLookup($filter: IssueFilter, $first: Int, $after: String) {
  issues(filter: $filter, first: $first, after: $after, includeArchived: true) {
    nodes { ...IssueFields }
    pageInfo { hasNextPage endCursor }
  }
}
${ISSUE_FRAGMENT}`;

/** The fields of an issue a poll compares, each a key of `IssueChanges`. */
const COMPARED_FIELDS = [
  "title",
  "state",
  "assignee",
  "priority",
  "labels",
  "project",
  "projectMilestone",
  "dueDate",
] as const;

/**
 * Returns the compared fields that differ between two versions of an issue,
 * each with its value before and after. Values are compared as JSON, so a
 * renamed label or state counts as a change too.
 */
export const compareIssues = (before: IssueBlock, after: IssueBlock): IssueChanges => {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of COMPARED_FIELDS) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      changes[field] = { from: before[field], to: after[field] };
    }
  }
  return changes;
};

/**
 * Returns the ids of the issues the Connection's open signals follow, with
 * whether a `linear/assigned` signal is among them. A thread of another
 * workspace or of something other than an issue is left out.
 */
const readFollowedIssueIds = (
  workspace: WorkspaceBlock,
  signals: ReadonlyArray<{ readonly kind: string; readonly threadRef: string }>,
): Map<string, { assigned: boolean }> => {
  const prefix = buildIssueRef(workspace, "");
  const followed = new Map<string, { assigned: boolean }>();
  for (const signal of signals) {
    if (signal.kind !== MENTION_SIGNAL_KIND && signal.kind !== ASSIGNED_SIGNAL_KIND) continue;
    if (!signal.threadRef.startsWith(prefix)) continue;
    const id = signal.threadRef.slice(prefix.length);
    const assigned = signal.kind === ASSIGNED_SIGNAL_KIND || followed.get(id)?.assigned === true;
    followed.set(id, { assigned });
  }
  return followed;
};

/**
 * Polls the `issues` feed once with the `Authorization` header
 * `authorization`. Returns an empty result. Fails with an `AuthError` when
 * Linear refuses the credential, with `LinearRateLimited` when it rate limits
 * the poll, and with a `PluginError` when:
 *
 * - a team, project, milestone, label or user in the config no longer exists;
 * - the filters match more than 1,000 issues;
 * - Linear fails or answers in a shape the plugin does not know;
 * - the stored state cannot be read, an event fails the host's limits, or an
 *   event cannot be emitted.
 */
export const pollLinearIssues = (
  authorization: string,
  config: LinearConnectionConfig,
  context: IngestContext,
): Effect.Effect<PollResult, AuthError | PluginError | LinearRateLimited, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const pollTime = new Date(yield* Clock.currentTimeMillis).toISOString();
    const stored = yield* readFeedState(context.state, ISSUES_STATE);
    // What an earlier poll wrote but may not have emitted. The state keeps it
    // until this poll writes its own, so a failure from here on emits it again.
    if (Option.isSome(stored)) {
      yield* Effect.forEach(stored.value.outbox, context.emit, { discard: true });
    }
    const { workspace, userId } = yield* checkConfiguredValues(authorization, config);
    const watchFilter = buildWatchFilter(config);
    const watched = yield* readPages(
      authorization,
      {
        name: "LinearWatchedIssues",
        text: WATCHED_QUERY,
        variables: { filter: watchFilter.filter },
      },
      "issues",
      ApiIssue,
      MAX_WATCHED_PAGES,
    );
    if (watched.hasMore) {
      // A partial set is never compared: every issue left out would look as if it left.
      return yield* new PluginError({
        message:
          "The Connection's filters match more than 1,000 Linear issues. Narrow them in the Connection's settings.",
      });
    }
    const listed = new Map(watched.items.map((issue) => [issue.id, issue]));
    if (Option.isNone(stored)) {
      // The first poll only learns the set: the Connection starts from now on.
      yield* writeFeedState(context.state, ISSUES_STATE, {
        filter: watchFilter.fingerprint,
        issues: Object.fromEntries(
          watched.items.map((issue) => [issue.id, buildIssueBlock(issue)]),
        ),
        followed: {},
        outbox: [],
      });
      return {};
    }
    const state = stored.value;
    const followedIds = readFollowedIssueIds(workspace, yield* context.openSignals());

    // Look up, in one query, the issues that left the set and the followed
    // issues outside it, to learn what became of them.
    const lookupIds = [
      ...new Set([
        ...Object.keys(state.issues).filter((id) => !listed.has(id)),
        ...[...followedIds.keys()].filter((id) => !listed.has(id)),
      ]),
    ];
    const lookedUp =
      lookupIds.length === 0
        ? new Map<string, ApiIssue>()
        : new Map(
            (yield* readPages(
              authorization,
              {
                name: "LinearIssueLookup",
                text: LOOKUP_QUERY,
                variables: { filter: { id: { in: lookupIds } } },
              },
              "issues",
              ApiIssue,
              Math.ceil(lookupIds.length / MAX_PAGE_SIZE),
            )).items.map((issue) => [issue.id, issue]),
          );

    const events = new Map<string, EmittedEvent>();
    const addEvent = (
      kind: Parameters<typeof buildIssueEvent>[0]["kind"],
      issue: IssueBlock,
      fields: Record<string, unknown>,
    ) => {
      const event = buildIssueEvent({ kind, workspace, issue, userId, fields, pollTime });
      events.set(event.dedupKey, event);
    };

    // A poll whose filter differs from the stored one records the issues
    // that entered without an event, so a wider filter does not flood Intake.
    const filterChanged = state.filter !== watchFilter.fingerprint;
    for (const issue of watched.items) {
      const block = buildIssueBlock(issue);
      const before = state.issues[issue.id];
      if (before === undefined) {
        if (!filterChanged) {
          addEvent("linear.issue.entered", block, { description: buildDescription(issue) });
        }
        continue;
      }
      const changes = compareIssues(before, block);
      if (Object.keys(changes).length > 0) addEvent("linear.issue.changed", block, { changes });
    }
    for (const [id, before] of Object.entries(state.issues)) {
      if (listed.has(id)) continue;
      const now = lookedUp.get(id);
      const how = decideClosedHow(now);
      const block = now === undefined ? before : buildIssueBlock(now);
      if (how !== undefined) {
        addEvent("linear.issue.closed", block, { how });
      } else {
        addEvent("linear.issue.left", block, {
          reassigned: before.assignee?.id !== block.assignee?.id,
        });
      }
    }

    const followed: Record<string, FollowedIssue> = {};
    for (const [id, { assigned }] of followedIds) {
      const now = listed.get(id) ?? lookedUp.get(id);
      const before = state.followed[id];
      const block = now === undefined ? before?.issue : buildIssueBlock(now);
      // An issue the feed has never seen and Linear no longer returns has no
      // block to put in an event, and nothing to end that a later poll could not.
      if (block === undefined) continue;
      const how = decideClosedHow(now);
      followed[id] = { issue: block, closed: how !== undefined };
      if (how !== undefined && before !== undefined && !before.closed) {
        addEvent("linear.issue.closed", block, { how });
        continue;
      }
      const wasAssignedToUser = before === undefined || before.issue.assignee?.id === userId;
      if (assigned && how === undefined && block.assignee?.id !== userId && wasAssignedToUser) {
        addEvent("linear.issue.unassigned", block, {});
      }
    }

    // An event the host would refuse must never reach the outbox, where it
    // would fail every later poll. So nothing is written when one fails.
    const computed = [...events.values()];
    yield* Effect.forEach(computed, (event) => checkEmittedEvent(LINEAR_EVENT_KINDS, event), {
      discard: true,
    });
    const next = {
      filter: watchFilter.fingerprint,
      issues: Object.fromEntries(watched.items.map((issue) => [issue.id, buildIssueBlock(issue)])),
      followed,
    };
    yield* writeFeedState(context.state, ISSUES_STATE, {
      ...next,
      outbox: computed as ReadonlyArray<OutboxEvent>,
    });
    if (computed.length > 0) {
      yield* Effect.forEach(computed, context.emit, { discard: true });
      yield* writeFeedState(context.state, ISSUES_STATE, { ...next, outbox: [] });
    }
    return {};
  });
