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
 * raises only `closed` and `unassigned`. Both are decided from how the issue
 * is now, not from a change between two polls, so an issue that closed or
 * was reassigned before the feed first followed it still ends its signal:
 *
 * - a followed issue that is closed now is `closed` when it closed after the
 *   notification that raised one of its signals. Both times are Linear's:
 *   the close time, and the `occurredAt` of the signal's event, which is when
 *   Linear created the notification. A mention on an issue that
 *   was already closed stays open, because people comment on closed issues.
 *   An issue Linear no longer returns counts as closed after any notification;
 * - an issue with an open `linear/assigned` signal whose assignee is not the
 *   user now is `unassigned`.
 *
 * Each end is emitted once per signal: the state remembers the dedup keys of
 * the events of the signals it was emitted for.
 *
 * A poll first emits the events an earlier poll left in the outbox. It then
 * reads everything, computes its events, and commits them with its new state
 * (`commitPoll`). A poll that fails before that write leaves the state as it
 * was and has emitted nothing; one that fails after it loses nothing,
 * because the next poll emits the outbox again.
 */
import { Clock, Effect, Option } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import {
  PluginError,
  type AuthError,
  type EmittedEvent,
  type IngestContext,
  type OpenSignal,
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
  readClosedAt,
} from "../linear-objects";
import { buildIssueEvent, buildIssueRef, type IssueKind } from "./events";
import { buildWatchFilter, checkConfiguredValues } from "./filter";
import {
  ASSIGNED_SIGNAL_KIND,
  commitPoll,
  emitStoredOutbox,
  ISSUES_STATE,
  MENTION_SIGNAL_KIND,
  NOTIFICATIONS_STATE,
  readFeedState,
  type EmittedEnds,
  type NotificationsState,
} from "./state";

/** The most pages of the watched set a poll reads: 1,000 issues. */
const MAX_WATCHED_PAGES = 4;

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
const compareIssues = (before: IssueBlock, after: IssueBlock): IssueChanges => {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of COMPARED_FIELDS) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      changes[field] = { from: before[field], to: after[field] };
    }
  }
  return changes;
};

/** One open `linear/mention` or `linear/assigned` signal on a followed issue. */
interface FollowingSignal {
  readonly kind: string;
  /** The dedup key of the signal's event, which is the notification's id. */
  readonly dedupKey: string;
  /** When Linear created the notification that raised the signal. */
  readonly notifiedAt: string;
}

/** An issue the feed follows: its open signals, and the issue as their notifications showed it. */
interface FollowedIssue {
  readonly signals: Array<FollowingSignal>;
  issue: IssueBlock | undefined;
}

/**
 * Finds the issues the Connection's open `linear/mention` and
 * `linear/assigned` signals follow, by issue id, each with its signals and
 * the issue as the `notifications` feed recorded it with the notification
 * that raised one of them, found by the dedup key of the signal's event.
 * A thread of another workspace or of something other than an issue is left
 * out.
 */
const findFollowedIssues = (
  workspace: WorkspaceBlock,
  signals: ReadonlyArray<OpenSignal>,
  raising: NotificationsState | undefined,
): Map<string, FollowedIssue> => {
  const prefix = buildIssueRef(workspace, "");
  const followed = new Map<string, FollowedIssue>();
  for (const signal of signals) {
    if (signal.kind !== MENTION_SIGNAL_KIND && signal.kind !== ASSIGNED_SIGNAL_KIND) continue;
    if (!signal.threadRef.startsWith(prefix)) continue;
    const id = signal.threadRef.slice(prefix.length);
    const record = raising?.raising[signal.event.dedupKey];
    const entry = followed.get(id) ?? { signals: [], issue: undefined };
    entry.signals.push({
      kind: signal.kind,
      dedupKey: signal.event.dedupKey,
      notifiedAt: signal.event.occurredAt,
    });
    entry.issue ??= record?.issue;
    followed.set(id, entry);
  }
  return followed;
};

/**
 * Checks whether an end was already emitted for every one of `signals`:
 * whether `emittedFor`, the dedup keys the end was emitted for, holds each
 * signal's key.
 */
