/**
 * Tests the supervisor the way a connection uses it: the controller's frames go
 * in, and the runner's frames come out. The adapter is a fake, because the
 * tests are about the runner's own bookkeeping (the sequence numbers, the
 * `live` table, the scratch directory), not about any harness.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Duration, Effect, Exit, Fiber, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";
import type {
  ExitReason,
  ProviderEvent,
  RequestResolution,
  RunnerToController,
  SendResult,
  SessionInputResult,
  SessionBinding,
  SessionEvent,
  SessionSpec,
  SessionStart,
  TurnInput,
} from "@hercule/protocol";
import type { ProviderAdapter, ProviderRunnerContext } from "../providers";
import type { Machine } from "./context";
import { makeWorkspaces } from "../workspaces";
import { makeSupervising } from "./supervisor";

const roots: Array<string> = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const INSTANCE = "0199e0e7-0000-7000-8000-00000000000a";
const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const NATIVE = "0199e0e7-0000-7000-8000-0000000000fe";
const TURN = "0199e0e7-0000-7000-8000-0000000000fd";
/** The id of the Queued Input row an input frame and its result are sent under. */
const REQUEST = "0199e0e7-0000-7000-8000-0000000000fc";
/** The id of the Queued Input row a start carries, distinct from `REQUEST` so the two results can be told apart. */
const START_REQUEST = "0199e0e7-0000-7000-8000-0000000000fa";
/** The input every start in these tests carries. */
const START_INPUT: TurnInput = { text: "begin" };
/** A subagent of the session, as a harness names it. */
const SUBAGENT = "agent-1";
/** The adapter's own id for the open request an answer refers to. The controller does not create one. */
const PARK = "0199e0e7-0000-7000-8000-0000000000fb";

/**
 * The controller's default inactivity and absolute timeouts, 30 minutes and
 * 8 hours (spec 03 section 6.2). Only the test clock can reach them.
 */
const INACTIVITY_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 8 * 60 * 60 * 1000;

const SPEC: SessionSpec = {
  instanceId: INSTANCE,
  workspaceId: null,
  modelSelection: { model: "claude-haiku-4-5", options: {} },
  accessMode: "approval-required",
  timeouts: { inactivityMs: INACTIVITY_MS, absoluteMs: ABSOLUTE_MS },
};

const START: SessionStart = {
  _tag: "sessionStart",
  requestId: START_REQUEST,
  sessionId: SESSION,
  input: START_INPUT,
  providerId: "fake",
  config: {},
  secrets: {},
  spec: SPEC,
  token: "a-session-token",
};

const at = "2026-09-07T10:00:00.000Z";

/**
 * An event no real adapter sends. The tests publish it until a relay receives
 * it, and the fake adapter filters it out before the relay under test sees it.
 */
const MARKER: ProviderEvent = {
  _tag: "runtime.warning",
  eventId: "e-marker",
  sessionId: SESSION,
  at,
  message: "is anybody listening",
};

/** A fake adapter that records what it was given and emits the events the test asks for. */
interface Fake {
  readonly adapter: ProviderAdapter;
  /** The context the supervisor resolved for the one session it started. */
  readonly contexts: Array<ProviderRunnerContext>;
  /** How many markers have reached a relay. A count above zero proves a relay is listening. */
  readonly heard: () => number;
  readonly inputs: Array<TurnInput>;
  /** Every `interrupt` call, with the subagent it named, if any. */
  readonly interrupted: Array<{ readonly sessionId: string; readonly subagentId?: string }>;
  /** The arguments of every `respondToApprovalRequest` and `respondToQuestion` call. */
  readonly answered: Array<readonly [string, string, RequestResolution]>;
  /** Every `stopSession` call, with the reason its caller gave. */
  readonly stops: Array<{ readonly sessionId: string; readonly reason: ExitReason }>;
  readonly emit: (event: ProviderEvent) => void;
  /** The error every later start and input fails with, when set. */
  fails: string | undefined;
  /** A harness that throws where nothing declared it could. */
  dies: boolean;
  /**
   * A harness that takes the stop and never exits: the process is wedged, or
   * ignoring the signal. Its session is only ever abandoned, never seen out.
   */
  stopsSilently: boolean;
}

const createFake = (): Fake => {
  const events = Effect.runSync(PubSub.unbounded<ProviderEvent>());
  let heard = 0;
  const contexts: Array<ProviderRunnerContext> = [];
  const inputs: Array<TurnInput> = [];
  const interrupted: Array<{ readonly sessionId: string; readonly subagentId?: string }> = [];
  const answered: Array<readonly [string, string, RequestResolution]> = [];
  const stops: Array<{ readonly sessionId: string; readonly reason: ExitReason }> = [];
  const held = new Map<string, SessionBinding>();
  const fake: Fake = {
    contexts,
    heard: () => heard,
    inputs,
    interrupted,
    answered,
    stops,
    fails: undefined,
    dies: false,
    stopsSilently: false,
    emit: (event) => {
      PubSub.publishUnsafe(events, event);
    },
    adapter: {
      providerId: "fake",
      binaryName: "fake-harness",
      /**
       * A PubSub drops events that no subscriber receives, so an event
       * published before the relay subscribed is lost. The runner has no
       * outbox yet that keeps such events for replay, so this is a race in any
       * test that starts a session. A marker that gets this far proves a relay is listening; it is
       * counted and dropped here, so the relay under test never sees it.
       */
      events: Stream.filter(Stream.fromPubSub(events), (event) => {
        if (event !== MARKER) return true;
        heard += 1;
        return false;
      }),
      probe: () => Effect.die("not probed here"),
      listSessions: Effect.sync(() => [...held.values()]),
      startSession: (sessionId, _spec, ctx) =>
        Effect.suspend(() => {
          if (fake.dies) throw new Error("the harness threw where nothing declared it could");
          if (fake.fails !== undefined) return Effect.fail(fake.fails);
          contexts.push(ctx);
          const binding: SessionBinding = {
            sessionId,
            nativeSessionId: NATIVE,
            instanceId: INSTANCE,
          };
          held.set(sessionId, binding);
          fake.emit({ _tag: "session.started", eventId: "e-started", sessionId, at });
          return Effect.succeed(binding);
        }),
      sendInput: (sessionId, input): Effect.Effect<SendResult, string> =>
        Effect.suspend(() => {
          if (!held.has(sessionId)) return Effect.fail(`session ${sessionId} is not running here`);
          if (fake.fails !== undefined) return Effect.fail(fake.fails);
          inputs.push(input);
          return Effect.succeed({ turnId: TURN, delivery: "opened" });
        }),
      interrupt: (sessionId, subagentId) =>
        Effect.sync(
          () =>
            void interrupted.push(
              subagentId === undefined ? { sessionId } : { sessionId, subagentId },
            ),
        ),
      /**
       * No session in this fake is really parked: the tests emit request events
       * directly, so there is no harness to pass an answer to. The arguments are
       * recorded, because passing the frame's three fields to the adapter in
       * the right order is the runner's own job.
       */
      respondToApprovalRequest: (sessionId, requestId, decision) =>
        Effect.sync(() => void answered.push([sessionId, requestId, { decision }])),
      respondToQuestion: (sessionId, requestId, answers) =>
        Effect.sync(() => void answered.push([sessionId, requestId, { answers }])),
      /**
       * The exit reason comes from the caller, not from this adapter: the
       * supervisor knows why it stopped a session, and the exit event is the
       * only place that reason can enter the stream.
       */
      stopSession: (sessionId, reason) =>
        Effect.sync(() => {
          stops.push({ sessionId, reason });
          if (fake.stopsSilently) return;
          held.delete(sessionId);
          fake.emit({
            _tag: "session.exited",
            eventId: `e-exited-${String(stops.length)}`,
            sessionId,
            at,
            reason,
          });
        }),
    },
  };
  return fake;
};

/** Builds one connection that records every frame the supervisor sends, in order, on a fresh machine. */
const buildConnection = (fake: Fake) => {
  const under = mkdtempSync(join(tmpdir(), "hercule-supervisor-"));
  roots.push(under);
  const sent: Array<RunnerToController> = [];
  const machine: Machine = {
    providersDir: join(under, "providers"),
    scratchDir: join(under, "scratch"),
    binDir: join(under, "bin"),
    herculeTool: { skill: "# hercule", claudePluginDir: join(under, "claude-plugin") },
    controllerUrl: "https://controller.example:4938",
    baseEnv: { PATH: "/usr/bin" },
    findBinary: (name) => `/usr/local/bin/${name}`,
    workspaces: makeWorkspaces({ storageDir: join(under, "storage") }),
    socketPath: join(under, "daemon.sock"),
  };
  // `makeSupervising` returns the process-wide value, and each connection's
  // supervisor is built from it with `forConnection`. Sessions outlive the
  // socket that started them, and so does the shutdown that stops them all.
  const runner = makeSupervising([fake.adapter]);
  const supervisor = runner.forConnection({
    machine,
    send: (frame) => Effect.sync(() => sent.push(frame)),
  });
  return { supervisor, runner, sent, machine, under };
};

