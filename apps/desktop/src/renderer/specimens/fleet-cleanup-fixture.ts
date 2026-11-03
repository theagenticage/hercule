/**
 * The idle workspaces of studio in the Fleet specimen (fleet-fixture.ts), for
 * the cleanup dialog (`fleet.html?cleanup`): nine workspaces that Threads used
 * and nobody has used for 8 to 40 days, six whose Threads are all Done and
 * three that still have a Thread that is not. One has a name too long for its
 * row, and one was never measured.
 *
 * The Threads carry UUIDv7 ids and answer the cleanup dialog's read of them
 * through the specimen's fetch, which decodes them like any answer. The fetch
 * also plays the controller's end of a cleanup (`createCleanupSession`).
 */
import { USED_SINCE_LOOKED_REFUSAL, type Session, type Workspace } from "@hercule/contract";
import { buildSession, buildWorkspace } from "@hercule/client-core/threads/testing";
import { STUDIO } from "./fleet-fixture";
import { SPECIMEN_NOW } from "./sidebar-fixture";

const GB = 1e9;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns the instant `days` days before the specimen's clock. */
const daysAgo = (days: number): string => new Date(SPECIMEN_NOW - days * DAY_MS).toISOString();

/** Returns a canonical UUIDv7 for the record numbered `number`. */
const buildId = (number: number): string =>
  `01a0f0c0-1000-7000-8000-${String(number).padStart(12, "0")}`;

interface IdleSpec {
  /** The title of the workspace's one Thread, which names the row. */
  readonly title: string;
  /** What removing the workspace frees in GB, or `null` for one never measured. */
  readonly freesGb: number | null;
  readonly usedDaysAgo: number;
  readonly isDone: boolean;
}

const IDLE_SPECS: readonly IdleSpec[] = [
  {
    title: "Migrate the payout report to the new ledger",
    freesGb: 14.2,
    usedDaysAgo: 12,
    isDone: true,
  },
  { title: "Fix the flaky checkout test", freesGb: 9.8, usedDaysAgo: 19, isDone: true },
  {
    title: "Upgrade the search index to the new analyzer and re-run every fixture",
    freesGb: 7.4,
    usedDaysAgo: 8,
    isDone: false,
  },
  {
    title: "Spike: stream invoices over the websocket",
    freesGb: 6.1,
    usedDaysAgo: 24,
    isDone: true,
  },
  { title: "Draft the 2026 pricing page", freesGb: 3.3, usedDaysAgo: 31, isDone: true },
  { title: "Investigate the slow dashboard query", freesGb: 2.6, usedDaysAgo: 15, isDone: false },
  { title: "Rename the billing module", freesGb: 1.2, usedDaysAgo: 40, isDone: true },
  { title: "Try the new date picker", freesGb: 0.48, usedDaysAgo: 22, isDone: true },
  { title: "Backfill the audit log", freesGb: null, usedDaysAgo: 10, isDone: false },
];

/** Studio's idle workspaces, ephemeral and ready. */
export const STUDIO_CLEANUP_WORKSPACES: readonly Workspace[] = IDLE_SPECS.map(
  ({ freesGb, usedDaysAgo }, index): Workspace =>
    buildWorkspace({
      id: buildId(index + 1),
      runnerId: STUDIO.id,
      kind: "ephemeral",
      lastUsedAt: daysAgo(usedDaysAgo),
      diskUsage:
        freesGb === null
          ? null
          : {
              sizeBytes: Math.round(freesGb * 1.25 * GB),
              freesBytes: Math.round(freesGb * GB),
              measuredAt: daysAgo(1),
            },
    }),
);

/** A Thread with UUIDv7 in every id field, which the specimen's fetch answers can carry. */
const STUDIO_THREAD_BASE: Session = buildSession({
  id: buildId(99),
  permissionProfileId: buildId(900),
  providerAccountId: buildId(901),
});

