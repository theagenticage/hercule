/**
 * The audit log of the Fleet specimen's machines (fleet-fixture.ts): what the
 * controller recorded about a machine, as `event.query { runnerId }` returns
 * it, newest first. The payloads are the shapes the controller writes, which
 * `describeMachineActivity` reads (`@hercule/client-core/machine-activity`).
 *
 * The times are fixed instants before the specimen's clock, Tuesday
 * 29 September 2026, 09:41 UTC, so the page's day headings never change.
 */
import type { EventWithFacts } from "@hercule/contract";

/** The ids of the sessions and the run that the log's entries name. */
export interface ActivityNames {
  /** The Provider Account whose sign-in the log records. */
  readonly providerAccountId: string;
  /** The run that spawned a dozen sessions in one minute. */
  readonly runId: string;
  /** Sessions that exist in the specimen's lists, so each entry names a session the page can show. The log reuses them when it needs more. */
  readonly sessionIds: ReadonlyArray<string>;
}

/** One log entry before it is numbered: when it happened (UTC), what it was, and who did it. */
type Entry = readonly [at: string, kind: string, payload: EventWithFacts["payload"], actor: string];

const USER = "user";
const SYSTEM = "system";

/** Builds an audit log entry the controller received at `at`. */
const buildAuditEvent = (id: number, [at, kind, payload, actor]: Entry): EventWithFacts => ({
  id,
  source: "platform",
  connectionId: null,
  system: "hercule",
  kind,
  occurredAt: at,
  receivedAt: at,
  dedupKey: `audit-${String(id)}`,
  refs: [],
  url: null,
  payload,
  actor,
  title: null,
  author: null,
  signals: [],
  resolvedSignals: [],
  ignoredBy: null,
  tasks: [],
  knownBy: [],
});

/** Numbers `entries`, oldest first, and returns them as the controller does: newest first. */
const buildAuditLog = (entries: ReadonlyArray<Entry>): ReadonlyArray<EventWithFacts> =>
  entries.map((entry, index) => buildAuditEvent(index + 1, entry)).toReversed();

/**
 * Returns the log of a machine that joined and has done nothing since: the
 * one entry every machine has. Its time is `at`.
 */
export const buildJoinedLog = (at: string): ReadonlyArray<EventWithFacts> =>
  buildAuditLog([[at, "runner.joined", { reserved: false, becameDefaultRunner: false }, SYSTEM]]);

/**
 * Returns the log of atlas, 50 entries over five days, newest first. It holds
 * every category and these cases:
 *
 * - problems: going offline and coming back (twice), sessions lost with it,
 *   free disk falling below the limit and recovering, a refused removal;
 * - folds: twelve sessions that one run spawned in a minute, workspaces a
 *   sweep removed, removals the user asked for, sessions lost together;
 * - a sign-in, label and session cap changes, Stop new work and its undo.
 */
