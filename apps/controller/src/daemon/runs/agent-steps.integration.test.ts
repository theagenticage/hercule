/**
 * Integration tests for agent steps over the real runner socket: a run
 * started through the API places its agent step's session on a fake runner,
 * and the test plays that runner. It reports the session's events and sends
 * the step's result the way a real runner does: the result first, then the
 * event that ends the turn.
 */
import { describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { Run, Session } from "@hercule/contract";
import {
  buildWorkspaceActionCapability,
  type ControllerToRunner,
  type ProviderEvent,
  type SessionInput,
  type SessionStart,
  type WorkspaceStepOutcome,
} from "@hercule/protocol";
import { send } from "../../http/testing";
import { WORKSPACE_ACTION_IDS } from "../../plugins";
import { buildProviderDefinition, createPluginFixture } from "../../plugins/testing";
import {
  buildCreateStep,
  findStepRecords,
  readRun,
  requestCancel,
  startSentWorkflow,
  waitForRunTo,
} from "../../runs/testing";
import {
  at,
  findInstanceId,
  listInputs,
  listFrames,
  readProfileNamed,
  readSession,
  reportEvent,
  spawnThreadUnder,
  waitForRunnerGone,
  waitUntil,
  withFleet,
  WAIT_DEADLINE_MS,
  type Arranged,
  type FleetOptions,
  type Wire,
} from "../../sessions/testing";
import { createAgent, emitLabeledEvent, localGithubPlugin } from "../../workflows/testing";
import { createRepo, FACTS, MODELS, reportWorkspaceReady } from "../../workspaces/testing";

/** The workflow step that runs the agent in every definition here. */
const IMPLEMENT = "implement";

/** The step key of one iteration of a run's agent step, `implement` unless named. */
const buildStepKey = (runId: string, iteration = 1, stepId = IMPLEMENT) => ({
  runId,
  stepId,
  iteration,
});

type StepKey = ReturnType<typeof buildStepKey>;

/** The output schema of a step whose agent says whether its work is done. */
const DONE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["done"],
  properties: { done: { type: "boolean" } },
};

/** What a runner reports for a step turn that ended with this output. */
const completeWith = (
  output: Extract<WorkspaceStepOutcome, { readonly status: "completed" }>["output"],
): WorkspaceStepOutcome => ({ status: "completed", output });

/** What a runner reports for a step turn with no output schema that answered `text`. */
const answerText = (text: string): WorkspaceStepOutcome =>
  completeWith({ text, exitStatus: "completed" });

/** The message of a step input that the user may not change, cancel or steer. */
const STEP_INPUT_FIXED =
  "this input is the prompt of a workflow run's agent step, so it cannot be changed, cancelled or steered; " +
  "it is sent when the session is next idle; to stop the step, cancel the run with run.cancel";

/**
 * Runs `body` against a controller with one runner that hosts the test
 * provider, so an Agent on it can run. `plugins` are loaded beside the
 * provider, and the other options go to the controller unchanged.
 */
const withAgentStepFleet = (
  body: (arranged: Arranged) => Promise<void>,
  {
    plugins = [],
    ...options
  }: Omit<FleetOptions, "plugins" | "facts" | "models"> &
    Partial<Pick<FleetOptions, "plugins">> = {},
): Promise<void> =>
  withFleet(body, {
    plugins: [
      createPluginFixture({
        id: "providers",
        definitions: [buildProviderDefinition("test-provider")],
      }).plugin,
      ...plugins,
    ],
    facts: FACTS,
    models: MODELS,
    ...options,
  });

/** A workflow that runs the agent, then files a task titled with the text of its answer. */
const buildImplementDefinition = (agentId: string, extra: Record<string, unknown> = {}) => ({
  name: "Implement, then file a task",
  steps: [
    { id: IMPLEMENT, kind: "agent", agent: agentId, prompt: "Implement the change.", ...extra },
    {
      id: "file",
      kind: "action",
      action: "task.create",
      params: { title: "Done: {{ steps.implement.output.text }}", description: "" },
    },
  ],
  edges: [{ from: IMPLEMENT, to: "file" }],
});

/**
 * A workflow that runs the agent again, once, while it says its work is not
 * done, then files a task. `extra` adds fields to the agent step.
 */
const buildLoopDefinition = (agentId: string, extra: Record<string, unknown> = {}) => ({
  name: "Implement until done",
  steps: [
    {
      id: IMPLEMENT,
      kind: "agent",
      agent: agentId,
      prompt: "Implement the change.",
      // The step's own edge leads into it, so it has to be named as the start.
      entry: true,
      outputSchema: DONE_SCHEMA,
      ...extra,
    },
    buildCreateStep("file"),
  ],
  edges: [
    {
      from: IMPLEMENT,
      to: IMPLEMENT,
      condition: "steps.implement.output.done == false",
      maxTraversals: 1,
    },
    { from: IMPLEMENT, to: "file", condition: "steps.implement.output.done == true" },
  ],
});

