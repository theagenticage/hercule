/**
 * Proves the scripted runner and the fleet against the compiled controller:
 * every thread state the desktop app draws can be reached, and is read back
 * through the public API with the same client the app uses. No app window is
 * started. Run `pnpm build:binary` first.
 *
 * The 500-thread case is part of the default run while it stays fast. It
 * prints how long spawning, settling and listing took; vitest shows that
 * output only with `--reporter=verbose`.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  buildQueryKeys,
  createClient,
  createLive,
  type HerculeClient,
  type LiveQueryKey,
} from "../../packages/client-core/src/index";
import type { RequestKind } from "../../scripts/scripted-runner";
import { connectFleet, type Fleet } from "./fleet";
import { startControllerForTest } from "./harness";

const REQUEST_KINDS: ReadonlyArray<RequestKind> = [
  "command_approval",
  "file_change_approval",
  "file_read_approval",
  "tool_approval",
  "question",
];

/** A scratch controller, a fleet signed in to it, and a client for reading it back. */
interface Arranged {
  readonly url: string;
  readonly fleet: Fleet;
  readonly client: HerculeClient;
}

/**
 * Waits until the live socket has pushed at least once and then nothing for a
 * quarter of a second. The controller collects changes for a short window
 * (50 ms) before it pushes them, so writes that landed just before a
 * subscription can still arrive after the greeting.
 */
async function waitForQuietSocket(pushes: ReadonlyArray<unknown>): Promise<void> {
  for (;;) {
    const seen = pushes.length;
    await sleep(250);
    if (seen > 0 && pushes.length === seen) return;
  }
}

/**
 * Starts a scratch controller that is set up, and connects a fleet to it.
 * The controller is stopped and the runners disconnected when the test ends.
 */
async function arrangeFleet(): Promise<Arranged> {
  const controller = await startControllerForTest({ setUp: true });
  const fleet = await connectFleet(controller.url);
  onTestFinished(fleet.disconnectRunners);
  return {
    url: controller.url,
    fleet,
    client: createClient({ baseUrl: controller.url, token: fleet.token }),
  };
}

