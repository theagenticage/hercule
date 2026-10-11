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
 * The poll reads everything first, then emits, then stores the new list. A
 * poll that fails at any point stores nothing, so the next poll compares with
 * the same list and emits the same events under the same dedup keys: the host
 * drops the ones it already has.
 */
import { Clock, Effect, Option } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import {
  PluginError,
  type AuthError,
  type EmittedEvent,
  type IngestContext,
  type PollResult,
} from "@hercule/plugin-host";
import type { SentryFailure } from "../api";
import type { SentryConnectionConfig } from "../connection-type";
import { readUserId } from "../identity";
import type { IssueBlock, LatestEvent, ReturnedFrom } from "../kinds";
import type { OrganizationAccess } from "../organization";
import {
  buildIssueBlock,
  compareNumericIds,
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
  type WatchedIssue,
  type WatchState,
} from "./state";

/** How many issue details, and how many latest events, one poll reads. The rest wait for the next poll. */
const READS_PER_POLL = 20;

/** How long the plugin remembers that an issue left as resolved or archived, so it can tell when it comes back. */
const LEFT_MEMORY_MILLIS = 90 * 24 * 60 * 60 * 1000;

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The work a poll does for an issue that needs reads before its event can be
 * built. Every other change is a field update that needs none.
 */
type Work =
  | { readonly kind: "entered"; readonly issue: ApiIssue }
  | {
      readonly kind: "returned";
      readonly issue: ApiIssue;
      readonly leftAs: ReturnedFrom;
      readonly leftAt: string;
    }
  | { readonly kind: "escalating"; readonly issue: ApiIssue; readonly previous: WatchedIssue }
  | {
      readonly kind: "regression-check";
      readonly issue: ApiIssue;
      readonly previous: WatchedIssue;
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
    case "escalating":
      return { details: 0, latestEvents: 1 };
    case "returned":
    case "regression-check":
      return { details: 1, latestEvents: 1 };
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

/** Returns true when the issue is assigned to the user themselves, not to one of their teams. */
const isAssignedToUser = (issue: ApiIssue, userId: string): boolean =>
  issue.assignedTo?.type === "user" && issue.assignedTo.id === userId;

/** Returns the `latestEvent` field of a payload, which is left out when Sentry had no event. */
const buildLatestEventField = (
  latestEvent: LatestEvent | undefined,
): { readonly latestEvent?: LatestEvent } => (latestEvent === undefined ? {} : { latestEvent });

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
            toYou: isAssignedToUser(issue, scope.userId),
            ...buildLatestEventField(latestEvent),
          },
          dedupKey: `${issue.id}:entered:${issue.lastSeen}`,
          occurredAt: issue.lastSeen,
          fallbackTime: scope.pollTime,
        }),
      ],
      watched: { issue: block },
    };
  });

/** Reads what an `escalating` event carries and builds it. */
const findEscalating = (
  scope: PollScope,
  organization: OrganizationAccess["organization"],
  issue: ApiIssue,
  previous: WatchedIssue,
  budget: ReadBudget,
): Effect.Effect<Finding, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    budget.latestEvents -= 1;
    const latestEvent = yield* readLatestEvent(scope.access, issue.id, issue.lastSeen);
    const block = buildIssueBlock(issue);
    return {
      events: [
        buildIssueEvent({
          kind: "escalating",
          organization,
          issue: block,
          fields: buildLatestEventField(latestEvent),
          dedupKey: `${issue.id}:escalating:${issue.lastSeen}`,
          occurredAt: issue.lastSeen,
          fallbackTime: scope.pollTime,
        }),
      ],
      watched: {
        issue: block,
        ...(previous.regressionActivityId === undefined
          ? {}
          : { regressionActivityId: previous.regressionActivityId }),
      },
    };
  });

/**
 * Reads an issue that came back from the left memory and builds its
 * `regressed` event. The event is keyed by the regression activity that
 * happened since the issue left. Sentry records none when an archived issue
 * escalates, so the key then falls back to the issue's last event time.
 */
const findReturned = (
  scope: PollScope,
  organization: OrganizationAccess["organization"],
  work: Extract<Work, { kind: "returned" }>,
  budget: ReadBudget,
): Effect.Effect<Finding, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const { issue } = work;
    budget.details -= 1;
    budget.latestEvents -= 1;
    const regressions = yield* readRegressions(scope.access, issue.id);
    const latestEvent = yield* readLatestEvent(scope.access, issue.id, issue.lastSeen);
    const comeBack = regressions.filter(
      (regression) => Date.parse(regression.dateCreated) > Date.parse(work.leftAt),
    );
    const newest = comeBack.at(-1);
    const release = newest?.release ?? latestEvent?.release;
    const block = buildIssueBlock(issue);
    const regressionActivityId = findNewestActivityId(regressions);
    return {
      events: [
        buildIssueEvent({
          kind: "regressed",
          organization,
          issue: block,
          fields: {
            after: work.leftAs,
            ...(release === undefined ? {} : { release }),
            ...buildLatestEventField(latestEvent),
          },
          dedupKey:
            newest === undefined
              ? `${issue.id}:regressed:${issue.lastSeen}`
              : `${issue.id}:regressed:${newest.activityId}`,
          occurredAt: newest === undefined ? issue.lastSeen : newest.dateCreated,
          fallbackTime: scope.pollTime,
        }),
      ],
      watched: {
        issue: block,
        ...(regressionActivityId === undefined ? {} : { regressionActivityId }),
      },
    };
  });