/**
 * Plays the runner's side of the sessions a test runs. A runner numbers each
 * session's events from 1, so the player keeps the next number per session,
 * across reconnects.
 */
const createSessionPlayer = () => {
  const lastSeq = new Map<string, number>();
  const report = (wire: Wire, sessionId: string, event: Record<string, unknown>): void => {
    const seq = (lastSeq.get(sessionId) ?? 0) + 1;
    lastSeq.set(sessionId, seq);
    reportEvent(wire, seq, {
      eventId: crypto.randomUUID(),
      sessionId,
      at,
      ...event,
    } as ProviderEvent);
  };
  const turnId = (key: StepKey) => `${key.stepId}-${String(key.iteration)}`;
  const player = {
    report,
    /** Reports that a session's harness has started. */
    reportStarted: (wire: Wire, sessionId: string): void =>
      report(wire, sessionId, {
        _tag: "session.started",
        providerRefs: { nativeSessionId: `native-${sessionId}` },
      }),
    /** Reports that the turn of a step key has started. */
    startTurn: (wire: Wire, sessionId: string, key: StepKey): void =>
      report(wire, sessionId, { _tag: "turn.started", turnId: turnId(key) }),
    /** Sends a step key's result, as a runner does when the step's turn ends. */
    sendResult: (wire: Wire, key: StepKey, outcome: WorkspaceStepOutcome): void =>
      wire.send({ _tag: "workspaceStepResult", ...key, outcome }),
    /** Reports that the turn of a step key has ended. */
    endTurn: (wire: Wire, sessionId: string, key: StepKey): void =>
      report(wire, sessionId, { _tag: "turn.completed", turnId: turnId(key), state: "completed" }),
    /**
     * Runs a step key's whole turn: reports it started, sends its result, then
     * reports its end, in the order a runner does.
     */
    runTurn: (wire: Wire, sessionId: string, key: StepKey, outcome: WorkspaceStepOutcome): void => {
      player.startTurn(wire, sessionId, key);
      player.sendResult(wire, key, outcome);
      player.endTurn(wire, sessionId, key);
    },
  };
  return player;
};

type SessionPlayer = ReturnType<typeof createSessionPlayer>;

/** Waits until a run has ended with `status`, and returns it. */
const waitForRunEnded = (arranged: Arranged, runId: string, status: Run["status"]): Promise<Run> =>
  waitForRunTo(arranged, runId, status, (run) => run.status === status);

/** Waits until the record of a step key names its session, and returns that session's id. */
const waitForStepSessionId = (arranged: Arranged, key: StepKey): Promise<string> =>
  waitUntil(`gave iteration ${String(key.iteration)} of ${key.stepId} a session`, async () => {
    const run = await readRun(arranged.harness.base, arranged.token, key.runId);
    const record = findStepRecords(run, key.stepId).find((one) => one.iteration === key.iteration);
    return record?.sessionId ?? undefined;
  });

/** Lists the start frames a runner was sent for a session. */
const listSessionStarts = (wire: Wire, sessionId: string): ReadonlyArray<SessionStart> =>
  listFrames<SessionStart>(wire, "sessionStart").filter((frame) => frame.sessionId === sessionId);

/** Waits until the runner has been sent the start of a session, and returns that frame. */
const waitForSessionStart = (wire: Wire, sessionId: string): Promise<SessionStart> =>
  waitUntil("started the step's session", () => listSessionStarts(wire, sessionId)[0]);

/** Checks whether an input frame starts the turn of a step key. */
const startsStepTurn = (frame: SessionInput, key: StepKey): boolean =>
  JSON.stringify(frame.input.step) === JSON.stringify(key);

/** Waits until the runner has been sent the input that starts a step key's turn, and returns that frame. */
const waitForStepInput = (wire: Wire, key: StepKey): Promise<SessionInput> =>
  waitUntil(`sent the input of iteration ${String(key.iteration)} of ${key.stepId}`, () =>
    listFrames<SessionInput>(wire, "sessionInput").find((frame) => startsStepTurn(frame, key)),
  );

/** Checks whether a frame is the request for a step key's result. */
const asksForResult = (frame: ControllerToRunner, key: StepKey): boolean =>
  frame._tag === "workspaceStepStart" &&
  frame.kind === "agent" &&
  frame.runId === key.runId &&
  frame.stepId === key.stepId &&
  frame.iteration === key.iteration;

/** Checks whether a frame tells the runner it may delete a step key's result. */
const settlesStep = (frame: ControllerToRunner, key: StepKey): boolean =>
  frame._tag === "workspaceStepSettle" &&
  frame.steps.some((step) => JSON.stringify(step) === JSON.stringify(key));

/** Checks whether a frame stops a session. */
const stopsSession = (frame: ControllerToRunner, sessionId: string): boolean =>
  frame._tag === "sessionStop" && frame.sessionId === sessionId;

/** Waits until the runner has been sent a frame that `matches`, and returns it. */
const waitForFrame = (
  wire: Wire,
  what: string,
  matches: (frame: ControllerToRunner) => boolean,
): Promise<ControllerToRunner> => waitUntil(what, () => wire.frames.find(matches));

