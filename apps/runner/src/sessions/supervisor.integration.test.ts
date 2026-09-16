/**
 * The supervisor driven the way a connection drives it: the three frames a
 * controller sends in, the frames the runner sends back out. The adapter here
 * is a fake, because what is under test is the runner's own bookkeeping - the
 * sequence, the live table, the scratch directory - and not any harness.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Duration, Effect, Fiber, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";
import type {
  ApprovalDecision,
  ExitReason,
  ProviderEvent,
  RunnerToController,
  SendResult,
  SessionInputResult,
  SessionBinding,
  SessionEvent,
  SessionSpec,
  SessionStart,
  TurnInput,
} from "@hydra/protocol";
import type { ProviderAdapter, ProviderRunnerContext } from "../providers";
import type { Machine } from "./context";
import { makeWorkspaces } from "../workspaces";
import { supervising } from "./supervisor";

const roots: Array<string> = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const INSTANCE = "0199e0e7-0000-7000-8000-00000000000a";
const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const NATIVE = "0199e0e7-0000-7000-8000-0000000000fe";
const TURN = "0199e0e7-0000-7000-8000-0000000000fd";
/** The Queued Input row an input frame is sent under, and answered under. */
const REQUEST = "0199e0e7-0000-7000-8000-0000000000fc";
/** The adapter's own id for the park an answer names; the controller mints none. */
const PARK = "0199e0e7-0000-7000-8000-0000000000fb";

/** The shipped defaults (spec 03 section 6.2): only the test clock can cross them. */
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
  sessionId: SESSION,
  providerId: "fake",
  config: {},
  spec: SPEC,
};

const at = "2026-09-07T10:00:00.000Z";

/**
 * No adapter sends this: it is published until a relay is heard from, and
 * filtered out before one sees it.
 */
const MARKER: ProviderEvent = {
  _tag: "runtime.warning",
  eventId: "e-marker",
  sessionId: SESSION,
  at,
  message: "is anybody listening",
};

/** An adapter that reports what it was handed and emits what the test asks for. */
interface Fake {
  readonly adapter: ProviderAdapter;
  /** The context the supervisor resolved for the one session it started. */
  readonly contexts: Array<ProviderRunnerContext>;
  /** How many markers have reached a relay, which is what says one is listening. */
  readonly heard: () => number;
  readonly inputs: Array<TurnInput>;
  readonly interrupted: Array<string>;
  /** Every `respondToRequest`, as the positional arguments it was handed. */
  readonly answered: Array<readonly [string, string, ApprovalDecision]>;
  /** Every `stopSession`, with the reason its caller gave it. */
  readonly stops: Array<{ readonly sessionId: string; readonly reason: ExitReason }>;
  readonly emit: (event: ProviderEvent) => void;
  fails: string | undefined;
  /** A harness that throws where nothing declared it could. */
  dies: boolean;
  /**
   * A harness that takes the stop and never exits: the process is wedged, or
   * ignoring the signal. Its session is only ever abandoned, never seen out.
   */
  stopsSilently: boolean;
}

const faking = (): Fake => {
  const events = Effect.runSync(PubSub.unbounded<ProviderEvent>());
  let heard = 0;
  const contexts: Array<ProviderRunnerContext> = [];
  const inputs: Array<TurnInput> = [];
  const interrupted: Array<string> = [];
  const answered: Array<readonly [string, string, ApprovalDecision]> = [];
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
       * A PubSub drops what no subscriber is on, so an event published before
       * the relay ran is one nobody heard - the missing outbox (spec 03 section
       * 2.3), and a race for any test that starts a session. A marker that got
       * this far is the proof a relay is listening; it is counted and dropped
       * here rather than passed on, so the relay under test never sees it.
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
          inputs.push(input);
          return Effect.succeed({ turnId: TURN, delivery: "opened" });
        }),
      interrupt: (sessionId) => Effect.sync(() => void interrupted.push(sessionId)),
      /**
       * Nothing parks in this fake: the request events are emitted directly,
       * so there is never an answer for it to carry back to a harness. What
       * the answer was handed is recorded, because the frame's three fields
       * reaching the adapter in the right order is the runner's own job.
       */
      respondToRequest: (sessionId, requestId, decision) =>
        Effect.sync(() => void answered.push([sessionId, requestId, decision])),
      /**
       * The reason is the caller's, not this adapter's: the supervisor is the
       * one that knows why it stopped a session, and the exit event is the only
       * place that reason can enter the stream.
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

/** One connection: what the supervisor writes, in order, and where things live. */
const connecting = (fake: Fake) => {
  const under = mkdtempSync(join(tmpdir(), "hydra-supervisor-"));
  roots.push(under);
  const sent: Array<RunnerToController> = [];
  const machine: Machine = {
    providersDir: join(under, "providers"),
    scratchDir: join(under, "scratch"),
    controllerUrl: "https://controller.example:4938",
    baseEnv: { PATH: "/usr/bin" },
    binaryOf: (name) => `/usr/local/bin/${name}`,
    workspaces: makeWorkspaces({ storageDir: join(under, "storage") }),
    socketPath: join(under, "daemon.sock"),
  };
  // The value `supervising` returns is the process's, and one connection's
  // supervisor is built from it through `forConnection`: a session outlives
  // the socket that started it, and so does the shutdown that ends every one
  // of them.
  const runner = supervising([fake.adapter]);
  const supervisor = runner.forConnection({
    machine,
    send: (frame) => Effect.sync(() => sent.push(frame)),
  });
  return { supervisor, runner, sent, machine, under };
};

