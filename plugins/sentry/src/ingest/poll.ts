/**
 * One poll of the `issues` feed. It lists the issues the Connection's filters
 * match, compares the list with the one the last poll stored, and emits an
 * event for each change:
 *
 * - `entered`: an issue joined the list;
 * - `regressed`: a resolved or archived issue came back;
 * - `escalating`: an issue on the list became escalating;
 * - `resolved`, `archived`: an issue left the list because somebody
 *   resolved or archived it;
 * - `left`: an issue left the list for another reason.
 *
 * A poll first emits the events an earlier poll left in the state's `outbox`.
 * It then reads everything and computes its events, checks each against the
 * host's limits, writes the new list and those events as the new `outbox` in
 * one write, emits them, and empties the `outbox`. A poll that fails before
 * the write, an event that fails its check included, leaves the state as it
 * was and has emitted nothing. A poll that fails after it loses no event, because the
 * next poll emits the `outbox` again, and the dedup keys make the host drop
 * the ones it already has. So an issue announced by an `entered` event is
 * always in the stored list, and its departure is seen.
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
import type { SentryFailure } from "../api";
import type { SentryConnectionConfig } from "../connection-type";
import { readUserId } from "../identity";
import { SENTRY_EVENT_KINDS, type LatestEvent } from "../kinds";
import type { OrganizationAccess } from "../organization";
import {
  buildIssueBlock,
  compareNumericIds,
  isAssignedToUser,
  readStatusActorId,
  type ApiIssue,
  type Regression,
} from "../sentry-objects";
import { buildIssueEvent } from "./events";
import { resolveFilter, type ResolvedFilter } from "./filter";
import { listWatchedIssues, lookUpIssues } from "./list";
import { readLatestEvent, readRegressions } from "./reads";
import {
  readWatchState,
  writeWatchState,
  type LeftIssue,
  type OutboxEvent,
  type WatchedIssue,
  type WatchState,
} from "./state";

/** How many issue details, and how many latest events, one poll reads. The rest wait for the next poll. */
const READS_PER_POLL = 20;

/** How long the plugin remembers that an issue left as resolved or archived, so it can tell when it comes back. */
const LEFT_MEMORY_MILLIS = 90 * 24 * 60 * 60 * 1000;

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The work a poll does for an issue that needs reads before its events can be
 * built. Every other change is a field update that needs none.
 *
 * - `entered`: an issue that joined the list;
 * - `returned`: an issue that joined the list and the left memory has it;
 * - `stayed`: an issue that was on the list and turned escalating
 *   (`turnedEscalating`), or needs its regression check (`checkRegressions`):
 *   it is regressed or escalating and had a new event, or an earlier poll
 *   deferred its check.
 */
type Work =
  | { readonly kind: "entered"; readonly issue: ApiIssue }
  | { readonly kind: "returned"; readonly issue: ApiIssue; readonly left: LeftIssue }
  | {
      readonly kind: "stayed";
      readonly issue: ApiIssue;
      readonly previous: WatchedIssue;
      readonly turnedEscalating: boolean;
      readonly checkRegressions: boolean;
    };

/** The reads a poll has left. */
interface ReadBudget {
  details: number;
  latestEvents: number;
}

/** Returns the most reads `work` makes. */
const computeMostReads = (work: Work): ReadBudget => {
  switch (work.kind) {
    case "entered":
      return { details: 0, latestEvents: 1 };
    case "returned":
      return { details: 1, latestEvents: 1 };
    case "stayed":
      return { details: work.checkRegressions ? 1 : 0, latestEvents: 1 };
  }
};

/** What a poll knows while it runs. */
interface PollScope {
  readonly access: OrganizationAccess;
  readonly userId: string;
  readonly filter: ResolvedFilter;
  /** The poll's time, as ISO text. */
  readonly pollTime: string;
  readonly pollMillis: number;
}