/**
 * How long a wait on the relay may take. This is wall-clock time, not a number
 * of attempts: an attempt takes longer when the machine is busy, so a fixed
 * count would give the shortest wait exactly when the rest of the suite runs
 * alongside. Vitest's test timeout is derived from it, because a wait that
 * outlasts the test timeout never gets to report what it was waiting for.
 */
const WAIT_DEADLINE_MS = 10_000;

/**
 * Three waits, because the longest test waits for the relay to subscribe, then
 * for the result of its body, then for the relay to read past it. A test whose
 * waits can outlast the timeout never gets to report what it was waiting for.
 */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 5_000 });

/** Waits until `ready` returns true. Fails the test, naming `what`, if the deadline passes first. */
const waitUntil = (what: string, ready: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + WAIT_DEADLINE_MS;
    while (!ready() && Date.now() < deadline) yield* Effect.sleep(1);
    expect(ready(), `the relay never ${what}`).toBe(true);
  });

/**
 * Waits until a marker has reached the relay. This is the only reliable sign
 * that a relay has subscribed to the PubSub: `Stream.onStart` fires before the
 * subscription exists, so it would be too early. Because the relay reads the
 * PubSub in order, nothing published before the marker can still be in flight
 * once the marker arrives.
 */
const awaitMarker = (fake: Fake): Effect.Effect<void> =>
  Effect.suspend(() => {
    const before = fake.heard();
    return waitUntil("heard a marker", () => {
      fake.emit(MARKER);
      return fake.heard() > before;
    });
  });

/** Runs `body` with the relay forked beside it, the way a connection runs it. */
const runWithRelay = <A>(
  fake: Fake,
  supervisor: { readonly relay: Effect.Effect<void> },
  body: Effect.Effect<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const relaying = yield* Effect.forkChild(supervisor.relay);
      // Wait for proof, not for a fixed time: `forkChild` returns the fiber
      // before it has run, so a session started now would publish its
      // `session.started` to a PubSub with no subscriber yet.
      yield* awaitMarker(fake);
      const value = yield* body;
      yield* Fiber.interrupt(relaying);
      return value;
    }),
  );

const listSessionEvents = (sent: ReadonlyArray<RunnerToController>): ReadonlyArray<SessionEvent> =>
  sent.filter((frame): frame is SessionEvent => frame._tag === "sessionEvent");

const listInputResults = (
  sent: ReadonlyArray<RunnerToController>,
): ReadonlyArray<SessionInputResult> =>
  sent.filter((frame): frame is SessionInputResult => frame._tag === "sessionInputResult");

/**
 * Checks that the input a start carried was answered once, as refused, with
 * a reason that contains `reason`.
 */
const expectStartInputRefused = (sent: ReadonlyArray<RunnerToController>, reason: string): void => {
  const results = listInputResults(sent);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ requestId: START_REQUEST, ok: false });
  expect(results[0]?.message ?? "").toContain(reason);
};

describe("one session, start to exit", () => {
  it("sends every event under a sequence that only goes up", async () => {
    const fake = createFake();
    const { supervisor, sent, machine } = buildConnection(fake);

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.input({
          _tag: "sessionInput",
          requestId: REQUEST,
          sessionId: SESSION,
          input: { text: "hi" },
        });
        yield* Effect.sync(() =>
          fake.emit({
            _tag: "content.delta",
            eventId: "e-delta",
            sessionId: SESSION,
            at,
            turnId: "t-1",
            itemId: "i-1",
            streamKind: "assistant_text",
            delta: "hello",
          }),
        );
        yield* waitUntil("sent two events", () => listSessionEvents(sent).length === 2);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* waitUntil("sent three events", () => listSessionEvents(sent).length === 3);
      }),
    );

    expect(fake.inputs).toEqual([START_INPUT, { text: "hi" }]);
    const events = listSessionEvents(sent);
    expect(events.map((frame) => frame.event._tag)).toEqual([
      "session.started",
      "content.delta",
      "session.exited",
    ]);
    // The controller inserts each event once, keyed by this number, so the
    // number must never repeat or go backwards.
    expect(events.map((frame) => frame.seq)).toEqual([1, 2, 3]);
    // The harness is handed the scratch cwd and the instance's home, not paths
    // the controller invented.
    expect(fake.contexts[0]?.cwd).toBe(join(machine.scratchDir, SESSION));
    expect(fake.contexts[0]?.home).toBe(join(machine.providersDir, INSTANCE));
    expect(fake.contexts[0]?.binary).toBe("/usr/local/bin/fake-harness");
    expect(fake.contexts[0]?.env["HERCULE_SESSION"]).toBe("1");
    // The credential the session calls Hercule with, carried from the frame the
    // controller sent to the process the adapter spawns, and nowhere else.
    expect(fake.contexts[0]?.env["HERCULE_TOKEN"]).toBe(START.token);
    // And the skill that tells it about Hercule, as this machine prepared it.
    expect(fake.contexts[0]?.herculeTool.claudePluginDir).toBe(machine.herculeTool.claudePluginDir);
  });

  it("reports the sessions it holds, and none once the session has exited", async () => {
    const fake = createFake();
    const { supervisor, sent, machine } = buildConnection(fake);

    const scratch = join(machine.scratchDir, SESSION);
    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.report;
        expect(existsSync(scratch)).toBe(true);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* waitUntil("sent the exit", () =>
          listSessionEvents(sent).some((frame) => frame.event._tag === "session.exited"),
        );
        yield* supervisor.report;
      }),
    );

    const reports = sent.filter((frame) => frame._tag === "sessionsReport");
    // A plain snapshot: each binding links the Hercule session to the harness's own session.
    expect(reports[0]?.sessions).toEqual([
      { sessionId: SESSION, nativeSessionId: NATIVE, instanceId: INSTANCE },
    ]);
    expect(reports[1]?.sessions).toEqual([]);
    // The scratch directory dies with the session it was made for.
    expect(existsSync(scratch)).toBe(false);
  });
});

describe("the input a start carries", () => {
  it("is handed to the harness and answered as delivered, with no input frame after the start", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelay(fake, supervisor, supervisor.start(START));

    expect(fake.inputs).toEqual([START_INPUT]);
    expect(listInputResults(sent)).toEqual([
      { _tag: "sessionInputResult", requestId: START_REQUEST, ok: true, delivery: "opened" },
    ]);
  });

  it("is answered as refused, with a runtime error, when the harness refuses it, and the session runs on", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);
    Object.assign(fake.adapter, {
      sendInput: () => Effect.fail("the harness is not ready for input"),
    });

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* waitUntil("sent two events", () => listSessionEvents(sent).length === 2);
        yield* supervisor.report;
      }),
    );

    expectStartInputRefused(sent, "the harness is not ready for input");
    // The order of these two events on the session's stream is not
    // guaranteed. `session.started` comes through the relay and the error is
    // sent by the start itself, and each is numbered when it is sent. The
    // order is harmless for the controller: a `runtime.error` changes no
    // session status, so it is recorded the same way before or after
    // `session.started`, and the controller learns of the refusal from the
    // `sessionInputResult`, not from either event.
    const events = listSessionEvents(sent).map((frame) => frame.event._tag);
    expect(events).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining(["runtime.error", "session.started"]));
    // The controller's usual rule for a refused input applies to a session
    // that is still running, so the runner must not end it.
    const reports = sent.filter((frame) => frame._tag === "sessionsReport");
    expect(reports[0]?.sessions.map((binding) => binding.sessionId)).toEqual([SESSION]);
  });
});

describe("a start interrupted while its harness is starting", () => {
  it("still hands the harness its input and answers it", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    // Hold the adapter's `startSession` open, so the interrupt arrives once
    // the harness is being started.
    let gateEntered = false;
    let resumeGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resumeGate = resolve;
    });
    const original = fake.adapter.startSession;
    Object.assign(fake.adapter, {
      startSession: (sessionId: string, spec: SessionSpec, ctx: ProviderRunnerContext) => {
        gateEntered = true;
        return Effect.andThen(
          Effect.promise(() => gate),
          original(sessionId, spec, ctx),
        );
      },
    });

    const exit = await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(supervisor.start(START));
        yield* waitUntil("the harness was asked to start", () => gateEntered);
        // Interrupt the start the way a dropped socket does. The interrupt
        // waits for the start to finish, so it runs in its own fiber. That
        // fiber starts at once, so the interrupt is requested before the
        // gate opens, while the harness is still starting.
        yield* Effect.forkChild(Fiber.interrupt(starting), { startImmediately: true });
        resumeGate();
        return yield* Fiber.await(starting);
      }),
    );

    // The start received the interrupt, and still finished first. Without
    // the input, the harness would sit with no turn and no idle wait.
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(fake.inputs).toEqual([START_INPUT]);
    expect(listInputResults(sent)).toEqual([
      { _tag: "sessionInputResult", requestId: START_REQUEST, ok: true, delivery: "opened" },
    ]);
  });
});