/**
 * How long a wait on the relay is given. Wall clock rather than a count of
 * attempts: an attempt takes as long as the machine is busy, so counting them
 * makes the wait shortest exactly when the rest of the suite is running beside
 * it. Vitest's own budget is set from it, because a give-up wait longer than
 * the test timeout never gets to say what it was waiting for.
 */
const WAIT_DEADLINE_MS = 10_000;

/**
 * Three, because the longest case here waits for the relay to subscribe, then
 * for what the body did, then for the relay to have read past it: a test whose
 * waits can outlast the timeout never gets to say what it was waiting for.
 */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 5_000 });

/** Waits for something the relay has done, or gives up and says so. */
const until = (what: string, ready: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + WAIT_DEADLINE_MS;
    while (!ready() && Date.now() < deadline) yield* Effect.sleep(1);
    expect(ready(), `the relay never ${what}`).toBe(true);
  });

/**
 * Waits until a marker has reached the relay. That is the one thing that says a
 * relay is on the PubSub - `Stream.onStart` fires before the subscription
 * exists, so it would say so too early - and, because the relay reads the
 * PubSub in order, nothing published before the marker can still be in flight
 * when it arrives.
 */
const marked = (fake: Fake): Effect.Effect<void> =>
  Effect.suspend(() => {
    const before = fake.heard();
    return until("heard a marker", () => {
      fake.emit(MARKER);
      return fake.heard() > before;
    });
  });

/** The relay runs for as long as the body does, the way a connection forks it. */
const driving = <A>(
  fake: Fake,
  supervisor: { readonly relay: Effect.Effect<void> },
  body: Effect.Effect<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const relaying = yield* Effect.forkChild(supervisor.relay);
      // Proved, not slept through: `forkChild` hands the fiber back before it
      // has run, so a session started here would publish its `session.started`
      // to a PubSub nobody is on yet.
      yield* marked(fake);
      const value = yield* body;
      yield* Fiber.interrupt(relaying);
      return value;
    }),
  );

const eventsIn = (sent: ReadonlyArray<RunnerToController>): ReadonlyArray<SessionEvent> =>
  sent.filter((frame): frame is SessionEvent => frame._tag === "sessionEvent");

const answersIn = (sent: ReadonlyArray<RunnerToController>): ReadonlyArray<SessionInputResult> =>
  sent.filter((frame): frame is SessionInputResult => frame._tag === "sessionInputResult");

describe("one session, start to exit", () => {
  it("sends every event under a sequence that only goes up", async () => {
    const fake = faking();
    const { supervisor, sent, machine } = connecting(fake);

    await driving(
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
        yield* until("sent two events", () => eventsIn(sent).length === 2);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* until("sent three events", () => eventsIn(sent).length === 3);
      }),
    );

    expect(fake.inputs).toEqual([{ text: "hi" }]);
    const events = eventsIn(sent);
    expect(events.map((frame) => frame.event._tag)).toEqual([
      "session.started",
      "content.delta",
      "session.exited",
    ]);
    // The controller inserts on this number exactly once, so it is the one
    // thing about the stream that must never repeat or go backwards.
    expect(events.map((frame) => frame.seq)).toEqual([1, 2, 3]);
    // The harness is handed the scratch cwd and the instance's home, not paths
    // the controller invented.
    expect(fake.contexts[0]?.cwd).toBe(join(machine.scratchDir, SESSION));
    expect(fake.contexts[0]?.home).toBe(join(machine.providersDir, INSTANCE));
    expect(fake.contexts[0]?.binary).toBe("/usr/local/bin/fake-harness");
    expect(fake.contexts[0]?.env["HYDRA_SESSION"]).toBe("1");
  });

  it("reports what it holds, and holds nothing once the session has exited", async () => {
    const fake = faking();
    const { supervisor, sent, machine } = connecting(fake);

    const scratch = join(machine.scratchDir, SESSION);
    await driving(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.report;
        expect(existsSync(scratch)).toBe(true);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* until("sent the exit", () =>
          eventsIn(sent).some((frame) => frame.event._tag === "session.exited"),
        );
        yield* supervisor.report;
      }),
    );

    const reports = sent.filter((frame) => frame._tag === "sessionsReport");
    // A plain snapshot: the binding joins the Hydra session to the harness's own.
    expect(reports[0]?.sessions).toEqual([
      { sessionId: SESSION, nativeSessionId: NATIVE, instanceId: INSTANCE },
    ]);
    expect(reports[1]?.sessions).toEqual([]);
    // The scratch directory dies with the session it was made for.
    expect(existsSync(scratch)).toBe(false);
  });
});