/** What the poll found out about one issue. */
interface Finding {
  readonly events: ReadonlyArray<EmittedEvent>;
  readonly watched: WatchedIssue;
}

/** Returns the highest activity id, or undefined when there are none. */
const findNewestActivityId = (regressions: ReadonlyArray<Regression>): string | undefined =>
  regressions.at(-1)?.activityId;

/** Returns the `latestEvent` field of a payload, which is left out when Sentry had no event. */
const buildLatestEventField = (
  latestEvent: LatestEvent | undefined,
): { readonly latestEvent?: LatestEvent } => (latestEvent === undefined ? {} : { latestEvent });

/** Returns the `regressionActivityId` field of an entry, which is left out when there is none. */
const buildRegressionActivityIdField = (
  regressionActivityId: string | undefined,
): { readonly regressionActivityId?: string } =>
  regressionActivityId === undefined ? {} : { regressionActivityId };

/** Reads what an `entered` event carries and builds it. */
const findEntered = (
  scope: PollScope,
  organization: OrganizationAccess["organization"],
  issue: ApiIssue,
  budget: ReadBudget,
): Effect.Effect<Finding, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    budget.latestEvents -= 1;
    const latestEvent = yield* readLatestEvent(scope.access, issue.id, issue.lastSeen);
    const block = buildIssueBlock(issue);
    return {
      events: [
        buildIssueEvent({
          kind: "entered",
          organization,
          issue: block,
          fields: {
            toYou: isAssignedToUser(block, scope.userId),
            ...buildLatestEventField(latestEvent),
          },
          dedupKey: `${issue.id}:entered:${issue.lastSeen}`,
          occurredAt: issue.lastSeen,
          fallbackTime: scope.pollTime,
        }),
      ],
      watched: { issue: block, since: scope.pollTime },
    };
  });

/**
 * Returns true when a regression is newer than what the plugin has seen on the
 * issue. With a remembered activity id the ids decide, so the clocks of Sentry
 * and Hercule never have to agree. Without one (the plugin never read the
 * issue's detail), the regression is new when Sentry created it after
 * `startedAt`: when the poll added the issue to the set, or saw it leave. A
 * regression from before then is the one the issue came with. This is the one
 * place a time of Sentry is compared with a time of Hercule.
 */
const isNewRegression = (
  regression: Regression,
  seen: { readonly regressionActivityId?: string | undefined; readonly startedAt: string },
): boolean =>
  seen.regressionActivityId === undefined
    ? Date.parse(regression.dateCreated) > Date.parse(seen.startedAt)
    : compareNumericIds(regression.activityId, seen.regressionActivityId) > 0;

/**
 * Reads an issue that came back from the left memory and builds its
 * `regressed` event, with `after` saying how the issue left. The event is
 * keyed by the newest regression activity the plugin has not seen. Sentry
 * records none when an archived issue escalates or a person reopens an issue,
 * so the key then falls back to the time the issue left, which differs for
 * every return.
 */
const findReturned = (
  scope: PollScope,
  organization: OrganizationAccess["organization"],
  work: Extract<Work, { kind: "returned" }>,
  budget: ReadBudget,
): Effect.Effect<Finding, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const { issue, left } = work;
    budget.details -= 1;
    budget.latestEvents -= 1;
    const regressions = yield* readRegressions(scope.access, issue.id);
    const latestEvent = yield* readLatestEvent(scope.access, issue.id, issue.lastSeen);
    const newest = regressions
      .filter((regression) =>
        isNewRegression(regression, {
          regressionActivityId: left.regressionActivityId,
          startedAt: left.leftAt,
        }),
      )
      .at(-1);
    const release = newest?.release ?? latestEvent?.release;
    const block = buildIssueBlock(issue);
    return {
      events: [
        buildIssueEvent({
          kind: "regressed",
          organization,
          issue: block,
          fields: {
            after: left.as,
            ...(release === undefined ? {} : { release }),
            ...buildLatestEventField(latestEvent),
          },
          // With no new activity (an archived issue that escalated, or an issue
          // reopened by hand) the time it left keys the event: one key per return.
          dedupKey:
            newest === undefined
              ? `${issue.id}:regressed:${left.leftAt}`
              : `${issue.id}:regressed:${newest.activityId}`,
          occurredAt: newest === undefined ? issue.lastSeen : newest.dateCreated,
          fallbackTime: scope.pollTime,
        }),
      ],
      watched: {
        issue: block,
        ...buildRegressionActivityIdField(
          findNewestActivityId(regressions) ?? left.regressionActivityId,
        ),
        since: scope.pollTime,
      },
    };
  });