/** Waits until a session's state passes `ready`, and returns the session. */
const waitForSessionTo = (
  arranged: Arranged,
  id: string,
  what: string,
  ready: (session: Session) => boolean,
): Promise<Session> =>
  waitUntil(what, async () => {
    const session = await readSession(arranged, id);
    return ready(session) ? session : undefined;
  });

/**
 * Waits until a run's agent step has a session on `wire`, starts that
 * session, and waits until the runner has the prompt of the step key and the
 * session is busy with it. Returns the session's id.
 */
const startStepSession = async (
  arranged: Arranged,
  player: SessionPlayer,
  key: StepKey,
  wire: Wire = arranged.wire,
): Promise<string> => {
  const sessionId = await waitForStepSessionId(arranged, key);
  await waitForSessionStart(wire, sessionId);
  player.reportStarted(wire, sessionId);
  await waitForStepInput(wire, key);
  await waitForSessionTo(
    arranged,
    sessionId,
    "opened the step's turn",
    (one) => one.status === "busy",
  );
  return sessionId;
};

/** Checks that a request was refused with `invalid_state` and the message of a fixed step input. */
const expectStepInputFixed = async (response: Response): Promise<void> => {
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { code: "invalid_state", message: STEP_INPUT_FIXED },
  });
};

/** Lists the ids of the sessions a run's records name, in the order of the records. */
const listRunSessionIds = (run: Run): ReadonlyArray<string | undefined> =>
  run.steps.map((record) => record.sessionId ?? undefined);

