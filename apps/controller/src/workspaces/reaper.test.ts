/**
 * The workspace expiry sweep.
 *
 * The controller decides, the machine deletes. An
 * ephemeral workspace nothing is using any more goes after the orphan window;
 * one whose threads can still be resumed is its thread's work, so it survives
 * the orphan window and goes only on the long idle one. A primary never goes,
 * and neither does anything on a machine that is not there to be told.
 *
 * The sweep's interval is handed over by the test, the way the ping and probe
 * intervals are: the shipped ten minutes is longer than a test can wait, and a
 * real Bun listener cannot be driven by a `TestClock`. The two windows are
 * crossed by ageing the rows rather than by waiting them out, since the
 * shortest either setting admits is an hour.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import type { SessionStart } from "@hercule/protocol";
import type { Session } from "@hercule/contract";
import { get, send } from "../http/testing";
import { framesWhen, report, spawned, until, type Arranged } from "../sessions/testing";
import {
  framesTagged,
  provisioned,
  readWorkspace,
  repo,
  withFleet,
  type WorkspaceRecord,
} from "./testing";

/** A sweep a test can wait out, in place of the shipped ten minutes. */
const SWEEP = Duration.millis(50);

const withSweep = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  withFleet(body, { workspaceSweepInterval: SWEEP });

/** Says the workspace is made, so the session waiting on it can be dispatched. */
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
  return await until("made the workspace ready", async () => {
    const one = await readWorkspace(arranged, id);
    return one.status === "ready" ? one : undefined;
  });
};

const at = "2026-09-16T10:00:00.000Z";

/** A thread in a worktree of its own, started and idle on the machine. */
const threadIn = async (
  arranged: Arranged,
  resourceId: string,
  count: number,
): Promise<Session> => {
  const session = await spawned(arranged, {
    prompt: "hello",
    workspace: { kind: "ephemeral", checkouts: [{ resourceId }] },
  });
  await makeReady(arranged, String(session.workspaceId));
  await framesWhen<SessionStart>(arranged.wire, "sessionStart", count);
  report(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.started",
  });
  await until("started the session", async () => {
    const response = await get(
      arranged.harness.base,
      `/api/v1/sessions/${session.id}`,
      arranged.token,
    );
    const one = (await response.json()) as Session;
    return one.status === "idle" ? one : undefined;
  });
  return session;
};

/** Ends the thread with nothing to resume from: the workspace is then an orphan. */
const endUnresumable = async (arranged: Arranged, session: Session): Promise<void> => {
  report(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.exited",
    reason: "crash",
  });
  await until("ended the session", async () => {
    const response = await get(
      arranged.harness.base,
      `/api/v1/sessions/${session.id}`,
      arranged.token,
    );
    const one = (await response.json()) as Session;
    return one.status === "exited" && !one.resumable ? one : undefined;
  });
};

/** Ends the thread in a way the next input resumes in place. */
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
  await until("bound the native session", async () => {
    const response = await get(
      arranged.harness.base,
      `/api/v1/sessions/${session.id}`,
      arranged.token,
    );
    const one = (await response.json()) as Session;
    return one.nativeSessionId !== null ? one : undefined;
  });
  report(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.exited",
    reason: "stopped",
  });
  await until("ended the session", async () => {
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

/** Puts a workspace's clock back, which is how a window is crossed here. */
const age = (arranged: Arranged, id: string, hours: number): Promise<unknown> =>
  Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql`
        UPDATE workspaces
        SET last_used_at = ${hoursAgo(hours)}, provisioned_at = ${hoursAgo(hours)}
        WHERE id = unhex(replace(${id}, '-', ''))`,
    ),
  );

/**
 * Gives the sweep six turns, so "left alone" means left alone rather than "not
 * swept yet". A pass reads its candidates in one query and disposes of what it
 * finds before it sleeps again, so one turn is enough to act and the other five
 * are the margin a loaded machine needs: a workspace still standing after six
 * intervals is one the sweep decided to keep.
 */
const sweptSeveralTimes = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Duration.toMillis(SWEEP) * 6));

/**
 * A workspace the same sweep pass must take away: ended with nothing to resume
 * and aged past the orphan window. A negative case waits for this one to go
 * rather than for a stretch of wall clock, so "left alone" is a decision the
 * sweep took in that pass and not a pass that never ran.
 */
const decoy = async (arranged: Arranged, resourceId: string, count: number): Promise<string> => {
  const session = await threadIn(arranged, resourceId, count);
  await endUnresumable(arranged, session);
  const workspaceId = String(session.workspaceId);
  await age(arranged, workspaceId, 25);
  return workspaceId;
};

const disposedWhen = (arranged: Arranged, id: string): Promise<WorkspaceRecord> =>
  until("disposed the workspace", async () => {
    const one = await readWorkspace(arranged, id);
    return one.status === "deleted" ? one : undefined;
  });

/**
 * The workspaces the machine has been told to delete, once this many frames
 * have crossed the socket. The sweep flips the row in its transaction and sends
 * the frame after it commits, so a test that reads the wire the moment the row
 * reads `deleted` is asserting on a race rather than on an ordering.
 */
const disposesWhen = (arranged: Arranged, count: number): Promise<ReadonlyArray<unknown>> =>
  until(`sent ${String(count)} workspaceDispose frames`, () => {
    const sent = framesTagged(arranged.wire, "workspaceDispose").map(
      (frame) => frame["workspaceId"],
    );
    return sent.length >= count ? sent : undefined;
  });