/**
 * Reads an issue that stayed on the list and builds its events:
 *
 * - one `regressed` event for each regression activity the plugin has not
 *   seen, oldest first, when the issue had a new event;
 * - then an `escalating` event when the issue's substatus turned `escalating`.
 *
 * Builds none when the new event was not a new regression. An issue that was
 * already regressed when the plugin stored it has a regression from before
 * `since`, which is not new. The newest activity becomes the one the plugin
 * remembers either way. The `regressed` events say the issue came back after
 * it was resolved, because an issue that stayed on the list was never seen
 * leaving it.
 */
const findStayed = (
  scope: PollScope,
  organization: OrganizationAccess["organization"],
  work: Extract<Work, { kind: "stayed" }>,
  budget: ReadBudget,
): Effect.Effect<Finding, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const { issue, previous } = work;
    let regressions: ReadonlyArray<Regression> = [];
    if (work.checkRegressions) {
      budget.details -= 1;
      regressions = yield* readRegressions(scope.access, issue.id);
    }
    const fresh = regressions.filter((regression) =>
      isNewRegression(regression, {
        regressionActivityId: previous.regressionActivityId,
        startedAt: previous.since,
      }),
    );
    const block = buildIssueBlock(issue);
    const watched: WatchedIssue = {
      issue: block,
      ...buildRegressionActivityIdField(
        findNewestActivityId(regressions) ?? previous.regressionActivityId,
      ),
      since: previous.since,
    };
    if (fresh.length === 0 && !work.turnedEscalating) return { events: [], watched };
    budget.latestEvents -= 1;
    const latestEvent = yield* readLatestEvent(scope.access, issue.id, issue.lastSeen);
    const newest = fresh.at(-1);
    const regressed = fresh.map((regression) => {
      const isNewest = regression === newest;
      const release = regression.release ?? (isNewest ? latestEvent?.release : undefined);
      return buildIssueEvent({
        kind: "regressed",
        organization,
        issue: block,
        fields: {
          after: "resolved" as const,
          ...(release === undefined ? {} : { release }),
          ...(isNewest ? buildLatestEventField(latestEvent) : {}),
        },
        dedupKey: `${issue.id}:regressed:${regression.activityId}`,
        occurredAt: regression.dateCreated,
        fallbackTime: scope.pollTime,
      });
    });
    const escalating = work.turnedEscalating
      ? [
          buildIssueEvent({
            kind: "escalating",
            organization,
            issue: block,
            fields: buildLatestEventField(latestEvent),
            dedupKey: `${issue.id}:escalating:${issue.lastSeen}`,
            occurredAt: issue.lastSeen,
            fallbackTime: scope.pollTime,
          }),
        ]
      : [];
    return { events: [...regressed, ...escalating], watched };
  });

/** Reads what `work` needs and builds its events, spending the reads from `budget`. */
const findForWork = (
  scope: PollScope,
  organization: OrganizationAccess["organization"],
  work: Work,
  budget: ReadBudget,
): Effect.Effect<Finding, SentryFailure, HttpClient.HttpClient> => {
  switch (work.kind) {
    case "entered":
      return findEntered(scope, organization, work.issue, budget);
    case "returned":
      return findReturned(scope, organization, work, budget);
    case "stayed":
      return findStayed(scope, organization, work, budget);
  }
};