describe("the scripted fleet", () => {
  it("walks a thread through queued, starting, busy, interrupted, idle, and both kinds of exit", async () => {
    const { fleet, client } = await arrangeFleet();
    const readSession = (id: string) => client.session.read({ params: { id } });
    const runner = await fleet.enlistRunner("scripted-1", { maxConcurrentSessions: 1 });
    runner.holdStarts();

    const [first] = await fleet.spawnThreads(1, { runner });
    await expect.poll(async () => (await readSession(first!.id)).status).toBe("starting");
    // The runner's one slot is taken, so the next thread waits.
    const [second] = await fleet.spawnThreads(1, { runner });
    expect((await readSession(second!.id)).status).toBe("queued");

    // Once started, the controller delivers the spawn's prompt, which opens a turn.
    await runner.startSession(first!.id, { resumable: false });
    await expect.poll(async () => (await readSession(first!.id)).status).toBe("busy");
    runner.completeTurn(first!.id);
    await expect.poll(async () => (await readSession(first!.id)).status).toBe("idle");
    runner.startTurn(first!.id);
    await expect.poll(async () => (await readSession(first!.id)).status).toBe("busy");
    runner.endSession(first!.id, "crash");
    await expect.poll(async () => (await readSession(first!.id)).status).toBe("exited");
    expect((await readSession(first!.id)).resumable).toBe(false);

    // The slot is free again, so the queued thread is sent to the runner.
    await runner.startSession(second!.id);
    await expect.poll(async () => (await readSession(second!.id)).status).toBe("busy");
    await client.session.interrupt({ params: { id: second!.id } });
    await expect.poll(async () => (await readSession(second!.id)).status).toBe("idle");
    await client.session.stop({ params: { id: second!.id } });
    await expect.poll(async () => (await readSession(second!.id)).status).toBe("exited");
    expect((await readSession(second!.id)).resumable).toBe(true);
  });

  it("opens a Request of each kind, and clears it once it is answered or withdrawn", async () => {
    const { fleet, client } = await arrangeFleet();
    const readSession = (id: string) => client.session.read({ params: { id } });
    const runner = await fleet.enlistRunner("scripted-1");
    const [thread] = await fleet.spawnThreads(1, { runner });
    const id = thread!.id;
    await expect.poll(async () => (await readSession(id)).status).toBe("busy");

    for (const kind of REQUEST_KINDS) {
      const requestId = runner.openRequest(id, kind);
      await expect.poll(async () => (await readSession(id)).openRequest?.kind).toBe(kind);
      const { openRequest } = await readSession(id);
      await client.session.respond({
        params: { id },
        payload: { requestId, decision: openRequest!.decisions[0] },
      });
      await expect.poll(async () => (await readSession(id)).openRequest).toBeNull();
    }

    // A harness can also withdraw its own question.
    runner.openRequest(id, "question");
    await expect.poll(async () => (await readSession(id)).openRequest?.kind).toBe("question");
    runner.resolveRequest(id, "cancel");
    await expect.poll(async () => (await readSession(id)).openRequest).toBeNull();
    expect((await readSession(id)).status).toBe("busy");
  });

  it("holds a resumed thread that crashes before its first turn", async () => {
    const { fleet, client } = await arrangeFleet();
    const readSession = (id: string) => client.session.read({ params: { id } });
    const runner = await fleet.enlistRunner("scripted-1");
    const [thread] = await fleet.spawnThreads(1, { runner });
    const id = thread!.id;
    await expect.poll(async () => (await readSession(id)).status).toBe("busy");
    runner.endSession(id, "crash");
    await expect.poll(async () => (await readSession(id)).status).toBe("exited");
    // Only a resume arms the crash-loop guard, never a first start.
    expect((await readSession(id)).resumeHeld).toBe(false);

    // The input resumes the thread, and the resumed process crashes on it.
    // The thread stays held only while that input waits for an answer: the
    // controller cancels it after 10 s, and the thread is then plain exited.
    runner.crashSessionOnNextInput(id);
    await client.session.input({ params: { id }, payload: { text: "Try again" } });
    await expect.poll(async () => (await readSession(id)).resumeHeld).toBe(true);
    expect(await readSession(id)).toMatchObject({ status: "exited", resumable: true });
  });

  it("takes a runner offline and unreachable, and reconnects it with its threads", async () => {
    const { fleet, client } = await arrangeFleet();
    const readSession = (id: string) => client.session.read({ params: { id } });
    const readConnectivity = async (id: string) =>
      (await client.runner.read({ params: { id } })).connectivity;
    const runner = await fleet.enlistRunner("scripted-1");
    const [idle, asleep] = await fleet.spawnThreads(2, { runner });
    for (const thread of [idle!, asleep!]) {
      await expect.poll(async () => (await readSession(thread.id)).status).toBe("busy");
    }
    runner.completeTurn(idle!.id);
    runner.endSession(asleep!.id, "crash");
    await expect.poll(async () => (await readSession(idle!.id)).status).toBe("idle");
    await expect.poll(async () => (await readSession(asleep!.id)).status).toBe("exited");

    // A runner that goes away changes none of its threads. The desktop app
    // reads the runner to show them as out of reach.
    const expectThreadsKept = async () => {
      expect((await readSession(idle!.id)).status).toBe("idle");
      expect(await readSession(asleep!.id)).toMatchObject({ status: "exited", resumable: true });
    };

    await runner.goOffline();
    await expect.poll(() => readConnectivity(runner.runnerId)).toBe("offline");
    await expectThreadsKept();
    await runner.reconnect();
    await expect.poll(() => readConnectivity(runner.runnerId)).toBe("online");

    await runner.goUnreachable();
    await expect.poll(() => readConnectivity(runner.runnerId)).toBe("unreachable");
    await expectThreadsKept();
    await runner.reconnect();
    await expect.poll(() => readConnectivity(runner.runnerId)).toBe("online");

    // A thread is placed only after the runner's report of its sessions is
    // handled, so once this one runs, the report kept the idle thread alive.
    const [later] = await fleet.spawnThreads(1, { runner });
    await expect.poll(async () => (await readSession(later!.id)).status).toBe("busy");
    await expectThreadsKept();
  });

  it("stops a script that is still streaming when its runner goes offline, rather than failing it", async () => {
    const { fleet } = await arrangeFleet();
    const runner = await fleet.enlistRunner("scripted-1");
    const { thread, played } = await fleet.spawnScriptedThread({ runner }, [
      { kind: "stream", forMs: 60_000 },
    ]);
    await fleet.waitForTurn(thread.id, 1, "running");
    // Long enough for the script to be between two deltas of its stream.
    await sleep(200);

    await runner.goOffline();

    await expect(played).resolves.toBeUndefined();
  });

  it("opens threads in a primary and an ephemeral workspace, filed under a project", async () => {
    const { fleet, client } = await arrangeFleet();
    const readSession = (id: string) => client.session.read({ params: { id } });
    const project = await fleet.createProject("Hercule");
    const repository = await fleet.createRepository("https://github.com/example/hercule", [
      project.id,
    ]);
    const runner = await fleet.enlistRunner("scripted-1");

    const [primary] = await fleet.spawnThreads(1, {
      runner,
      projectId: project.id,
      workspace: { kind: "primary", resourceId: repository.id },
    });
    const [ephemeral] = await fleet.spawnThreads(1, {
      runner,
      projectId: project.id,
      workspace: { kind: "ephemeral", checkouts: [{ resourceId: repository.id }] },
    });

    for (const thread of [primary!, ephemeral!]) {
      await expect.poll(async () => (await readSession(thread.id)).status).toBe("busy");
      const read = await readSession(thread.id);
      expect(read.workspaceId).not.toBeNull();
      expect(read.projectId).toBe(project.id);
    }
    expect(primary!.workspaceId).not.toBe(ephemeral!.workspaceId);
  });

  it("pushes a change naming the thread when a Request opens", async () => {
    const { url, fleet, client } = await arrangeFleet();
    const runner = await fleet.enlistRunner("scripted-1");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await expect
      .poll(async () => (await client.session.read({ params: { id: thread!.id } })).status)
      .toBe("busy");

    const live = createLive({ client, baseUrl: url });
    const pushes: Array<ReadonlyArray<LiveQueryKey>> = [];
    live.start();
    const unsubscribe = live.subscribe("session", (keys) => {
      pushes.push(keys);
    });
    onTestFinished(async () => {
      unsubscribe();
      await live.stop();
    });
    // The greeting refreshes every subscription, so the first push shows the
    // socket is up. Once the thread's last writes have been pushed too, any
    // later push naming it comes from the Request.
    await waitForQuietSocket(pushes);
    const settled = pushes.length;

    runner.openRequest(thread!.id, "command_approval");
    await expect
      .poll(() => pushes.slice(settled))
      .toContainEqual(buildQueryKeys("session", [thread!.id]));
  });

  it("spawns 500 threads over two runners and lists them in one page", async () => {
    const { fleet, client } = await arrangeFleet();
    const runners = await Promise.all(
      ["scripted-1", "scripted-2"].map((name) =>
        fleet.enlistRunner(name, { maxConcurrentSessions: 250 }),
      ),
    );

    const began = performance.now();
    await Promise.all(runners.map((runner) => fleet.spawnThreads(250, { runner })));
    const spawned = performance.now();
    await expect
      .poll(
        async () => {
          const { items } = await client.session.query({ query: { thread: true, limit: 500 } });
          return items.filter((session) => session.status === "busy").length;
        },
        { timeout: 30_000 },
      )
      .toBe(500);
    const settled = performance.now();
    const { items } = await client.session.query({ query: { thread: true, limit: 500 } });
    const listed = performance.now();

    expect(items).toHaveLength(500);
    console.info(
      `500 threads: spawned in ${Math.round(spawned - began)} ms, ` +
        `all busy ${Math.round(settled - spawned)} ms later, ` +
        `listed in ${Math.round(listed - settled)} ms`,
    );
  });
});