describe("a start the controller sends twice", () => {
  it("is a no-op, and leaves the running session its working directory", async () => {
    const fake = faking();
    const { supervisor, sent, machine } = connecting(fake);
    const scratch = join(machine.scratchDir, SESSION);

    await driving(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* until("sent the start", () => eventsIn(sent).length === 1);
        yield* Effect.sync(() => writeFileSync(join(scratch, "work.txt"), "half a turn"));
        // The controller re-issues a command it cannot account for after a
        // reconnect (spec 03 section 2.3), and this one must not be destructive.
        yield* supervisor.start(START);
        // Read past it before counting: an event the duplicate had wrongly
        // published would still be in the relay otherwise, and the count below
        // would say "nothing happened" about a relay that had not looked yet.
        yield* marked(fake);
      }),
    );

    expect(existsSync(join(scratch, "work.txt"))).toBe(true);
    expect(fake.contexts).toHaveLength(1);
    // No second start, and above all no exit for a session that is still running.
    expect(eventsIn(sent).map((frame) => frame.event._tag)).toEqual(["session.started"]);
  });
});

describe("an exit that arrives after the id was started again", () => {
  it("leaves the running session its directory and its place in the table", async () => {
    const fake = faking();
    const { supervisor, sent, machine } = connecting(fake);
    const scratch = join(machine.scratchDir, SESSION);

    await driving(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* until("sent the start", () => eventsIn(sent).length === 1);
        // The exit of an earlier run under the same id, still on its way
        // through the relay when the new one started. Only the adapter can
        // tell the two apart: the event carries the same session id.
        yield* Effect.sync(() =>
          fake.emit({
            _tag: "session.exited",
            eventId: "e-old",
            sessionId: SESSION,
            at,
            reason: "process_exit",
          }),
        );
        yield* until("sent two events", () => eventsIn(sent).length === 2);
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
    expect(fake.inputs).toEqual([{ text: "hi" }]);
    expect(eventsIn(sent)).toHaveLength(2);
  });
});

describe("a stale exit's release racing a fresh start under the same id", () => {
  it("does not tear down the fresh start's entry", async () => {
    const fake = faking();
    const { supervisor, sent } = connecting(fake);

    const originalListSessions = fake.adapter.listSessions;
    const originalStartSession = fake.adapter.startSession;
    let listCalls = 0;
    let releaseEntered = false;
    let resumeRelease: () => void = () => {};
    const releaseGate = new Promise<void>((resolve) => {
      resumeRelease = resolve;
    });
    let startCalls = 0;
    let freshStartEntered = false;
    let resumeFreshStart: () => void = () => {};
    const freshStartGate = new Promise<void>((resolve) => {
      resumeFreshStart = resolve;
    });

    // The second `listSessions` call is `release`'s, checking what a stale
    // exit left behind; held open so a fresh start for the same id can run
    // while it is still deciding. The second `startSession` call is that
    // fresh start's; held open past `live` taking its entry but before the
    // adapter itself has one - the exact window `release`'s gated read above
    // has to land in for the race to matter.
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
        if (startCalls !== 2) return originalStartSession(sessionId, spec, ctx);
        freshStartEntered = true;
        return Effect.andThen(
          Effect.promise(() => freshStartGate),
          originalStartSession(sessionId, spec, ctx),
        );
      },
    });

    await driving(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* until("sent the start", () => eventsIn(sent).length === 1);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* until("release began checking who is live", () => releaseEntered);
        yield* Effect.forkChild(supervisor.start(START));
        yield* until("the fresh start reached the harness", () => freshStartEntered);
        resumeRelease();
        yield* until("the stale exit reached the wire", () => eventsIn(sent).length === 2);
        resumeFreshStart();
        yield* until("the fresh start finished", () => fake.contexts.length === 2);
        // If `release` tore down the fresh entry by mistake, this second stop
        // finds nothing live and does nothing - the assertion below is what
        // catches that.
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* until("the second stop reached the harness", () => fake.stops.length === 2);
      }),
    );

    expect(fake.stops.map((stop) => stop.reason)).toEqual(["stopped", "stopped"]);
  });
});

