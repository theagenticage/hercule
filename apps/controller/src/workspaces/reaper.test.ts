/**
 * The workspace expiry sweep.
 *
 * The controller decides what to dispose of, and the runner deletes it:
 *
 * - An ephemeral workspace nothing uses any more is disposed of after the
 *   orphan window.
 * - A workspace whose thread can still be resumed holds that thread's work,
 *   so it outlives the orphan window and is disposed of only after the longer
 *   idle window.
 * - A primary is never disposed of, and neither is any workspace on a runner
 *   that is offline.
 *
 * The test passes in the sweep interval, as it does the ping and probe
 * intervals: the shipped ten minutes is longer than a test can wait, and a
 * real Bun listener cannot be driven by a `TestClock`. The tests cross the two
 * windows by ageing the rows rather than by waiting, since the shortest value
 * either setting allows is an hour.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import type { SessionStart } from "@hercule/protocol";
import type { Session } from "@hercule/contract";
import { get, send } from "../http/testing";
import {
  waitForFrames,
  reportEvent,
  spawnSessionOrFail,
  waitUntil,
  type Arranged,
} from "../sessions/testing";
import {
  listFramesTagged,
  provisionWorkspaceOrFail,
  readWorkspace,
  createRepo,
  withFleet,
  type WorkspaceRecord,
} from "./testing";

/** A sweep interval short enough for a test to wait for, instead of the shipped ten minutes. */
const SWEEP = Duration.millis(50);

const withSweep = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  withFleet(body, { workspaceSweepInterval: SWEEP });

/** Reports the workspace ready, so the session waiting on it can be dispatched. */
const makeReady = async (arranged: Arranged, id: string): Promise<WorkspaceRecord> => {
  const workspace = await readWorkspace(arranged, id);
  arranged.wire.send({
    _tag: "workspaceReport",
    workspaceId: id,
    status: "ready",
    checkouts: workspace.checkouts.map((checkout) => ({
      checkoutId: checkout.checkoutId,
      branch: "main",
      branches: ["main"],
      defaultBranch: "main",
    })),
  } as never);
  return await waitUntil("made the workspace ready", async () => {
    const one = await readWorkspace(arranged, id);
    return one.status === "ready" ? one : undefined;
  });
};

const at = "2026-09-16T10:00:00.000Z";

/**
 * Spawns a thread in a worktree of its own, and waits until it is started on
 * the runner and busy with the turn its prompt opened.
 */
const spawnThreadIn = async (
  arranged: Arranged,
  resourceId: string,
  count: number,
): Promise<Session> => {
  const session = await spawnSessionOrFail(arranged, {
    prompt: "hello",
    workspace: { kind: "ephemeral", checkouts: [{ resourceId }] },
  });
  await makeReady(arranged, String(session.workspaceId));
  await waitForFrames<SessionStart>(arranged.wire, "sessionStart", count);
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.started",
  });
  await waitUntil("started the session", async () => {
    const response = await get(
      arranged.harness.base,
      `/api/v1/sessions/${session.id}`,
      arranged.token,
    );
    const one = (await response.json()) as Session;
    return one.status === "busy" ? one : undefined;
  });
  return session;
};

/** Ends the thread with nothing to resume from: the workspace is then an orphan. */
const endUnresumable = async (arranged: Arranged, session: Session): Promise<void> => {
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.exited",
    reason: "crash",
  });
  await waitUntil("ended the session", async () => {
    const response = await get(
      arranged.harness.base,
      `/api/v1/sessions/${session.id}`,
      arranged.token,
    );
    const one = (await response.json()) as Session;
    return one.status === "exited" && !one.resumable ? one : undefined;
  });
};

/** Ends the thread so that the next input resumes it in place. */
const endResumable = async (arranged: Arranged, session: Session): Promise<void> => {
  arranged.wire.send({
    _tag: "sessionsReport",
    sessions: [
      {
        sessionId: session.id,
        nativeSessionId: "native-1",
        instanceId: arranged.instances[0]!.id,
      },
    ],
  });
  await waitUntil("bound the native session", async () => {
    const response = await get(
      arranged.harness.base,
      `/api/v1/sessions/${session.id}`,
      arranged.token,
    );
    const one = (await response.json()) as Session;
    return one.nativeSessionId !== null ? one : undefined;
  });
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.exited",
    reason: "stopped",
  });
  await waitUntil("ended the session", async () => {
    const response = await get(
      arranged.harness.base,
      `/api/v1/sessions/${session.id}`,
      arranged.token,
    );
    const one = (await response.json()) as Session;
    return one.status === "exited" && one.resumable ? one : undefined;
  });
};

const hoursAgo = (hours: number): string =>
  new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

/** Moves a workspace's timestamps back by `hours`, which is how these tests cross a window. */
const ageWorkspace = (arranged: Arranged, id: string, hours: number): Promise<unknown> =>
  Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql`
        UPDATE workspaces
        SET last_used_at = ${hoursAgo(hours)}, provisioned_at = ${hoursAgo(hours)}
        WHERE id = unhex(replace(${id}, '-', ''))`,
    ),
  );

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
 * with nothing to resume, and it is aged past the orphan window. Returns its
 * id. A negative test waits for this workspace to be disposed of rather than
 * for a stretch of wall-clock time, so "left alone" is a decision the sweep
 * made in that pass, not a pass that never ran.
 */
