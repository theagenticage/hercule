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
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type { Input, Run, Session } from "@hercule/contract";
import {
  buildWorkspaceActionCapability,
  type ActionStepStart,
  type ControllerToRunner,
  type ProviderEvent,
  type SessionInput,
  type SessionStart,
  type WorkspaceStepOutcome,
} from "@hercule/protocol";
import { nowIso } from "../../db";
import { send } from "../../http/testing";
import { inputRepository } from "../../sessions";
import { Live } from "../sessions";
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

/** The second agent step of a definition that runs the agent twice in a row. */
const REVIEW = "review";

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

/** The reason stored on an input that was not sent because its runner was not connected. */
const PROMPT_NOT_SENT =
  "that session's runner is not connected; the input stays queued and is sent when the runner connects";

/** The reason stored on a step's prompt that was cancelled because its run ended. */
const PROMPT_RUN_ENDED = "the step's run ended before a runner took this prompt";

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

/** Counts the inputs that start a step key's turn, across the connections `wires` of one runner. */
const countStepInputs = (wires: ReadonlyArray<Wire>, key: StepKey): number =>
  wires.flatMap((wire) =>
    listFrames<SessionInput>(wire, "sessionInput").filter((frame) => startsStepTurn(frame, key)),
  ).length;

/**
 * Waits until the only input of a step's session, its prompt, is `sent`: it
 * left the controller and the runner never confirmed it, so the controller
 * never sends it again and leaves the step to the runner's answer. Returns
 * that input.
 */
const waitForPromptSent = (arranged: Arranged, sessionId: string): Promise<Input> =>
  waitUntil("gave up waiting for the runner to confirm the step's prompt", async () => {
    const inputs = await listInputs(arranged, sessionId);
    expect(inputs).toHaveLength(1);
    const prompt = inputs[0]!;
    return prompt.status === "sent" ? prompt : undefined;
  });

/** Waits until the only input of a step's session, its prompt, is `delivered`, and returns it. */
const waitForPromptDelivered = (arranged: Arranged, sessionId: string): Promise<Input> =>
  waitUntil("recorded the runner's late confirmation of the step's prompt", async () => {
    const inputs = await listInputs(arranged, sessionId);
    expect(inputs).toHaveLength(1);
    const prompt = inputs[0]!;
    return prompt.status === "delivered" ? prompt : undefined;
  });

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

/** The commit step of the definitions here that commit. */
const COMMIT_STEP = {
  id: "commit",
  kind: "action",
  action: "git.commit",
  params: { message: "Save the work" },
};

/** Waits until the runner has been sent the start of a run's commit step, and returns that frame. */
const waitForCommitStart = (wire: Wire, runId: string): Promise<ActionStepStart> =>
  waitUntil("sent the commit step", () =>
    wire.frames.find(
      (frame): frame is ActionStepStart =>
        frame._tag === "workspaceStepStart" &&
        frame.kind !== "agent" &&
        frame.runId === runId &&
        frame.stepId === COMMIT_STEP.id,
    ),
  );

/** What a runner reports for a commit step that committed. */
const COMMITTED = completeWith({ sha: "abc123", branch: "release", committed: true });

/**
 * Waits until the runner has been sent the provision of a run's workspace,
 * and reports that workspace ready, so the run's sessions can start in it.
 */
const reportRunWorkspaceReady = async (arranged: Arranged): Promise<void> => {
  const provision = await waitForFrame(
    arranged.wire,
    "sent the run's workspace",
    (frame) => frame._tag === "workspaceProvision",
  );
  await reportWorkspaceReady(arranged, (provision as { readonly workspaceId: string }).workspaceId);
};

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

/**
 * Plays a runner whose idle step session unloads just as the next prompt
 * reaches it, the way a real runner unloads: only after the turn has ended.
 *
 * 1. The runner ends the turn of `ended`, and holds the prompt of `next`
 *    that the controller then sends, without answering it.
 * 2. The idle session unloads.
 * 3. The runner refuses the held prompt, because the session is gone.
 *
 * The prompt then waits again, and the controller resumes the session in
 * place for it. Later inputs are answered `opened`.
 */
