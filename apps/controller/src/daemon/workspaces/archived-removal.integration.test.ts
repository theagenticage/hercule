/**
 * Integration tests for removing the workspace of archived Threads (spec 03
 * section 6.9). The test plays the runner. Threads are archived by writing the
 * rows `session.archive` writes, because that operation belongs to the
 * sessions domain; what is checked here is what the workspace does with them:
 *
 * - the sweep and `workspace.dispose` remove an archived workspace whole,
 *   and list the archived sessions whose harness files go with it;
 * - a runner without the `archivedSessionFiles` capability gets neither the
 *   list nor a refusal, and the workspace is left with a warning;
 * - the warnings a runner reports when it confirms the removal are stored.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import type { Session, Workspace } from "@hercule/contract";
import { ARCHIVED_SESSION_FILES_CAPABILITY, type WorkspaceDispose } from "@hercule/protocol";
import { withTransaction } from "../../db";
import { get, send } from "../../http/testing";
import {
  CURRENT_CAPABILITIES,
  waitUntil,
  WAIT_DEADLINE_MS,
  type Arranged,
} from "../../sessions/testing";
import {
  ageLeases,
  archiveSessions,
  endResumable,
  listFramesTagged,
  readWorkspace,
  returnToAutomaticCleanup,
  spawnThread,
  withFleet,
} from "../../workspaces/testing";

const SWEEP = Duration.millis(50);

const WITHOUT_FILES = CURRENT_CAPABILITIES.filter((c) => c !== ARCHIVED_SESSION_FILES_CAPABILITY);
const WITH_FILES = [...WITHOUT_FILES, ARCHIVED_SESSION_FILES_CAPABILITY];

const RUNNER_TOO_OLD = "This machine's runner is too old to delete the harness's files. Update it.";

/** Waits for six sweep intervals, so a workspace that still exists is one the sweep kept. */
const waitForSeveralSweeps = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Duration.toMillis(SWEEP) * 6));

const readSession = async (arranged: Arranged, id: string): Promise<Session> => {
  const response = await get(arranged.harness.base, `/api/v1/sessions/${id}`, arranged.token);
  expect(response.status).toBe(200);
  return (await response.json()) as Session;
};

/** Runs a write the public API has no operation for, in a transaction of its own. */
const writeRows = (
  arranged: Arranged,
  statement: Effect.Effect<unknown, unknown>,
): Promise<unknown> =>
  Effect.runPromise(Effect.orDie(withTransaction(arranged.harness.sql, statement)));

/** Returns the dispose frames the runner was sent for the workspace. */
const listDisposals = (arranged: Arranged, workspaceId: string): ReadonlyArray<WorkspaceDispose> =>
  listFramesTagged(arranged.wire, "workspaceDispose").filter(
    (frame) => frame["workspaceId"] === workspaceId,
  ) as unknown as ReadonlyArray<WorkspaceDispose>;

/**
 * Starts a Thread in a workspace of its own, ends it so that its lease is
 * released, and archives it the way `session.archive` does: the session is
 * marked, and the workspace goes back to automatic cleanup. Returns the
 * session, with its native session id bound.
 */
const archiveThread = async (arranged: Arranged, count: number): Promise<Session> => {
  const thread = await spawnThread(arranged, { kind: "ephemeral", checkouts: [] }, count);
  await endResumable(arranged, thread);
  await archiveSessions(arranged, [thread.id]);
  await returnToAutomaticCleanup(arranged, thread.workspaceId!);
  return await readSession(arranged, thread.id);
};

/** Has the user dispose of the workspace without asking to discard anything. */
const disposeWorkspace = async (arranged: Arranged, workspaceId: string): Promise<void> => {
  const response = await send(
    "DELETE",
    arranged.harness.base,
    `/api/v1/workspaces/${workspaceId}`,
    { token: arranged.token },
  );
  expect(response.status, await response.clone().text()).toBe(200);
};

/** Has the runner confirm the removal the controller asked for, with these warnings. */
const confirmDeleted = async (
  arranged: Arranged,
  frame: WorkspaceDispose,
  warnings: ReadonlyArray<string>,
): Promise<Workspace> => {
  arranged.wire.send({
    _tag: "workspaceReport",
    workspaceId: frame.workspaceId,
    requestId: frame.requestId!,
    status: "deleted",
    ...(warnings.length === 0 ? {} : { warnings }),
  });
  return await waitUntil("recorded the confirmed deletion", async () => {
    const one = await readWorkspace(arranged, frame.workspaceId);
    return one.status === "deleted" ? one : undefined;
  });
};

