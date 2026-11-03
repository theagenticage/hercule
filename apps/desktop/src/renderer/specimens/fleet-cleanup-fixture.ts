/**
 * The controller's end of a cleanup of studio in the Fleet specimen
 * (`fleet.html?cleanup`), played through the specimen's fetch: it answers the
 * cleanup dialog's read of the Threads of studio's idle workspaces
 * (`STUDIO_IDLE_RECORDS`, in fleet-fixture.ts), the archive, the removal
 * request and the read of the workspaces that follows it.
 */
import { USED_SINCE_LOOKED_REFUSAL, type Session } from "@hercule/contract";
import { STUDIO_IDLE_RECORDS } from "./fleet-fixture";
import { SPECIMEN_NOW } from "./sidebar-fixture";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns the instant `days` days before the specimen's clock. */
const daysAgo = (days: number): string => new Date(SPECIMEN_NOW - days * DAY_MS).toISOString();

const STUDIO_WORKSPACES = STUDIO_IDLE_RECORDS.map(({ workspace }) => workspace);
const STUDIO_THREADS = STUDIO_IDLE_RECORDS.map(({ thread }) => thread);

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
  threads: STUDIO_THREADS,
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
  const [, second, , , fifth] = STUDIO_WORKSPACES;
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
        const removed = STUDIO_WORKSPACES.map((workspace) =>
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