describe("a start the controller sends twice", () => {
  it("is a no-op, and leaves the running session its working directory", async () => {
    const fake = createFake();
    const { supervisor, sent, machine } = buildConnection(fake);
    const scratch = join(machine.scratchDir, SESSION);

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* waitUntil("sent the start", () => listSessionEvents(sent).length === 1);
        yield* Effect.sync(() => writeFileSync(join(scratch, "work.txt"), "half a turn"));
        // After a reconnect the controller sends again every command whose work
        // the runner did not report, so a start can arrive twice, and the
        // second must not be destructive (spec 03 section 2.3).
        yield* supervisor.start(START);
        // Wait for the relay to read past the duplicate before counting.
        // Otherwise an event the duplicate wrongly published could still be
        // in flight, and the count below would pass too early.
        yield* awaitMarker(fake);
      }),
    );

    expect(existsSync(join(scratch, "work.txt"))).toBe(true);
    expect(fake.contexts).toHaveLength(1);
    // No second start, and above all no exit for a session that is still running.
    expect(listSessionEvents(sent).map((frame) => frame.event._tag)).toEqual(["session.started"]);
  });

  it("refuses the input the second start carries, instead of handing the harness the same prompt again", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.start(START);
      }),
    );

    expect(fake.inputs).toEqual([START_INPUT]);
    // Both frames carry the same row, and each is answered once.
    expect(listInputResults(sent)).toEqual([
      { _tag: "sessionInputResult", requestId: START_REQUEST, ok: true, delivery: "opened" },
      {
        _tag: "sessionInputResult",
        requestId: START_REQUEST,
        ok: false,
        message: `session ${SESSION} is already running on this runner`,
      },
    ]);
  });
});

describe("an exit that arrives after the id was started again", () => {
  it("leaves the running session its directory and its place in the table", async () => {
    const fake = createFake();
    const { supervisor, sent, machine } = buildConnection(fake);
    const scratch = join(machine.scratchDir, SESSION);

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* waitUntil("sent the start", () => listSessionEvents(sent).length === 1);
        // The exit of an earlier run under the same id, still on its way
        // through the relay when the new one started. The event has the same
        // session id, so only the adapter can tell the two apart.
        yield* Effect.sync(() =>
          fake.emit({
            _tag: "session.exited",
            eventId: "e-old",
            sessionId: SESSION,
            at,
            reason: "process_exit",
          }),
        );
        yield* waitUntil("sent two events", () => listSessionEvents(sent).length === 2);
        yield* supervisor.input({
          _tag: "sessionInput",
          requestId: REQUEST,
          sessionId: SESSION,
          input: { text: "hi" },
        });
      }),
    );

    expect(existsSync(scratch)).toBe(true);
    // Still held, so its input reached the harness rather than a runtime error.
    expect(fake.inputs).toEqual([START_INPUT, { text: "hi" }]);
    expect(listSessionEvents(sent)).toHaveLength(2);
  });
});

describe("a stale exit's release racing a fresh start under the same id", () => {
  it("holds the fresh start until the stale exit is handled, then keeps its entry", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    const originalListSessions = fake.adapter.listSessions;
    const originalStartSession = fake.adapter.startSession;
    let listCalls = 0;
    let releaseEntered = false;
    let resumeRelease: () => void = () => {};
    const releaseGate = new Promise<void>((resolve) => {
      resumeRelease = resolve;
    });
    let startCalls = 0;
    // Whether the stale exit had reached the wire when the fresh start asked
    // the adapter for its harness.
    let staleExitSentBeforeFreshStart: boolean | undefined;

    // The second `listSessions` call comes from `releaseSession`, handling the
    // stale exit. It is held open while a fresh start for the same id
    // arrives. A start that follows a stop must wait until the stopped
    // session's entry is gone, so the fresh start cannot reach the harness
    // while the release is still deciding which entry to remove.
    Object.assign(fake.adapter, {
      listSessions: Effect.suspend(() => {
        listCalls += 1;
        if (listCalls !== 2) return originalListSessions;
        releaseEntered = true;
        return Effect.andThen(
          Effect.promise(() => releaseGate),
          originalListSessions,
        );
      }),
      startSession: (sessionId: string, spec: SessionSpec, ctx: ProviderRunnerContext) => {
        startCalls += 1;
        if (startCalls === 2) {
          staleExitSentBeforeFreshStart = listSessionEvents(sent).length === 2;
        }
        return originalStartSession(sessionId, spec, ctx);
      },
    });

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* waitUntil("sent the start", () => listSessionEvents(sent).length === 1);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* waitUntil("release began checking who is live", () => releaseEntered);
        yield* Effect.forkChild(supervisor.start(START));
        resumeRelease();
        yield* waitUntil("the fresh start finished", () => fake.contexts.length === 2);
        // If `releaseSession` tore down the fresh entry by mistake, this second
        // stop finds no entry and does nothing. The assertion below catches
        // that.
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* waitUntil("the second stop reached the harness", () => fake.stops.length === 2);
      }),
    );

    expect(staleExitSentBeforeFreshStart).toBe(true);
    expect(fake.stops.map((stop) => stop.reason)).toEqual(["stopped", "stopped"]);
  });
});

describe("a start for a session this machine tore down when it exited", () => {
  it("starts it again under the same id, instead of treating it as already running", async () => {
    const fake = createFake();
    const { supervisor, sent, machine } = buildConnection(fake);
    const resumed: SessionStart = {
      ...START,
      spec: { ...SPEC, continue: { nativeSessionId: NATIVE, mode: "resume" } },
    };

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* waitUntil("sent the start", () => listSessionEvents(sent).length === 1);
        // The harness ends on its own, the way an idle one is unloaded: the
        // adapter stops holding the session and emits its exit.
        yield* fake.adapter.stopSession(SESSION, "process_exit");
        yield* waitUntil("sent the exit", () => listSessionEvents(sent).length === 2);
        yield* supervisor.start(resumed);
        yield* waitUntil("sent the second start", () => listSessionEvents(sent).length === 3);
      }),
    );

    expect(listSessionEvents(sent).map((frame) => frame.event._tag)).toEqual([
      "session.started",
      "session.exited",
      "session.started",
    ]);
    expect(fake.contexts).toHaveLength(2);
    expect(existsSync(join(machine.scratchDir, SESSION))).toBe(true);
  });
});

describe("a session that ended while the socket was down", () => {
  it("is started afresh rather than taken for one that is still running", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelay(
      fake,
      supervisor,
      Effect.flatMap(supervisor.start(START), () =>
        waitUntil("sent the start", () => listSessionEvents(sent).length === 1),
      ),
    );
    // The harness ends between connections. No relay is running, so its exit
    // reaches no controller, and the supervisor's entry outlives the session.
    // Nothing sends the exit again, because there is no outbox.
    await Effect.runPromise(fake.adapter.stopSession(SESSION, "stopped"));
    await runWithRelay(
      fake,
      supervisor,
      Effect.flatMap(supervisor.start(START), () =>
        waitUntil("sent the second start", () => listSessionEvents(sent).length === 2),
      ),
    );

    expect(fake.contexts).toHaveLength(2);
    expect(listSessionEvents(sent).map((frame) => frame.event._tag)).toEqual([
      "session.started",
      "session.started",
    ]);
  });
});