const unloadSessionBeforePromptAnswered = async (
  arranged: Arranged,
  player: SessionPlayer,
  sessionId: string,
  ended: StepKey,
  next: StepKey,
): Promise<void> => {
  const { wire } = arranged;
  wire.answering(() => undefined);
  player.endTurn(wire, sessionId, ended);
  const sent = await waitForStepInput(wire, next);
  player.report(wire, sessionId, { _tag: "session.exited", reason: "idle_unload" });
  await waitForSessionTo(arranged, sessionId, "exited", (one) => one.status === "exited");
  wire.answering(() => "opened");
  wire.send({
    _tag: "sessionInputResult",
    requestId: sent.requestId,
    ok: false,
    message: "that session is not running",
  });
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
        // The session is named for the run's workflow and the step, not for
        // the prompt, which may be long and is the same in every run.
        expect(await readSession(arranged, sessionId)).toMatchObject({
          runId,
          stepId: IMPLEMENT,
          title: "Implement, then file a task · implement",
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
        // The controller never stops the session when an iteration settles;
        // only the run's end does. A real runner would also unload it once it
        // sat idle, which this test never reports.
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

  it.each([
    {
      exit: "its harness unloads while idle",
      // The turn ends, and the runner unloads the idle harness as the
      // prompt arrives. It still holds the transcript, so the same
      // connection takes the resume.
      leave: async (
        arranged: Arranged,
        player: SessionPlayer,
        sessionId: string,
        ended: StepKey,
        next: StepKey,
      ): Promise<Wire> => {
        await unloadSessionBeforePromptAnswered(arranged, player, sessionId, ended, next);
        return arranged.wire;
      },
    },
    {
      exit: "its runner restarts",
      // The runner restarts before the turn ends, and holds no session.
      leave: async (arranged: Arranged): Promise<Wire> => {
        arranged.wire.close();
        await waitForRunnerGone(arranged);
        const back = await arranged.reconnect();
        back.send({ _tag: "sessionsReport", sessions: [] });
        return back;
      },
    },
  ])(
    "keeps the next iteration's waiting prompt when $exit, and resumes the session in place for it",
    async ({ leave }) => {
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

        const back = await leave(arranged, player, sessionId, first, second);

        // The session is resumed in place, and its prompt is sent to it.
        const resumed = await waitUntil("resumed the step's session", () =>
          listSessionStarts(back, sessionId).find((frame) => frame.spec.continue !== undefined),
        );
        expect(resumed.spec.continue).toEqual({
          nativeSessionId: `native-${sessionId}`,
          mode: "resume",
        });
        player.reportStarted(back, sessionId);
        await waitForSessionTo(
          arranged,
          sessionId,
          "opened the second iteration's turn",
          (one) => one.status === "busy",
        );
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
    "keeps a prompt the runner refused because its session had just unloaded, and resumes the session in place for it",
    async () => {
      await withAgentStepFleet(
        async (arranged) => {
          const { wire } = arranged;
          const player = createSessionPlayer();
          // The runner holds the prompt without answering, so it is still on
          // the wire when the session unloads.
          wire.answering(() => undefined);
          const agentId = await createAgent(arranged.harness.base, arranged.token);
          const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
            definition: buildImplementDefinition(agentId),
          });
          const key = buildStepKey(runId);
          const sessionId = await waitForStepSessionId(arranged, key);
          await waitForSessionStart(wire, sessionId);
          player.reportStarted(wire, sessionId);
          const sent = await waitForStepInput(wire, key);

          // The harness unloads before it takes the prompt, and the runner
          // then refuses the prompt, because the session is gone.
          player.report(wire, sessionId, { _tag: "session.exited", reason: "idle_unload" });
          await waitForSessionTo(arranged, sessionId, "exited", (one) => one.status === "exited");
          wire.answering(() => "opened");
          wire.send({
            _tag: "sessionInputResult",
            requestId: sent.requestId,
            ok: false,
            message: "that session is not running",
          });

          // The prompt goes back to waiting, and the session is resumed in
          // place for it.
          const resumed = await waitUntil("resumed the step's session", () =>
            listSessionStarts(wire, sessionId).find((frame) => frame.spec.continue !== undefined),
          );
          expect(resumed.spec.continue).toEqual({
            nativeSessionId: `native-${sessionId}`,
            mode: "resume",
          });
          player.reportStarted(wire, sessionId);
          await waitUntil("sent the step's prompt again", () => {
            const prompts = listFrames<SessionInput>(wire, "sessionInput").filter((frame) =>
              startsStepTurn(frame, key),
            );
            return prompts.length === 2 ? prompts : undefined;
          });
          player.runTurn(wire, sessionId, key, answerText("Shipped"));

          const ended = await waitForRunEnded(arranged, runId, "completed");
          expect(findStepRecords(ended, IMPLEMENT)[0]).toMatchObject({
            status: "completed",
            sessionId,
            output: { text: "Shipped" },
          });
          expect(await listInputs(arranged, sessionId)).toEqual([
            expect.objectContaining({ status: "delivered", delivery: "opened" }),
          ]);
        },
        { eventRoutingInterval: Duration.millis(50) },
      );
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "fails the run with session-failed when a session resumed for the step's prompt exits again before it starts a turn",
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
        await unloadSessionBeforePromptAnswered(
          arranged,
          player,
          sessionId,
          first,
          buildStepKey(runId, 2),
        );
        await waitUntil("resumed the step's session", () =>
          listSessionStarts(wire, sessionId).find((frame) => frame.spec.continue !== undefined),
        );

        // The resumed process exits before it starts a turn. The same exit
        // kept the prompt the first time, but now the crash-loop guard is
        // armed, so the prompt is cancelled and the step fails.
        player.report(wire, sessionId, { _tag: "session.exited", reason: "idle_unload" });
        const ended = await waitForRunEnded(arranged, runId, "failed");
        expect(ended).toMatchObject({ failureReason: "session-failed", failedStepId: IMPLEMENT });
        expect(findStepRecords(ended, IMPLEMENT)[1]).toMatchObject({
          iteration: 2,
          status: "failed",
          error: {
            code: "session_failed",
            message: "The step's session exited (idle_unload) before it took the step's prompt.",
          },
        });
        expect(listSessionStarts(wire, sessionId)).toHaveLength(2);
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
            reason: PROMPT_RUN_ENDED,
          });
        },
        { eventRoutingInterval: Duration.hours(1) },
      );
    },
    WAIT_DEADLINE_MS * 2,
  );

  it.each([
    {
      ending: "the run's stop ends the session",
      endSession: (
        arranged: Arranged,
        player: SessionPlayer,
        sessionId: string,
      ): Promise<ReadonlyArray<Wire>> => {
        player.report(arranged.wire, sessionId, { _tag: "session.exited", reason: "stopped" });
        return Promise.resolve([arranged.wire]);
      },
    },
    {
      // The restarted runner no longer knows the step is settled, so it
      // would run the prompt if the session were resumed for it.
      ending: "the runner restarts before it handles the run's stop",
      endSession: async (arranged: Arranged): Promise<ReadonlyArray<Wire>> => {
        arranged.wire.close();
        await waitForRunnerGone(arranged);
        const back = await arranged.reconnect();
        back.send({ _tag: "sessionsReport", sessions: [] });
        return [arranged.wire, back];
      },
    },
  ])(
    "cancels at once a step's prompt the runner refused after its run ended, and never resumes the session for it, when $ending",
    async ({ endSession }) => {
      await withAgentStepFleet(
        async (arranged) => {
          const { wire } = arranged;
          const player = createSessionPlayer();
          // The runner holds the prompt without answering, so the run is
          // cancelled while the prompt is on its way.
          wire.answering(() => undefined);
          const agentId = await createAgent(arranged.harness.base, arranged.token);
          const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
            definition: buildImplementDefinition(agentId),
          });
          const key = buildStepKey(runId);
          const sessionId = await waitForStepSessionId(arranged, key);
          await waitForSessionStart(wire, sessionId);
          player.reportStarted(wire, sessionId);
          const sent = await waitForStepInput(wire, key);

          const response = await requestCancel(arranged.harness.base, arranged.token, runId);
          expect(response.status, await response.clone().text()).toBe(200);
          await waitForFrame(wire, "settled the step", (frame) => settlesStep(frame, key));
          await waitForFrame(wire, "stopped the run's session", (frame) =>
            stopsSession(frame, sessionId),
          );
          // The settle reached the runner before the prompt did, so the runner
          // refuses the prompt and runs no turn.
          wire.send({
            _tag: "sessionInputResult",
            requestId: sent.requestId,
            ok: false,
            message:
              "the step ended before its prompt reached the harness, so the prompt was not run",
          });
          await waitUntil("cancelled the refused prompt", async () =>
            (await listInputs(arranged, sessionId)).find((one) => one.status === "cancelled"),
          );
          expect(await listInputs(arranged, sessionId)).toEqual([
            expect.objectContaining({ status: "cancelled", reason: PROMPT_RUN_ENDED }),
          ]);

          const wires = await endSession(arranged, player, sessionId);
          await waitForSessionTo(arranged, sessionId, "exited", (one) => one.status === "exited");
          const ended = await waitForRunEnded(arranged, runId, "cancelled");
          expect(findStepRecords(ended, IMPLEMENT)[0]?.status).toBe("cancelled");
          expect(countStepInputs(wires, key)).toBe(1);
          expect(wires.flatMap((one) => listSessionStarts(one, sessionId))).toHaveLength(1);
        },
        // A delivery pass runs every 50 ms, so a prompt left waiting would
        // be sent again, or would resume the exited session.
        { eventRoutingInterval: Duration.millis(50) },
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
    "never sends a step's prompt again when the connection dropped before the runner answered it, and settles the step on the result the restarted runner kept",
    async () => {
      await withAgentStepFleet(
        async (arranged) => {
          const player = createSessionPlayer();
          // The runner takes the prompt and starts its turn, but its answer to
          // the input is lost with the connection.
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
          player.startTurn(arranged.wire, sessionId, key);
          await waitForSessionTo(
            arranged,
            sessionId,
            "opened the turn",
            (one) => one.status === "busy",
          );

          arranged.wire.close();
          await waitForRunnerGone(arranged);
          // The prompt has left the controller, so it is never sent again.
          // The input deadline is far longer than this test, so only the
          // dropped connection can have ended the wait for the runner's
          // answer.
          await waitForPromptSent(arranged, sessionId);

          // The runner restarted too, so it holds no session. The step's turn
          // ended before the restart, and the runner kept its result.
          const back = await arranged.reconnect();
          await waitForFrame(back, "asked for the step's result", (frame) =>
            asksForResult(frame, key),
          );
          back.send({ _tag: "sessionsReport", sessions: [] });
          await waitForSessionTo(
            arranged,
            sessionId,
            "ended the lost session",
            (one) => one.status === "exited",
          );
          const meanwhile = await readRun(arranged.harness.base, arranged.token, runId);
          expect(findStepRecords(meanwhile, IMPLEMENT)[0]?.status).toBe("running");
          player.sendResult(back, key, answerText("Shipped"));

          const ended = await waitForRunEnded(arranged, runId, "completed");
          expect(findStepRecords(ended, IMPLEMENT)[0]).toMatchObject({
            status: "completed",
            sessionId,
            output: { text: "Shipped" },
          });
          // One prompt and one turn: the session was not resumed to run the
          // prompt a second time.
          expect(countStepInputs([arranged.wire, back], key)).toBe(1);
          expect(listSessionStarts(back, sessionId)).toEqual([]);
        },
        { inputDeadline: Duration.minutes(1), eventRoutingInterval: Duration.millis(50) },
      );
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "keeps a step's prompt queued when its runner is gone before the prompt leaves the controller, and sends it once the runner is back",
    async () => {
      await withAgentStepFleet(
        async (arranged) => {
          const player = createSessionPlayer();
          const agentId = await createAgent(arranged.harness.base, arranged.token);
          const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
            definition: buildImplementDefinition(agentId),
          });
          const key = buildStepKey(runId);
          const sessionId = await waitForStepSessionId(arranged, key);
          await waitForSessionStart(arranged.wire, sessionId);

          // The session goes idle and its runner drops before the prompt is
          // sent. Over the socket, the change to idle sends the prompt before
          // a close can land, so the idle status is written by hand once the
          // runner is gone.
          arranged.wire.close();
          await waitForRunnerGone(arranged);
          await Effect.runPromise(
            Effect.orDie(arranged.harness.sql`
              UPDATE sessions SET status = 'idle'
              WHERE id = unhex(replace(${sessionId}, '-', ''))
            `),
          );
          // A delivery checks for a connection before it claims the prompt.
          // This claims and sends without that check, as a delivery does
          // when the connection drops between the check and the send.
          const exit = await arranged.harness.runWithLiveSessions(
            Effect.gen(function* () {
              const inputs = yield* inputRepository;
              const live = yield* Live;
              const claimed = yield* inputs.claimOldestUnlessOneIsOnTheWire(
                sessionId,
                yield* nowIso,
              );
              yield* live.sendClaimed(Option.getOrThrow(claimed));
            }),
          );
          expect(Exit.isSuccess(exit)).toBe(true);
          // The prompt never left the controller, so it waits to be sent.
          expect(await listInputs(arranged, sessionId)).toMatchObject([
            { status: "queued", sentAt: null, reason: PROMPT_NOT_SENT },
          ]);

          const back = await arranged.reconnect();
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
          // The delivery pass sends the prompt on the new connection.
          await waitForStepInput(back, key);
          player.runTurn(back, sessionId, key, answerText("Shipped"));

          const ended = await waitForRunEnded(arranged, runId, "completed");
          expect(findStepRecords(ended, IMPLEMENT)[0]).toMatchObject({
            status: "completed",
            sessionId,
            output: { text: "Shipped" },
          });
          expect(countStepInputs([arranged.wire, back], key)).toBe(1);
          // The runner was never asked for a result of a prompt it never had.
          expect(back.frames.filter((frame) => asksForResult(frame, key))).toEqual([]);
        },
        { eventRoutingInterval: Duration.millis(50) },
      );
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "asks the runner for a step's result at once when it does not answer the step's prompt in time, and never sends the prompt again",
    async () => {
      await withAgentStepFleet(
        async (arranged) => {
          const { wire } = arranged;
          const player = createSessionPlayer();
          // The runner takes the prompt and never answers it.
          wire.answering(() => undefined);
          const agentId = await createAgent(arranged.harness.base, arranged.token);
          const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
            definition: buildImplementDefinition(agentId),
          });
          const key = buildStepKey(runId);
          const sessionId = await waitForStepSessionId(arranged, key);
          await waitForSessionStart(wire, sessionId);
          player.reportStarted(wire, sessionId);
          await waitForStepInput(wire, key);

          // The runner is still connected, so the controller asks it right
          // away how the step's turn ended.
          await waitForFrame(wire, "asked for the step's result", (frame) =>
            asksForResult(frame, key),
          );
          await waitForPromptSent(arranged, sessionId);
          player.runTurn(wire, sessionId, key, answerText("Shipped"));

          const ended = await waitForRunEnded(arranged, runId, "completed");
          expect(findStepRecords(ended, IMPLEMENT)[0]).toMatchObject({
            status: "completed",
            output: { text: "Shipped" },
          });
          expect(countStepInputs([wire], key)).toBe(1);
        },
        { inputDeadline: Duration.millis(200), eventRoutingInterval: Duration.millis(50) },
      );
    },
    WAIT_DEADLINE_MS * 2,
  );

  it.each([
    { when: "before the step's turn starts", turnStartsFirst: false },
    { when: "after the step's turn started", turnStartsFirst: true },
  ])(
    "marks a step's prompt delivered when the runner confirms it after the deadline, $when, and completes the step from the runner's result",
    async ({ turnStartsFirst }) => {
      await withAgentStepFleet(
        async (arranged) => {
          const { wire } = arranged;
          const player = createSessionPlayer();
          // The runner takes the prompt, but confirms it later than the
          // controller waits.
          wire.answering(() => undefined);
          const agentId = await createAgent(arranged.harness.base, arranged.token);
          const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
            definition: buildImplementDefinition(agentId),
          });
          const key = buildStepKey(runId);
          const sessionId = await waitForStepSessionId(arranged, key);
          await waitForSessionStart(wire, sessionId);
          player.reportStarted(wire, sessionId);
          await waitForStepInput(wire, key);
          if (turnStartsFirst) player.startTurn(wire, sessionId, key);

          await waitForFrame(wire, "asked for the step's result", (frame) =>
            asksForResult(frame, key),
          );
          await waitForPromptSent(arranged, sessionId);
          wire.release("opened");

          // The runner took the prompt after all, so the prompt is delivered.
          expect(await waitForPromptDelivered(arranged, sessionId)).toMatchObject({
            delivery: "opened",
            sentAt: null,
            reason: null,
          });
          await waitForSessionTo(
            arranged,
            sessionId,
            "opened the turn",
            (one) => one.status === "busy",
          );
          if (!turnStartsFirst) player.startTurn(wire, sessionId, key);
          player.sendResult(wire, key, answerText("Shipped"));
          player.endTurn(wire, sessionId, key);

          const ended = await waitForRunEnded(arranged, runId, "completed");
          expect(findStepRecords(ended, IMPLEMENT)[0]).toMatchObject({
            status: "completed",
            output: { text: "Shipped" },
          });
          expect(countStepInputs([wire], key)).toBe(1);
        },
        { inputDeadline: Duration.millis(200), eventRoutingInterval: Duration.millis(50) },
      );
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "keeps a step's prompt sent when the runner refuses it after the deadline, and fails the step on the runner's interrupted answer",
    async () => {
      await withAgentStepFleet(
        async (arranged) => {
          const { wire } = arranged;
          const player = createSessionPlayer();
          // The runner refuses the prompt, but later than the controller waits.
          wire.answering(() => undefined);
          const agentId = await createAgent(arranged.harness.base, arranged.token);
          const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
            definition: buildImplementDefinition(agentId),
          });
          const key = buildStepKey(runId);
          const sessionId = await waitForStepSessionId(arranged, key);
          await waitForSessionStart(wire, sessionId);
          player.reportStarted(wire, sessionId);
          const sent = await waitForStepInput(wire, key);
          await waitForFrame(wire, "asked for the step's result", (frame) =>
            asksForResult(frame, key),
          );
          const prompt = await waitForPromptSent(arranged, sessionId);

          wire.send({
            _tag: "sessionInputResult",
            requestId: sent.requestId,
            ok: false,
            message: "the harness is not ready for input",
          });
          // A runner that refused the prompt ran no turn for it, so it
          // answers the request for the step's result with `interrupted`.
          player.sendResult(wire, key, {
            status: "failed",
            code: "interrupted",
            message: "The runner does not know this step.",
          });

          const ended = await waitForRunEnded(arranged, runId, "failed");
          expect(ended).toMatchObject({ failureReason: "session-failed", failedStepId: IMPLEMENT });
          expect(findStepRecords(ended, IMPLEMENT)[0]).toMatchObject({
            status: "failed",
            error: { code: "interrupted", message: "The runner does not know this step." },
          });
          // The refusal came after the prompt was given up on, so it changes
          // nothing, and the prompt is never sent again.
          expect(await listInputs(arranged, sessionId)).toEqual([prompt]);
          expect(countStepInputs([wire], key)).toBe(1);
        },
        { inputDeadline: Duration.millis(200), eventRoutingInterval: Duration.millis(50) },
      );
    },
    WAIT_DEADLINE_MS * 2,
  );

  it.each([
    {
      ending: "completes",
      outcome: answerText("Shipped"),
      status: "completed",
      record: { status: "completed", output: { text: "Shipped" } },
    },
    {
      ending: "fails",
      outcome: {
        status: "failed",
        code: "interrupted",
        message: "The runner does not know this step.",
      },
      status: "failed",
      record: {
        status: "failed",
        error: { code: "interrupted", message: "The runner does not know this step." },
      },
    },
  ] as const)(
    "waits for the runner's answer about a step whose prompt was on the wire when the controller restarted, and $ending the step on it",
    async ({ outcome, status, record }) => {
      await withAgentStepFleet(async (arranged) => {
        const player = createSessionPlayer();
        // The runner's answer to the prompt has not arrived when the
        // controller restarts.
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

        await arranged.harness.reboot();
        await waitForPromptSent(arranged, sessionId);

        // The runner restarted as well, and holds no session.
        arranged.wire.close();
        await waitForRunnerGone(arranged);
        const back = await arranged.reconnect();
        await waitForFrame(back, "asked for the step's result", (frame) =>
          asksForResult(frame, key),
        );
        back.send({ _tag: "sessionsReport", sessions: [] });
        await waitForSessionTo(
          arranged,
          sessionId,
          "ended the lost session",
          (one) => one.status === "exited",
        );
        // Only the runner can say whether the step's turn ran, so the step
        // waits for its answer.
        const meanwhile = await readRun(arranged.harness.base, arranged.token, runId);
        expect(findStepRecords(meanwhile, IMPLEMENT)[0]?.status).toBe("running");

        player.sendResult(back, key, outcome);
        const ended = await waitForRunEnded(arranged, runId, status);
        expect(findStepRecords(ended, IMPLEMENT)[0]).toMatchObject(record);
        if (status === "failed") {
          expect(ended).toMatchObject({ failureReason: "session-failed", failedStepId: IMPLEMENT });
        }
        expect(countStepInputs([arranged.wire, back], key)).toBe(1);
      });
    },
    WAIT_DEADLINE_MS * 3,
  );

  it(
    "fails the run with session-failed when the runner refuses the step's prompt after its session exited for good",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const { wire } = arranged;
        const player = createSessionPlayer();
        // The runner holds the prompt without answering, so it is still on
        // the wire when the session exits.
        wire.answering(() => undefined);
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: buildImplementDefinition(agentId),
        });
        const key = buildStepKey(runId);
        const sessionId = await waitForStepSessionId(arranged, key);
        await waitForSessionStart(wire, sessionId);
        player.reportStarted(wire, sessionId);
        const sent = await waitForStepInput(wire, key);

        player.report(wire, sessionId, { _tag: "session.exited", reason: "process_exit" });
        await waitForSessionTo(arranged, sessionId, "exited", (one) => one.status === "exited");
        wire.send({
          _tag: "sessionInputResult",
          requestId: sent.requestId,
          ok: false,
          message: "that session is not running",
        });

        const ended = await waitForRunEnded(arranged, runId, "failed");
        expect(ended).toMatchObject({ failureReason: "session-failed", failedStepId: IMPLEMENT });
        expect(findStepRecords(ended, IMPLEMENT)[0]).toMatchObject({
          status: "failed",
          error: {
            code: "session_failed",
            message:
              "The step's prompt could not be sent to its session: that session is not running",
          },
        });
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "sends a step's prompt again after the runner refused it, and runs the step's turn on the second send",
    async () => {
      await withAgentStepFleet(
        async (arranged) => {
          const { wire } = arranged;
          const player = createSessionPlayer();
          let refused = false;
          wire.answering(() => {
            if (refused) return "opened";
            refused = true;
            return { message: "the harness is not ready for input" };
          });
          const agentId = await createAgent(arranged.harness.base, arranged.token);
          const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
            definition: buildImplementDefinition(agentId),
          });
          const key = buildStepKey(runId);
          const sessionId = await waitForStepSessionId(arranged, key);
          await waitForSessionStart(wire, sessionId);
          player.reportStarted(wire, sessionId);

          await waitUntil("sent the step's prompt again", () =>
            countStepInputs([wire], key) === 2 ? true : undefined,
          );
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
            output: { text: "Shipped" },
          });
          expect(await listInputs(arranged, sessionId)).toEqual([
            expect.objectContaining({ status: "delivered", delivery: "opened", sentAt: null }),
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
    "gives a step session a 5 s idle unload, so the next step gets the runner's only slot once the runner unloads it",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const { wire } = arranged;
        const player = createSessionPlayer();
        const capped = await send(
          "PATCH",
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}`,
          { body: { maxConcurrentSessions: 1 }, token: arranged.token },
        );
        expect(capped.status, await capped.clone().text()).toBe(200);
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: {
            name: "Implement, then review",
            steps: [
              { id: IMPLEMENT, kind: "agent", agent: agentId, prompt: "Implement the change." },
              { id: REVIEW, kind: "agent", agent: agentId, prompt: "Review the change." },
            ],
            edges: [{ from: IMPLEMENT, to: REVIEW }],
          },
        });
        const implementKey = buildStepKey(runId);
        const reviewKey = buildStepKey(runId, 1, REVIEW);
        const implementer = await startStepSession(arranged, player, implementKey);
        expect(listSessionStarts(wire, implementer)[0]?.spec.timeouts.idleMs).toBe(5_000);
        player.runTurn(wire, implementer, implementKey, answerText("Implemented"));

        // The idle implementer still holds the only slot, so the reviewer waits.
        const reviewer = await waitForStepSessionId(arranged, reviewKey);
        expect((await readSession(arranged, reviewer)).status).toBe("queued");
        expect(listSessionStarts(wire, reviewer)).toEqual([]);

        // The runner unloads the implementer once it has sat idle that long.
        player.report(wire, implementer, { _tag: "session.exited", reason: "idle_unload" });
        await startStepSession(arranged, player, reviewKey);
        expect(listSessionStarts(wire, reviewer)[0]?.spec.timeouts.idleMs).toBe(5_000);
        player.runTurn(wire, reviewer, reviewKey, answerText("Approved"));
        const ended = await waitForRunEnded(arranged, runId, "completed");
        expect(listRunSessionIds(ended)).toEqual([implementer, reviewer]);
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
    "switches a repo's main workspace to the workflow's branch for the first step's session only, never for a fresh session or a later commit",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const { wire } = arranged;
        const player = createSessionPlayer();
        const repoId = await createRepo(arranged, "https://github.com/o/agent.git");
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: {
            name: "Implement on the release branch, then commit",
            workspace: { kind: "primary", resourceId: repoId, branch: "release" },
            steps: [
              {
                id: IMPLEMENT,
                kind: "agent",
                agent: agentId,
                prompt: "Implement the change.",
                entry: true,
                outputSchema: DONE_SCHEMA,
                freshSession: true,
              },
              COMMIT_STEP,
            ],
            edges: [
              {
                from: IMPLEMENT,
                to: IMPLEMENT,
                condition: "steps.implement.output.done == false",
                maxTraversals: 1,
              },
              { from: IMPLEMENT, to: "commit", condition: "steps.implement.output.done == true" },
            ],
          },
        });
        await reportRunWorkspaceReady(arranged);
        const firstKey = buildStepKey(runId, 1);
        const first = await startStepSession(arranged, player, firstKey);
        expect(listSessionStarts(wire, first)[0]?.checkoutBranch).toBe("release");
        player.runTurn(wire, first, firstKey, completeWith({ done: false }));

        // The first session's agent may have moved to another branch by now,
        // so the second session starts on whatever branch is current.
        const secondKey = buildStepKey(runId, 2);
        const second = await startStepSession(arranged, player, secondKey);
        expect(listSessionStarts(wire, second)[0]).not.toHaveProperty("checkoutBranch");
        player.runTurn(wire, second, secondKey, completeWith({ done: true }));

        // The commit goes to that branch too.
        const commit = await waitForCommitStart(wire, runId);
        expect(commit).not.toHaveProperty("checkoutBranch");
        player.sendResult(wire, buildStepKey(runId, 1, COMMIT_STEP.id), COMMITTED);
        await waitForRunEnded(arranged, runId, "completed");
      });
    },
    WAIT_DEADLINE_MS * 3,
  );

  it(
    "switches a repo's main workspace to the workflow's branch for a first commit step, and not for the agent step after it",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const { wire } = arranged;
        const player = createSessionPlayer();
        const repoId = await createRepo(arranged, "https://github.com/o/agent.git");
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: {
            name: "Commit on the release branch, then implement",
            workspace: { kind: "primary", resourceId: repoId, branch: "release" },
            steps: [
              COMMIT_STEP,
              { id: IMPLEMENT, kind: "agent", agent: agentId, prompt: "Implement the change." },
            ],
            edges: [{ from: COMMIT_STEP.id, to: IMPLEMENT }],
          },
        });
        await reportRunWorkspaceReady(arranged);
        const commit = await waitForCommitStart(wire, runId);
        expect(commit.checkoutBranch).toBe("release");
        player.sendResult(wire, buildStepKey(runId, 1, COMMIT_STEP.id), COMMITTED);

        const key = buildStepKey(runId);
        const sessionId = await startStepSession(arranged, player, key);
        expect(listSessionStarts(wire, sessionId)[0]).not.toHaveProperty("checkoutBranch");
        player.runTurn(wire, sessionId, key, answerText("Implemented"));
        await waitForRunEnded(arranged, runId, "completed");
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "switches a repo's main workspace to the workflow's branch for only one of a first agent step and a first commit step that start at once",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const { wire } = arranged;
        const player = createSessionPlayer();
        const repoId = await createRepo(arranged, "https://github.com/o/agent.git");
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: {
            name: "Implement and commit at once on the release branch",
            workspace: { kind: "primary", resourceId: repoId, branch: "release" },
            steps: [
              { id: IMPLEMENT, kind: "agent", agent: agentId, prompt: "Implement the change." },
              COMMIT_STEP,
            ],
            edges: [],
          },
        });
        await reportRunWorkspaceReady(arranged);
        const key = buildStepKey(runId);
        const sessionId = await startStepSession(arranged, player, key);
        const commit = await waitForCommitStart(wire, runId);

        // Only the step whose start pinned the run switches the branch, and
        // either step may be the one. If both did, the second switch could
        // undo a branch the first step's work had already moved to.
        const switches = [
          listSessionStarts(wire, sessionId)[0]?.checkoutBranch,
          commit.checkoutBranch,
        ];
        expect(switches.filter((branch) => branch !== undefined)).toEqual(["release"]);

        player.sendResult(wire, buildStepKey(runId, 1, COMMIT_STEP.id), COMMITTED);
        player.runTurn(wire, sessionId, key, answerText("Implemented"));
        await waitForRunEnded(arranged, runId, "completed");
      });
    },
    WAIT_DEADLINE_MS * 2,
  );

  it(
    "never switches a repo's main workspace to the workflow's branch again when the first step's session is resumed",
    async () => {
      await withAgentStepFleet(async (arranged) => {
        const { wire } = arranged;
        const player = createSessionPlayer();
        const repoId = await createRepo(arranged, "https://github.com/o/agent.git");
        const agentId = await createAgent(arranged.harness.base, arranged.token);
        const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
          definition: {
            ...buildLoopDefinition(agentId),
            workspace: { kind: "primary", resourceId: repoId, branch: "release" },
          },
        });
        await reportRunWorkspaceReady(arranged);
        const first = buildStepKey(runId, 1);
        const second = buildStepKey(runId, 2);
        const sessionId = await startStepSession(arranged, player, first);
        expect(listSessionStarts(wire, sessionId)[0]?.checkoutBranch).toBe("release");
        player.startTurn(wire, sessionId, first);
        player.sendResult(wire, first, completeWith({ done: false }));
        await unloadSessionBeforePromptAnswered(arranged, player, sessionId, first, second);
        const resumed = await waitUntil("resumed the step's session", () =>
          listSessionStarts(wire, sessionId).find((frame) => frame.spec.continue !== undefined),
        );
        expect(resumed).not.toHaveProperty("checkoutBranch");
        player.reportStarted(wire, sessionId);
        await waitUntil("sent the second iteration's prompt again", () =>
          countStepInputs([wire], second) === 2 ? true : undefined,
        );
        player.runTurn(wire, sessionId, second, completeWith({ done: true }));
        await waitForRunEnded(arranged, runId, "completed");
      });
    },
    WAIT_DEADLINE_MS * 2,
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

  it(
    "resumes a step's session the runner unloaded while the run waited for its signal, with the same five-second idle unload",
    async () => {
      await withAgentStepFleet(
        async (arranged) => {
          const { wire } = arranged;
          const player = createSessionPlayer();
          const agentId = await createAgent(arranged.harness.base, arranged.token);
          const pullRequest = "https://github.com/octo/repo/pull/7";
          const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
            definition: {
              name: "Open a pull request, and work on it again on a label",
              triggers: [
                {
                  id: "labeled",
                  kind: "signal",
                  on: { kind: "github.pr.labeled", connectionId: "any" },
                  correlation: {
                    event: "event.payload.subject.url",
                    run: "steps.implement.output.url",
                  },
                },
              ],
              steps: [
                {
                  id: IMPLEMENT,
                  kind: "agent",
                  agent: agentId,
                  prompt: "Implement the change and open a pull request.",
                  // The signal's edge leads into this step, so it has to be
                  // named as the start.
                  entry: true,
                  outputSchema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["url"],
                    properties: { url: { type: "string" } },
                  },
                },
              ],
              edges: [{ from: "labeled", to: IMPLEMENT, maxTraversals: 1 }],
            },
          });
          const first = buildStepKey(runId, 1);
          const second = buildStepKey(runId, 2);
          const sessionId = await startStepSession(arranged, player, first);
          player.runTurn(wire, sessionId, first, completeWith({ url: pullRequest }));
          await waitForRunTo(arranged, runId, "ran the first iteration", (run) =>
            findStepRecords(run, IMPLEMENT).some((record) => record.status === "completed"),
          );

          // The runner unloads the idle session while the run waits for its signal.
          player.report(wire, sessionId, { _tag: "session.exited", reason: "idle_unload" });
          await waitForSessionTo(arranged, sessionId, "exited", (one) => one.status === "exited");

          await emitLabeledEvent(arranged.harness.base, arranged.token, { added: ["changes"] });
          const resumed = await waitUntil("resumed the step's session", () =>
            listSessionStarts(wire, sessionId).find((frame) => frame.spec.continue !== undefined),
          );
          expect(resumed.spec.continue).toEqual({
            nativeSessionId: `native-${sessionId}`,
            mode: "resume",
          });
          // The resumed session unloads again once the second iteration's turn ends.
          expect(resumed.spec.timeouts.idleMs).toBe(5_000);
          player.reportStarted(wire, sessionId);
          await waitForStepInput(wire, second);
          player.runTurn(wire, sessionId, second, completeWith({ url: pullRequest }));
          const run = await waitForRunTo(
            arranged,
            runId,
            "ran the second iteration",
            (one) =>
              findStepRecords(one, IMPLEMENT).filter((record) => record.status === "completed")
                .length === 2,
          );
          expect(findStepRecords(run, IMPLEMENT).map((record) => record.sessionId)).toEqual([
            sessionId,
            sessionId,
          ]);
          expect(listSessionStarts(wire, sessionId)).toHaveLength(2);
        },
        { plugins: [localGithubPlugin], eventRoutingInterval: Duration.millis(10) },
      );
    },
    WAIT_DEADLINE_MS * 3,
  );
});