/**
 * Returns true when a regression is newer than what the plugin has seen. With
 * a remembered activity id the ids decide. Without one (the issue was already
 * regressed when the plugin first saw it) the activity must be newer than the
 * last event the plugin saw.
 */
const isNewRegression = (regression: Regression, previous: WatchedIssue): boolean =>
  previous.regressionActivityId === undefined
    ? Date.parse(regression.dateCreated) > Date.parse(previous.issue.lastSeen)
    : compareNumericIds(regression.activityId, previous.regressionActivityId) > 0;

/**
 * Reads an issue that stayed on the list and is regressed with a new event,
 * and builds one `regressed` event for each regression activity the plugin
 * has not seen. Builds none when the new event was not a new regression.
 */
const findRegressionCheck = (
  scope: PollScope,
  organization: OrganizationAccess["organization"],
  work: Extract<Work, { kind: "regression-check" }>,
  budget: ReadBudget,
): Effect.Effect<Finding, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const { issue, previous } = work;
    budget.details -= 1;
    const regressions = yield* readRegressions(scope.access, issue.id);
    const fresh = regressions.filter((regression) => isNewRegression(regression, previous));
    const block = buildIssueBlock(issue);
    const regressionActivityId = findNewestActivityId(regressions) ?? previous.regressionActivityId;
    const watched: WatchedIssue = {
      issue: block,
      ...(regressionActivityId === undefined ? {} : { regressionActivityId }),
    };
    if (fresh.length === 0) return { events: [], watched };
    budget.latestEvents -= 1;
    const latestEvent = yield* readLatestEvent(scope.access, issue.id, issue.lastSeen);
    return {
      events: fresh.map((regression) => {
        const release =
          regression.release ?? (regression === fresh.at(-1) ? latestEvent?.release : undefined);
        return buildIssueEvent({
          kind: "regressed",
          organization,
          issue: block,
          fields: {
            after: "resolved" as const,
            ...(release === undefined ? {} : { release }),
            ...(regression === fresh.at(-1) ? buildLatestEventField(latestEvent) : {}),
          },
          dedupKey: `${issue.id}:regressed:${regression.activityId}`,
          occurredAt: regression.dateCreated,
          fallbackTime: scope.pollTime,
        });
      }),
      watched,
    };
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
    case "escalating":
      return findEscalating(scope, organization, work.issue, work.previous, budget);
    case "returned":
      return findReturned(scope, organization, work, budget);
    case "regression-check":
      return findRegressionCheck(scope, organization, work, budget);
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
 * - an issue not stored and not in the left memory is `entered`, or is stored
 *   silently when the filter changed;
 * - an issue in the left memory is `returned`, also after a filter change;
 * - a stored issue whose substatus turned `escalating` is `escalating`;
 * - a stored issue that is `regressed` and had a new event is checked for a
 *   new regression;
 * - any other stored issue only gets its fields updated.
 */
const planWork = (
  listed: ReadonlyArray<ApiIssue>,
  state: WatchState,
  filterChanged: boolean,
): Plan => {
  const work: Array<Work> = [];
  const quiet = new Map<string, WatchedIssue>();
  for (const issue of listed) {
    const previous = state.issues[issue.id];
    const remembered = state.left[issue.id];
    if (previous === undefined) {
      if (remembered !== undefined) {
        work.push({ kind: "returned", issue, leftAs: remembered.as, leftAt: remembered.leftAt });
      } else if (filterChanged) {
        quiet.set(issue.id, { issue: buildIssueBlock(issue) });
      } else {
        work.push({ kind: "entered", issue });
      }
    } else if (previous.issue.substatus !== "escalating" && issue.substatus === "escalating") {
      work.push({ kind: "escalating", issue, previous });
    } else if (issue.substatus === "regressed" && issue.lastSeen !== previous.issue.lastSeen) {
      work.push({ kind: "regression-check", issue, previous });
    } else {
      quiet.set(issue.id, {
        issue: buildIssueBlock(issue),
        ...(previous.regressionActivityId === undefined
          ? {}
          : { regressionActivityId: previous.regressionActivityId }),
      });
    }
  }
  work.sort((first, second) => compareNumericIds(first.issue.id, second.issue.id));
  return { work, quiet };
};

/** An issue that left the list, and the event that says why. */
interface Departure {
  readonly event: EmittedEvent;
  /** Set for an issue that was resolved or archived, so the plugin recognises it when it returns. */
  readonly remembered?: LeftIssue;
}