describe("a session that cannot run here", () => {
  it("ends a session whose adapter failed to start it, instead of leaving it starting forever", async () => {
    const fake = createFake();
    fake.fails = "no fake-harness on this machine";
    const { supervisor, sent, machine } = buildConnection(fake);

    await runWithRelay(fake, supervisor, supervisor.start(START));

    const events = listSessionEvents(sent).map((frame) => frame.event);
    expect(events.map((event) => event._tag)).toEqual(["runtime.error", "session.exited"]);
    expect(events[0]).toMatchObject({
      class: "unknown",
      message: "no fake-harness on this machine",
    });
    // Not `stopped`: nobody asked for this, and there is nothing to resume.
    expect(events[1]).toMatchObject({ reason: "crash" });
    // And nothing of it is left on disk.
    expect(existsSync(join(machine.scratchDir, SESSION))).toBe(false);
    // The input never reached a harness, and the controller is told so.
    expect(fake.inputs).toEqual([]);
    expectStartInputRefused(sent, "no fake-harness on this machine");
    // The answer comes before the exit, so the controller has it before the
    // exit closes the session.
    expect(sent.findIndex((frame) => frame._tag === "sessionInputResult")).toBeLessThan(
      sent.findIndex(
        (frame) => frame._tag === "sessionEvent" && frame.event._tag === "session.exited",
      ),
    );
  });

  it("ends a start whose output schema is outside the subset, before any harness is asked", async () => {
    const fake = createFake();
    const { supervisor, sent, machine } = buildConnection(fake);

    await runWithRelay(
      fake,
      supervisor,
      supervisor.start({
        ...START,
        // This schema is valid JSON but outside the subset the three
        // harnesses agree on. The controller lints the schema too, so a frame
        // like this means the controller and the runner disagree about which
        // schemas are allowed.
        spec: { ...SPEC, outputSchema: { type: "object", properties: {}, minProperties: 1 } },
      }),
    );

    const events = listSessionEvents(sent).map((frame) => frame.event);
    expect(events.map((event) => event._tag)).toEqual(["runtime.error", "session.exited"]);
    expect(events[0]).toMatchObject({
      message: expect.stringContaining("minProperties") as string,
    });
    expect(events[1]).toMatchObject({ reason: "crash" });
    // The adapter was never asked for a harness, and nothing was written to disk.
    expect(fake.contexts).toEqual([]);
    expect(existsSync(join(machine.scratchDir, SESSION))).toBe(false);
    expectStartInputRefused(sent, "minProperties");
  });

  it("ends a start for a provider this build has no adapter for", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelay(fake, supervisor, supervisor.start({ ...START, providerId: "codex" }));

    const events = listSessionEvents(sent).map((frame) => frame.event);
    expect(events[0]).toMatchObject({ message: "no adapter for codex in this runner build" });
    expect(events[1]).toMatchObject({ _tag: "session.exited", reason: "crash" });
    expectStartInputRefused(sent, "no adapter for codex in this runner build");
  });

  it("reports a defect on the session instead of letting it end the connection", async () => {
    const fake = createFake();
    const { supervisor, sent, machine } = buildConnection(fake);
    fake.dies = true;

    await runWithRelay(fake, supervisor, supervisor.start(START));

    // Every other frame handler on this connection catches its own defects. A
    // start that did not would leave the controller waiting in `starting`
    // forever.
    const events = listSessionEvents(sent).map((frame) => frame.event);
    expect(events.map((event) => event._tag)).toEqual(["runtime.error", "session.exited"]);
    // And it left nothing behind: neither the directory nor an entry that
    // would make the next start for this session look like a duplicate.
    expect(existsSync(join(machine.scratchDir, SESSION))).toBe(false);
    expectStartInputRefused(sent, "the harness threw where nothing declared it could");
  });

  it("ends a start whose context cannot be prepared, before any harness is asked", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);
    const workspaceId = "0199e0e7-0000-7000-8000-0000000000ee";

    await runWithRelay(
      fake,
      supervisor,
      // A workspace this runner does not hold, so the session has nowhere to run.
      supervisor.start({ ...START, spec: { ...SPEC, workspaceId } }),
    );

    const events = listSessionEvents(sent).map((frame) => frame.event);
    expect(events.map((event) => event._tag)).toEqual(["runtime.error", "session.exited"]);
    expect(events[1]).toMatchObject({ reason: "crash" });
    expect(fake.contexts).toEqual([]);
    expectStartInputRefused(sent, `this runner does not hold workspace ${workspaceId}`);
  });

  it("reports input for a session it does not hold as lost, and ignores a stop for one", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.input({
          _tag: "sessionInput",
          requestId: REQUEST,
          sessionId: SESSION,
          input: { text: "hi" },
        });
        // Commands are idempotent across a reconnect: a session this runner
        // does not hold has already exited and already sent its exit.
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
      }),
    );

    const events = listSessionEvents(sent).map((frame) => frame.event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ _tag: "runtime.error", sessionId: SESSION });
    // The controller waits for the result under the row's id, and a reason it
    // can show is better than a bare flag.
    expect(listInputResults(sent)).toHaveLength(1);
    expect(listInputResults(sent)[0]).toMatchObject({ requestId: REQUEST, ok: false });
    expect(listInputResults(sent)[0]?.message ?? "").toContain(SESSION);
    expect(listInputResults(sent)[0]?.delivery).toBeUndefined();
  });
});

describe("what the runner sends back for input, interrupts and answers", () => {
  it("reports a delivered input with the delivery the adapter returned", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.input({
          _tag: "sessionInput",
          requestId: REQUEST,
          sessionId: SESSION,
          input: { text: "hi" },
        });
      }),
    );

    expect(fake.inputs).toEqual([START_INPUT, { text: "hi" }]);
    expect(listInputResults(sent)).toEqual([
      { _tag: "sessionInputResult", requestId: START_REQUEST, ok: true, delivery: "opened" },
      { _tag: "sessionInputResult", requestId: REQUEST, ok: true, delivery: "opened" },
    ]);
  });

  it("ends the running turn for a session it holds, and nothing for one it does not", async () => {
    const fake = createFake();
    const { supervisor } = buildConnection(fake);

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.interrupt({ _tag: "sessionInterrupt", sessionId: SESSION });
        yield* supervisor.interrupt({
          _tag: "sessionInterrupt",
          sessionId: "0199e0e7-0000-7000-8000-0000000000aa",
        });
      }),
    );

    expect(fake.interrupted).toEqual([{ sessionId: SESSION }]);
  });

  it("passes the subagent an interrupt names to the adapter", async () => {
    const fake = createFake();
    const { supervisor } = buildConnection(fake);

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.interrupt({
          _tag: "sessionInterrupt",
          sessionId: SESSION,
          subagentId: SUBAGENT,
        });
      }),
    );

    // The adapter, not the runner, stops the subagents below this one: only
    // the adapter knows them.
    expect(fake.interrupted).toEqual([{ sessionId: SESSION, subagentId: SUBAGENT }]);
  });

  it("passes a decision to the adapter for a session it holds, and ignores one it does not", async () => {
    const fake = createFake();
    const { supervisor } = buildConnection(fake);

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.respondToApprovalRequest({
          _tag: "sessionRespondToApprovalRequest",
          sessionId: SESSION,
          requestId: PARK,
          decision: "allow_always",
        });
        yield* supervisor.respondToApprovalRequest({
          _tag: "sessionRespondToApprovalRequest",
          sessionId: "0199e0e7-0000-7000-8000-0000000000aa",
          requestId: PARK,
          decision: "deny",
        });
      }),
    );

    expect(fake.answered).toEqual([[SESSION, PARK, { decision: "allow_always" }]]);
  });

  it("passes answers to a question to the adapter as answers", async () => {
    const fake = createFake();
    const { supervisor } = buildConnection(fake);
    const answers = { Storage: "localStorage", Features: ["Sync", "Search"] } as const;

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.respondToQuestion({
          _tag: "sessionRespondToQuestion",
          sessionId: SESSION,
          requestId: PARK,
          answers,
        });
      }),
    );

    expect(fake.answered).toEqual([[SESSION, PARK, { answers }]]);
  });
});

/**
 * Like `runWithRelay`, but with the test clock in place of the wall clock. Only
 * the two supervision timers read the test clock. Every wait on the relay stays
 * on the wall clock, because it waits for another fiber to run, and moving
 * virtual time does not make that happen.
 */
const runWithRelayOnTestClock = <A>(
  fake: Fake,
  supervisor: { readonly relay: Effect.Effect<void> },
  body: Effect.Effect<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const relaying = yield* Effect.forkChild(supervisor.relay);
        yield* TestClock.withLive(awaitMarker(fake));
        const value = yield* body;
        yield* Fiber.interrupt(relaying);
        return value;
      }),
      TestClock.layer(),
    ),
  );

/** Waits on the relay using the wall clock, while the test clock drives the timers. */
const waitOnWallClock = (what: string, ready: () => boolean): Effect.Effect<void> =>
  TestClock.withLive(waitUntil(what, ready));

/**
 * Waits until the relay has sent at least `count` session events. The relay
 * updates the inactivity clock and sends the event in one step, so once the
 * frame is seen, the clock is already set.
 */
const awaitForwarded = (
  sent: ReadonlyArray<RunnerToController>,
  count: number,
): Effect.Effect<void> =>
  waitOnWallClock(`sent ${String(count)} events`, () => listSessionEvents(sent).length >= count);

/**
 * Returns the field that attributes an event to `subagentId`, or no field for
 * the session's own agent.
 */
const attributeTo = (subagentId: string | undefined) =>
  subagentId === undefined ? {} : { subagentId };

const emitTurnStarted = (fake: Fake, turnId: string, subagentId?: string): void =>
  fake.emit({
    _tag: "turn.started",
    eventId: `e-${turnId}-started`,
    sessionId: SESSION,
    at,
    turnId,
    ...attributeTo(subagentId),
  });

const emitTurnCompleted = (fake: Fake, turnId: string, subagentId?: string): void =>
  fake.emit({
    _tag: "turn.completed",
    eventId: `e-${turnId}-done`,
    sessionId: SESSION,
    at,
    turnId,
    state: "completed",
    ...attributeTo(subagentId),
  });