describe("a start for a session this machine tore down when it exited", () => {
  it("starts it again under the same id, rather than refusing it as one already here", async () => {
    const fake = faking();
    const { supervisor, sent, machine } = connecting(fake);
    const resumed: SessionStart = {
      ...START,
      spec: { ...SPEC, continue: { nativeSessionId: NATIVE, mode: "resume" } },
    };

    await driving(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* until("sent the start", () => eventsIn(sent).length === 1);
        // The harness ends on its own, the way an idle one is unloaded: it
        // stops holding the session and says so.
        yield* fake.adapter.stopSession(SESSION, "process_exit");
        yield* until("sent the exit", () => eventsIn(sent).length === 2);
        yield* supervisor.start(resumed);
        yield* until("sent the second start", () => eventsIn(sent).length === 3);
      }),
    );

    expect(eventsIn(sent).map((frame) => frame.event._tag)).toEqual([
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
    const fake = faking();
    const { supervisor, sent } = connecting(fake);

    await driving(
      fake,
      supervisor,
      Effect.flatMap(supervisor.start(START), () =>
        until("sent the start", () => eventsIn(sent).length === 1),
      ),
    );
    // The harness ends between connections: its exit is published to a relay
    // nobody is running, so it reaches no controller and the supervisor's own
    // entry outlives the session. Nothing replays it - there is no outbox.
    await Effect.runPromise(fake.adapter.stopSession(SESSION, "stopped"));
    await driving(
      fake,
      supervisor,
      Effect.flatMap(supervisor.start(START), () =>
        until("sent the second start", () => eventsIn(sent).length === 2),
      ),
    );

    expect(fake.contexts).toHaveLength(2);
    expect(eventsIn(sent).map((frame) => frame.event._tag)).toEqual([
      "session.started",
      "session.started",
    ]);
  });
});

describe("a session that cannot run here", () => {
  it("ends a start the adapter refused, rather than leaving it starting forever", async () => {
    const fake = faking();
    fake.fails = "no fake-harness on this machine";
    const { supervisor, sent, machine } = connecting(fake);

    await driving(fake, supervisor, supervisor.start(START));

    const events = eventsIn(sent).map((frame) => frame.event);
    expect(events.map((event) => event._tag)).toEqual(["runtime.error", "session.exited"]);
    expect(events[0]).toMatchObject({
      class: "unknown",
      message: "no fake-harness on this machine",
    });
    // Not `stopped`: nobody asked for this, and there is nothing to resume.
    expect(events[1]).toMatchObject({ reason: "crash" });
    // And nothing of it is left on disk.
    expect(existsSync(join(machine.scratchDir, SESSION))).toBe(false);
  });

  it("ends a start for a provider this build has no adapter for", async () => {
    const fake = faking();
    const { supervisor, sent } = connecting(fake);

    await driving(fake, supervisor, supervisor.start({ ...START, providerId: "codex" }));

    const events = eventsIn(sent).map((frame) => frame.event);
    expect(events[0]).toMatchObject({ message: "no adapter for codex in this runner build" });
    expect(events[1]).toMatchObject({ _tag: "session.exited", reason: "crash" });
  });

  it("reports a defect on the session rather than letting it take the connection down", async () => {
    const fake = faking();
    const { supervisor, sent, machine } = connecting(fake);
    fake.dies = true;

    await driving(fake, supervisor, supervisor.start(START));

    // Every other answer on this connection catches its own defects; a session
    // that did not would leave the controller waiting in `starting` forever.
    const events = eventsIn(sent).map((frame) => frame.event);
    expect(events.map((event) => event._tag)).toEqual(["runtime.error", "session.exited"]);
    // And it left nothing behind: neither the directory nor an entry that
    // would make the next start for this session look like a duplicate.
    expect(existsSync(join(machine.scratchDir, SESSION))).toBe(false);
  });

  it("says input for a session it does not hold was lost, and stays quiet about stopping one", async () => {
    const fake = faking();
    const { supervisor, sent } = connecting(fake);

    await driving(
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
        // does not hold has already exited, and said so once.
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
      }),
    );

    const events = eventsIn(sent).map((frame) => frame.event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ _tag: "runtime.error", sessionId: SESSION });
    // The caller is waiting on the answer under the row's own id, and a reason
    // it can report beats a bare flag.
    expect(answersIn(sent)).toHaveLength(1);
    expect(answersIn(sent)[0]).toMatchObject({ requestId: REQUEST, ok: false });
    expect(answersIn(sent)[0]?.message ?? "").toContain(SESSION);
    expect(answersIn(sent)[0]?.delivery).toBeUndefined();
  });
});

