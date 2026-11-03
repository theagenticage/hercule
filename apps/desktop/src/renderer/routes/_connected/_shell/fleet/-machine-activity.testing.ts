/**
 * What the tests of a machine's Recent section and its Activity page share: a
 * machine, audit log entries about it, and a fake controller that plays
 * `event.query` over them a page at a time, as the real one does.
 */
import { HARNESSES } from "@hercule/client-core/testing";
import type { EventWithFacts, Runner } from "@hercule/contract";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  type Call,
  type Handler,
} from "../../../../app/testing";
import { buildRunner } from "../../../../screens/fleet/fleet.testing";

export const ATLAS: Runner = buildRunner({
  id: "01a06d02-0000-7000-8000-00000000a710",
  name: "atlas",
});

/** The day the tests run on, which `vi.useFakeTimers` sets in each test file. */
export const NOW = new Date("2026-11-02T14:00:00.000Z");

let nextEventId = 1;

/**
 * Builds the audit entry of `kind` that happened `minutesAgo` minutes before
 * `NOW`. Entries are numbered in the order they are built, so build the
 * oldest first.
 */
export const buildAuditEvent = (
  kind: string,
  minutesAgo: number,
  over: {
    readonly payload?: EventWithFacts["payload"];
    readonly actor?: EventWithFacts["actor"];
  } = {},
): EventWithFacts => ({
  id: nextEventId++,
  source: "platform",
  connectionId: null,
  system: "hercule",
  kind,
  occurredAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  receivedAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  dedupKey: `audit-${String(nextEventId)}`,
  refs: [],
  url: null,
  payload: over.payload ?? {},
  actor: over.actor ?? "system",
  title: null,
  author: null,
  signals: [],
  resolvedSignals: [],
  ignoredBy: null,
  tasks: [],
  knownBy: [],
});

/** Builds the entry for the machine going offline, `minutesAgo` before `NOW`: a problem, by the controller. */
export const buildWentOffline = (minutesAgo: number): EventWithFacts =>
  buildAuditEvent("runner.stateChanged", minutesAgo, { payload: { state: "offline" } });

/** Builds the entry for the machine coming online, `minutesAgo` before `NOW`, by the controller. */
export const buildCameOnline = (minutesAgo: number): EventWithFacts =>
  buildAuditEvent("runner.stateChanged", minutesAgo, { payload: { state: "online" } });

/** Builds the entry for Stop new work, `minutesAgo` before `NOW`, by the user. */
export const buildStoppedNewWork = (minutesAgo: number): EventWithFacts =>
  buildAuditEvent("runner.drained", minutesAgo, { actor: "user" });

/** Builds the entry for a session spawned for no run, `minutesAgo` before `NOW`, by the controller. */
export const buildSessionSpawned = (minutesAgo: number, sessionId: string): EventWithFacts =>
  buildAuditEvent("session.spawned", minutesAgo, { payload: { sessionId } });

/** What a test opens the machine's pages with. */
export interface OpenedMachine {
  /** The requests the page sent the controller. */
  readonly calls: readonly Call[];
  readonly app: Awaited<ReturnType<typeof renderApp>>;
  /** Replaces the log the controller serves. A page that reads the log again then sees the new entries. */
  readonly setEvents: (events: readonly EventWithFacts[]) => void;
}

/**
 * Starts the app at `path` with a controller that has atlas and serves
 * `events`, in any order, as `event.query` pages of `pageSize`, newest first,
 * for atlas only. `overrides` replace any answer. Waits for the first
 * screen's route to settle, not for any of its text.
 */
export const openMachineWithEvents = async (
  path: string,
  events: readonly EventWithFacts[],
  {
    pageSize = 100,
    overrides = {},
  }: { pageSize?: number; overrides?: Record<string, Handler> } = {},
): Promise<OpenedMachine> => {
  let log = events;
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, runners: [] }),
    "GET /api/v1/runners": { body: { items: [ATLAS] } },
    "GET /api/v1/sessions": { body: { items: [] } },
    "GET /api/v1/harnesses": { body: HARNESSES },
    "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "UTC" } } },
    "GET /api/v1/controller": {
      body: {
        id: "01a06d02-c000-7000-8000-000000000001",
        publicKey: "key",
        version: "0.9.3",
        defaultRunnerId: null,
        localRunnerId: null,
        textGeneration: { model: null, unavailableReason: null, lastFailure: null },
      },
    },
    "GET /api/v1/events": (call) => {
      const query = new URLSearchParams(call.search);
      if (query.get("runnerId") !== ATLAS.id) return { body: { items: [] } };
      const limit = Number(query.get("limit") ?? pageSize);
      const before = Number(query.get("cursor") ?? Infinity);
      const older = log.filter((event) => event.id < before).toSorted((a, b) => b.id - a.id);
      const items = older.slice(0, Math.min(limit, pageSize));
      const last = items.at(-1);
      return {
        body: {
          items,
          ...(older.length > items.length && last !== undefined
            ? { nextCursor: String(last.id) }
            : {}),
        },
      };
    },
    ...overrides,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    {
      path,
    },
  );
  return {
    calls,
    app,
    setEvents: (next) => {
      log = next;
    },
  };
};