const emitDelta = (fake: Fake, id: string): void =>
  fake.emit({
    _tag: "content.delta",
    eventId: `e-${id}`,
    sessionId: SESSION,
    at,
    turnId: "t-1",
    itemId: "i-1",
    streamKind: "assistant_text",
    delta: "still here",
  });

/** Lists the reasons of the exits sent to the controller, in order. */
const listExitReasons = (sent: ReadonlyArray<RunnerToController>): ReadonlyArray<string> =>
  listSessionEvents(sent)
    .map((frame) => frame.event)
    .filter((event) => event._tag === "session.exited")
    .map((event) => (event as { readonly reason: string }).reason);

describe("a harness that goes silent mid-turn", () => {
  it("is stopped with inactivity_timeout as the exit reason", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        // `session.started` and `turn.started`. The second one starts the
        // inactivity clock as it passes through the relay.
        yield* awaitForwarded(sent, 2);

        yield* TestClock.adjust(INACTIVITY_MS);
        // Wait for the exit frame itself, not only for the stop request to the
        // adapter: the two can be several ticks apart in the relay.
        yield* awaitForwarded(sent, 3);
      }),
    );

    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "inactivity_timeout" }]);
    // The reason reaches the controller in the only way it can: on the
    // adapter's exit event, forwarded like any other event.
    expect(listExitReasons(sent)).toEqual(["inactivity_timeout"]);
  });

  it("restarts the wait on any event of that session", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        yield* awaitForwarded(sent, 2);

        yield* TestClock.adjust(INACTIVITY_MS - 1);
        yield* Effect.sync(() => emitDelta(fake, "d-1"));
        yield* awaitForwarded(sent, 3);

        // The first wait would have expired now. Nothing happens, because the
        // delta a millisecond earlier restarted the wait.
        yield* TestClock.adjust(1);
        expect(fake.stops).toEqual([]);

        yield* TestClock.adjust(INACTIVITY_MS - 2);
        expect(fake.stops).toEqual([]);

        yield* TestClock.adjust(1);
        yield* waitOnWallClock("stopped the session", () => fake.stops.length === 1);
      }),
    );

    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "inactivity_timeout" }]);
  });

  it("is left alone once the turn has completed, however long the silence", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        yield* awaitForwarded(sent, 2);
        yield* Effect.sync(() => emitTurnCompleted(fake, "t-1"));
        yield* awaitForwarded(sent, 3);

        // An idle session is not stuck: it is waiting for its user, and only
        // the absolute deadline may end it.
        yield* TestClock.adjust(ABSOLUTE_MS - 1);
      }),
    );

    expect(fake.stops).toEqual([]);
    expect(listExitReasons(sent)).toEqual([]);
  });

  it("is watched again from the next turn the harness opens", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        yield* awaitForwarded(sent, 2);
        yield* Effect.sync(() => emitTurnCompleted(fake, "t-1"));
        yield* awaitForwarded(sent, 3);
        yield* TestClock.adjust(INACTIVITY_MS * 2);

        yield* Effect.sync(() => emitTurnStarted(fake, "t-2"));
        yield* awaitForwarded(sent, 4);
        yield* TestClock.adjust(INACTIVITY_MS);
        yield* awaitForwarded(sent, 5);
      }),
    );

    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "inactivity_timeout" }]);
    expect(listExitReasons(sent)).toEqual(["inactivity_timeout"]);
  });
});

/**
 * Emits a `request.opened`. A session parked on an open request is waiting for
 * its user, not stuck, so the inactivity clock must not run while the request
 * is open.
 */
const emitRequestOpened = (fake: Fake, requestId: string, subagentId?: string): void =>
  fake.emit({
    _tag: "request.opened",
    eventId: `e-${requestId}-opened`,
    sessionId: SESSION,
    at,
    ...attributeTo(subagentId),
    request: {
      requestId,
      itemId: "i-1",
      kind: "command_approval",
      decisions: ["allow", "allow_always", "deny", "cancel"],
      detail: { command: "ls -la" },
    },
  });

const emitRequestResolved = (fake: Fake, requestId: string, subagentId?: string): void =>
  fake.emit({
    _tag: "request.resolved",
    eventId: `e-${requestId}-resolved`,
    sessionId: SESSION,
    at,
    requestId,
    decision: "allow",
    ...attributeTo(subagentId),
  });

/**
 * One of the four events that decide whether the inactivity clock runs: its
 * tag, the turn or request id it carries, and the subagent it belongs to,
 * when it is not the session's own agent's.
 */
type Step = readonly [
  tag: "turn.started" | "request.opened" | "request.resolved" | "turn.completed",
  id: string,
  subagentId?: string,
];

const emitStep = (fake: Fake, [tag, id, subagentId]: Step): void => {
  if (tag === "turn.started") return emitTurnStarted(fake, id, subagentId);
  if (tag === "turn.completed") return emitTurnCompleted(fake, id, subagentId);
  if (tag === "request.opened") return emitRequestOpened(fake, id, subagentId);
  return emitRequestResolved(fake, id, subagentId);
};

/** Describes a step for a test name, such as `request.opened r-1 (agent-1)`. */
const describeStep = ([tag, id, subagentId]: Step): string =>
  subagentId === undefined ? `${tag} ${id}` : `${tag} ${id} (${subagentId})`;

describe("a session parked on an open request", () => {
  /**
   * Listed by hand rather than generated: the repo has no property-testing
   * library, and whether the clock runs depends only on the open turns and
   * the open Requests, so the sequences that change either are few enough to
   * list.
   */
  const SEQUENCES: ReadonlyArray<readonly [ReadonlyArray<Step>, boolean]> = [
    [[["turn.started", "t-1"]], true],
    [
      [
        ["turn.started", "t-1"],
        ["request.opened", "r-1"],
      ],
      false,
    ],
    [
      [
        ["turn.started", "t-1"],
        ["request.opened", "r-1"],
        ["request.resolved", "r-1"],
      ],
      true,
    ],
    [
      [
        ["turn.started", "t-1"],
        ["request.opened", "r-1"],
        ["turn.completed", "t-1"],
      ],
      false,
    ],
    // The clock that the open request stopped is gone, not leaked: the next
    // turn is watched as usual and the session is stopped once.
    [
      [
        ["turn.started", "t-1"],
        ["request.opened", "r-1"],
        ["turn.completed", "t-1"],
        ["turn.started", "t-2"],
      ],
      true,
    ],
    [
      [
        ["turn.started", "t-1"],
        ["request.opened", "r-1"],
        ["request.resolved", "r-1"],
        ["turn.completed", "t-1"],
      ],
      false,
    ],
    [
      [
        ["turn.started", "t-1"],
        ["turn.completed", "t-1"],
        ["turn.started", "t-2"],
      ],
      true,
    ],
    // Every Request is reported at once and closes on its own, so one
    // resolution leaves the other Request open.
    [
      [
        ["turn.started", "t-1"],
        ["request.opened", "r-1"],
        ["request.opened", "r-2"],
        ["request.resolved", "r-1"],
      ],
      false,
    ],
    [
      [
        ["turn.started", "t-1"],
        ["request.opened", "r-1"],
        ["request.opened", "r-2"],
        ["request.resolved", "r-1"],
        ["request.resolved", "r-2"],
      ],
      true,
    ],
    [
      [
        ["turn.started", "t-1"],
        ["request.opened", "r-1"],
        ["request.resolved", "r-1"],
        ["request.opened", "r-2"],
      ],
      false,
    ],
    // One agent's turn ending does not close another agent's turn.
    [
      [
        ["turn.started", "t-1"],
        ["turn.started", "t-2", SUBAGENT],
        ["turn.completed", "t-1"],
      ],
      true,
    ],
    [
      [
        ["turn.started", "t-1"],
        ["turn.started", "t-2", SUBAGENT],
        ["turn.completed", "t-2", SUBAGENT],
      ],
      true,
    ],
    [
      [
        ["turn.started", "t-1"],
        ["turn.started", "t-2", SUBAGENT],
        ["turn.completed", "t-1"],
        ["turn.completed", "t-2", SUBAGENT],
      ],
      false,
    ],
    // A subagent waiting on its user pauses the clock like the session's own
    // agent does, and its Request closes with its own turn only.
    [
      [
        ["turn.started", "t-1"],
        ["turn.started", "t-2", SUBAGENT],
        ["request.opened", "r-1", SUBAGENT],
      ],
      false,
    ],
    [
      [
        ["turn.started", "t-1"],
        ["turn.started", "t-2", SUBAGENT],
        ["request.opened", "r-1", SUBAGENT],
        ["turn.completed", "t-1"],
      ],
      false,
    ],
    [
      [
        ["turn.started", "t-1"],
        ["turn.started", "t-2", SUBAGENT],
        ["request.opened", "r-1", SUBAGENT],
        ["turn.completed", "t-2", SUBAGENT],
      ],
      true,
    ],
    [
      [
        ["turn.started", "t-1"],
        ["request.opened", "r-1"],
        ["turn.started", "t-2", SUBAGENT],
        ["request.opened", "r-2", SUBAGENT],
        ["turn.completed", "t-2", SUBAGENT],
      ],
      false,
    ],
  ];

  for (const [sequence, armed] of SEQUENCES) {
    const steps = sequence.map(describeStep).join(" -> ");
    it(`is ${armed ? "watched" : "left alone"} after ${steps}`, async () => {
      const fake = createFake();
      const { supervisor, sent } = buildConnection(fake);

      await runWithRelayOnTestClock(
        fake,
        supervisor,
        Effect.gen(function* () {
          yield* supervisor.start(START);
          // Send one event at a time and wait for its frame. The relay updates
          // the clock and sends the event in one step, so once the frame is
          // seen, the clock is already set.
          let count = 1;
          for (const step of sequence) {
            count += 1;
            yield* Effect.sync(() => emitStep(fake, step));
            yield* awaitForwarded(sent, count);
          }

          yield* TestClock.adjust(INACTIVITY_MS);
          // Wait for the exit frame itself, not only for the stop request to
          // the adapter: the two are several ticks apart in the relay.
          if (armed)
            yield* waitOnWallClock("sent the exit", () => listExitReasons(sent).length === 1);
        }),
      );

      expect(fake.stops).toEqual(
        armed ? [{ sessionId: SESSION, reason: "inactivity_timeout" }] : [],
      );
      expect(listExitReasons(sent)).toEqual(armed ? ["inactivity_timeout"] : []);
    });
  }
});