describe("what the controller hears back about one input", () => {
  it("answers a delivered input with what the adapter said it did", async () => {
    const fake = faking();
    const { supervisor, sent } = connecting(fake);

    await driving(
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

    expect(fake.inputs).toEqual([{ text: "hi" }]);
    expect(answersIn(sent)).toEqual([
      { _tag: "sessionInputResult", requestId: REQUEST, ok: true, delivery: "opened" },
    ]);
  });

  it("ends the running turn for a session it holds, and nothing for one it does not", async () => {
    const fake = faking();
    const { supervisor } = connecting(fake);

    await driving(
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

    expect(fake.interrupted).toEqual([SESSION]);
  });

  it("answers the park for a session it holds, and nothing for one it does not", async () => {
    const fake = faking();
    const { supervisor } = connecting(fake);

    await driving(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.respond({
          _tag: "sessionRespond",
          sessionId: SESSION,
          requestId: PARK,
          decision: "allow_always",
        });
        yield* supervisor.respond({
          _tag: "sessionRespond",
          sessionId: "0199e0e7-0000-7000-8000-0000000000aa",
          requestId: PARK,
          decision: "deny",
        });
      }),
    );

    expect(fake.answered).toEqual([[SESSION, PARK, "allow_always"]]);
  });
});

/**
 * The same drive with the test clock in place of the wall clock. Only the two
 * supervision timers read that clock; every wait on the relay below stays on
 * the wall clock, because what those wait for is another fiber getting a turn,
 * which no amount of virtual time delivers.
 */
const timing = <A>(
  fake: Fake,
  supervisor: { readonly relay: Effect.Effect<void> },
  body: Effect.Effect<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const relaying = yield* Effect.forkChild(supervisor.relay);
        yield* TestClock.withLive(marked(fake));
        const value = yield* body;
        yield* Fiber.interrupt(relaying);
        return value;
      }),
      TestClock.layer(),
    ),
  );

/** A wait on the relay, on the wall clock, while the test clock drives the timers. */
const awaiting = (what: string, ready: () => boolean): Effect.Effect<void> =>
  TestClock.withLive(until(what, ready));

/**
 * The event the relay has sent for a session, once it has sent one. Arming a
 * clock and sending the event that armed it are the same pass through the
 * relay now, so seeing the frame is enough to know the clock is set.
 */
const forwarded = (sent: ReadonlyArray<RunnerToController>, count: number): Effect.Effect<void> =>
  awaiting(`sent ${String(count)} events`, () => eventsIn(sent).length >= count);

const turnStarted = (fake: Fake, turnId: string): void =>
  fake.emit({
    _tag: "turn.started",
    eventId: `e-${turnId}-started`,
    sessionId: SESSION,
    at,
    turnId,
  });

const turnCompleted = (fake: Fake, turnId: string): void =>
  fake.emit({
    _tag: "turn.completed",
    eventId: `e-${turnId}-done`,
    sessionId: SESSION,
    at,
    turnId,
    state: "completed",
  });

const delta = (fake: Fake, id: string): void =>
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

/** The reasons the exits sent to the controller carry, in order. */
const exitReasons = (sent: ReadonlyArray<RunnerToController>): ReadonlyArray<string> =>
  eventsIn(sent)
    .map((frame) => frame.event)
    .filter((event) => event._tag === "session.exited")
    .map((event) => (event as { readonly reason: string }).reason);