const isEndEmittedForAll = (
  emittedFor: ReadonlyArray<string> | undefined,
  signals: ReadonlyArray<FollowingSignal>,
): boolean => signals.every((signal) => emittedFor?.includes(signal.dedupKey) === true);

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
    const pollId = yield* Effect.sync(() => crypto.randomUUID());
    const stored = yield* readFeedState(context.state, ISSUES_STATE);
    yield* emitStoredOutbox(context, stored);
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
    const blocks = new Map(watched.items.map((issue) => [issue.id, buildIssueBlock(issue)]));
    const issues = Object.fromEntries(blocks);
    if (Option.isNone(stored)) {
      // The first poll only learns the set: the Connection starts from now on.
      yield* commitPoll(
        context,
        ISSUES_STATE,
        stored,
        { filter: watchFilter.fingerprint, issues, ended: {} },
        [],
      );
      return {};
    }
    const state = stored.value;
    // The notifications feed records the notification behind each mention and
    // assignment. The host never runs two polls of one handle at a time, and
    // both feeds share this Connection's handle, so the notifications state
    // is never half written while this poll reads it. This feed never writes it.
    const raising = Option.getOrUndefined(yield* readFeedState(context.state, NOTIFICATIONS_STATE));
    const followed = findFollowedIssues(workspace, yield* context.openSignals(), raising);

    // Look up, in one query, the issues that left the set and the followed
    // issues outside it, to learn what became of them.
    const lookupIds = [
      ...new Set([
        ...Object.keys(state.issues).filter((id) => !listed.has(id)),
        ...[...followed.keys()].filter((id) => !listed.has(id)),
      ]),
    ];
    const lookedUp = new Map<string, ApiIssue>();
    if (lookupIds.length > 0) {
      const found = yield* readPages(
        authorization,
        {
          name: "LinearIssueLookup",
          text: LOOKUP_QUERY,
          variables: { filter: { id: { in: lookupIds } } },
        },
        "issues",
        ApiIssue,
        Math.ceil(lookupIds.length / MAX_PAGE_SIZE),
      );
      // An issue on a page this poll did not read would look deleted.
      if (found.hasMore) {
        return yield* new PluginError({
          message: `Linear answered the lookup of ${String(lookupIds.length)} issues by id with more pages than it should need.`,
        });
      }
      for (const issue of found.items) lookedUp.set(issue.id, issue);
    }

    // One event per issue and kind: a followed issue that leaves the watched
    // set because it closed gets one `closed` event, the end of its signals.
    const events = new Map<string, EmittedEvent>();
    const addEvent = (
      kind: IssueKind,
      issue: IssueBlock,
      fields: Record<string, unknown>,
      signalKeys?: ReadonlyArray<string>,
    ) => {
      const event = buildIssueEvent({
        kind,
        workspace,
        issue,
        userId,
        fields,
        pollTime,
        pollId,
        ...(signalKeys === undefined ? {} : { signalKeys }),
      });
      events.set(`${issue.id} ${kind}`, event);
    };

    // A poll whose filter differs from the stored one records the issues
    // that entered without an event, so a wider filter does not flood Intake.
    const filterChanged = state.filter !== watchFilter.fingerprint;
    for (const issue of watched.items) {
      const block = blocks.get(issue.id) ?? buildIssueBlock(issue);
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

    const ended: Record<string, EmittedEnds> = {};
    for (const [id, { signals, issue }] of followed) {
      const now = listed.get(id) ?? lookedUp.get(id);
      const block =
        now === undefined ? (state.issues[id] ?? issue) : (blocks.get(id) ?? buildIssueBlock(now));
      const emitted = state.ended[id] ?? {};
      ended[id] = emitted;
      // An issue Linear no longer returns, and that neither feed recorded,
      // has no block to put in an event, so its signals stay open until the
      // user resolves them. That happens only when the plugin's state was
      // reset and the issue was then deleted for good or hidden from the
      // user: Linear still returns a trashed issue.
      if (block === undefined) continue;
      const how = decideClosedHow(now);
      if (how !== undefined) {
        const closedAt = readClosedAt(now, how);
        // Linear keeps no close time for a deleted issue, and may keep none
        // for a closed one; either counts as closed after every notification.
        const ending = signals.filter(
          (signal) =>
            closedAt === undefined || Date.parse(closedAt) > Date.parse(signal.notifiedAt),
        );
        if (ending.length > 0) {
          if (!isEndEmittedForAll(emitted.closed, ending)) {
            const keys = ending.map((signal) => signal.dedupKey);
            addEvent("linear.issue.closed", block, { how }, keys);
            ended[id] = { ...emitted, closed: keys };
          }
          continue;
        }
      }
      const assigned = signals.find((signal) => signal.kind === ASSIGNED_SIGNAL_KIND);
      if (assigned === undefined || block.assignee?.id === userId) continue;
      if (!isEndEmittedForAll(emitted.unassigned, [assigned])) {
        addEvent("linear.issue.unassigned", block, {}, [assigned.dedupKey]);
        ended[id] = { ...ended[id], unassigned: [assigned.dedupKey] };
      }
    }

    yield* commitPoll(
      context,
      ISSUES_STATE,
      stored,
      { filter: watchFilter.fingerprint, issues, ended },
      [...events.values()],
    );
    return {};
  });