describe("a session that has run for as long as it may", () => {
  it("is stopped at the absolute deadline, mid-turn and with events still arriving", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        yield* awaitForwarded(sent, 2);

        // A busy session that never hits the inactivity timeout: an event
        // every half of the inactivity timeout, until the absolute deadline.
        const step = Math.floor(INACTIVITY_MS / 2);
        let elapsed = 0;
        let count = 2;
        while (elapsed + step < ABSOLUTE_MS) {
          yield* TestClock.adjust(step);
          elapsed += step;
          count += 1;
          yield* Effect.sync(() => emitDelta(fake, `d-${String(count)}`));
          yield* awaitForwarded(sent, count);
          expect(fake.stops, `at ${String(elapsed)}ms`).toEqual([]);
        }

        yield* TestClock.adjust(ABSOLUTE_MS - elapsed);
        yield* waitOnWallClock("stopped the session", () => fake.stops.length === 1);
      }),
    );

    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "absolute_timeout" }]);
    expect(listExitReasons(sent)).toEqual(["absolute_timeout"]);
  });

  it("is not stopped at all when it ended before the deadline", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* awaitForwarded(sent, 1);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* awaitForwarded(sent, 2);

        // Both timers end with the session. A timer still running here would
        // stop a session that is already gone, or the next one with its id.
        yield* TestClock.adjust(ABSOLUTE_MS * 2);
      }),
    );

    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "stopped" }]);
    expect(listExitReasons(sent)).toEqual(["stopped"]);
  });

  it("gives a session started again under the same id its own deadline", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* awaitForwarded(sent, 1);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* awaitForwarded(sent, 2);

        yield* TestClock.adjust(ABSOLUTE_MS / 2);
        yield* supervisor.start(START);
        yield* awaitForwarded(sent, 3);

        // The first session's deadline, which this one must not inherit.
        yield* TestClock.adjust(ABSOLUTE_MS / 2);
        expect(fake.stops).toHaveLength(1);

        yield* TestClock.adjust(ABSOLUTE_MS / 2);
        yield* waitOnWallClock("stopped the second session", () => fake.stops.length === 2);
      }),
    );

    expect(fake.stops).toEqual([
      { sessionId: SESSION, reason: "stopped" },
      { sessionId: SESSION, reason: "absolute_timeout" },
    ]);
  });
});

/**
 * Tests the idle unload: a session that sits between turns for `idleMs` is
 * stopped with `idle_unload`, which leaves its native state behind so it can
 * be resumed later. The timer is generic. The session here is a plain one,
 * with no conversation or assistant anywhere in its spec: the runner knows
 * nothing about why a spec carries `idleMs`.
 */
const IDLE_MS = 60_000;

const IDLE_START: SessionStart = {
  ...START,
  spec: { ...SPEC, timeouts: { ...SPEC.timeouts, idleMs: IDLE_MS } },
};

