/**
 * Proves the scripted runner and the fleet against the compiled controller:
 * every state the desktop tests put a thread or a runner in can be reached,
 * and is read back through the public API with the same client the app uses.
 * No app window is started. Run `pnpm build:binary` first.
 *
 * The 500-thread case is part of the default run while it stays fast. It
 * prints how long spawning, settling and listing took; vitest shows that
 * output only with `--reporter=verbose`.
 */
import { describe, expect, it, onTestFinished } from "vitest";
import { pollUntil } from "../../apps/desktop/scripts/poll";
import {
  buildQueryKeys,
  createLive,
  type LiveQueryKey,
} from "../../packages/client-core/src/index";
import type { RequestKind, ScriptedQuestions } from "../../apps/desktop/scripts/scripted-runner";
import { arrangeFleet } from "./harness";

const REQUEST_KINDS: ReadonlyArray<RequestKind> = [
  "command_approval",
  "file_change_approval",
  "file_read_approval",
  "tool_approval",
  "question",
];

/** Builds a single-choice question headed `header`, with one option, "Either". */
function buildQuestion(header: string): ScriptedQuestions[number] {
  return {
    question: `Which ${header.toLowerCase()} do you want?`,
    header,
    options: [{ label: "Either", description: "Any is fine." }],
    multiSelect: false,
  };
}

/**
 * Waits until the live socket has pushed at least once and then nothing for a
 * quarter of a second. The controller collects changes for a short window
 * (50 ms) before it pushes them, so writes that landed just before a
 * subscription can still arrive after the greeting. Fails after 10 s, when
 * the socket never pushed or never went quiet.
 */
async function waitForQuietSocket(pushes: ReadonlyArray<unknown>): Promise<void> {
  let seen = 0;
  await pollUntil(
    () => {
      const quiet = seen > 0 && pushes.length === seen;
      seen = pushes.length;
      return quiet ? true : undefined;
    },
    {
      timeoutMs: 10_000,
      intervalMs: 250,
      timeoutMessage: () =>
        seen === 0
          ? "the live socket pushed nothing within 10 s of subscribing"
          : `the live socket was still pushing 10 s after subscribing (${String(seen)} pushes)`,
    },
  );
}