describe("the workspace expiry sweep", () => {
  it("disposes an orphaned ephemeral past the orphan window, and leaves a young one", async () => {
    await withSweep(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      const old = await threadIn(arranged, web, 1);
      await endUnresumable(arranged, old);
      const oldWorkspace = String(old.workspaceId);

      const young = await threadIn(arranged, web, 2);
      await endUnresumable(arranged, young);
      const youngWorkspace = String(young.workspaceId);

      // The default orphan window is a day; only one of them is older.
      await age(arranged, oldWorkspace, 25);

      const gone = await disposedWhen(arranged, oldWorkspace);
      expect(gone.status).toBe("deleted");
      expect(await disposesWhen(arranged, 1)).toEqual([oldWorkspace]);
      expect((await readWorkspace(arranged, youngWorkspace)).status).not.toBe("deleted");

      // Nobody asked for this one to go, so the log says who did and why.
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

  it("keeps a resumable thread's workspace past the orphan window and takes it on the idle one", async () => {
    await withSweep(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      const session = await threadIn(arranged, web, 1);
      await endResumable(arranged, session);
      const workspaceId = String(session.workspaceId);

      // Well past a day, well short of thirty.
      await age(arranged, workspaceId, 25);
      await sweptSeveralTimes();
      expect((await readWorkspace(arranged, workspaceId)).status).not.toBe("deleted");
      expect(framesTagged(arranged.wire, "workspaceDispose")).toEqual([]);

      await age(arranged, workspaceId, 31 * 24);
      const gone = await disposedWhen(arranged, workspaceId);
      expect(gone.status).toBe("deleted");
    });
  });

  it("leaves a workspace a session is still living in, however old the row says it is", async () => {
    await withSweep(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      const session = await threadIn(arranged, web, 1);
      const workspaceId = String(session.workspaceId);

      await age(arranged, workspaceId, 90 * 24);
      const taken = await decoy(arranged, web, 2);

      // The pass that took the decoy is the pass that saw this one and kept it.
      await disposedWhen(arranged, taken);
      expect((await readWorkspace(arranged, workspaceId)).status).not.toBe("deleted");
      expect(await disposesWhen(arranged, 1)).toEqual([taken]);
    });
  });

  it("leaves a primary alone, whatever its age", async () => {
    await withSweep(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      const primary = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      await makeReady(arranged, primary.id);

      await age(arranged, primary.id, 90 * 24);
      const taken = await decoy(arranged, web, 1);

      // The pass that took the decoy is the pass that saw the primary and kept it.
      await disposedWhen(arranged, taken);
      expect((await readWorkspace(arranged, primary.id)).status).toBe("ready");
      expect(await disposesWhen(arranged, 1)).toEqual([taken]);
    });
  });

  it("waits for a machine that is not there rather than disposing behind its back", async () => {
    await withSweep(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      const session = await threadIn(arranged, web, 1);
      await endUnresumable(arranged, session);
      const workspaceId = String(session.workspaceId);
      await age(arranged, workspaceId, 90 * 24);

      arranged.wire.close();
      await until("saw the machine go", async () => {
        const response = await get(
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}`,
          arranged.token,
        );
        const runner = (await response.json()) as { connectivity: string };
        return runner.connectivity === "online" ? undefined : runner;
      });
      await sweptSeveralTimes();

      expect((await readWorkspace(arranged, workspaceId)).status).not.toBe("deleted");

      // And it goes on the first sweep after the machine comes back.
      await arranged.reconnect();
      await disposedWhen(arranged, workspaceId);
    });
  });

  it("marks the workspace used at provisioning and at every session start and exit in it", async () => {
    await withSweep(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      const session = await spawned(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspaceId = String(session.workspaceId);

      const atProvision = await readWorkspace(arranged, workspaceId);
      expect(atProvision.lastUsedAt).not.toBeNull();

      await age(arranged, workspaceId, 1);
      const aged = await readWorkspace(arranged, workspaceId);

      await makeReady(arranged, workspaceId);
      await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);
      report(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
      });
      const started = await until("marked the workspace used at the start", async () => {
        const one = await readWorkspace(arranged, workspaceId);
        return one.lastUsedAt !== aged.lastUsedAt ? one : undefined;
      });

      await age(arranged, workspaceId, 1);
      // Read back, as after the first ageing: waiting for a wall-clock
      // threshold instead would be satisfied by the value the start wrote, and
      // the case would pass without the exit having marked anything.
      const before = await readWorkspace(arranged, workspaceId);
      expect(before.lastUsedAt).not.toBe(started.lastUsedAt);
      await endUnresumable(arranged, session);
      const ended = await until("marked the workspace used at the exit", async () => {
        const one = await readWorkspace(arranged, workspaceId);
        return one.lastUsedAt !== null && one.lastUsedAt !== before.lastUsedAt ? one : undefined;
      });
      expect(ended.lastUsedAt).not.toBe(started.lastUsedAt);
    });
  });
});

/** The shipped defaults, as the criterion names them, so a change to one is deliberate. */
describe("the windows the sweep reads", () => {
  it("takes its windows from the settings the user may raise", async () => {
    await withSweep(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      const session = await threadIn(arranged, web, 1);
      await endUnresumable(arranged, session);
      const workspaceId = String(session.workspaceId);

      // Two hours old: past nothing, until the window is turned down to one.
      await age(arranged, workspaceId, 2);
      await sweptSeveralTimes();
      expect((await readWorkspace(arranged, workspaceId)).status).not.toBe("deleted");

      const patched = await send("PATCH", arranged.harness.base, "/api/v1/settings", {
        body: { controller: { "workspace.orphanTtlHours": 1 } },
        token: arranged.token,
      });
      expect(patched.status, await patched.clone().text()).toBe(200);

      await disposedWhen(arranged, workspaceId);
    });
  });
});
