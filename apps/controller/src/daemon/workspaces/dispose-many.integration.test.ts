/**
 * Integration tests for `workspace.disposeMany` (spec 11, workspace). The test
 * plays the runner. What is checked here:
 *
 * - only the user may call it;
 * - a workspace used after the time the caller looked is refused, keeps its
 *   files, and the runner is told nothing;
 * - a main workspace is refused;
 * - each workspace is reserved on its own: one refusal does not stop the
 *   others, and the results come back in the order given;
 * - a plain workspace is removed as `workspace.dispose` removes it, and an
 *   archived one is removed whole with its archived sessions.
 */
import { describe, expect, it } from "vitest";
import type { Session, Workspace, WorkspaceDisposeManyOutput } from "@hercule/contract";
import type { WorkspaceDispose } from "@hercule/protocol";
import { mintUuid, uuidToString } from "../../db";
import { post } from "../../http/testing";
import {
  CURRENT_CAPABILITIES,
  spawnThreadWithGrants,
  WAIT_DEADLINE_MS,
  waitUntil,
  type Arranged,
} from "../../sessions/testing";
import {
  createRepo,
  endResumable,
  listFramesTagged,
  readWorkspace,
  spawnThread,
  withFleet,
} from "../../workspaces/testing";

const MAIN_REFUSAL = "A main workspace is removed on its own, with workspace.dispose.";

const USED_REFUSAL =
  "Someone used this workspace since you looked. Check it again before you remove it.";

const LISTED_TWICE_REFUSAL = "This workspace is listed more than once in the request.";

interface Item {
  readonly workspaceId: string;
  readonly expectedLastUsedAt?: string;
}

/** Calls `workspace.disposeMany` with this token and returns the raw response. */
const callDisposeMany = (arranged: Arranged, items: ReadonlyArray<Item>, token?: string) =>
  post(arranged.harness.base, "/api/v1/workspaces/dispose", { items }, token ?? arranged.token);

/** Has the user call `workspace.disposeMany` and returns its results. */
const disposeMany = async (
  arranged: Arranged,
  items: ReadonlyArray<Item>,
): Promise<WorkspaceDisposeManyOutput["results"]> => {
  const response = await callDisposeMany(arranged, items);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as WorkspaceDisposeManyOutput).results;
};

/** Returns the dispose frames the runner was sent for the workspace. */
const listDisposals = (arranged: Arranged, workspaceId: string): ReadonlyArray<WorkspaceDispose> =>
  listFramesTagged(arranged.wire, "workspaceDispose").filter(
    (frame) => frame["workspaceId"] === workspaceId,
  ) as unknown as ReadonlyArray<WorkspaceDispose>;

/** Starts a Thread in a workspace of its own and ends it, so nothing holds the workspace. Returns the Thread. */
const startIdleThread = async (arranged: Arranged, count: number): Promise<Session> => {
  const thread = await spawnThread(arranged, { kind: "ephemeral", checkouts: [] }, count);
  await endResumable(arranged, thread);
  return thread;
};

/** Has the user archive these Threads, through `session.archive`. */
const archiveThreads = async (arranged: Arranged, sessionIds: ReadonlyArray<string>) => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/sessions/archive",
    { sessionIds },
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
};

/** Reads the workspace's `lastUsedAt`, which an idle workspace always has. */
const readLastUsedAt = async (arranged: Arranged, workspaceId: string): Promise<string> => {
  const workspace: Workspace = await readWorkspace(arranged, workspaceId);
  expect(workspace.lastUsedAt).not.toBeNull();
  return workspace.lastUsedAt!;
};

