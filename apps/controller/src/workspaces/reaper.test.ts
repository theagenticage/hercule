/**
 * The workspace expiry sweep, on the workspaces of threads.
 *
 * Every session holds a lease on its workspace while it runs, and releases
 * it when it exits. The controller decides what to dispose of from the
 * leases alone, and the runner deletes it:
 *
 * - A thread that cannot be resumed releases its lease as `orphan`, and its
 *   workspace is disposed of after the orphan window.
 * - A thread that can still be resumed holds work the user may come back to,
 *   so it releases its lease as `idle`, and its workspace is disposed of only
 *   after the longer idle window.
 * - A workspace with an active lease is never disposed of, and neither is a
 *   primary or any workspace on a runner that is offline.
 * - The window is fixed when the lease is released: a settings change moves
 *   only later releases.
 *
 * The test passes in the sweep interval, as it does the ping and probe
 * intervals: the shipped ten minutes is longer than a test can wait, and a
 * real Bun listener cannot be driven by a `TestClock`. The tests cross the
 * windows by ageing the leases rather than by waiting, since the shortest
 * value either setting allows is an hour.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import type { SessionStart } from "@hercule/protocol";
import { get, send } from "../http/testing";
import {
  waitForFrames,
  reportEvent,
  spawnSessionOrFail,
  waitUntil,
  type Arranged,
} from "../sessions/testing";
import {
  ageLeases,
  bindTranscript,
  countLeases,
  endResumable,
  endUnresumable,
  listFramesTagged,
  listWorkspaceDeletions,
  provisionWorkspaceOrFail,
  readWorkspace,
  reportThreadExit,
  reportWorkspaceReady,
  createRepo,
  spawnThread,
  withFleet,
  type WorkspaceRecord,
} from "./testing";

/** A sweep interval short enough for a test to wait for, instead of the shipped ten minutes. */
const SWEEP = Duration.millis(50);

const HOUR_MS = 60 * 60 * 1000;

const withSweep = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  withFleet(body, { workspaceSweepInterval: SWEEP });

const at = "2026-09-16T10:00:00.000Z";

/** Spawns a thread in a worktree of its own; see `spawnThread`. */
const spawnThreadIn = (arranged: Arranged, resourceId: string, count: number) =>
  spawnThread(arranged, { kind: "ephemeral", checkouts: [{ resourceId }] }, count);

/** Returns the time `hours` after `from`, as the API writes a timestamp. */
const addHours = (from: string, hours: number): string =>
  new Date(Date.parse(from) + hours * HOUR_MS).toISOString();

/**
 * Waits for six sweep intervals, so "left alone" means the sweep kept the
 * workspace, not that it has not run yet. A sweep reads its candidates in one
 * query and disposes of them before it sleeps again, so one interval is enough
 * to act, and the other five are a margin for a loaded machine. A workspace
 * that still exists after six intervals is one the sweep decided to keep.
 */
const waitForSeveralSweeps = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Duration.toMillis(SWEEP) * 6));

/**
 * Creates a workspace that the same sweep must dispose of: its thread ended
 * with nothing to resume, and its lease is aged past the orphan window.
 * Returns its id. A negative test waits for this workspace to be disposed of
 * rather than for a stretch of wall-clock time, so "left alone" is a decision
 * the sweep made in that pass, not a pass that never ran.
 */
const createDecoy = async (
  arranged: Arranged,
  resourceId: string,
  count: number,
): Promise<string> => {
  const session = await spawnThreadIn(arranged, resourceId, count);
  await endUnresumable(arranged, session);
  const workspaceId = String(session.workspaceId);
  await ageLeases(arranged, workspaceId, 25);
  return workspaceId;
};

const waitForDisposed = (arranged: Arranged, id: string): Promise<WorkspaceRecord> =>
  waitUntil("disposed the workspace", async () => {
    const one = await readWorkspace(arranged, id);
    return one.status === "deleted" ? one : undefined;
  });

/**
 * Waits until at least `count` dispose frames were sent to the runner, and
 * returns their workspace ids. The sweep updates the row in its transaction
 * and sends the frame after the commit, so a test that reads the wire as soon
 * as the row is `deleted` would be asserting on a race.
 */