describe("agent steps over the runner socket", () => {
  it(
    "runs the step's turn in a session on the runner, continues the run on its result, and stops the session when the run ends",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const { wire } = arranged;
        const player = createSessionPlayer();
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: buildImplementDefinition(agentId),
        });
        const key = buildStepKey(runId);

        const sessionId = await waitForStepSessionId(arranged, key);
        const start = await waitForSessionStart(wire, sessionId);
        // A run with no workspace still runs on one runner, and its session
        // works in no workspace.
        expect(start.spec.workspaceId).toBeNull();
        expect(start.spec).not.toHaveProperty("outputSchema");
        expect(await readSession(arranged, sessionId)).toMatchObject({
          runId,
          stepId: IMPLEMENT,
        });
        const started = await readRun(arranged.harness.base, arranged.token, runId);
        expect(started.runnerId).toBe(arranged.runnerId);
        expect(findStepRecords(started, IMPLEMENT)[0]?.status).toBe("running");

        player.reportStarted(wire, sessionId);
        // The prompt carries the step key, so the runner reports the turn it
        // opens as the step's result.
        const input = await waitForStepInput(wire, key);
        expect(input.input.text).toBe("Implement the change.");
        await waitForSessionTo(
          arranged,
          sessionId,
          "opened the turn",
          (one) => one.status === "busy",
        );

        player.runTurn(wire, sessionId, key, answerText("Shipped"));
        const ended = await waitForRunEnded(arranged, runId, "completed");
        expect(findStepRecords(ended, IMPLEMENT)[0]).toMatchObject({
          status: "completed",
          sessionId,
          output: { text: "Shipped", exitStatus: "completed" },
        });
        expect(findStepRecords(ended, "file")[0]).toMatchObject({
          status: "completed",
          output: { title: "Done: Shipped" },
        });
        // The runner may delete the result once the step's end is recorded,
        // and the run's end stops its session.
        await waitForFrame(wire, "settled the step", (frame) => settlesStep(frame, key));
        await waitForFrame(wire, "stopped the run's session", (frame) =>
          stopsSession(frame, sessionId),
        );
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it.each([
    {
      code: "schema_failure",
      message: "The output does not match the step's schema: done is required.",
      failureReason: "schema-failure",
    },
    {
      code: "session_failed",
      message: "The step's turn failed: the harness crashed.",
      failureReason: "session-failed",
    },
  ] as const)(
    "sends the session the step's output schema, and fails the run with $failureReason when the step fails with $code",
    async ({ code, message, failureReason }) => {
      await withAgentStepFleet(async (arranged) => {
        const player = createSessionPlayer();
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: buildImplementDefinition(agentId, { outputSchema: DONE_SCHEMA }),
        });
        const key = buildStepKey(runId);
        const sessionId = await startStepSession(arranged, player, key);
        expect(listSessionStarts(arranged.wire, sessionId)[0]?.spec.outputSchema).toEqual(
          DONE_SCHEMA,
        );

        player.runTurn(arranged.wire, sessionId, key, { status: "failed", code, message });
        const ended = await waitForRunEnded(arranged, runId, "failed");
        expect(ended).toMatchObject({ failureReason, failedStepId: IMPLEMENT });
        expect(findStepRecords(ended, IMPLEMENT)[0]).toMatchObject({
          status: "failed",
          error: { code, message },
        });
        expect(findStepRecords(ended, "file")).toEqual([]);
        await waitForFrame(arranged.wire, "settled the step", (frame) => settlesStep(frame, key));
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "runs the next iteration as the next turn of the same session, sent only once the session is idle, and lets nobody change its prompt",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const { wire } = arranged;
        const player = createSessionPlayer();
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: buildLoopDefinition(agentId),
        });
        const first = buildStepKey(runId, 1);
        const second = buildStepKey(runId, 2);
        const sessionId = await startStepSession(arranged, player, first);

        // The result ends the first iteration while its turn still runs, so
        // the second iteration's prompt waits on the busy session.
        player.startTurn(wire, sessionId, first);
        player.sendResult(wire, first, completeWith({ done: false }));
        expect(await waitForStepSessionId(arranged, second)).toBe(sessionId);
        await waitForFrame(wire, "settled the first iteration", (frame) =>
          settlesStep(frame, first),
        );
        const prompt = (await listInputs(arranged, sessionId)).find(
          (one) => one.status === "queued",
        );
        expect(prompt).toBeDefined();
        // Steering it into the running turn would end the step with that
        // turn's answer, and a changed or cancelled prompt would leave the
        // run without the turn it waits for.
        const inputPath = `/api/v1/sessions/${sessionId}/inputs/${prompt!.id}`;
        const request = (method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown) =>
          send(method, arranged.harness.base, path, {
            ...(body === undefined ? {} : { body }),
            token: arranged.token,
          });
        await expectStepInputFixed(await request("POST", `${inputPath}/steer`));
        await expectStepInputFixed(await request("PATCH", inputPath, { text: "Do less." }));
        await expectStepInputFixed(await request("DELETE", inputPath));
        expect(
          listFrames<SessionInput>(wire, "sessionInput").some((frame) =>
            startsStepTurn(frame, second),
          ),
        ).toBe(false);

        player.endTurn(wire, sessionId, first);
        const input = await waitForStepInput(wire, second);
        expect(input.input.text).toBe("Implement the change.");
        await waitForSessionTo(
          arranged,
          sessionId,
          "opened the second turn",
          (one) => one.status === "busy",
        );
        player.runTurn(wire, sessionId, second, completeWith({ done: true }));

        const ended = await waitForRunEnded(arranged, runId, "completed");
        expect(findStepRecords(ended, IMPLEMENT).map((record) => record.sessionId)).toEqual([
          sessionId,
          sessionId,
        ]);
        expect(listSessionStarts(wire, sessionId)).toHaveLength(1);
        // Settling an iteration never stops the session; only the run's end does.
        const stopAt = wire.frames.findIndex((frame) => stopsSession(frame, sessionId));
        const secondInputAt = wire.frames.indexOf(input);
        expect(stopAt === -1 || stopAt > secondInputAt).toBe(true);
        await waitForFrame(wire, "stopped the run's session", (frame) =>
          stopsSession(frame, sessionId),
        );
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "keeps the next iteration's waiting prompt when its runner restarts, and resumes the session in place for it",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const player = createSessionPlayer();
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: buildLoopDefinition(agentId),
        });
        const first = buildStepKey(runId, 1);
        const second = buildStepKey(runId, 2);
        const sessionId = await startStepSession(arranged, player, first);
        // The result ends the first iteration while its turn still runs, so
        // the second iteration's prompt waits on the busy session.
        player.startTurn(arranged.wire, sessionId, first);
        player.sendResult(arranged.wire, first, completeWith({ done: false }));
        await waitUntil("queued the second iteration's prompt", async () =>
          (await listInputs(arranged, sessionId)).find((one) => one.status === "queued"),
        );

        // The runner restarts before the turn ends, and holds no session.
        arranged.wire.close();
        await waitForRunnerGone(arranged);
        const back = await arranged.reconnect();
        back.send({ _tag: "sessionsReport", sessions: [] });

        // The session is resumed in place, and its prompt is sent to it.
        const resumed = await waitForSessionStart(back, sessionId);
        expect(resumed.spec.continue).toEqual({
          nativeSessionId: `native-${sessionId}`,
          mode: "resume",
        });
        player.reportStarted(back, sessionId);
        await waitForStepInput(back, second);
        player.runTurn(back, sessionId, second, completeWith({ done: true }));

        const ended = await waitForRunEnded(arranged, runId, "completed");
        expect(findStepRecords(ended, IMPLEMENT).map((record) => record.sessionId)).toEqual([
          sessionId,
          sessionId,
        ]);
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "cancels the prompt an exited session kept when its run is cancelled, so the session is not resumed for it",
    async () => {
      await withAgentStepFleet(
        async (arranged) => {
          const player = createSessionPlayer();
          const agentId = await createAgent(arranged.harness.base, arranged.token);
          const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
            definition: buildLoopDefinition(agentId),
          });
          const first = buildStepKey(runId, 1);
          const sessionId = await startStepSession(arranged, player, first);
          player.startTurn(arranged.wire, sessionId, first);
          player.sendResult(arranged.wire, first, completeWith({ done: false }));
          await waitUntil("queued the second iteration's prompt", async () =>
            (await listInputs(arranged, sessionId)).find((one) => one.status === "queued"),
          );

          // The runner restarts and holds no session. The session keeps its
          // prompt, and only the next delivery tick, an hour away here,
          // would resume it.
          arranged.wire.close();
          await waitForRunnerGone(arranged);
          const back = await arranged.reconnect();
          back.send({ _tag: "sessionsReport", sessions: [] });
          await waitForSessionTo(arranged, sessionId, "exited", (one) => one.status === "exited");
          expect((await listInputs(arranged, sessionId)).map((one) => one.status)).toContain(
            "queued",
          );

          const response = await requestCancel(arranged.harness.base, arranged.token, runId);
          expect(response.status, await response.clone().text()).toBe(200);
          await waitForRunEnded(arranged, runId, "cancelled");
          expect((await listInputs(arranged, sessionId)).at(-1)).toMatchObject({
            status: "cancelled",
            reason: "the step's run ended before this prompt was sent",
          });
        },
        { eventRoutingInterval: Duration.hours(1) },
      );
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "runs each iteration of a fresh-session step in a new session, and stops them all when the run is cancelled",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const { wire } = arranged;
        const player = createSessionPlayer();
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: buildLoopDefinition(agentId, { freshSession: true }),
        });
        const firstKey = buildStepKey(runId, 1);
        const secondKey = buildStepKey(runId, 2);
        const first = await startStepSession(arranged, player, firstKey);
        player.runTurn(wire, first, firstKey, completeWith({ done: false }));

        const second = await startStepSession(arranged, player, secondKey);
        expect(second).not.toBe(first);
        expect(listSessionStarts(wire, second)).toHaveLength(1);

        const response = await requestCancel(arranged.harness.base, arranged.token, runId);
        expect(response.status, await response.clone().text()).toBe(200);
        const ended = await waitForRunEnded(arranged, runId, "cancelled");
        expect(findStepRecords(ended, IMPLEMENT).map((record) => record.status)).toEqual([
          "completed",
          "cancelled",
        ]);
        await waitForFrame(wire, "stopped the first session", (frame) =>
          stopsSession(frame, first),
        );
        await waitForFrame(wire, "stopped the second session", (frame) =>
          stopsSession(frame, second),
        );
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "asks a runner that reconnects for the result of a turn it took, and fails a step whose waiting prompt its restart dropped",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const player = createSessionPlayer();
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const taken = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: buildImplementDefinition(agentId),
        });
        const takenKey = buildStepKey(taken);
        const takenSession = await startStepSession(arranged, player, takenKey);
        // This session never starts, so its prompt is still on the controller.
        const waiting = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: buildImplementDefinition(agentId),
        });
        const waitingSession = await waitForStepSessionId(arranged, buildStepKey(waiting));
        await waitForSessionStart(arranged.wire, waitingSession);

        arranged.wire.close();
        await waitForRunnerGone(arranged);
        const back = await arranged.reconnect();
        const request = await waitForFrame(back, "asked for the taken step's result", (frame) =>
          asksForResult(frame, takenKey),
        );
        expect(request).toEqual({
          _tag: "workspaceStepStart",
          kind: "agent",
          ...takenKey,
          workspaceId: null,
        });
        // The restarted runner still holds the taken session and lost the other.
        back.send({
          _tag: "sessionsReport",
          sessions: [
            {
              sessionId: takenSession,
              nativeSessionId: `native-${takenSession}`,
              instanceId: findInstanceId(arranged, "test-provider"),
            },
          ],
        });
        const dropped = await waitForRunEnded(arranged, waiting, "failed");
        expect(dropped).toMatchObject({ failureReason: "session-failed", failedStepId: IMPLEMENT });
        expect(findStepRecords(dropped, IMPLEMENT)[0]).toMatchObject({
          status: "failed",
          error: {
            code: "session_failed",
            message: "The step's session exited (runner_restart) before it took the step's prompt.",
          },
        });

        player.runTurn(back, takenSession, takenKey, answerText("Shipped"));
        const ended = await waitForRunEnded(arranged, taken, "completed");
        expect(findStepRecords(ended, "file")[0]).toMatchObject({
          output: { title: "Done: Shipped" },
        });
        // Every frame sent on arrival is in long before the run completed,
        // and none asked for the result of the step whose prompt waited.
        expect(back.frames.filter((frame) => frame._tag === "workspaceStepStart")).toHaveLength(1);
      });
    },
    WAIT_DEADLINE_MS * 3,
  );

  it(
    "sends a step's prompt again when its runner never answered it, and completes the step on the result the runner sends back",
    async () => {
      await withAgentStepFleet(
        async (arranged) => {
          const player = createSessionPlayer();
          // The runner takes the prompt but never answers it, like one whose
          // connection drops just after the frame arrives.
          arranged.wire.answering(() => undefined);
          const agentId = await createAgent(arranged.harness.base, arranged.token);
          const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
            definition: buildImplementDefinition(agentId),
          });
          const key = buildStepKey(runId);
          const sessionId = await waitForStepSessionId(arranged, key);
          await waitForSessionStart(arranged.wire, sessionId);
          player.reportStarted(arranged.wire, sessionId);
          await waitForStepInput(arranged.wire, key);

          arranged.wire.close();
          await waitForRunnerGone(arranged);
          // The prompt went back to waiting when the connection closed, and
          // the queued-input delivery pass sends it again. The runner ran the
          // turn and kept its result, so for a prompt under the same step key
          // it sends that result first, then answers that the prompt went
          // into the turn it already ran.
          const back = await arranged.reconnect();
          back.answering((frame) => {
            if (!startsStepTurn(frame, key)) return "opened";
            player.sendResult(back, key, answerText("Shipped"));
            return "steered";
          });
          back.send({
            _tag: "sessionsReport",
            sessions: [
              {
                sessionId,
                nativeSessionId: `native-${sessionId}`,
                instanceId: findInstanceId(arranged, "test-provider"),
              },
            ],
          });

          const ended = await waitForRunEnded(arranged, runId, "completed");
          expect(findStepRecords(ended, IMPLEMENT)[0]).toMatchObject({
            status: "completed",
            sessionId,
            output: { text: "Shipped" },
          });
          expect(
            listFrames<SessionInput>(back, "sessionInput").filter((frame) =>
              startsStepTurn(frame, key),
            ),
          ).toHaveLength(1);
          expect(await listInputs(arranged, sessionId)).toEqual([
            expect.objectContaining({ status: "delivered", delivery: "steered" }),
          ]);
        },
        { eventRoutingInterval: Duration.millis(50) },
      );
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "stops the session of a run that was cancelled while its runner was away, once the runner connects again",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const player = createSessionPlayer();
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: buildImplementDefinition(agentId),
        });
        const sessionId = await startStepSession(arranged, player, buildStepKey(runId));

        arranged.wire.close();
        await waitForRunnerGone(arranged);
        const response = await requestCancel(arranged.harness.base, arranged.token, runId);
        expect(response.status, await response.clone().text()).toBe(200);
        await waitForRunEnded(arranged, runId, "cancelled");
        // The stop could not reach the runner, so the session is still running.
        expect(await readSession(arranged, sessionId)).toMatchObject({ status: "busy" });

        const back = await arranged.reconnect();
        await waitForFrame(back, "stopped the session of the cancelled run", (frame) =>
          stopsSession(frame, sessionId),
        );
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "fails the run with session-failed when the runner restarted while the step's turn ran",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const player = createSessionPlayer();
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: buildImplementDefinition(agentId),
        });
        const key = buildStepKey(runId);
        const sessionId = await startStepSession(arranged, player, key);

        arranged.wire.close();
        await waitForRunnerGone(arranged);
        const back = await arranged.reconnect();
        await waitForFrame(back, "asked for the step's result", (frame) =>
          asksForResult(frame, key),
        );
        // The restarted runner holds no session. Its session ends, but only
        // the runner can say how the step's turn ended, so the step waits.
        back.send({ _tag: "sessionsReport", sessions: [] });
        await waitForSessionTo(
          arranged,
          sessionId,
          "ended the lost session",
          (one) => one.status === "exited",
        );
        const meanwhile = await readRun(arranged.harness.base, arranged.token, runId);
        expect(findStepRecords(meanwhile, IMPLEMENT)[0]?.status).toBe("running");

        const message = "The runner restarted while the step's turn ran.";
        player.sendResult(back, key, { status: "failed", code: "interrupted", message });
        const ended = await waitForRunEnded(arranged, runId, "failed");
        expect(ended).toMatchObject({ failureReason: "session-failed", failedStepId: IMPLEMENT });
        expect(findStepRecords(ended, IMPLEMENT)[0]).toMatchObject({
          status: "failed",
          error: { code: "interrupted", message },
        });
      });
    },
    WAIT_DEADLINE_MS * 3,
  );

  it(
    "fails the run with session-failed when the session exits before it took the next iteration's prompt",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const { wire } = arranged;
        const player = createSessionPlayer();
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: buildLoopDefinition(agentId),
        });
        const first = buildStepKey(runId, 1);
        const sessionId = await startStepSession(arranged, player, first);
        player.startTurn(wire, sessionId, first);
        player.sendResult(wire, first, completeWith({ done: false }));
        await waitForStepSessionId(arranged, buildStepKey(runId, 2));

        player.report(wire, sessionId, { _tag: "session.exited", reason: "process_exit" });
        const ended = await waitForRunEnded(arranged, runId, "failed");
        expect(ended).toMatchObject({ failureReason: "session-failed", failedStepId: IMPLEMENT });
        expect(findStepRecords(ended, IMPLEMENT)[1]).toMatchObject({
          iteration: 2,
          status: "failed",
          error: {
            code: "session_failed",
            message: "The step's session exited (process_exit) before it took the step's prompt.",
          },
        });
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "fails the run with session-failed when the controller ends the session because its runner was lost",
    async () => {
      await withAgentStepFleet(
        async (arranged) => {
          const player = createSessionPlayer();
          const agentId = await createAgent(arranged.harness.base, arranged.token);
          const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
            definition: buildImplementDefinition(agentId),
          });
          const sessionId = await startStepSession(arranged, player, buildStepKey(runId));

          arranged.wire.close();
          // Nothing has been heard about the session for longer than its
          // absolute timeout, eight hours by default.
          await Effect.runPromise(
            Effect.orDie(arranged.harness.sql`
              UPDATE sessions SET last_activity_at = '2026-01-01T00:00:00.000Z'
              WHERE id = unhex(replace(${sessionId}, '-', ''))
            `),
          );
          const ended = await waitForRunEnded(arranged, runId, "failed");
          expect(ended).toMatchObject({ failureReason: "session-failed", failedStepId: IMPLEMENT });
          expect(findStepRecords(ended, IMPLEMENT)[0]).toMatchObject({
            status: "failed",
            error: {
              code: "session_failed",
              message:
                "The step's session ended because its runner was not heard from for longer than the session's absolute timeout.",
            },
          });
        },
        { lostRunnerSweepInterval: Duration.millis(50) },
      );
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "fails the run once, with session-failed, when the step's runner is retired",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const player = createSessionPlayer();
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: buildImplementDefinition(agentId),
        });
        await startStepSession(arranged, player, buildStepKey(runId));

        const retired = await send(
          "POST",
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}/retire`,
          { body: { force: true }, token: arranged.token },
        );
        expect(retired.status, await retired.clone().text()).toBe(200);
        const ended = await waitForRunEnded(arranged, runId, "failed");
        expect(ended).toMatchObject({ failureReason: "session-failed", failedStepId: IMPLEMENT });
        expect(findStepRecords(ended, IMPLEMENT)).toEqual([
          expect.objectContaining({
            status: "failed",
            error: {
              code: "session_failed",
              message: "The step's session ended because its runner was retired.",
            },
          }),
        ]);
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "queues the step's session while its runner is full, and starts it once a session ends",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const player = createSessionPlayer();
        const capped = await send(
          "PATCH",
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}`,
          { body: { maxConcurrentSessions: 1 }, token: arranged.token },
        );
        expect(capped.status, await capped.clone().text()).toBe(200);
        const occupying = await spawnThreadUnder(
          arranged,
          await readProfileNamed(arranged, "worker"),
        );

        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: buildImplementDefinition(agentId),
        });
        const key = buildStepKey(runId);
        const sessionId = await waitForStepSessionId(arranged, key);
        expect((await readSession(arranged, sessionId)).status).toBe("queued");
        expect(listSessionStarts(arranged.wire, sessionId)).toEqual([]);

        // The thread reported its start at sequence number 1.
        reportEvent(arranged.wire, 2, {
          eventId: crypto.randomUUID(),
          sessionId: occupying.session.id,
          at,
          _tag: "session.exited",
          reason: "stopped",
        });
        await startStepSession(arranged, player, key);
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "opens the run's workspace on its runner before the step's session, which works in it",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const { wire } = arranged;
        const player = createSessionPlayer();
        const repoId = await createRepo(arranged, "https://github.com/o/agent.git");
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: {
            ...buildImplementDefinition(agentId),
            workspace: { kind: "ephemeral", checkouts: [{ resourceId: repoId }] },
          },
        });
        const key = buildStepKey(runId);
        const sessionId = await waitForStepSessionId(arranged, key);
        // The session waits for the workspace, which the runner makes first.
        const provision = await waitForFrame(
          wire,
          "sent the run's workspace",
          (frame) => frame._tag === "workspaceProvision",
        );
        const workspaceId = (provision as { readonly workspaceId: string }).workspaceId;
        expect(listSessionStarts(wire, sessionId)).toEqual([]);
        await reportWorkspaceReady(arranged, workspaceId);
        const start = await waitForSessionStart(wire, sessionId);
        expect(start.spec.workspaceId).toBe(workspaceId);
        player.reportStarted(wire, sessionId);
        await waitForStepInput(wire, key);
        await waitForSessionTo(
          arranged,
          sessionId,
          "opened the turn",
          (one) => one.status === "busy",
        );

        // The session asks for git credentials with its own token. The
        // running agent step does not entitle the runner itself: a runner
        // that was entitled would be told the repo has no Connection.
        const requestId = crypto.randomUUID();
        wire.send({
          _tag: "credentialRequest",
          requestId,
          remote: "github.com/o/agent",
          workspaceId,
        });
        const answer = await waitForFrame(
          wire,
          "answered the runner's credential request",
          (frame) => frame._tag === "credentialAnswer" && frame.requestId === requestId,
        );
        expect(answer).toMatchObject({ error: "unauthorized" });

        // A runner that reconnects is asked for the result in the workspace's
        // directory, where it keeps the step's result file.
        wire.close();
        await waitForRunnerGone(arranged);
        const back = await arranged.reconnect();
        const request = await waitForFrame(back, "asked for the step's result", (frame) =>
          asksForResult(frame, key),
        );
        expect(request).toMatchObject({ workspaceId });
        player.sendResult(back, key, answerText("Shipped"));
        await waitForRunEnded(arranged, runId, "completed");
      });
    },
    WAIT_DEADLINE_MS * 3,
  );

  it(
    "pins the run only to a runner that can run agent steps",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const player = createSessionPlayer();
        // A runner on an older build runs workspace actions but not agent steps.
        const older = await arranged.enlist({
          capabilities: [...WORKSPACE_ACTION_IDS].map(buildWorkspaceActionCapability),
        });
        arranged.wire.close();
        await waitForRunnerGone(arranged);

        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: buildImplementDefinition(agentId),
        });
        await waitForRunTo(arranged, runId, "running", (run) => run.status === "running");
        const waiting = await readRun(arranged.harness.base, arranged.token, runId);
        expect(findStepRecords(waiting, IMPLEMENT)[0]?.status).toBe("pending");

        const back = await arranged.reconnect();
        back.send({ _tag: "sessionsReport", sessions: [] });
        await startStepSession(arranged, player, buildStepKey(runId), back);
        expect((await readRun(arranged.harness.base, arranged.token, runId)).runnerId).toBe(
          arranged.runnerId,
        );
        expect(listFrames(older.wire, "sessionStart")).toEqual([]);
      });
    },
    WAIT_DEADLINE_MS * 3,
  );

  it(
    "runs a review loop: a signal on the pull request the agent opened sends the run back to the agent, in the sessions it already has",
    async () => {
      await withAgentStepFleet(
        async (arranged) => {
          const { wire } = arranged;
          const player = createSessionPlayer();
          const agentId = await createAgent(arranged.harness.base, arranged.token);
          const pullRequest = "https://github.com/octo/repo/pull/7";
          const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
            definition: {
              name: "Implement and open a pull request, again on a label",
              // The event payload carries the pull request's url, so the signal
              // correlates on it.
              triggers: [
                {
                  id: "labeled",
                  kind: "signal",
                  on: { kind: "github.pr.labeled", connectionId: "any" },
                  correlation: {
                    event: "event.payload.subject.url",
                    run: "steps.open_pr.output.url",
                  },
                },
              ],
              steps: [
                {
                  id: IMPLEMENT,
                  kind: "agent",
                  agent: agentId,
                  prompt: "Implement the change.",
                  // The signal's edge leads into this step, so it has to be
                  // named as the start.
                  entry: true,
                },
                {
                  id: "open_pr",
                  kind: "agent",
                  agent: agentId,
                  prompt: "Open a pull request.",
                  outputSchema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["url"],
                    properties: { url: { type: "string" } },
                  },
                },
              ],
              edges: [
                { from: IMPLEMENT, to: "open_pr" },
                { from: "labeled", to: IMPLEMENT, maxTraversals: 1 },
              ],
            },
          });
          const implementOnce = buildStepKey(runId, 1);
          const openOnce = buildStepKey(runId, 1, "open_pr");
          const implementer = await startStepSession(arranged, player, implementOnce);
          player.runTurn(wire, implementer, implementOnce, answerText("Implemented"));
          const opener = await startStepSession(arranged, player, openOnce);
          expect(opener).not.toBe(implementer);
          player.runTurn(wire, opener, openOnce, completeWith({ url: pullRequest }));

          // The run waits for its signal once its steps are done.
          await waitForRunTo(arranged, runId, "ran open_pr", (run) =>
            findStepRecords(run, "open_pr").some((record) => record.status === "completed"),
          );
          expect((await readRun(arranged.harness.base, arranged.token, runId)).status).toBe(
            "running",
          );

          await emitLabeledEvent(arranged.harness.base, arranged.token, { added: ["changes"] });
          const implementAgain = buildStepKey(runId, 2);
          const openAgain = buildStepKey(runId, 2, "open_pr");
          await waitForStepInput(wire, implementAgain);
          player.runTurn(wire, implementer, implementAgain, answerText("Addressed"));
          await waitForStepInput(wire, openAgain);
          player.runTurn(wire, opener, openAgain, completeWith({ url: pullRequest }));
          await waitForRunTo(
            arranged,
            runId,
            "ran open_pr again",
            (run) =>
              findStepRecords(run, "open_pr").every((record) => record.status === "completed") &&
              findStepRecords(run, "open_pr").length === 2,
          );

          // Each step ran both times in the session it started first.
          const run = await readRun(arranged.harness.base, arranged.token, runId);
          expect(listRunSessionIds(run)).toEqual([
            implementer,
            opener,
            undefined,
            implementer,
            opener,
          ]);
          expect(listFrames(wire, "sessionStart")).toHaveLength(2);

          const response = await requestCancel(arranged.harness.base, arranged.token, runId);
          expect(response.status, await response.clone().text()).toBe(200);
          await waitForFrame(wire, "stopped the implementer", (frame) =>
            stopsSession(frame, implementer),
          );
          await waitForFrame(wire, "stopped the opener", (frame) => stopsSession(frame, opener));
        },
        { plugins: [localGithubPlugin], eventRoutingInterval: Duration.millis(10) },
      );
    },
    WAIT_DEADLINE_MS * 3,
  );
});