const createDecoy = async (
  arranged: Arranged,
  resourceId: string,
  count: number,
): Promise<string> => {
  const session = await spawnThreadIn(arranged, resourceId, count);
  await endUnresumable(arranged, session);
  const workspaceId = String(session.workspaceId);
  await ageWorkspace(arranged, workspaceId, 25);
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
      await ageWorkspace(arranged, oldWorkspace, 25);

      const gone = await waitForDisposed(arranged, oldWorkspace);
      expect(gone.status).toBe("deleted");
      expect(await waitForDisposeFrames(arranged, 1)).toEqual([oldWorkspace]);
      expect((await readWorkspace(arranged, youngWorkspace)).status).not.toBe("deleted");

      // No user disposed of this workspace, so the audit entry records the
      // system as the actor, and the reason.
      const log = (await (
        await get(arranged.harness.base, "/api/v1/events", arranged.token)
      ).json()) as {
        items: ReadonlyArray<{
          kind: string;
          actor: string | null;
          payload: Record<string, unknown>;
        }>;
      };
      const swept = log.items.filter((entry) => entry.kind === "workspace.deleted");
      expect(swept).toHaveLength(1);
      expect(swept[0]?.actor).toBe("system");
      expect(swept[0]?.payload).toMatchObject({
        workspaceId: oldWorkspace,
        runnerId: arranged.runnerId,
        reason: "orphan",
      });
    });
  });

  it("keeps a resumable thread's workspace past the orphan window, and disposes of it after the idle window", async () => {
    await withSweep(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const session = await spawnThreadIn(arranged, web, 1);
      await endResumable(arranged, session);
      const workspaceId = String(session.workspaceId);

      // Past one day, but well short of thirty.
      await ageWorkspace(arranged, workspaceId, 25);
      await waitForSeveralSweeps();
      expect((await readWorkspace(arranged, workspaceId)).status).not.toBe("deleted");
      expect(listFramesTagged(arranged.wire, "workspaceDispose")).toEqual([]);

      await ageWorkspace(arranged, workspaceId, 31 * 24);
      const gone = await waitForDisposed(arranged, workspaceId);
      expect(gone.status).toBe("deleted");
    });
  });

  it("leaves a workspace with a running session, however old its row is", async () => {
    await withSweep(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const session = await spawnThreadIn(arranged, web, 1);
      const workspaceId = String(session.workspaceId);

      await ageWorkspace(arranged, workspaceId, 90 * 24);
      const taken = await createDecoy(arranged, web, 2);

      // The pass that disposed of the decoy also saw this workspace and kept it.
      await waitForDisposed(arranged, taken);
      expect((await readWorkspace(arranged, workspaceId)).status).not.toBe("deleted");
      expect(await waitForDisposeFrames(arranged, 1)).toEqual([taken]);
    });
  });

  it("leaves a primary alone, whatever its age", async () => {
    await withSweep(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const primary = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      await makeReady(arranged, primary.id);

      await ageWorkspace(arranged, primary.id, 90 * 24);
      const taken = await createDecoy(arranged, web, 1);

      // The pass that disposed of the decoy also saw the primary and kept it.
      await waitForDisposed(arranged, taken);
      expect((await readWorkspace(arranged, primary.id)).status).toBe("ready");
      expect(await waitForDisposeFrames(arranged, 1)).toEqual([taken]);
    });
  });

  it("waits for an offline runner to come back before disposing of its workspace", async () => {
    await withSweep(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const session = await spawnThreadIn(arranged, web, 1);
      await endUnresumable(arranged, session);
      const workspaceId = String(session.workspaceId);
      await ageWorkspace(arranged, workspaceId, 90 * 24);

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

      await ageWorkspace(arranged, workspaceId, 1);
      const aged = await readWorkspace(arranged, workspaceId);

      await makeReady(arranged, workspaceId);
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

      await ageWorkspace(arranged, workspaceId, 1);
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
  it("takes its windows from the controller settings, which a user can change", async () => {
    await withSweep(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const session = await spawnThreadIn(arranged, web, 1);
      await endUnresumable(arranged, session);
      const workspaceId = String(session.workspaceId);

      // Two hours old: inside the default window, until the window is lowered to one hour.
      await ageWorkspace(arranged, workspaceId, 2);
      await waitForSeveralSweeps();
      expect((await readWorkspace(arranged, workspaceId)).status).not.toBe("deleted");

      const patched = await send("PATCH", arranged.harness.base, "/api/v1/settings", {
        body: { controller: { "workspace.orphanTtlHours": 1 } },
        token: arranged.token,
      });
      expect(patched.status, await patched.clone().text()).toBe(200);

      await waitForDisposed(arranged, workspaceId);
    });
  });
});