describe("workspace.disposeMany", () => {
  it(
    "refuses a session whatever its profile grants, and removes nothing",
    async () => {
      await withFleet(
        async (arranged) => {
          const idle = await startIdleThread(arranged, 1);
          const workspaceId = idle.workspaceId!;
          const caller = await spawnThreadWithGrants(arranged, "removers", ["workspace.write"]);

          const response = await callDisposeMany(arranged, [{ workspaceId }], caller.token);

          expect(response.status).toBe(403);
          expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
          expect((await readWorkspace(arranged, workspaceId)).status).toBe("ready");
          expect(listDisposals(arranged, workspaceId)).toEqual([]);
        },
        { capabilities: CURRENT_CAPABILITIES },
      );
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "refuses a workspace a session used after expectedLastUsedAt, keeps its files, and removes it once the caller has looked again",
    async () => {
      await withFleet(
        async (arranged) => {
          const first = await startIdleThread(arranged, 1);
          const workspaceId = first.workspaceId!;
          const lookedAt = await readLastUsedAt(arranged, workspaceId);

          const second = await spawnThread(arranged, { kind: "existing", workspaceId }, 2);
          await endResumable(arranged, second);
          const usedAt = await readLastUsedAt(arranged, workspaceId);
          expect(usedAt).not.toBe(lookedAt);

          expect(
            await disposeMany(arranged, [{ workspaceId, expectedLastUsedAt: lookedAt }]),
          ).toEqual([{ workspaceId, outcome: "refused", message: USED_REFUSAL }]);
          expect((await readWorkspace(arranged, workspaceId)).status).toBe("ready");
          expect(listDisposals(arranged, workspaceId)).toEqual([]);

          expect(
            await disposeMany(arranged, [{ workspaceId, expectedLastUsedAt: usedAt }]),
          ).toEqual([{ workspaceId, outcome: "requested" }]);
          const frame = await waitUntil(
            "asked the runner to remove the workspace",
            () => listDisposals(arranged, workspaceId)[0],
          );
          expect(frame).not.toHaveProperty("discardChanges");
          expect((await readWorkspace(arranged, workspaceId)).status).toBe("disposing");
        },
        { capabilities: CURRENT_CAPABILITIES },
      );
    },
    WAIT_DEADLINE_MS * 3,
  );

  it(
    "answers each workspace in the order given, refuses a main workspace, an unknown id and a repeat without stopping the rest, and removes an archived workspace whole",
    async () => {
      await withFleet(
        async (arranged) => {
          const plain = (await startIdleThread(arranged, 1)).workspaceId!;

          const archivedThread = await startIdleThread(arranged, 2);
          await archiveThreads(arranged, [archivedThread.id]);
          const archived = archivedThread.workspaceId!;

          const resourceId = await createRepo(arranged, "https://github.com/o/main.git");
          const mainThread = await spawnThread(arranged, { kind: "primary", resourceId }, 3);
          await endResumable(arranged, mainThread);
          const main = mainThread.workspaceId!;

          const unknown = uuidToString(mintUuid());

          const results = await disposeMany(arranged, [
            { workspaceId: main },
            { workspaceId: unknown },
            { workspaceId: plain },
            { workspaceId: archived },
            { workspaceId: plain },
          ]);

          expect(results).toEqual([
            { workspaceId: main, outcome: "refused", message: MAIN_REFUSAL },
            { workspaceId: unknown, outcome: "refused", message: "no such workspace" },
            { workspaceId: plain, outcome: "requested" },
            { workspaceId: archived, outcome: "requested" },
            { workspaceId: plain, outcome: "refused", message: LISTED_TWICE_REFUSAL },
          ]);

          const plainFrame = await waitUntil(
            "asked the runner to remove the plain workspace",
            () => listDisposals(arranged, plain)[0],
          );
          expect(plainFrame).not.toHaveProperty("discardChanges");
          expect(plainFrame).not.toHaveProperty("archivedSessions");
          const archivedFrame = await waitUntil(
            "asked the runner to remove the archived workspace",
            () => listDisposals(arranged, archived)[0],
          );
          expect(archivedFrame.discardChanges).toBe(true);
          expect(archivedFrame.archivedSessions).toMatchObject([{ nativeSessionId: "native-1" }]);

          expect(listDisposals(arranged, plain)).toHaveLength(1);
          expect(listDisposals(arranged, main)).toEqual([]);
          expect((await readWorkspace(arranged, main)).status).toBe("ready");
        },
        { capabilities: CURRENT_CAPABILITIES },
      );
    },
    WAIT_DEADLINE_MS * 4,
  );
});