describe("the scripted fleet", () => {
  it("walks a thread through queued, busy, idle, interrupted, and both kinds of exit", async () => {
    const { fleet, client, waitForStatus } = await arrangeFleet();
    const readSession = (id: string) => client.session.read({ params: { id } });
    const runner = await fleet.enlistRunner("scripted-1", { maxConcurrentSessions: 1 });

    // The spawn's prompt opens a turn, so the thread settles busy.
    const [first] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(first!.id, "busy");
    // The runner's one slot is taken, so the next thread waits.
    const [second] = await fleet.spawnThreads(1, { runner });
    expect((await readSession(second!.id)).status).toBe("queued");

    runner.completeTurn(first!.id);
    await waitForStatus(first!.id, "idle");
    runner.startTurn(first!.id);
    await waitForStatus(first!.id, "busy");
    runner.endSession(first!.id, "crash");
    await waitForStatus(first!.id, "exited");

    // The slot is free again, so the queued thread is sent to the runner.
    await waitForStatus(second!.id, "busy");
    await client.session.interrupt({ params: { id: second!.id }, payload: {} });
    await waitForStatus(second!.id, "idle");
    await client.session.stop({ params: { id: second!.id } });
    await waitForStatus(second!.id, "exited");
    expect((await readSession(second!.id)).resumable).toBe(true);
  });

  it("opens a Request of each kind, and clears it once it is answered", async () => {
    const { fleet, client, waitForStatus } = await arrangeFleet();
    const readSession = (id: string) => client.session.read({ params: { id } });
    const runner = await fleet.enlistRunner("scripted-1");
    const [thread] = await fleet.spawnThreads(1, { runner });
    const id = thread!.id;
    await waitForStatus(id, "busy");

    for (const kind of REQUEST_KINDS) {
      const requestId = runner.openRequest(id, kind);
      await expect.poll(async () => (await readSession(id)).openRequests[0]?.kind).toBe(kind);
      const openRequest = (await readSession(id)).openRequests[0]!;
      // A question is answered with answers, every approval with a decision.
      if (openRequest.kind === "question") {
        await client.session.respondToQuestion({
          params: { id },
          payload: {
            requestId,
            answers: Object.fromEntries(
              openRequest.detail.questions.map((question) => [
                question.header,
                question.options[0]!.label,
              ]),
            ),
          },
        });
      } else {
        await client.session.respondToApprovalRequest({
          params: { id },
          payload: { requestId, decision: openRequest.decisions[0] },
        });
      }
      await expect.poll(async () => (await readSession(id)).openRequests).toEqual([]);
    }
    expect((await readSession(id)).status).toBe("busy");
  });

  it("opens Requests of subagents at any depth, and stops a subagent with every subagent below it", async () => {
    const { fleet, client, waitForStatus } = await arrangeFleet();
    const readSession = (id: string) => client.session.read({ params: { id } });
    const readSubagents = async (id: string) =>
      (await client.session.querySubagents({ params: { id }, query: {} })).items;
    const runner = await fleet.enlistRunner("scripted-1");
    const { thread, played } = await fleet.spawnScriptedThread({ runner }, [
      {
        kind: "subagent",
        subagentId: "asker",
        description: "Plan the migration",
        brief: "Plan it.",
        background: true,
        steps: [
          {
            kind: "subagent",
            subagentId: "nested",
            description: "Dry-run the deploy",
            brief: "Dry-run it.",
            background: true,
            steps: [{ kind: "command", command: "./deploy.sh --dry-run", ask: true }],
          },
          {
            kind: "question",
            questions: [
              buildQuestion("Downtime"),
              buildQuestion("Backfill"),
              buildQuestion("Checks"),
            ],
          },
          { kind: "command", command: "pnpm db:migrate --dry-run", forMs: 60_000 },
        ],
      },
      {
        kind: "subagent",
        subagentId: "sibling",
        description: "Find the flaky tests",
        brief: "Find them.",
        background: true,
        steps: [{ kind: "command", command: "pnpm test", forMs: 60_000 }],
      },
      { kind: "end", state: "completed" },
    ]);
    const id = thread.id;

    // The session's own agent is done, while two subagents wait on the user.
    await expect
      .poll(async () =>
        (await readSession(id)).openRequests.map(({ kind, subagentId }) => ({ kind, subagentId })),
      )
      .toEqual([
        { kind: "command_approval", subagentId: "nested" },
        { kind: "question", subagentId: "asker" },
      ]);
    await waitForStatus(id, "idle");
    expect((await readSubagents(id)).find((one) => one.id === "nested")?.parentSubagentId).toBe(
      "asker",
    );

    // Answering the question lets its subagent go on to its next step.
    const question = (await readSession(id)).openRequests.find(
      (request) => request.kind === "question",
    )!;
    await client.session.respondToQuestion({
      params: { id },
      payload: {
        requestId: question.requestId,
        answers: { Downtime: "Either", Backfill: "Either", Checks: "Either" },
      },
    });
    await expect
      .poll(async () => (await readSubagents(id)).find((one) => one.id === "asker")?.activity)
      .toMatch(/^Running/);

    // Stopping the asker stops the subagent below it and cancels that
    // subagent's Request. Its sibling goes on.
    await client.session.interrupt({ params: { id }, payload: { subagentId: "asker" } });
    await expect
      .poll(async () => (await readSubagents(id)).map(({ id, status }) => ({ id, status })))
      .toEqual([
        { id: "asker", status: "stopped" },
        { id: "nested", status: "stopped" },
        { id: "sibling", status: "running" },
      ]);
    expect((await readSession(id)).openRequests).toEqual([]);

    await client.session.interrupt({ params: { id }, payload: {} });
    await expect(played).resolves.toBeUndefined();
  });

  it("takes a runner offline, and reconnects it with its threads", async () => {
    const { fleet, client, waitForStatus } = await arrangeFleet();
    const readSession = (id: string) => client.session.read({ params: { id } });
    const readConnectivity = async (id: string) =>
      (await client.runner.read({ params: { id } })).connectivity;
    const runner = await fleet.enlistRunner("scripted-1");
    const [idle, asleep] = await fleet.spawnThreads(2, { runner });
    for (const thread of [idle!, asleep!]) await waitForStatus(thread.id, "busy");
    runner.completeTurn(idle!.id);
    runner.endSession(asleep!.id, "crash");
    await waitForStatus(idle!.id, "idle");
    await waitForStatus(asleep!.id, "exited");

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

    // A thread is placed only after the runner's report of its sessions is
    // handled, so once this one runs, the report kept the idle thread alive.
    const [later] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(later!.id, "busy");
    await expectThreadsKept();
  });

  it("stops a script that is still streaming when its runner goes offline, rather than failing it", async () => {
    const { fleet } = await arrangeFleet();
    const runner = await fleet.enlistRunner("scripted-1");
    const { thread, played } = await fleet.spawnScriptedThread({ runner }, [
      { kind: "stream", forMs: 60_000 },
    ]);
    await fleet.waitForTurn(thread.id, 1, "running");

    await runner.goOffline();

    await expect(played).resolves.toBeUndefined();
  });

  it("opens threads in a primary and an ephemeral workspace, filed under a project", async () => {
    const { fleet, client, waitForStatus } = await arrangeFleet();
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
      await waitForStatus(thread.id, "busy");
      const read = await readSession(thread.id);
      expect(read.workspaceId).not.toBeNull();
      expect(read.projectId).toBe(project.id);
    }
    expect(primary!.workspaceId).not.toBe(ephemeral!.workspaceId);
  });

  it("pushes a change naming the thread when a Request opens", async () => {
    const { url, fleet, client, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("scripted-1");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");

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