/** The changes the poll found on the list, and the entries that stay as they are. */
interface Plan {
  /** The issues that need reads, in the order the poll takes them. */
  readonly work: ReadonlyArray<Work>;
  /** The entries of issues that need no reads, by issue id. */
  readonly quiet: ReadonlyMap<string, WatchedIssue>;
}

/**
 * Compares the list with the stored state and decides what each listed issue
 * needs:
 *
 * - an issue not stored is `entered`, or `returned` when the left memory has
 *   it; after a filter change it is stored silently instead, with no event;
 * - a stored issue whose substatus turned `escalating`, that is regressed or
 *   escalating and had a new event, or whose entry is marked `recheck`, is
 *   `stayed` work;
 * - any other stored issue only gets its fields updated.
 *
 * The work is ordered for the read budget: issues that joined the list first,
 * by id, then issues that stayed, the one with the oldest stored `lastSeen`
 * first. A deferred issue keeps its old `lastSeen`, so it moves up the queue
 * on the next poll and a few noisy issues cannot use the budget every time.
 */
const planWork = (
  listed: ReadonlyArray<ApiIssue>,
  state: WatchState,
  filterChanged: boolean,
  pollTime: string,
): Plan => {
  const arrivals: Array<Work> = [];
  const stays: Array<Extract<Work, { kind: "stayed" }>> = [];
  const quiet = new Map<string, WatchedIssue>();
  for (const issue of listed) {
    const previous = state.issues[issue.id];
    if (previous === undefined) {
      const left = state.left[issue.id];
      if (filterChanged) {
        quiet.set(issue.id, { issue: buildIssueBlock(issue), since: pollTime });
      } else if (left !== undefined) {
        arrivals.push({ kind: "returned", issue, left });
      } else {
        arrivals.push({ kind: "entered", issue });
      }
      continue;
    }
    const turnedEscalating =
      previous.issue.substatus !== "escalating" && issue.substatus === "escalating";
    const checkRegressions =
      previous.recheck === true ||
      ((issue.substatus === "regressed" || issue.substatus === "escalating") &&
        issue.lastSeen !== previous.issue.lastSeen);
    if (turnedEscalating || checkRegressions) {
      stays.push({ kind: "stayed", issue, previous, turnedEscalating, checkRegressions });
    } else {
      quiet.set(issue.id, { ...previous, issue: buildIssueBlock(issue) });
    }
  }
  arrivals.sort((first, second) => compareNumericIds(first.issue.id, second.issue.id));
  stays.sort(
    (first, second) =>
      Date.parse(first.previous.issue.lastSeen) - Date.parse(second.previous.issue.lastSeen) ||
      compareNumericIds(first.issue.id, second.issue.id),
  );
  return { work: [...arrivals, ...stays], quiet };
};

/** An issue that left the list, and the event that says why. */
interface Departure {
  readonly event: EmittedEvent;
  /** Set for an issue that was resolved or archived, so the plugin recognises it when it returns. */
  readonly remembered?: LeftIssue;
}

/**
 * Builds the event for one issue that left the list. `stored` is the issue's
 * entry from the last poll, and `found` is the issue as Sentry has it now, or
 * undefined when Sentry does not have it any more.
 *
 * - resolved and archived issues get their own events;
 * - an unresolved issue is `left`, as `aged-out` when it has had no event
 *   within the window and as `unmatched` when it no longer matches the other
 *   filters;
 * - an issue Sentry no longer has, or has in a state this plugin does not
 *   know, is `left` as `deleted`, with the issue as the last poll stored it.
 *
 * Every event is keyed by the issue's `since`, so an issue that is resolved,
 * unresolved by hand with no new event, and resolved again raises two events.
 */
