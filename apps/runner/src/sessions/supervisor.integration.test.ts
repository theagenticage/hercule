/**
 * The supervisor driven the way a connection drives it: the three frames a
 * controller sends in, the frames the runner sends back out. The adapter here
 * is a fake, because what is under test is the runner's own bookkeeping - the
 * sequence, the live table, the scratch directory - and not any harness.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Fiber, PubSub, Stream } from "effect";
import type {
  ProviderEvent,
  RunnerToController,
  SessionBinding,
  SessionEvent,
  SessionSpec,
  SessionStart,
  TurnInput,
} from "@hydra/protocol";
import type { ProviderAdapter, ProviderRunnerContext, SendResult } from "../providers";
import type { Machine } from "./context";
import { supervising } from "./supervisor";

const roots: Array<string> = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const INSTANCE = "0199e0e7-0000-7000-8000-00000000000a";
const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const NATIVE = "0199e0e7-0000-7000-8000-0000000000fe";

const SPEC: SessionSpec = {
  instanceId: INSTANCE,
  workspaceId: null,
  modelSelection: { model: "claude-haiku-4-5", options: {} },
  accessMode: "approval-required",
};

const START: SessionStart = {
  _tag: "sessionStart",
  sessionId: SESSION,
  providerId: "fake",
  config: {},
  spec: SPEC,
};

const at = "2026-09-07T10:00:00.000Z";

/** An adapter that reports what it was handed and emits what the test asks for. */
interface Fake {
  readonly adapter: ProviderAdapter;
  /** The context the supervisor resolved for the one session it started. */
  readonly contexts: Array<ProviderRunnerContext>;
  readonly inputs: Array<TurnInput>;
  readonly emit: (event: ProviderEvent) => void;
  fails: string | undefined;
  /** A harness that throws where nothing declared it could. */
  dies: boolean;
}

const faking = (): Fake => {
  const events = Effect.runSync(PubSub.unbounded<ProviderEvent>());
  const contexts: Array<ProviderRunnerContext> = [];
  const inputs: Array<TurnInput> = [];
  const held = new Map<string, SessionBinding>();
  const fake: Fake = {
    contexts,
    inputs,
    fails: undefined,
    dies: false,
    emit: (event) => {
      PubSub.publishUnsafe(events, event);
    },
    adapter: {
      providerId: "fake",
      binaryName: "fake-harness",
      events: Stream.fromPubSub(events),
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
          return Effect.succeed({ turnId: "t-1", delivery: "opened" });
        }),
      stopSession: (sessionId) =>
        Effect.sync(() => {
          held.delete(sessionId);
          fake.emit({
            _tag: "session.exited",
            eventId: "e-exited",
            sessionId,
            at,
            reason: "stopped",
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
  };
  const supervisor = supervising([fake.adapter])({
    machine,
    send: (frame) => Effect.sync(() => sent.push(frame)),
  });
  return { supervisor, sent, machine, under };
};

/** The relay runs for as long as the body does, the way a connection forks it. */
const driving = <A>(
  supervisor: { readonly relay: Effect.Effect<void> },
  body: Effect.Effect<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const relaying = yield* Effect.forkChild(supervisor.relay);
      // Subscribing is what running the relay does, and an event published
      // before it has subscribed is one nobody was there to hear - which is
      // what the missing outbox means in general (spec 03 section 2.3).
      yield* Effect.sleep(5);
      const value = yield* body;
      // Long enough for everything published to have been read and written.
      yield* Effect.sleep(10);
      yield* Fiber.interrupt(relaying);
      return value;
    }),
  );

/** Waits for something the relay has done, or gives up and says so. */
const until = (ready: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200 && !ready(); attempt++) yield* Effect.sleep(1);
    expect(ready(), "the relay never got there").toBe(true);
  });

const eventsIn = (sent: ReadonlyArray<RunnerToController>): ReadonlyArray<SessionEvent> =>
  sent.filter((frame): frame is SessionEvent => frame._tag === "sessionEvent");

describe("one session, start to exit", () => {
  it("sends every event under a sequence that only goes up", async () => {
    const fake = faking();
    const { supervisor, sent, machine } = connecting(fake);

    await driving(
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.input({
          _tag: "sessionInput",
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
        yield* until(() => eventsIn(sent).length === 2);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* until(() => eventsIn(sent).length === 3);
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
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.report;
        expect(existsSync(scratch)).toBe(true);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* until(() => eventsIn(sent).some((frame) => frame.event._tag === "session.exited"));
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
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* until(() => eventsIn(sent).length === 1);
        yield* Effect.sync(() => writeFileSync(join(scratch, "work.txt"), "half a turn"));
        // The controller re-issues a command it cannot account for after a
        // reconnect (spec 03 section 2.3), and this one must not be destructive.
        yield* supervisor.start(START);
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
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* until(() => eventsIn(sent).length === 1);
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
        yield* until(() => eventsIn(sent).length === 2);
        yield* supervisor.input({
          _tag: "sessionInput",
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

describe("a session that ended while the socket was down", () => {
  it("is started afresh rather than taken for one that is still running", async () => {
    const fake = faking();
    const { supervisor, sent } = connecting(fake);

    await driving(supervisor, supervisor.start(START));
    // The harness ends between connections: its exit is published to a relay
    // nobody is running, so it reaches no controller and the supervisor's own
    // entry outlives the session. Nothing replays it - there is no outbox.
    await Effect.runPromise(fake.adapter.stopSession(SESSION));
    await driving(supervisor, supervisor.start(START));

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

    await driving(supervisor, supervisor.start(START));

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

    await driving(supervisor, supervisor.start({ ...START, providerId: "codex" }));

    const events = eventsIn(sent).map((frame) => frame.event);
    expect(events[0]).toMatchObject({ message: "no adapter for codex in this runner build" });
    expect(events[1]).toMatchObject({ _tag: "session.exited", reason: "crash" });
  });

  it("reports a defect on the session rather than letting it take the connection down", async () => {
    const fake = faking();
    const { supervisor, sent, machine } = connecting(fake);
    fake.dies = true;

    await driving(supervisor, supervisor.start(START));

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
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.input({
          _tag: "sessionInput",
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
  });
});