export const buildAtlasLog = ({
  providerAccountId,
  runId,
  sessionIds,
}: ActivityNames): ReadonlyArray<EventWithFacts> => {
  const session = (index: number): string => sessionIds[index % sessionIds.length]!;
  const run = `run:${runId}`;
  /** Twelve sessions spawned by one run in the same minute, a few seconds apart. */
  const spawnedByRun: ReadonlyArray<Entry> = Array.from({ length: 12 }, (_, index): Entry => [
    `2026-09-28T09:15:${String(10 + index * 3).padStart(2, "0")}.000Z`,
    "session.spawned",
    { sessionId: session(index), runId },
    run,
  ]);
  /** Four idle workspaces the sweep removed in one minute. */
  const sweptIdle: ReadonlyArray<Entry> = [0, 1, 2, 3].map((index): Entry => [
    `2026-09-27T10:30:${String(5 + index * 4).padStart(2, "0")}.000Z`,
    "workspace.deleted",
    { reason: "idle", holder: `session:${session(index)}` },
    SYSTEM,
  ]);
  /** Three workspaces of finished runs the sweep removed in one minute. */
  const sweptFinishedRuns: ReadonlyArray<Entry> = [0, 1, 2].map((index): Entry => [
    `2026-09-29T09:10:${String(2 + index * 3).padStart(2, "0")}.000Z`,
    "workspace.deleted",
    { reason: "none", holder: run },
    SYSTEM,
  ]);
  return buildAuditLog([
    // Friday 25 September: the machine joins and is set up.
    [
      "2026-09-25T14:02:11.000Z",
      "runner.joined",
      { reserved: false, becameDefaultRunner: true },
      SYSTEM,
    ],
    ["2026-09-25T14:03:40.000Z", "providerAccount.signedIn", { providerAccountId }, USER],
    [
      "2026-09-25T14:10:02.000Z",
      "runner.updated",
      { changes: { labels: { old: [], new: ["macos", "xcode"] } } },
      USER,
    ],
    [
      "2026-09-25T14:10:31.000Z",
      "runner.updated",
      { changes: { maxConcurrentSessions: { old: 10, new: 12 } } },
      USER,
    ],
    // Saturday 26 September: threads start and stop.
    ["2026-09-26T08:41:00.000Z", "session.spawned", { sessionId: session(0) }, USER],
    ["2026-09-26T08:52:20.000Z", "session.spawned", { sessionId: session(1) }, USER],
    [
      "2026-09-26T09:05:05.000Z",
      "session.spawned",
      { sessionId: session(2) },
      `session:${session(0)}`,
    ],
    ["2026-09-26T09:30:00.000Z", "workspace.created", {}, SYSTEM],
    ["2026-09-26T09:31:00.000Z", "workspace.created", {}, SYSTEM],
    ["2026-09-26T16:45:12.000Z", "session.stopped", { sessionId: session(1) }, USER],
    ["2026-09-26T18:20:00.000Z", "session.archived", { sessionId: session(0) }, USER],
    // Sunday 27 September: the machine drops out at night and the sweep cleans up.
    ["2026-09-27T03:05:00.000Z", "runner.crashLooping", { count: 3 }, SYSTEM],
    ["2026-09-27T03:12:08.000Z", "runner.stateChanged", { state: "offline" }, SYSTEM],
    ["2026-09-27T03:19:44.000Z", "runner.stateChanged", { state: "online" }, SYSTEM],
    [
      "2026-09-27T03:19:50.000Z",
      "session.reconciled",
      { sessionId: session(2), reason: "runner_lost" },
      SYSTEM,
    ],
    [
      "2026-09-27T03:19:52.000Z",
      "session.reconciled",
      { sessionId: session(3), reason: "runner_lost" },
      SYSTEM,
    ],
    [
      "2026-09-27T10:05:40.000Z",
      "session.stopped",
      { sessionId: session(6), reason: "crash" },
      SYSTEM,
    ],
    ...sweptIdle,
    // Monday 28 September: more capacity, a busy run, a full disk, a refused cleanup.
    [
      "2026-09-28T08:05:30.000Z",
      "runner.updated",
      { changes: { maxConcurrentSessions: { old: 12, new: 16 } } },
      USER,
    ],
    ...spawnedByRun,
    [
      "2026-09-28T13:40:15.000Z",
      "runner.placementsChanged",
      { acceptingPlacements: false },
      SYSTEM,
    ],
    [
      "2026-09-28T14:55:02.000Z",
      "workspace.disposalRequested",
      { operation: "workspaceDispose" },
      USER,
    ],
    [
      "2026-09-28T14:55:04.000Z",
      "workspace.disposalRequested",
      { operation: "workspaceDispose" },
      USER,
    ],
    [
      "2026-09-28T14:55:06.000Z",
      "workspace.disposalRequested",
      { operation: "workspaceDispose" },
      USER,
    ],
    [
      "2026-09-28T14:55:09.000Z",
      "workspace.disposalRefused",
      {
        message:
          "The runner refused safe removal: the workspace has uncommitted changes. The workspace is retained. Automatic cleanup will not retry this removal. Inspect it, resolve the refusal, and explicitly retry removal.",
        runnerMessage: "the folder is in use by another process",
      },
      SYSTEM,
    ],
    [
      "2026-09-28T14:55:20.000Z",
      "workspace.deleted",
      { reason: "idle", holder: `session:${session(4)}` },
      SYSTEM,
    ],
    [
      "2026-09-28T14:55:24.000Z",
      "workspace.deleted",
      { reason: "idle", holder: `session:${session(5)}` },
      SYSTEM,
    ],
    ["2026-09-28T15:06:31.000Z", "runner.placementsChanged", { acceptingPlacements: true }, SYSTEM],
    ["2026-09-28T17:30:00.000Z", "runner.drained", {}, USER],
    ["2026-09-28T17:48:12.000Z", "runner.undrained", {}, USER],
    // Tuesday 29 September, today.
    ...sweptFinishedRuns,
    ["2026-09-29T09:21:10.000Z", "runner.stateChanged", { state: "offline" }, SYSTEM],
    ["2026-09-29T09:22:03.000Z", "runner.stateChanged", { state: "online" }, SYSTEM],
    [
      "2026-09-29T09:30:20.000Z",
      "runner.updated",
      { changes: { diskWatermarkBytes: { old: 10_737_418_240, new: 20_000_000_000 } } },
      USER,
    ],
  ]);
};