describe("a harness that goes silent mid-turn", () => {
  it("is stopped for inactivity, and the exit says that is why", async () => {
    const fake = faking();
    const { supervisor, sent } = connecting(fake);

    await timing(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* Effect.sync(() => turnStarted(fake, "t-1"));
        // `session.started` and `turn.started`: the clock is armed by the
        // second of them, on its way through the relay.
        yield* forwarded(sent, 2);

        yield* TestClock.adjust(INACTIVITY_MS);
        // Waits for the exit frame itself, not merely for the adapter to have
        // been asked: the two can be several ticks apart on the way through
        // the relay.
        yield* forwarded(sent, 3);
      }),
    );

    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "inactivity_timeout" }]);
    // The reason reaches the controller the one way it can: on the adapter's
    // own exit event, forwarded like any other.
    expect(exitReasons(sent)).toEqual(["inactivity_timeout"]);
  });

  it("starts the wait over on any event of that session", async () => {
    const fake = faking();
    const { supervisor, sent } = connecting(fake);

    await timing(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* Effect.sync(() => turnStarted(fake, "t-1"));
        yield* forwarded(sent, 2);

        yield* TestClock.adjust(INACTIVITY_MS - 1);
        yield* Effect.sync(() => delta(fake, "d-1"));
        yield* forwarded(sent, 3);

        // The moment the first wait would have expired at. Nothing, because the
        // delta a millisecond earlier started the wait over.
        yield* TestClock.adjust(1);
        expect(fake.stops).toEqual([]);

        yield* TestClock.adjust(INACTIVITY_MS - 2);
        expect(fake.stops).toEqual([]);

        yield* TestClock.adjust(1);
        yield* awaiting("stopped the session", () => fake.stops.length === 1);
      }),
    );

    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "inactivity_timeout" }]);
  });

  it("is left alone once the turn has completed, however long the silence", async () => {
    const fake = faking();
    const { supervisor, sent } = connecting(fake);

    await timing(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* Effect.sync(() => turnStarted(fake, "t-1"));
        yield* forwarded(sent, 2);
        yield* Effect.sync(() => turnCompleted(fake, "t-1"));
        yield* forwarded(sent, 3);

        // An idle session is not a stuck one: it is waiting for its user, and
        // the absolute clock is the only one that may end it.
        yield* TestClock.adjust(ABSOLUTE_MS - 1);
      }),
    );

    expect(fake.stops).toEqual([]);
    expect(exitReasons(sent)).toEqual([]);
  });

  it("is watched again from the next turn the harness opens", async () => {
    const fake = faking();
    const { supervisor, sent } = connecting(fake);

    await timing(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* Effect.sync(() => turnStarted(fake, "t-1"));
        yield* forwarded(sent, 2);
        yield* Effect.sync(() => turnCompleted(fake, "t-1"));
        yield* forwarded(sent, 3);
        yield* TestClock.adjust(INACTIVITY_MS * 2);

        yield* Effect.sync(() => turnStarted(fake, "t-2"));
        yield* forwarded(sent, 4);
        yield* TestClock.adjust(INACTIVITY_MS);
        yield* forwarded(sent, 5);
      }),
    );

    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "inactivity_timeout" }]);
    expect(exitReasons(sent)).toEqual(["inactivity_timeout"]);
  });
});

/**
 * A session parked on an open request is waiting for its user, not stuck, so
 * the inactivity clock must not be running while one is open.
 */
const requestOpened = (fake: Fake, requestId: string): void =>
  fake.emit({
    _tag: "request.opened",
    eventId: `e-${requestId}-opened`,
    sessionId: SESSION,
    at,
    request: {
      requestId,
      itemId: "i-1",
      kind: "command_approval",
      decisions: ["allow", "allow_always", "deny", "cancel"],
      detail: { command: "ls -la" },
    },
  });

const requestResolved = (fake: Fake, requestId: string): void =>
  fake.emit({
    _tag: "request.resolved",
    eventId: `e-${requestId}-resolved`,
    sessionId: SESSION,
    at,
    requestId,
    decision: "allow",
  });

/** The four events the inactivity clock's arming is a function of. */
type Step = "turn.started" | "request.opened" | "request.resolved" | "turn.completed";

const step = (fake: Fake, which: Step, nth: number): void => {
  if (which === "turn.started") return turnStarted(fake, `t-${String(nth)}`);
  if (which === "turn.completed") return turnCompleted(fake, `t-${String(nth)}`);
  if (which === "request.opened") return requestOpened(fake, `r-${String(nth)}`);
  return requestResolved(fake, `r-${String(nth)}`);
};