describe("a session that sits idle between turns", () => {
  it("is stopped with idle_unload once idleMs has passed since its turn completed", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(IDLE_START);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        yield* awaitForwarded(sent, 2);
        yield* Effect.sync(() => emitTurnCompleted(fake, "t-1"));
        yield* awaitForwarded(sent, 3);

        yield* TestClock.adjust(IDLE_MS - 1);
        expect(fake.stops).toEqual([]);

        yield* TestClock.adjust(1);
        yield* waitOnWallClock("sent the exit", () => listExitReasons(sent).length === 1);
      }),
    );

    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "idle_unload" }]);
    expect(listExitReasons(sent)).toEqual(["idle_unload"]);
  });

  it("is not unloaded while its start input's turn is reported late, and is unloaded idleMs after that turn completes", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        // A resumed session hands its harness the input at once. Its turn may
        // be reported much later, for example while the controller is busy
        // with other sessions' events, and nothing may unload the session in
        // that gap: the input would be lost with the harness.
        yield* supervisor.start(IDLE_START);
        yield* awaitForwarded(sent, 1);
        yield* TestClock.adjust(IDLE_MS * 10);
        expect(fake.stops).toEqual([]);

        // The turn the input opened arms the wait once it completes, as any
        // turn does.
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        yield* awaitForwarded(sent, 2);
        yield* Effect.sync(() => emitTurnCompleted(fake, "t-1"));
        yield* awaitForwarded(sent, 3);
        yield* TestClock.adjust(IDLE_MS);
        yield* waitOnWallClock("sent the exit", () => listExitReasons(sent).length === 1);
      }),
    );

    expect(fake.inputs).toEqual([START_INPUT]);
    expect(listExitReasons(sent)).toEqual(["idle_unload"]);
  });

  it("is stopped with idle_unload once idleMs has passed since its harness refused the start input", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);
    Object.assign(fake.adapter, {
      sendInput: () => Effect.fail("the harness is not ready for input"),
    });

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        // The refused input opens no turn, so the session is idle from the
        // refusal on, and nothing else would ever end it.
        yield* supervisor.start(IDLE_START);
        yield* TestClock.adjust(IDLE_MS - 1);
        expect(fake.stops).toEqual([]);

        yield* TestClock.adjust(1);
        yield* waitOnWallClock("sent the exit", () => listExitReasons(sent).length === 1);
      }),
    );

    expect(listInputResults(sent)).toEqual([
      {
        _tag: "sessionInputResult",
        requestId: START_REQUEST,
        ok: false,
        message: "the harness is not ready for input",
      },
    ]);
    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "idle_unload" }]);
    expect(listExitReasons(sent)).toEqual(["idle_unload"]);
  });

  it("is kept by an input frame, and waits idleMs again after the turn that input opened", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(IDLE_START);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        yield* awaitForwarded(sent, 2);
        yield* Effect.sync(() => emitTurnCompleted(fake, "t-1"));
        yield* awaitForwarded(sent, 3);

        yield* TestClock.adjust(IDLE_MS / 2);
        yield* supervisor.input({
          _tag: "sessionInput",
          requestId: REQUEST,
          sessionId: SESSION,
          input: { text: "still there?" },
        });

        // The first timer would fire now. The harness has not opened the new
        // turn yet, so only the input frame can have cancelled the timer.
        yield* TestClock.adjust(IDLE_MS / 2);
        expect(fake.stops).toEqual([]);

        yield* Effect.sync(() => emitTurnStarted(fake, "t-2"));
        yield* awaitForwarded(sent, 4);
        yield* Effect.sync(() => emitTurnCompleted(fake, "t-2"));
        yield* awaitForwarded(sent, 5);

        yield* TestClock.adjust(IDLE_MS - 1);
        expect(fake.stops).toEqual([]);

        yield* TestClock.adjust(1);
        yield* waitOnWallClock("sent the exit", () => listExitReasons(sent).length === 1);
      }),
    );

    expect(fake.inputs).toEqual([START_INPUT, { text: "still there?" }]);
    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "idle_unload" }]);
    expect(listExitReasons(sent)).toEqual(["idle_unload"]);
  });

  it("waits idleMs again after its harness refuses an input frame", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(IDLE_START);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        yield* awaitForwarded(sent, 2);
        yield* Effect.sync(() => emitTurnCompleted(fake, "t-1"));
        yield* awaitForwarded(sent, 3);

        // The input frame cancels the wait, and the refused input opens no
        // turn, so the session is idle again from the refusal on.
        yield* TestClock.adjust(IDLE_MS / 2);
        fake.fails = "the harness is busy";
        yield* supervisor.input({
          _tag: "sessionInput",
          requestId: REQUEST,
          sessionId: SESSION,
          input: { text: "still there?" },
        });

        yield* TestClock.adjust(IDLE_MS - 1);
        expect(fake.stops).toEqual([]);

        yield* TestClock.adjust(1);
        yield* waitOnWallClock("sent the exit", () => listExitReasons(sent).length === 1);
      }),
    );

    expect(fake.inputs).toEqual([START_INPUT]);
    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "idle_unload" }]);
    expect(listExitReasons(sent)).toEqual(["idle_unload"]);
  });

  it("does not wait idleMs again after an input is refused while the session is stopping", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(IDLE_START);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        yield* awaitForwarded(sent, 2);
        yield* Effect.sync(() => emitTurnCompleted(fake, "t-1"));
        yield* awaitForwarded(sent, 3);

        // The harness takes the stop and is slow to exit, and an input that
        // arrives in that time is refused. The session is on its way out, so
        // the refusal must not give it a new idle wait.
        fake.stopsSilently = true;
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* supervisor.input({
          _tag: "sessionInput",
          requestId: REQUEST,
          sessionId: SESSION,
          input: { text: "still there?" },
        });

        yield* TestClock.adjust(IDLE_MS * 2);
      }),
    );

    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "stopped" }]);
    expect(listInputResults(sent).at(-1)).toMatchObject({ requestId: REQUEST, ok: false });
    expect(listInputResults(sent).at(-1)?.message).toContain("is stopping");
    // The harness was never handed the input.
    expect(fake.inputs).toEqual([START_INPUT]);
  });

  it("is left alone while parked on a permission request, however long it waits", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(IDLE_START);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        yield* awaitForwarded(sent, 2);
        yield* Effect.sync(() => emitRequestOpened(fake, "r-1"));
        yield* awaitForwarded(sent, 3);

        // A user who takes their time to answer does not lose the session.
        yield* TestClock.adjust(IDLE_MS * 100);
        expect(fake.stops).toEqual([]);

        // Once the request is answered and the turn is over, the timer runs.
        // Without this part, the test would also pass with no timer at all.
        yield* Effect.sync(() => emitRequestResolved(fake, "r-1"));
        yield* awaitForwarded(sent, 4);
        yield* Effect.sync(() => emitTurnCompleted(fake, "t-1"));
        yield* awaitForwarded(sent, 5);
        yield* TestClock.adjust(IDLE_MS);
        yield* waitOnWallClock("sent the exit", () => listExitReasons(sent).length === 1);
      }),
    );

    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "idle_unload" }]);
    expect(listExitReasons(sent)).toEqual(["idle_unload"]);
  });

  it("is not unloaded while a subagent's turn is open after the session's own turn ended", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(IDLE_START);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        yield* awaitForwarded(sent, 2);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-2", SUBAGENT));
        yield* awaitForwarded(sent, 3);
        // A background subagent goes on working after the session's own turn.
        yield* Effect.sync(() => emitTurnCompleted(fake, "t-1"));
        yield* awaitForwarded(sent, 4);

        yield* TestClock.adjust(IDLE_MS * 2);
        expect(fake.stops).toEqual([]);

        // The wait starts once the last open turn of any agent has ended.
        yield* Effect.sync(() => emitTurnCompleted(fake, "t-2", SUBAGENT));
        yield* awaitForwarded(sent, 5);
        yield* TestClock.adjust(IDLE_MS - 1);
        expect(fake.stops).toEqual([]);

        yield* TestClock.adjust(1);
        yield* waitOnWallClock("sent the exit", () => listExitReasons(sent).length === 1);
      }),
    );

    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "idle_unload" }]);
    expect(listExitReasons(sent)).toEqual(["idle_unload"]);
  });

  it("is kept by a subagent's turn that starts while it waits", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(IDLE_START);
        yield* awaitForwarded(sent, 1);

        // A subagent wakes by itself, for example when its background shell
        // finishes, with no input from the user.
        yield* TestClock.adjust(IDLE_MS / 2);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1", SUBAGENT));
        yield* awaitForwarded(sent, 2);
        yield* TestClock.adjust(IDLE_MS);
        expect(fake.stops).toEqual([]);
      }),
    );

    expect(fake.stops).toEqual([]);
  });

  it("is never unloaded when its spec has no idleMs", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        yield* awaitForwarded(sent, 2);
        yield* Effect.sync(() => emitTurnCompleted(fake, "t-1"));
        yield* awaitForwarded(sent, 3);

        // Up to the absolute deadline, which is the only limit left.
        yield* TestClock.adjust(ABSOLUTE_MS - 1);
      }),
    );

    expect(fake.stops).toEqual([]);
    expect(listExitReasons(sent)).toEqual([]);
  });
});

/**
 * Tests what an announced shutdown does to the sessions this runner holds.
 *
 * A runner that goes away without stopping its harnesses leaves orphan
 * processes behind, and sessions the controller believes are busy. So these
 * tests check two things:
 *
 * - `shutdown` does not return until the exit of every session it stopped has
 *   been sent, because the caller closes the socket as soon as it returns;
 * - `shutdown` still returns when a harness will not exit.
 */

/** A second session, so a shutdown has more than one session to stop. */
const OTHER_SESSION = "0199e0e7-0000-7000-8000-0000000000ef";

const OTHER_START: SessionStart = { ...START, sessionId: OTHER_SESSION };

/**
 * The longest a shutdown may take with a harness that never exits. This is
 * generous compared to the few seconds the shutdown waits: the test checks that
 * the wait ends, not the exact limit the implementation chose.
 */
const SHUTDOWN_BUDGET_MS = 20_000;

const sortStopsBySession = (fake: Fake): ReadonlyArray<{ sessionId: string; reason: ExitReason }> =>
  [...fake.stops].sort((one, other) => one.sessionId.localeCompare(other.sessionId));

describe("an announced shutdown", () => {
  it("stops every live session with runner_restart, and sends their exits before it returns", async () => {
    const fake = createFake();
    const { supervisor, runner, sent } = buildConnection(fake);

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.start(OTHER_START);
        yield* waitUntil("sent both sessions' starts", () => listSessionEvents(sent).length === 2);

        yield* runner.shutdown("runner_restart");

        // Check as soon as it returns, without waiting: the caller closes the
        // socket next, and the controller would never see an exit that is
        // still in flight.
        expect(listExitReasons(sent)).toEqual(["runner_restart", "runner_restart"]);
      }),
    );

    expect(sortStopsBySession(fake)).toEqual([
      { sessionId: OTHER_SESSION, reason: "runner_restart" },
      { sessionId: SESSION, reason: "runner_restart" },
    ]);
  });

  it("still returns when a harness accepts the stop and never exits", async () => {
    const fake = createFake();
    const { supervisor, runner, sent } = buildConnection(fake);

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.start(OTHER_START);
        yield* waitUntil("sent both sessions' starts", () => listSessionEvents(sent).length === 2);
        yield* Effect.sync(() => {
          fake.stopsSilently = true;
        });

        const returned = yield* Effect.raceFirst(
          Effect.as(runner.shutdown("runner_restart"), true),
          Effect.as(Effect.sleep(Duration.millis(SHUTDOWN_BUDGET_MS)), false),
        );

        expect(returned, "the shutdown kept waiting for a harness that never exited").toBe(true);
        // Both harnesses were asked to stop, and neither sent an exit.
        expect(listExitReasons(sent)).toEqual([]);
      }),
    );

    expect(sortStopsBySession(fake)).toEqual([
      { sessionId: OTHER_SESSION, reason: "runner_restart" },
      { sessionId: SESSION, reason: "runner_restart" },
    ]);
  });

  it("ignores a start the controller sends after it", async () => {
    const fake = createFake();
    const { supervisor, runner, sent } = buildConnection(fake);

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* waitUntil("sent the start", () => listSessionEvents(sent).length === 1);
        yield* runner.shutdown("runner_restart");

        // The controller sent this start before it learned of the shutdown. A
        // harness spawned now would never be stopped.
        yield* supervisor.start(OTHER_START);
      }),
    );

    expect(fake.contexts).toHaveLength(1);
    expect(sortStopsBySession(fake)).toEqual([{ sessionId: SESSION, reason: "runner_restart" }]);
    // The second start's input is answered all the same, so the controller
    // does not wait for it.
    expect(listInputResults(sent)).toEqual([
      { _tag: "sessionInputResult", requestId: START_REQUEST, ok: true, delivery: "opened" },
      {
        _tag: "sessionInputResult",
        requestId: START_REQUEST,
        ok: false,
        message: "the runner is shutting down",
      },
    ]);
  });
});