/**
 * Builds the event for one issue that left the list. `found` is the issue as
 * Sentry has it now, and undefined when Sentry does not have it any more.
 *
 * - resolved and archived issues get their own events;
 * - an unresolved issue is `left`, as `aged-out` when it has had no event
 *   within the window and as `unmatched` when it no longer matches the other
 *   filters;
 * - an issue Sentry no longer has, or has in a state this plugin does not
 *   know, is `left` as `deleted`, with the issue as the last poll stored it.
 */
const buildDeparture = (
  scope: PollScope,
  organization: OrganizationAccess["organization"],
  stored: IssueBlock,
  found: ApiIssue | undefined,
): Departure => {
  const base = { organization, fallbackTime: scope.pollTime, occurredAt: scope.pollTime };
  if (found?.status === "resolved") {
    const issue = buildIssueBlock(found);
    return {
      event: buildIssueEvent({
        ...base,
        kind: "resolved",
        issue,
        fields: { byYou: readStatusActorId(found) === scope.userId },
        dedupKey: `${issue.id}:resolved:${issue.lastSeen}`,
      }),
      remembered: { as: "resolved", leftAt: scope.pollTime },
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
        dedupKey: `${issue.id}:archived:${issue.lastSeen}`,
      }),
      remembered: { as: "archived", leftAt: scope.pollTime },
    };
  }
  const issue = found?.status === "unresolved" ? buildIssueBlock(found) : stored;
  const reason =
    found?.status !== "unresolved"
      ? ("deleted" as const)
      : Date.parse(found.lastSeen) < scope.pollMillis - scope.filter.lastSeenDays * MILLIS_PER_DAY
        ? ("aged-out" as const)
        : ("unmatched" as const);
  const assignee = found?.assignedTo ?? null;
  const reassigned =
    assignee !== null &&
    (stored.assignedTo === null ||
      stored.assignedTo.type !== assignee.type ||
      stored.assignedTo.id !== assignee.id);
  return {
    event: buildIssueEvent({
      ...base,
      kind: "left",
      issue,
      fields: { reason, reassigned, lastSeenDays: scope.filter.lastSeenDays },
      dedupKey: `${issue.id}:left:${issue.lastSeen}`,
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
 * - the filters match more than 1,000 issues;
 * - Sentry fails or answers in a shape the plugin does not know;
 * - the stored state cannot be read, or an event cannot be emitted.
 */
export const pollSentryIssues = (
  access: OrganizationAccess,
  config: SentryConnectionConfig,
  identity: { readonly accountId: string },
  context: IngestContext,
): Effect.Effect<PollResult, AuthError | PluginError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const pollMillis = yield* Clock.currentTimeMillis;
    const filter = yield* resolveFilter(access, config);
    const listed = yield* listWatchedIssues(access, filter);
    const stored = yield* readWatchState(context.state);
    if (Option.isNone(stored)) {
      // The first poll only learns the list: everything on it is already there, not new.
      yield* writeWatchState(context.state, {
        filter: filter.fingerprint,
        issues: Object.fromEntries(
          listed.map((issue) => [issue.id, { issue: buildIssueBlock(issue) }]),
        ),
        left: {},
      });
      return {};
    }
    const state = stored.value;
    const scope: PollScope = {
      access,
      userId: readUserId(identity.accountId),
      filter,
      pollTime: new Date(pollMillis).toISOString(),
      pollMillis,
    };
    const { organization } = access;
    const plan = planWork(listed, state, state.filter !== filter.fingerprint);

    // Read what each changed issue needs, in id order, until the budget is spent.
    // An issue that does not fit keeps its old entry, so the next poll sees the same change.
    const budget: ReadBudget = { details: READS_PER_POLL, latestEvents: READS_PER_POLL };
    const findings = new Map<string, Finding>();
    for (const work of plan.work) {
      const most = computeMostReads(work);
      if (most.details > budget.details || most.latestEvents > budget.latestEvents) continue;
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
        (state.issues[id] as WatchedIssue).issue,
        lookedUp.get(id),
      ),
    }));

    // Emit before storing: a failed emit leaves the old state, and the next poll emits again.
    for (const finding of findings.values()) {
      yield* Effect.forEach(finding.events, context.emit, { discard: true });
    }
    yield* Effect.forEach(departures, ({ departure }) => context.emit(departure.event), {
      discard: true,
    });

    const issues: Record<string, WatchedIssue> = {};
    for (const issue of listed) {
      const watched =
        findings.get(issue.id)?.watched ?? plan.quiet.get(issue.id) ?? state.issues[issue.id];
      if (watched !== undefined) issues[issue.id] = watched;
    }
    const left: Record<string, LeftIssue> = {};
    for (const [id, remembered] of Object.entries(state.left)) {
      if (Date.parse(remembered.leftAt) >= pollMillis - LEFT_MEMORY_MILLIS && !findings.has(id)) {
        left[id] = remembered;
      }
    }
    for (const { id, departure } of departures) {
      if (departure.remembered !== undefined) left[id] = departure.remembered;
    }
    yield* writeWatchState(context.state, { filter: filter.fingerprint, issues, left });
    return {};
  }).pipe(
    Effect.catchTag("SentryRateLimited", (limit) =>
      Effect.succeed({ nextAfterSeconds: limit.retryAfterSeconds }),
    ),
  );