const waitForDisposeFrames = (arranged: Arranged, count: number): Promise<ReadonlyArray<unknown>> =>
  waitUntil(`sent ${String(count)} workspaceDispose frames`, () => {
    const sent = listFramesTagged(arranged.wire, "workspaceDispose").map(
      (frame) => frame["workspaceId"],
    );
    return sent.length >= count ? sent : undefined;
  });

/** Moves a workspace's `lastUsedAt` back by `hours`, so a test can see the next write change it. */
const ageLastUsed = (arranged: Arranged, id: string, hours: number): Promise<unknown> =>
  Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql`
        UPDATE workspaces
        SET last_used_at = ${new Date(Date.now() - hours * HOUR_MS).toISOString()}
        WHERE id = unhex(replace(${id}, '-', ''))`,
    ),
  );

/** Returns when the session last exited, as the API reports it. */
const readThreadExit = async (arranged: Arranged, sessionId: string): Promise<string> => {
  const response = await get(
    arranged.harness.base,
    `/api/v1/sessions/${sessionId}`,
    arranged.token,
  );
  const session = (await response.json()) as { readonly exitedAt: string | null };
  if (session.exitedAt === null) throw new Error("the session has not exited");
  return session.exitedAt;
};

describe("the workspace expiry sweep", () => {
  it("disposes of an orphaned ephemeral workspace past the orphan window, and leaves a newer one", async () => {
    await withSweep(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const old = await spawnThreadIn(arranged, web, 1);
      await endUnresumable(arranged, old);
      const oldWorkspace = String(old.workspaceId);

      const young = await spawnThreadIn(arranged, web, 2);
      await endUnresumable(arranged, young);
      const youngWorkspace = String(young.workspaceId);

      // The default orphan window is a day; only one of the two is older.
      await ageLeases(arranged, oldWorkspace, 25);

      const gone = await waitForDisposed(arranged, oldWorkspace);
      expect(gone.status).toBe("deleted");
      expect(gone.keptUntil).toBeNull();
      // A workspace that is gone keeps nothing, so its released leases go too.
      expect(await countLeases(arranged, oldWorkspace)).toBe(0);
      expect(await waitForDisposeFrames(arranged, 1)).toEqual([oldWorkspace]);
      expect((await readWorkspace(arranged, youngWorkspace)).status).not.toBe("deleted");

      // No user disposed of this workspace, so the audit entry records the
      // system as the actor, the retention that let it go as the reason, and
      // the holder of that lease.
      const swept = await listWorkspaceDeletions(arranged);
      expect(swept).toHaveLength(1);
      expect(swept[0]?.actor).toBe("system");
      expect(swept[0]?.payload).toEqual({
        workspaceId: oldWorkspace,
        runnerId: arranged.runnerId,
        reason: "orphan",
        holder: `session:${old.id}`,
      });
    });
  });

  it("keeps a resumable thread's workspace past the orphan window, and disposes of it after the idle window", async () => {
    await withSweep(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const session = await spawnThreadIn(arranged, web, 1);
      await endResumable(arranged, session);
      const workspaceId = String(session.workspaceId);

      // The idle window, thirty days by default, runs from the exit.
      const kept = await readWorkspace(arranged, workspaceId);
      expect(kept.sessionIds).toEqual([]);
      const exited = await readThreadExit(arranged, session.id);
      expect(kept.keptUntil).toBe(addHours(exited, 30 * 24));

      // Past one day, but well short of thirty.
      await ageLeases(arranged, workspaceId, 25);
      await waitForSeveralSweeps();
      expect((await readWorkspace(arranged, workspaceId)).status).not.toBe("deleted");
      expect(listFramesTagged(arranged.wire, "workspaceDispose")).toEqual([]);

      await ageLeases(arranged, workspaceId, 30 * 24);
      const gone = await waitForDisposed(arranged, workspaceId);
      expect(gone.status).toBe("deleted");
    });
  });

  it("makes a resumed thread's lease active again, so its workspace is kept while it runs", async () => {
    await withSweep(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const session = await spawnThreadIn(arranged, web, 1);
      await endResumable(arranged, session);
      const workspaceId = String(session.workspaceId);
      expect((await readWorkspace(arranged, workspaceId)).keptUntil).not.toBeNull();

      // A new message resumes the session in the workspace it exited from.
      const input = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/input`,
        {
          body: { text: "again" },
          token: arranged.token,
        },
      );
      expect(input.status, await input.clone().text()).toBe(200);
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2);

      const resumed = await readWorkspace(arranged, workspaceId);
      expect(resumed.sessionIds).toEqual([session.id]);
      expect(resumed.keptUntil).toBeNull();

      // However far back the old release is moved, the active lease keeps it.
      await ageLeases(arranged, workspaceId, 90 * 24);
      const taken = await createDecoy(arranged, web, 3);
      await waitForDisposed(arranged, taken);
      expect((await readWorkspace(arranged, workspaceId)).status).toBe("ready");
    });
  });

  it("disposes of the workspace past the orphan window when the thread's conversation was deleted before it exited", async () => {
    await withSweep(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const session = await spawnThreadIn(arranged, web, 1);
      await bindTranscript(arranged, session);
      const workspaceId = String(session.workspaceId);
      // The session answers a conversation that is deleted while it runs. It
      // then takes no input, so it can never be resumed, and its worktree
      // holds no work anyone can come back to.
      await Effect.runPromise(
        Effect.orDie(
          Effect.gen(function* () {
            const sql = arranged.harness.sql;
            // A UUIDv7, which the API requires of the id it reads back.
            const conversation = `0199e0e7000070008000${crypto.randomUUID().slice(-12)}`;
            yield* sql`
              INSERT INTO conversations (id, assistant_id, channel, container_key, created_at)
              VALUES (unhex(${conversation}), randomblob(16), 'web', NULL, ${at})`;
            yield* sql`
              UPDATE sessions SET conversation_id = unhex(${conversation})
              WHERE id = unhex(replace(${session.id}, '-', ''))`;
            yield* sql`DELETE FROM conversations WHERE id = unhex(${conversation})`;
          }),
        ),
      );
      const exited = await reportThreadExit(arranged, session, "stopped");
      expect(exited.resumable).toBe(false);

      // Past one day, well short of thirty: only a lease released as
      // `orphan` lets the workspace go this early.
      await ageLeases(arranged, workspaceId, 25);
      const gone = await waitForDisposed(arranged, workspaceId);
      expect(gone.status).toBe("deleted");
    });
  });

  it("leaves a workspace with a running session", async () => {
    await withSweep(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const session = await spawnThreadIn(arranged, web, 1);
      const workspaceId = String(session.workspaceId);
      const running = await readWorkspace(arranged, workspaceId);
      expect(running.sessionIds).toEqual([session.id]);
      expect(running.keptUntil).toBeNull();

      const taken = await createDecoy(arranged, web, 2);

      // The pass that disposed of the decoy also saw this workspace and kept it.
      await waitForDisposed(arranged, taken);
      expect((await readWorkspace(arranged, workspaceId)).status).not.toBe("deleted");
      expect(await waitForDisposeFrames(arranged, 1)).toEqual([taken]);
    });
  });

  it("leaves a primary alone, even after every lease on it has run out", async () => {
    await withSweep(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const primary = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      await reportWorkspaceReady(arranged, primary.id);
      const thread = await spawnThread(arranged, { kind: "primary", resourceId: web }, 1);
      expect(thread.workspaceId).toBe(primary.id);
      await endUnresumable(arranged, thread);
      await ageLeases(arranged, primary.id, 90 * 24);
      expect((await readWorkspace(arranged, primary.id)).keptUntil).toBeNull();

      const taken = await createDecoy(arranged, web, 2);

      // The pass that disposed of the decoy also saw the primary and kept it.
      await waitForDisposed(arranged, taken);
      expect((await readWorkspace(arranged, primary.id)).status).toBe("ready");
      expect(await waitForDisposeFrames(arranged, 1)).toEqual([taken]);
    });
  });

  it("keeps no released lease on a primary, and holds the lease again when the thread is resumed", async () => {
    await withSweep(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const primary = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      await reportWorkspaceReady(arranged, primary.id);
      const thread = await spawnThread(arranged, { kind: "primary", resourceId: web }, 1);
      expect((await readWorkspace(arranged, primary.id)).sessionIds).toEqual([thread.id]);

      // The sweep never deletes a primary, so a released lease on one would
      // only take up a row.
      await endResumable(arranged, thread);
      expect((await readWorkspace(arranged, primary.id)).sessionIds).toEqual([]);
      expect(await countLeases(arranged, primary.id)).toBe(0);

      const input = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/sessions/${thread.id}/input`,
        { body: { text: "again" }, token: arranged.token },
      );
      expect(input.status, await input.clone().text()).toBe(200);
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2);
      expect((await readWorkspace(arranged, primary.id)).sessionIds).toEqual([thread.id]);
    });
  });

  it("waits for an offline runner to come back before disposing of its workspace", async () => {
    await withSweep(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const session = await spawnThreadIn(arranged, web, 1);
      await endUnresumable(arranged, session);
      const workspaceId = String(session.workspaceId);
      await ageLeases(arranged, workspaceId, 90 * 24);

      arranged.wire.close();
      await waitUntil("saw the runner go offline", async () => {
        const response = await get(
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}`,
          arranged.token,
        );
        const runner = (await response.json()) as { connectivity: string };
        return runner.connectivity === "online" ? undefined : runner;
      });
      await waitForSeveralSweeps();

      expect((await readWorkspace(arranged, workspaceId)).status).not.toBe("deleted");

      // The first sweep after the runner reconnects disposes of it.
      await arranged.reconnect();
      await waitForDisposed(arranged, workspaceId);
    });
  });

  it("marks the workspace used at provisioning and at every session start and exit in it", async () => {
    await withSweep(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspaceId = String(session.workspaceId);

      const atProvision = await readWorkspace(arranged, workspaceId);
      expect(atProvision.lastUsedAt).not.toBeNull();

      await ageLastUsed(arranged, workspaceId, 1);
      const aged = await readWorkspace(arranged, workspaceId);

      await reportWorkspaceReady(arranged, workspaceId);
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
      });
      const started = await waitUntil("marked the workspace used at the start", async () => {
        const one = await readWorkspace(arranged, workspaceId);
        return one.lastUsedAt !== aged.lastUsedAt ? one : undefined;
      });

      await ageLastUsed(arranged, workspaceId, 1);
      // Read the aged value back, as after the first ageing. Waiting for a
      // wall-clock threshold instead would be satisfied by the value the start
      // wrote, and the test would pass even if the exit marked nothing.
      const before = await readWorkspace(arranged, workspaceId);
      expect(before.lastUsedAt).not.toBe(started.lastUsedAt);
      await endUnresumable(arranged, session);
      const ended = await waitUntil("marked the workspace used at the exit", async () => {
        const one = await readWorkspace(arranged, workspaceId);
        return one.lastUsedAt !== null && one.lastUsedAt !== before.lastUsedAt ? one : undefined;
      });
      expect(ended.lastUsedAt).not.toBe(started.lastUsedAt);
    });
  });
});

describe("the windows the sweep reads", () => {
  it("fixes each window when the lease is released, so a settings change moves only later releases", async () => {
    await withSweep(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const before = await spawnThreadIn(arranged, web, 1);
      await endUnresumable(arranged, before);
      const beforeWorkspace = String(before.workspaceId);
      const keptUntil = (await readWorkspace(arranged, beforeWorkspace)).keptUntil;
      expect(keptUntil).toBe(addHours(await readThreadExit(arranged, before.id), 24));

      const patched = await send("PATCH", arranged.harness.base, "/api/v1/settings", {
        body: { controller: { "workspace.orphanTtlHours": 1 } },
        token: arranged.token,
      });
      expect(patched.status, await patched.clone().text()).toBe(200);
      expect((await readWorkspace(arranged, beforeWorkspace)).keptUntil).toBe(keptUntil);

      // A thread that exits after the change is kept for the new hour.
      const after = await spawnThreadIn(arranged, web, 2);
      await endUnresumable(arranged, after);
      const afterWorkspace = String(after.workspaceId);
      expect((await readWorkspace(arranged, afterWorkspace)).keptUntil).toBe(
        addHours(await readThreadExit(arranged, after.id), 1),
      );

      // Two hours on, only the thread released under the new window has run out.
      await ageLeases(arranged, beforeWorkspace, 2);
      await ageLeases(arranged, afterWorkspace, 2);
      await waitForDisposed(arranged, afterWorkspace);
      expect((await readWorkspace(arranged, beforeWorkspace)).status).toBe("ready");
    });
  });
});