describe("a stop that arrives while a session is still starting", () => {
  it("is applied once the harness is up, instead of being lost", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    // Hold the adapter's `startSession` open, so the session already has a
    // `live` entry in the `starting` phase when the stop arrives. The stop can
    // only go to `pendingStop`.
    let gateEntered = false;
    let resumeGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resumeGate = resolve;
    });
    const original = fake.adapter.startSession;
    Object.assign(fake.adapter, {
      startSession: (sessionId: string, spec: SessionSpec, ctx: ProviderRunnerContext) => {
        gateEntered = true;
        return Effect.andThen(
          Effect.promise(() => gate),
          original(sessionId, spec, ctx),
        );
      },
    });

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* Effect.forkChild(supervisor.start(START));
        yield* waitUntil("the harness was asked to start", () => gateEntered);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        resumeGate();
        yield* waitUntil("the exit reached the wire", () =>
          listSessionEvents(sent).some((frame) => frame.event._tag === "session.exited"),
        );
      }),
    );

    expect(fake.contexts).toHaveLength(1);
    expect(sortStopsBySession(fake)).toEqual([{ sessionId: SESSION, reason: "stopped" }]);
    // A session on its way out gets no turn.
    expect(fake.inputs).toEqual([]);
    expectStartInputRefused(sent, "was stopped before its input was handed over");
  });
});

describe("a start that follows a stop of the same id", () => {
  /** How long the start waits for the earlier harness to exit, as the supervisor sets it. */
  const STOP_WAIT_MS = 30 * 1000;
  const AGAIN: SessionStart = { ...START, requestId: REQUEST };

  it("is refused as still stopping when the earlier harness has not exited 30 seconds later", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);
    let listed = 0;
    const original = fake.adapter.listSessions;
    Object.assign(fake.adapter, {
      listSessions: Effect.suspend(() => {
        listed += 1;
        return original;
      }),
    });

    await runWithRelayOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        fake.stopsSilently = true;
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        const before = listed;
        yield* Effect.forkChild(supervisor.start(AGAIN));
        // The start lists the adapter's sessions, finds the old harness still
        // there, and waits for it to exit.
        yield* waitOnWallClock("checked the adapter", () => listed > before);

        yield* TestClock.adjust(STOP_WAIT_MS - 1);
        expect(listInputResults(sent)).toHaveLength(1);
        yield* TestClock.adjust(1);
        yield* waitOnWallClock(
          "answered the second start",
          () => listInputResults(sent).length === 2,
        );
      }),
    );

    expect(listInputResults(sent)[1]).toMatchObject({ requestId: REQUEST, ok: false });
    expect(listInputResults(sent)[1]?.message).toContain("is still stopping");
    // No second harness was asked for, and the old one was not stopped twice.
    expect(fake.contexts).toHaveLength(1);
    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "stopped" }]);
  });

  it("keeps its entry when the old exit is handled after the adapter dropped the old session", async () => {
    const fake = createFake();
    const { runner, machine } = buildConnection(fake);
    // The relay holds this event until the test lets it go, so the old exit,
    // published after it, is handled only then.
    const HOLD: ProviderEvent = { ...MARKER, eventId: "e-hold" };
    let releaseHold: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const sent: Array<RunnerToController> = [];
    const supervisor = runner.forConnection({
      machine,
      send: (frame) =>
        Effect.andThen(
          frame._tag === "sessionEvent" && frame.event.eventId === HOLD.eventId
            ? Effect.promise(() => hold)
            : Effect.void,
          Effect.sync(() => void sent.push(frame)),
        ),
    });

    // `dropped`: the adapter no longer lists the old session, although its
    // exit is still on the way. The fake drops it from `listSessions` only,
    // so the second harness counts as listed once it has started.
    let dropped = false;
    // Set for the second start: its `listSessions` call lets the relay go, and
    // its `startSession` waits at `secondStart` before the harness is listed.
    let armed = false;
    let secondStartReached = false;
    let openSecondStart: () => void = () => {};
    const secondStart = new Promise<void>((resolve) => {
      openSecondStart = resolve;
    });
    const originalList = fake.adapter.listSessions;
    const originalStart = fake.adapter.startSession;
    Object.assign(fake.adapter, {
      listSessions: Effect.suspend(() => {
        if (armed) {
          armed = false;
          releaseHold();
        }
        return Effect.map(originalList, (bindings) =>
          dropped ? bindings.filter((binding) => binding.sessionId !== SESSION) : bindings,
        );
      }),
      startSession: (sessionId: string, spec: SessionSpec, ctx: ProviderRunnerContext) =>
        !dropped
          ? originalStart(sessionId, spec, ctx)
          : Effect.andThen(
              Effect.promise(() => {
                secondStartReached = true;
                return secondStart;
              }),
              Effect.suspend(() => {
                dropped = false;
                return originalStart(sessionId, spec, ctx);
              }),
            ),
    });

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* waitUntil("sent the start", () => listSessionEvents(sent).length === 1);
        fake.stopsSilently = true;
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        fake.emit(HOLD);
        dropped = true;
        fake.emit({
          _tag: "session.exited",
          eventId: "e-old-exit",
          sessionId: SESSION,
          at,
          reason: "stopped",
        });

        armed = true;
        yield* Effect.forkChild(supervisor.start(AGAIN));
        yield* waitUntil(
          "sent the old exit, and the second start asked for its harness",
          () => listExitReasons(sent).length === 1 && secondStartReached,
        );
        openSecondStart();
        yield* waitUntil("answered the second start", () => listInputResults(sent).length === 2);

        // The new session still has its entry: an input reaches its harness.
        yield* supervisor.input({
          _tag: "sessionInput",
          requestId: "0199e0e7-0000-7000-8000-0000000000f9",
          sessionId: SESSION,
          input: { text: "still there?" },
        });
      }),
    );

    expect(listInputResults(sent).map((result) => [result.requestId, result.ok])).toEqual([
      [START_REQUEST, true],
      [REQUEST, true],
      ["0199e0e7-0000-7000-8000-0000000000f9", true],
    ]);
    expect(fake.inputs).toEqual([START_INPUT, START_INPUT, { text: "still there?" }]);
  });
});

describe("a shutdown that happens before a start has added its entry", () => {
  it("never asks the adapter for the harness", async () => {
    const fake = createFake();
    const { supervisor, runner, sent } = buildConnection(fake);

    // Hold the first `listSessions` call open. It is `start`'s own check, made
    // before the session has a `live` entry, so a shutdown during the wait
    // cannot see the session.
    let gateEntered = false;
    let resumeGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resumeGate = resolve;
    });
    const original = fake.adapter.listSessions;
    Object.assign(fake.adapter, {
      listSessions: Effect.suspend(() => {
        if (gateEntered) return original;
        gateEntered = true;
        return Effect.andThen(
          Effect.promise(() => gate),
          original,
        );
      }),
    });

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* Effect.forkChild(supervisor.start(START));
        yield* waitUntil("the start reached its adapter check", () => gateEntered);
        // No session is live yet, so this returns at once. The held start must
        // see `stopped` once it resumes.
        yield* runner.shutdown("runner_restart");
        resumeGate();
        yield* waitUntil("the start saw the shutdown when it added its entry", () =>
          listSessionEvents(sent).some((frame) => frame.event._tag === "session.exited"),
        );
      }),
    );

    expect(fake.contexts).toHaveLength(0);
    expect(listSessionEvents(sent).map((frame) => frame.event._tag)).toEqual(["session.exited"]);
    expect(listExitReasons(sent)).toEqual(["runner_restart"]);
    expectStartInputRefused(sent, "the runner is shutting down");
  });
});

/**
 * Tests the instance's secret config values. They arrive in the start frame and
 * reach the adapter through the context and nowhere else. Written to the
 * runner's disk, they would outlive the session they belong to, and the machine
 * holds no Hercule state to restore them from.
 */
describe("the secrets a start frame carries", () => {
  const KEY = "a-paid-credential-nobody-else-holds";

  it("passes the frame's secrets to the adapter, by name", async () => {
    const fake = createFake();
    const { supervisor } = buildConnection(fake);

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start({ ...START, secrets: { zaiApiKey: KEY } });
        yield* waitUntil("started the session", () => fake.contexts.length === 1);
      }),
    );

    expect(fake.contexts[0]?.secrets).toEqual({ zaiApiKey: KEY });
    // The runner never adds them to the environment: only the adapter knows
    // which variable a key belongs in.
    expect(JSON.stringify(fake.contexts[0]?.env)).not.toContain(KEY);
  });

  it("passes an empty set of secrets when the frame has none", async () => {
    const fake = createFake();
    const { supervisor } = buildConnection(fake);

    await runWithRelay(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* waitUntil("started the session", () => fake.contexts.length === 1);
      }),
    );

    expect(fake.contexts[0]?.secrets).toEqual({});
  });
});