describe("a session parked on an open request", () => {
  /**
   * Enumerated rather than generated: the repo carries no property-testing
   * library, and the arming is a function of two flags, so the sequences that
   * flip each of them are countable.
   */
  const SEQUENCES: ReadonlyArray<readonly [ReadonlyArray<Step>, boolean]> = [
    [["turn.started"], true],
    [["turn.started", "request.opened"], false],
    [["turn.started", "request.opened", "request.resolved"], true],
    [["turn.started", "request.opened", "turn.completed"], false],
    // The clock a still-open request disarmed is gone, not leaked: the next
    // turn is watched the ordinary way and this session is stopped once.
    [["turn.started", "request.opened", "turn.completed", "turn.started"], true],
    [["turn.started", "request.opened", "request.resolved", "turn.completed"], false],
    [["turn.started", "turn.completed", "turn.started"], true],
    // One request is open per session at a time, so a second open that replaced
    // the first is answered by one resolution.
    [["turn.started", "request.opened", "request.opened", "request.resolved"], true],
    [["turn.started", "request.opened", "request.resolved", "request.opened"], false],
  ];

  for (const [sequence, armed] of SEQUENCES) {
    it(`is ${armed ? "watched" : "left alone"} after ${sequence.join(" -> ")}`, async () => {
      const fake = faking();
      const { supervisor, sent } = connecting(fake);

      await timing(
        fake,
        supervisor,
        Effect.gen(function* () {
          yield* supervisor.start(START);
          // One pass through the relay per event, in order: arming the clock
          // and sending the event that armed it are the same pass, so a frame
          // seen is a clock already set.
          let count = 1;
          for (const which of sequence) {
            count += 1;
            const nth = count;
            yield* Effect.sync(() => step(fake, which, nth));
            yield* forwarded(sent, nth);
          }

          yield* TestClock.adjust(INACTIVITY_MS);
          // The exit frame itself, not merely the adapter having been asked:
          // the two are several ticks apart on the way through the relay.
          if (armed) yield* awaiting("sent the exit", () => exitReasons(sent).length === 1);
        }),
      );

      expect(fake.stops).toEqual(
        armed ? [{ sessionId: SESSION, reason: "inactivity_timeout" }] : [],
      );
      expect(exitReasons(sent)).toEqual(armed ? ["inactivity_timeout"] : []);
    });
  }
});

describe("a session that has run for as long as it may", () => {
  it("is stopped at the absolute deadline, mid-turn and with events still arriving", async () => {
    const fake = faking();
    const { supervisor, sent } = connecting(fake);

    await timing(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* Effect.sync(() => turnStarted(fake, "t-1"));
        yield* forwarded(sent, 2);

        // A busy session, kept clear of the inactivity clock the whole way: an
        // event every quarter of the shorter wait, until the longer one is up.
        const step = Math.floor(INACTIVITY_MS / 2);
        let elapsed = 0;
        let count = 2;
        while (elapsed + step < ABSOLUTE_MS) {
          yield* TestClock.adjust(step);
          elapsed += step;
          count += 1;
          yield* Effect.sync(() => delta(fake, `d-${String(count)}`));
          yield* forwarded(sent, count);
          expect(fake.stops, `at ${String(elapsed)}ms`).toEqual([]);
        }

        yield* TestClock.adjust(ABSOLUTE_MS - elapsed);
        yield* awaiting("stopped the session", () => fake.stops.length === 1);
      }),
    );

    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "absolute_timeout" }]);
    expect(exitReasons(sent)).toEqual(["absolute_timeout"]);
  });

  it("is not stopped at all when it ended before the deadline", async () => {
    const fake = faking();
    const { supervisor, sent } = connecting(fake);

    await timing(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* forwarded(sent, 1);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* forwarded(sent, 2);

        // Both clocks die with the session. A timer still running here would
        // stop a session that is already gone, or the next one under its id.
        yield* TestClock.adjust(ABSOLUTE_MS * 2);
      }),
    );

    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "stopped" }]);
    expect(exitReasons(sent)).toEqual(["stopped"]);
  });

  it("gives a session started again under the same id a clock of its own", async () => {
    const fake = faking();
    const { supervisor, sent } = connecting(fake);

    await timing(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* forwarded(sent, 1);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* forwarded(sent, 2);

        yield* TestClock.adjust(ABSOLUTE_MS / 2);
        yield* supervisor.start(START);
        yield* forwarded(sent, 3);

        // The first session's deadline, which this one must not inherit.
        yield* TestClock.adjust(ABSOLUTE_MS / 2);
        expect(fake.stops).toHaveLength(1);

        yield* TestClock.adjust(ABSOLUTE_MS / 2);
        yield* awaiting("stopped the second session", () => fake.stops.length === 2);
      }),
    );

    expect(fake.stops).toEqual([
      { sessionId: SESSION, reason: "stopped" },
      { sessionId: SESSION, reason: "absolute_timeout" },
    ]);
  });
});

/**
 * What an announced shutdown does to what this runner is holding.
 *
 * A runner that walks away without stopping its harnesses leaves orphan
 * processes behind and sessions the controller believes are busy, so what is
 * asserted here is that `shutdown` does not return until every session it
 * stopped has had its exit forwarded - the caller hangs up the moment it does -
 * and that it returns anyway when a harness will not die.
 */

/** A second session, so a shutdown has more than one thing to see out. */
const OTHER_SESSION = "0199e0e7-0000-7000-8000-0000000000ef";

const OTHER_START: SessionStart = { ...START, sessionId: OTHER_SESSION };