const buildDeparture = (
  scope: PollScope,
  organization: OrganizationAccess["organization"],
  stored: WatchedIssue,
  found: ApiIssue | undefined,
): Departure => {
  const base = { organization, fallbackTime: scope.pollTime, occurredAt: scope.pollTime };
  const remember = (as: LeftIssue["as"]): LeftIssue => ({
    as,
    leftAt: scope.pollTime,
    lastSeen: stored.issue.lastSeen,
    ...buildRegressionActivityIdField(stored.regressionActivityId),
  });
  if (found?.status === "resolved") {
    const issue = buildIssueBlock(found);
    return {
      event: buildIssueEvent({
        ...base,
        kind: "resolved",
        issue,
        fields: { byYou: readStatusActorId(found) === scope.userId },
        dedupKey: `${issue.id}:resolved:${stored.since}`,
      }),
      remembered: remember("resolved"),
    };
  }
  if (found?.status === "ignored") {
    const issue = buildIssueBlock(found);
    return {
      event: buildIssueEvent({
        ...base,
        kind: "archived",
        issue,
        fields: { substatus: issue.substatus, byYou: readStatusActorId(found) === scope.userId },
        dedupKey: `${issue.id}:archived:${stored.since}`,
      }),
      remembered: remember("archived"),
    };
  }
  const issue = found?.status === "unresolved" ? buildIssueBlock(found) : stored.issue;
  const reason =
    found?.status !== "unresolved"
      ? ("deleted" as const)
      : Date.parse(found.lastSeen) < scope.pollMillis - scope.filter.lastSeenDays * MILLIS_PER_DAY
        ? ("aged-out" as const)
        : ("unmatched" as const);
  const assignee = found?.assignedTo ?? null;
  const reassigned =
    assignee !== null &&
    (stored.issue.assignedTo === null ||
      stored.issue.assignedTo.type !== assignee.type ||
      stored.issue.assignedTo.id !== assignee.id);
  return {
    event: buildIssueEvent({
      ...base,
      kind: "left",
      issue,
      fields: { reason, reassigned, lastSeenDays: scope.filter.lastSeenDays },
      dedupKey: `${issue.id}:left:${stored.since}`,
    }),
  };
};

/**
 * Polls the `issues` feed once. Returns an empty result normally and
 * `nextAfterSeconds` when Sentry rate limited the poll: nothing is emitted or
 * stored then, and the host waits.
 *
 * Fails with an `AuthError` when Sentry refuses the token. Fails with a
 * `PluginError` when:
 *
 * - a team, member, project or environment in the config no longer exists;
 * - a list of the organization is too long to read;
 * - the filters match more than 1,000 issues;
 * - Sentry fails or answers in a shape the plugin does not know, such as an id
 *   that is not made of digits;
 * - the stored state cannot be read, an event fails the host's limits, or an
 *   event cannot be emitted.
 */