describe("the sweep on an archived workspace", () => {
  it(
    "removes it whole once the archived window has passed, never before, and leaves a Thread that is not archived alone",
    async () => {
      await withFleet(
        async (arranged) => {
          const unarchived = await spawnThread(arranged, { kind: "ephemeral", checkouts: [] }, 1);
          await endResumable(arranged, unarchived);
          await ageLeases(arranged, unarchived.workspaceId!, 24 * 365);

          const archived = await archiveThread(arranged, 2);
          const workspaceId = archived.workspaceId!;
          expect(await readWorkspace(arranged, workspaceId)).toMatchObject({
            retentionPolicy: "automatic",
          });

          await ageLeases(arranged, workspaceId, 6 * 24);
          await waitForSeveralSweeps();
          expect((await readWorkspace(arranged, workspaceId)).status).toBe("ready");

          await ageLeases(arranged, workspaceId, 2 * 24);
          const frame = await waitUntil(
            "asked the runner to remove the archived workspace",
            () => listDisposals(arranged, workspaceId)[0],
          );
          expect(frame.discardChanges).toBe(true);
          expect(frame.archivedSessions).toEqual([
            {
              harnessId: archived.harnessId,
              harnessHome: `providers/homes/${archived.providerAccountId}/${archived.harnessId}`,
              nativeSessionId: "native-1",
            },
          ]);

          const warnings = ["Claude Code kept the files of 1 session: permission denied"];
          const gone = await confirmDeleted(arranged, frame, warnings);
          expect(gone.warnings).toEqual(warnings);
          expect((await readWorkspace(arranged, unarchived.workspaceId!)).status).toBe("ready");
          expect(listDisposals(arranged, unarchived.workspaceId!)).toEqual([]);
        },
        { workspaceSweepInterval: SWEEP, capabilities: WITH_FILES },
      );
    },
    WAIT_DEADLINE_MS * 3,
  );

  it(
    "removes it without the list, and says so, when its runner is too old to delete the harness's files",
    async () => {
      await withFleet(
        async (arranged) => {
          const archived = await archiveThread(arranged, 1);
          const workspaceId = archived.workspaceId!;
          await ageLeases(arranged, workspaceId, 8 * 24);
          const frame = await waitUntil(
            "asked the older runner to remove the archived workspace",
            () => listDisposals(arranged, workspaceId)[0],
          );
          expect(frame.discardChanges).toBe(true);
          expect(frame).not.toHaveProperty("archivedSessions");
          const gone = await confirmDeleted(arranged, frame, []);
          expect(gone.warnings).toEqual([RUNNER_TOO_OLD]);
        },
        { workspaceSweepInterval: SWEEP, capabilities: WITHOUT_FILES },
      );
    },
    WAIT_DEADLINE_MS * 3,
  );
});

describe("workspace.dispose on an archived workspace", () => {
  it(
    "removes it whole and lists the archived sessions, though the user did not ask to discard anything",
    async () => {
      await withFleet(
        async (arranged) => {
          const archived = await archiveThread(arranged, 1);
          const workspaceId = archived.workspaceId!;
          await disposeWorkspace(arranged, workspaceId);
          const [frame] = listDisposals(arranged, workspaceId);
          expect(frame!.discardChanges).toBe(true);
          expect(frame!.archivedSessions).toMatchObject([{ nativeSessionId: "native-1" }]);
          // Asking again while the removal is pending finds the same removal.
          await disposeWorkspace(arranged, workspaceId);
          expect(listDisposals(arranged, workspaceId).at(-1)).toEqual(frame);
          expect((await confirmDeleted(arranged, frame!, [])).warnings).toEqual([]);
        },
        { capabilities: WITH_FILES },
      );
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "names the harness home of an account made by the upgrade after the folder it kept",
    async () => {
      await withFleet(
        async (arranged) => {
          const archived = await archiveThread(arranged, 1);
          await writeRows(
            arranged,
            arranged.harness.sql`
                UPDATE provider_accounts
                SET legacy_home_folder = 'old-login', legacy_home_harness_id = ${archived.harnessId}
                WHERE id = unhex(replace(${archived.providerAccountId}, '-', ''))`,
          );
          await disposeWorkspace(arranged, archived.workspaceId!);
          const [frame] = listDisposals(arranged, archived.workspaceId!);
          expect(frame!.archivedSessions).toMatchObject([{ harnessHome: "providers/old-login" }]);
        },
        { capabilities: WITH_FILES },
      );
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "leaves out a session whose provider account is gone, because its harness home cannot be named, and warns that its files stay",
    async () => {
      await withFleet(
        async (arranged) => {
          const archived = await archiveThread(arranged, 1);
          await writeRows(
            arranged,
            arranged.harness.sql`
                UPDATE sessions SET provider_account_id = randomblob(16)
                WHERE id = unhex(replace(${archived.id}, '-', ''))`,
          );
          await disposeWorkspace(arranged, archived.workspaceId!);
          const [frame] = listDisposals(arranged, archived.workspaceId!);
          expect(frame!.discardChanges).toBe(true);
          expect(frame).not.toHaveProperty("archivedSessions");
          const gone = await confirmDeleted(arranged, frame!, []);
          expect(gone.warnings).toEqual([
            "The harness's files of 1 archived session were kept: their account was deleted.",
          ]);
        },
        { capabilities: WITH_FILES },
      );
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "keeps asking safely for a workspace that still has a Thread that is not archived",
    async () => {
      await withFleet(
        async (arranged) => {
          const first = await spawnThread(arranged, { kind: "ephemeral", checkouts: [] }, 1);
          const workspaceId = first.workspaceId!;
          await endResumable(arranged, first);
          const second = await spawnThread(arranged, { kind: "existing", workspaceId }, 2);
          await archiveSessions(arranged, [first.id]);
          // The second Thread is still working, so the workspace is refused.
          const refused = await send(
            "DELETE",
            arranged.harness.base,
            `/api/v1/workspaces/${workspaceId}`,
            { token: arranged.token },
          );
          expect(refused.status).toBe(409);
          await endResumable(arranged, second);
          await disposeWorkspace(arranged, workspaceId);
          const [frame] = listDisposals(arranged, workspaceId);
          expect(frame).not.toHaveProperty("discardChanges");
          expect(frame).not.toHaveProperty("archivedSessions");
        },
        { capabilities: WITH_FILES },
      );
    },
    WAIT_DEADLINE_MS * 2,
  );
});