/**
 * The most a shutdown may take with a harness that never exits. Generous next
 * to the few seconds the shutdown bounds the wait at: what is under test is a wait that
 * ends, not the constant the implementation chose.
 */
const SHUTDOWN_BUDGET_MS = 20_000;

const stopsBySession = (fake: Fake): ReadonlyArray<{ sessionId: string; reason: ExitReason }> =>
  [...fake.stops].sort((one, other) => one.sessionId.localeCompare(other.sessionId));

describe("an announced shutdown", () => {
  it("stops every live session as a restart, and their exits are out before it returns", async () => {
    const fake = faking();
    const { supervisor, runner, sent } = connecting(fake);

    await driving(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.start(OTHER_START);
        yield* until("sent both sessions' starts", () => eventsIn(sent).length === 2);

        yield* runner.shutdown("runner_restart");

        // Read the moment it returns, not after a wait: what the caller does
        // next is hang the socket up, and an exit still in flight then is one
        // the controller never sees.
        expect(exitReasons(sent)).toEqual(["runner_restart", "runner_restart"]);
      }),
    );

    expect(stopsBySession(fake)).toEqual([
      { sessionId: OTHER_SESSION, reason: "runner_restart" },
      { sessionId: SESSION, reason: "runner_restart" },
    ]);
  });

  it("goes anyway when a harness takes the stop and never exits", async () => {
    const fake = faking();
    const { supervisor, runner, sent } = connecting(fake);

    await driving(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.start(OTHER_START);
        yield* until("sent both sessions' starts", () => eventsIn(sent).length === 2);
        yield* Effect.sync(() => {
          fake.stopsSilently = true;
        });

        const returned = yield* Effect.raceFirst(
          Effect.as(runner.shutdown("runner_restart"), true),
          Effect.as(Effect.sleep(Duration.millis(SHUTDOWN_BUDGET_MS)), false),
        );

        expect(returned, "the shutdown waited on a harness that never died").toBe(true);
        // Abandoned, not seen out: both were asked, neither said anything back.
        expect(exitReasons(sent)).toEqual([]);
      }),
    );

    expect(stopsBySession(fake)).toEqual([
      { sessionId: OTHER_SESSION, reason: "runner_restart" },
      { sessionId: SESSION, reason: "runner_restart" },
    ]);
  });

  it("starts nothing the controller asks for after it", async () => {
    const fake = faking();
    const { supervisor, runner, sent } = connecting(fake);

    await driving(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* until("sent the start", () => eventsIn(sent).length === 1);
        yield* runner.shutdown("runner_restart");

        // A start the controller had already put on the wire when this runner
        // began going. Spawning a harness now is one nothing will ever stop.
        yield* supervisor.start(OTHER_START);
      }),
    );

    expect(fake.contexts).toHaveLength(1);
    expect(stopsBySession(fake)).toEqual([{ sessionId: SESSION, reason: "runner_restart" }]);
  });
});

describe("a stop that arrives while a session is still starting", () => {
  it("is applied once the harness is up, rather than lost", async () => {
    const fake = faking();
    const { supervisor, sent } = connecting(fake);

    // Held open on the adapter's own `startSession`, so the session already
    // has a `live` entry - `starting` - before the stop is asked for, with
    // nowhere yet to send it but `pendingStop`.
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

    await driving(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* Effect.forkChild(supervisor.start(START));
        yield* until("the harness was asked to start", () => gateEntered);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        resumeGate();
        yield* until("the exit reached the wire", () =>
          eventsIn(sent).some((frame) => frame.event._tag === "session.exited"),
        );
      }),
    );

    expect(fake.contexts).toHaveLength(1);
    expect(stopsBySession(fake)).toEqual([{ sessionId: SESSION, reason: "stopped" }]);
  });
});

describe("a shutdown that lands before a start has an entry to find", () => {
  it("never asks the adapter for the harness", async () => {
    const fake = faking();
    const { supervisor, runner, sent } = connecting(fake);

    // Held open on the very first `listSessions` - `start`'s own check,
    // crossed before this session has a `live` entry a shutdown taken in the
    // gap could see.
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

    await driving(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* Effect.forkChild(supervisor.start(START));
        yield* until("the start reached its own fence", () => gateEntered);
        // Nothing is live yet, so this returns at once - `stopped` is what
        // the still-gated start has to see, once it resumes.
        yield* runner.shutdown("runner_restart");
        resumeGate();
        yield* until("the entry saw the shutdown as it was made", () =>
          eventsIn(sent).some((frame) => frame.event._tag === "session.exited"),
        );
      }),
    );

    expect(fake.contexts).toHaveLength(0);
    expect(eventsIn(sent).map((frame) => frame.event._tag)).toEqual(["session.exited"]);
  });
});