export const pollSentryIssues = (
  access: OrganizationAccess,
  config: SentryConnectionConfig,
  identity: { readonly accountId: string },
  context: IngestContext,
): Effect.Effect<PollResult, AuthError | PluginError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const pollMillis = yield* Clock.currentTimeMillis;
    const pollTime = new Date(pollMillis).toISOString();
    const stored = yield* readWatchState(context.state);
    // What an earlier poll wrote but may not have emitted. The state keeps it
    // until this poll writes its own, so a failure from here on emits it again.
    if (Option.isSome(stored)) {
      yield* Effect.forEach(stored.value.outbox, context.emit, { discard: true });
    }
    const filter = yield* resolveFilter(access, config);
    const listed = yield* listWatchedIssues(access, filter);
    if (Option.isNone(stored)) {
      // The first poll only learns the list: everything on it is already there, not new.
      yield* writeWatchState(context.state, {
        filter: filter.fingerprint,
        issues: Object.fromEntries(
          listed.map((issue) => [issue.id, { issue: buildIssueBlock(issue), since: pollTime }]),
        ),
        left: {},
        outbox: [],
      });
      return {};
    }
    // Forget the issues that left more than 90 days ago before the diff, so an
    // issue that returns after a long pause in polling is new, not regressed.
    const state: WatchState = {
      ...stored.value,
      left: Object.fromEntries(
        Object.entries(stored.value.left).filter(
          ([, remembered]) => Date.parse(remembered.leftAt) >= pollMillis - LEFT_MEMORY_MILLIS,
        ),
      ),
    };
    const scope: PollScope = {
      access,
      userId: readUserId(identity.accountId),
      filter,
      pollTime,
      pollMillis,
    };
    const { organization } = access;
    const plan = planWork(listed, state, state.filter !== filter.fingerprint, pollTime);

    // Read what each changed issue needs until the budget is spent. An issue
    // that does not fit keeps its old entry, so the next poll sees the same
    // change. A stayed issue whose regression check does not fit is marked
    // `recheck`, so the next poll still reads it if its substatus has changed.
    const budget: ReadBudget = { details: READS_PER_POLL, latestEvents: READS_PER_POLL };
    const findings = new Map<string, Finding>();
    const deferred = new Map<string, WatchedIssue>();
    for (const work of plan.work) {
      const most = computeMostReads(work);
      if (most.details > budget.details || most.latestEvents > budget.latestEvents) {
        if (work.kind === "stayed" && work.checkRegressions) {
          deferred.set(work.issue.id, { ...work.previous, recheck: true });
        }
        continue;
      }
      findings.set(work.issue.id, yield* findForWork(scope, organization, work, budget));
    }

    // Find out what became of the issues that left the list.
    const listedIds = new Set(listed.map((issue) => issue.id));
    const departedIds = Object.keys(state.issues)
      .filter((id) => !listedIds.has(id))
      .sort(compareNumericIds);
    const lookedUp =
      departedIds.length === 0
        ? new Map<string, ApiIssue>()
        : yield* lookUpIssues(access, departedIds);
    const departures = departedIds.map((id) => ({
      id,
      departure: buildDeparture(
        scope,
        organization,
        state.issues[id] as WatchedIssue,
        lookedUp.get(id),
      ),
    }));

    const issues: Record<string, WatchedIssue> = {};
    for (const issue of listed) {
      const watched =
        findings.get(issue.id)?.watched ??
        deferred.get(issue.id) ??
        plan.quiet.get(issue.id) ??
        state.issues[issue.id];
      if (watched !== undefined) issues[issue.id] = watched;
    }
    // An issue that is in the set again is no longer remembered as left.
    const left: Record<string, LeftIssue> = {};
    for (const [id, remembered] of Object.entries(state.left)) {
      if (!(id in issues)) left[id] = remembered;
    }
    for (const { id, departure } of departures) {
      if (departure.remembered !== undefined) left[id] = departure.remembered;
    }

    // Check the events, store the new state together with them, then emit
    // them, then empty the outbox. The events are plain JSON, so storing and
    // emitting them as they are loses nothing; writing fails if one is not.
    const events = [
      ...[...findings.values()].flatMap((finding) => finding.events),
      ...departures.map(({ departure }) => departure.event),
    ];
    // An event the host would refuse must never reach the outbox, where it
    // would fail every later poll. So nothing is written when one fails.
    yield* Effect.forEach(events, (event) => checkEmittedEvent(SENTRY_EVENT_KINDS, event), {
      discard: true,
    });
    const next = { filter: filter.fingerprint, issues, left };
    yield* writeWatchState(context.state, {
      ...next,
      outbox: events as ReadonlyArray<OutboxEvent>,
    });
    if (events.length > 0) {
      yield* Effect.forEach(events, context.emit, { discard: true });
      yield* writeWatchState(context.state, { ...next, outbox: [] });
    }
    return {};
  }).pipe(
    Effect.catchTag("SentryRateLimited", (limit) =>
      Effect.succeed({ nextAfterSeconds: limit.retryAfterSeconds }),
    ),
  );