/** The Thread each idle workspace holds. */
export const STUDIO_CLEANUP_THREADS: readonly Session[] = IDLE_SPECS.map(
  ({ title, usedDaysAgo, isDone }, index): Session => ({
    ...STUDIO_THREAD_BASE,
    id: buildId(100 + index),
    title,
    workspaceId: buildId(index + 1),
    runnerId: STUDIO.id,
    status: "idle",
    createdAt: daysAgo(usedDaysAgo + 2),
    startedAt: daysAgo(usedDaysAgo + 2),
    lastActivityAt: daysAgo(usedDaysAgo),
    exitedAt: daysAgo(usedDaysAgo),
    ...(isDone ? { done: { at: daysAgo(usedDaysAgo), by: "user" as const } } : {}),
  }),
);

/** What the controller answers during a cleanup of studio. */
export interface CleanupAnswers {
  /** The Threads of the idle workspaces, which Clean up… reads. */
  readonly threads: readonly Session[];
  /**
   * How the workspaces read once their removal was asked for: `"pending"`
   * never answers, so every row stays "Removing…"; `"partial"` answers with
   * the removals settled, two workspaces refused by the machine.
   */
  readonly removal: "pending" | "partial";
}

/** Returns the answers for `cleanup`'s kind of removal. */
export const buildCleanupAnswers = (removal: CleanupAnswers["removal"]): CleanupAnswers => ({
  threads: STUDIO_CLEANUP_THREADS,
  removal,
});

const NOT_ANSWERED = new Promise<Response>(() => {});

/** Answers `body` as JSON. */
const answerJson = (body: unknown): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
  );

/** Reads the JSON body of a request. */
const readJson = <Body>(init: RequestInit | undefined): Promise<Body> =>
  new Response(init?.body).json() as Promise<Body>;

/**
 * Plays the controller's end of a cleanup of studio for the specimen's fetch:
 * the Threads read, the archive, the removal request and the workspaces read
 * that follows it. `answer` returns `undefined` for a request that is not part
 * of the cleanup, which the specimen's other answers then handle.
 *
 * The workspace in row 5 is refused as used since the dialog opened, in the
 * removal request itself. In a `partial` removal, row 2 is refused by the
 * machine afterwards, and the rest are deleted.
 */
export const createCleanupSession = (cleanup: CleanupAnswers) => {
  let isRemovalAsked = false;
  const [, second, , , fifth] = STUDIO_CLEANUP_WORKSPACES;
  return {
    answer: (url: string, init: RequestInit | undefined): Promise<Response> | undefined => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/api/v1/sessions?") && url.includes("workspaceId=")) {
        return answerJson({ items: cleanup.threads });
      }
      if (method === "POST" && url.endsWith("/api/v1/sessions/archive")) {
        return readJson<{ sessionIds: string[] }>(init).then(({ sessionIds }) =>
          answerJson(
            cleanup.threads
              .filter((thread) => sessionIds.includes(thread.id))
              .map((thread) => ({ ...thread, archived: { at: daysAgo(0), by: "user" } })),
          ),
        );
      }
      if (method === "POST" && url.endsWith("/api/v1/workspaces/dispose")) {
        isRemovalAsked = true;
        return readJson<{ items: { workspaceId: string }[] }>(init).then(({ items }) =>
          answerJson({
            results: items.map(({ workspaceId }) =>
              workspaceId === fifth!.id
                ? { workspaceId, outcome: "refused", message: USED_SINCE_LOOKED_REFUSAL }
                : { workspaceId, outcome: "requested" },
            ),
          }),
        );
      }
      if (method === "GET" && url.includes("/api/v1/workspaces") && isRemovalAsked) {
        if (cleanup.removal === "pending") return NOT_ANSWERED;
        const removed = STUDIO_CLEANUP_WORKSPACES.map((workspace) =>
          workspace.id === second!.id
            ? { ...workspace, message: "A process still has a file open." }
            : { ...workspace, status: "deleted" as const },
        );
        return answerJson({ items: removed });
      }
      return undefined;
    },
  };
};
