import { makeGithubTokenCopies } from "../credentials";
import { makeTestWorkspaces } from "../workspaces/testing";
/**
 * Tests the supervisor the way a connection uses it: the controller's frames go
 * in, and the runner's frames come out. The adapter is a fake, because the
 * tests are about the runner's own bookkeeping (the sequence numbers, the
 * `live` table, the scratch directory), not about any harness.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Deferred, Duration, Effect, Exit, Fiber, PubSub, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import type {
  ExitReason,
  ItemStatus,
  HarnessEvent,
  RequestResolution,
  RunnerToController,
  SendResult,
  SessionInputResult,
  SessionBinding,
  SessionEvent,
  SessionSpec,
  SessionStart,
  TurnInput,
  WorkspaceKind,
  WorkspaceStepKey,
  WorkspaceStepResult,
  WorkspaceReport,
} from "@hercule/protocol";
import {
  AdapterFailed,
  AnswerNotDelivered,
  HarnessNotInstalled,
  HarnessProtocolError,
  InputNotDelivered,
  MAX_FRAME_BYTES,
  SessionAlreadyRunning,
  SessionNotRunning,
  SteerRefused,
  type AdapterError,
  type GithubTokenAnswer,
} from "@hercule/protocol";
import { FIXTURE_SCHEMA } from "@hercule/protocol/testing";
import type { HarnessAdapter, HarnessRunnerContext } from "../harnesses";
import type { Machine } from "./context";

import { makeWorkspaceSteps } from "../workspace-steps";
import {
  addBranch,
  buildCheckout,
  buildProvisionFrame,
  cleanTemporaries,
  createId,
  hashContents,
  makeRemote,
  runGitOrThrow,
} from "../workspaces/testing";
import { openFileClock } from "../edit-marks";
import { writeStartMark } from "../edit-marks/testing";
import { makeSupervising, type SessionSupervisor, type Supervising } from "./supervisor";
import { makeAttachmentCache, type AttachmentCache } from "../attachments";
import { NO_CONTROLLER_UPLOADER } from "../harnesses/testing";
import { makeSessionSkillsFolders } from "../skills";
import {
  buildTestSkillRevision,
  buildTestLibrarySkillRevision,
  startSkillController,
  type SkillControllerStub,
  type TestSkillRevision,
} from "../skills/testing";

const roots: Array<string> = [];
/** Scopes that attach each test's workspace steps to its list of sent frames. */
const attachments: Array<Scope.Closeable> = [];

afterAll(async () => {
  for (const scope of attachments.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
  await cleanTemporaries();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const INSTANCE = "0199e0e7-0000-7000-8000-00000000000a";
const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const RUNNER_ID = "0199e0e7-0000-7000-8000-0000000000aa";
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
  harnessId: "fake",
  config: {},
  secrets: {},
  spec: SPEC,
  token: "a-session-token",
};

const at = "2026-09-07T10:00:00.000Z";

/**
 * An event no real adapter sends. The tests publish it until the watch receives
 * it, and the fake adapter filters it out before the watch under test sees it.
 */
const MARKER: HarnessEvent = {
  _tag: "runtime.warning",
  eventId: "e-marker",
  sessionId: SESSION,
  at,
  message: "is anybody listening",
};

/** A fake adapter that records what it was given and emits the events the test asks for. */
interface Fake {
  readonly adapter: HarnessAdapter;
  /** The context the supervisor resolved for the one session it started. */
  readonly contexts: Array<HarnessRunnerContext>;
  /** How many markers have reached the watch. A count above zero proves the watch is listening. */
  readonly heard: () => number;
  readonly inputs: Array<TurnInput>;
  /** How many `sendInput` calls have begun, including ones still waiting on `inputGate`. */
  readonly inputsBegun: () => number;
  /**
   * When set, `sendInput` waits for it to complete before the harness takes
   * the input, like a harness that is slow to answer.
   */
  inputGate: Deferred.Deferred<void> | undefined;
  /** Every `interrupt` call, with the subagent it named, if any. */
  readonly interrupted: Array<{ readonly sessionId: string; readonly subagentId?: string }>;
  /** The arguments of every `respondToApprovalRequest` and `respondToQuestion` call. */
  readonly answered: Array<readonly [string, string, RequestResolution]>;
  /** Every `stopSession` call, with the reason its caller gave. */
  readonly stops: Array<{ readonly sessionId: string; readonly reason: ExitReason }>;
  readonly emit: (event: HarnessEvent) => void;
  /** The error every later start and input fails with, when set. */
  fails: AdapterError | undefined;
  /** The message every `respondToQuestion` call fails with, when set. */
  answerFails: string | undefined;
  /** A harness that throws where nothing declared it could. */
  dies: boolean;
  /**
   * A harness that takes the stop and never exits: the process is wedged, or
   * ignoring the signal. Its session is only ever abandoned, never seen out.
   */
  stopsSilently: boolean;
}

const createFake = (): Fake => {
  const events = Effect.runSync(PubSub.unbounded<HarnessEvent>());
  let heard = 0;
  let inputsBegun = 0;
  const contexts: Array<HarnessRunnerContext> = [];
  const inputs: Array<TurnInput> = [];
  const interrupted: Array<{ readonly sessionId: string; readonly subagentId?: string }> = [];
  const answered: Array<readonly [string, string, RequestResolution]> = [];
  const stops: Array<{ readonly sessionId: string; readonly reason: ExitReason }> = [];
  const held = new Map<string, SessionBinding>();
  const fake: Fake = {
    contexts,
    heard: () => heard,
    inputs,
    inputsBegun: () => inputsBegun,
    inputGate: undefined,
    interrupted,
    answered,
    stops,
    fails: undefined,
    answerFails: undefined,
    dies: false,
    stopsSilently: false,
    emit: (event) => {
      PubSub.publishUnsafe(events, event);
    },
    adapter: {
      harnessId: "fake",
      binaryName: "fake-harness",
      /**
       * A PubSub drops events that no subscriber receives, so an event
       * published before the watch subscribed is lost. The runner has no
       * outbox yet that keeps such events for replay, so this is a race in any
       * test that starts a session. A marker that gets this far proves the watch is listening; it is
       * counted and dropped here, so the watch under test never sees it.
       */
      events: Stream.filter(Stream.fromPubSub(events), (event) => {
        if (event !== MARKER) return true;
        heard += 1;
        return false;
      }),
      probe: () => Effect.die("not probed here"),
      listSessions: Effect.sync(() => [...held.values()]),
      generateText: () => Effect.die("no text generation here"),
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
      sendInput: (sessionId, input): Effect.Effect<SendResult, AdapterError> =>
        Effect.suspend(() => {
          inputsBegun += 1;
          return fake.inputGate === undefined ? Effect.void : Deferred.await(fake.inputGate);
        }).pipe(
          Effect.andThen(() => {
            if (!held.has(sessionId)) {
              return Effect.fail(
                new SessionNotRunning({ message: `session ${sessionId} is not running here` }),
              );
            }
            if (fake.fails !== undefined) return Effect.fail(fake.fails);
            inputs.push(input);
            return Effect.succeed({ turnId: TURN, delivery: "opened" } as const);
          }),
        ),
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
        fake.answerFails === undefined
          ? Effect.sync(() => void answered.push([sessionId, requestId, { answers }]))
          : Effect.fail(new AnswerNotDelivered({ message: fake.answerFails })),
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

/** What a test has the controller answer to a GitHub token ask: a token, a refusal, or no answer at all. */
type ControllerReply = { token: string } | { reason: string } | Error;

/**
 * Builds a connection like `buildConnection`, on a controller that answers each
 * GitHub token ask with `answer` (an `Error` makes the ask fail). `asked` lists
 * the session tokens that were asked for.
 */
const buildConnectionAsking = (fake: Fake, answer: (sessionToken: string) => ControllerReply) => {
  const asked: Array<string> = [];
  const connection = buildConnection(fake, undefined, undefined, undefined, (sessionToken) => {
    asked.push(sessionToken);
    const reply = answer(sessionToken);
    return reply instanceof Error
      ? Promise.reject(reply)
      : Promise.resolve<GithubTokenAnswer>({
          _tag: "githubTokenAnswer",
          requestId: "request",
          ...reply,
        });
  });
  return { ...connection, asked };
};

/**
 * Builds one connection that records every frame the supervisor sends, in
 * order, on a fresh machine. `cache` replaces the machine's cache of attached
 * images, which otherwise fetches from a controller that does not exist.
 * `skillsController` is the URL the machine fetches skills from, by default
 * a controller that does not exist.
 */
const buildConnection = (
  fake: Fake,
  cache?: AttachmentCache,
  path = "/usr/bin",
  skillsController = "https://controller.example:4938",
  askController: (sessionToken: string) => Promise<GithubTokenAnswer> = () =>
    Promise.reject(new Error("no controller in this test")),
) => {
  const under = mkdtempSync(join(tmpdir(), "hercule-supervisor-"));
  roots.push(under);
  const sent: Array<RunnerToController> = [];
  const machine: Machine = {
    providersDir: join(under, "providers"),
    scratchDir: join(under, "scratch"),
    attachmentsDir: join(under, "attachments"),
    editMarksDir: join(under, "edit-marks"),
    fileClock: openFileClock(join(under, "edit-marks", "clock")),
    attachmentUploader: NO_CONTROLLER_UPLOADER,
    attachments:
      cache ??
      makeAttachmentCache({
        controllerUrl: "https://controller.example:4938",
        credential: "test",
      }),
    sessionSkillsFolders: makeSessionSkillsFolders({
      sessionSkillsDir: join(under, "session-skills"),
      credential: "test",
      readControllerUrl: () => skillsController,
    }),
    binDir: join(under, "bin"),
    herculeTool: {
      orientation: "",
      skill: "# hercule",
      claudePluginDir: join(under, "claude-plugin"),
    },
    controllerUrl: "https://controller.example:4938",
    baseEnv: { PATH: path },
    findBinary: (name) => `/usr/local/bin/${name}`,
    workspaces: makeTestWorkspaces({ storageDir: join(under, "storage") }),
    socketPath: join(under, "daemon.sock"),
  };
  const send = (frame: RunnerToController) => Effect.sync(() => void sent.push(frame));
  // The real workspace steps, sending on the same list as the supervisor, so
  // a test sees an agent step's result and the session's events in the order
  // they would reach the controller.
  const steps = makeWorkspaceSteps({
    storageDir: join(under, "storage"),
    workspaces: machine.workspaces,
    socketPath: machine.socketPath,
    baseEnv: machine.baseEnv,
  });
  const scope = Effect.runSync(Scope.make());
  attachments.push(scope);
  Effect.runSync(steps.attachConnection(send).pipe(Scope.provide(scope)));
  // `makeSupervising` returns the process-wide value, and each connection's
  // supervisor is built from it with `forConnection`. Sessions outlive the
  // socket that started them, and so does the shutdown that stops them all.
  const runner = makeSupervising([fake.adapter]);
  watchers.set(fake, { runner, scope, watching: false });
  // By default the controller never answers: a test sees only the token the
  // start gave.
  const githubTokenCopies = makeGithubTokenCopies({ ask: askController });
  const supervisor = runner.forConnection({
    scope,
    runnerId: RUNNER_ID,
    machine,
    githubTokenCopies,
    send,
    workspaceSteps: steps,
  });
  return { supervisor, runner, sent, machine, githubTokenCopies, under, steps, scope };
};

/**
 * Makes a directory with a `git` that waits, while the hold is on, in its
 * first call that runs `reflog`, and returns the PATH to run it in. The first
 * `reflog` call is the one a start makes when it takes its workspace's state.
 */
const makeSlowFirstReflog = () => {
  const dir = mkdtempSync(join(tmpdir(), "hercule-slow-reflog-"));
  roots.push(dir);
  const holdFile = join(dir, "hold");
  const enteredFile = join(dir, "entered");
  const claimedDir = join(dir, "claimed");
  const realGit = Bun.which("git") ?? "git";
  writeFileSync(
    join(dir, "git"),
    `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = reflog ] && mkdir "${claimedDir}" 2>/dev/null; then\n    touch "${enteredFile}"\n    while [ -f "${holdFile}" ]; do sleep 0.02; done\n  fi\ndone\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(join(dir, "git"), 0o755);
  return {
    path: `${dir}:/usr/bin:/bin`,
    hold: () => writeFileSync(holdFile, ""),
    release: () => rmSync(holdFile),
    hasEntered: () => existsSync(enteredFile),
  };
};

/** The runner each fake belongs to, and whether that runner's watch runs yet. */
const watchers = new Map<
  Fake,
  { readonly runner: Supervising; readonly scope: Scope.Scope; watching: boolean }
>();

/**
 * Forks the watch of the fake's runner the first time it is called for that
 * fake, the way the daemon forks it once at startup. The watch keeps running
 * after the caller is done, between connections too, as it does in a runner.
 * It reads the clock of the caller that forked it.
 */
const startWatching = (fake: Fake): Effect.Effect<void> =>
  Effect.suspend(() => {
    const watcher = watchers.get(fake);
    if (watcher === undefined) return Effect.die("the fake has no runner; use buildConnection");
    if (watcher.watching) return Effect.void;
    watcher.watching = true;
    return Effect.asVoid(Effect.forkIn(watcher.runner.watch, watcher.scope));
  });

/**
 * How long a wait on the watch may take. This is wall-clock time, not a number
 * of attempts: an attempt takes longer when the machine is busy, so a fixed
 * count would give the shortest wait exactly when the rest of the suite runs
 * alongside. Vitest's test timeout is derived from it, because a wait that
 * outlasts the test timeout never gets to report what it was waiting for.
 */
const WAIT_DEADLINE_MS = 10_000;

/**
 * Three waits, because the longest test waits for the watch to subscribe, then
 * for the result of its body, then for the watch to read past it. A test whose
 * waits can outlast the timeout never gets to report what it was waiting for.
 */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 5_000 });

/** Waits until `ready` returns true. Fails the test, naming `what`, if the deadline passes first. */
const waitUntil = (what: string, ready: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + WAIT_DEADLINE_MS;
    while (!ready() && Date.now() < deadline) yield* Effect.sleep(1);
    expect(ready(), `the supervisor never ${what}`).toBe(true);
  });

/**
 * Waits until a marker has reached the watch. This is the only reliable sign
 * that the watch has subscribed to the PubSub: `Stream.onStart` fires before the
 * subscription exists, so it would be too early. Because the watch reads the
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

/**
 * Runs `body` with the connection attached, the way a connection is attached
 * once the controller has proved its identity, and detaches it afterwards.
 * Starts the runner's watch first, if it is not running yet.
 */
const runConnected = <A>(
  fake: Fake,
  supervisor: SessionSupervisor,
  body: Effect.Effect<A>,
  options: { readonly controllerReadsFilesEdited: boolean } = { controllerReadsFilesEdited: true },
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* startWatching(fake);
        // Wait for proof, not for a fixed time: `forkIn` returns the fiber
        // before it has run, so a session started now would publish its
        // `session.started` to a PubSub with no subscriber yet.
        yield* awaitMarker(fake);
        yield* supervisor.attach(options);
        return yield* body;
      }),
    ),
  );

const listSessionEvents = (sent: ReadonlyArray<RunnerToController>): ReadonlyArray<SessionEvent> =>
  sent.filter((frame): frame is SessionEvent => frame._tag === "sessionEvent");

const listInputResults = (
  sent: ReadonlyArray<RunnerToController>,
): ReadonlyArray<SessionInputResult> =>
  sent.filter((frame): frame is SessionInputResult => frame._tag === "sessionInputResult");

/** Returns the message of a refused input result, or an empty string when it was not refused. */
const readRefusalMessage = (result: SessionInputResult | undefined): string =>
  result !== undefined && !result.ok ? result.error.message : "";

/** Returns the tag of a refused input result's error, or undefined when it was not refused. */
const readRefusalTag = (
  result: SessionInputResult | undefined,
): AdapterError["_tag"] | undefined =>
  result !== undefined && !result.ok ? result.error._tag : undefined;

/**
 * Checks that the input a start carried was answered once, as refused, with
 * an error of the given tag and a reason that contains `reason`.
 */
const expectStartInputRefused = (
  sent: ReadonlyArray<RunnerToController>,
  reason: string,
  tag: AdapterError["_tag"] = "AdapterFailed",
): void => {
  const results = listInputResults(sent);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ requestId: START_REQUEST, ok: false });
  expect(readRefusalTag(results[0])).toBe(tag);
  expect(readRefusalMessage(results[0])).toContain(reason);
};

describe("one session, start to exit", () => {
  it("sends every event under a sequence that only goes up", async () => {
    const fake = createFake();
    const { supervisor, sent, machine } = buildConnection(fake);

    await runConnected(
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
    await runConnected(
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

describe("an event too large for one frame", () => {
  it("leaves as frames that each fit, numbered one after another, followed by the warning", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);
    const text = "x".repeat(MAX_FRAME_BYTES + 1);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* Effect.sync(() =>
          fake.emit({
            _tag: "content.delta",
            eventId: "e-delta",
            sessionId: SESSION,
            at,
            turnId: "t-1",
            itemId: "i-1",
            streamKind: "assistant_text",
            delta: text,
            raw: { source: "fake", payload: text },
          }),
        );
        yield* waitUntil("sent the warning", () =>
          listSessionEvents(sent).some((frame) => frame.event._tag === "runtime.warning"),
        );
      }),
    );

    const frames = listSessionEvents(sent);
    const tags = frames.map((frame) => frame.event._tag);
    expect(tags[0]).toBe("session.started");
    expect(tags.at(-1)).toBe("runtime.warning");
    expect(tags.slice(1, -1).length).toBeGreaterThan(1);
    expect(tags.slice(1, -1).every((tag) => tag === "content.delta")).toBe(true);
    expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index + 1));
    for (const frame of frames) {
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    }
    const pieces = frames.flatMap((frame) =>
      frame.event._tag === "content.delta" ? [frame.event.delta] : [],
    );
    expect(pieces.join("")).toBe(text);
  });
});

describe("the input a start carries", () => {
  it("is handed to the harness and answered as delivered, with no input frame after the start", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnected(fake, supervisor, supervisor.start(START));

    expect(fake.inputs).toEqual([START_INPUT]);
    expect(listInputResults(sent)).toEqual([
      { _tag: "sessionInputResult", requestId: START_REQUEST, ok: true, delivery: "opened" },
    ]);
  });

  it("is answered as refused, with a runtime error, when the harness refuses it, and the session runs on", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);
    Object.assign(fake.adapter, {
      sendInput: () =>
        Effect.fail(new AdapterFailed({ message: "the harness is not ready for input" })),
    });

    await runConnected(
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
    // guaranteed. `session.started` comes through the watch and the error is
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

describe("a start for a session the adapter already hosts", () => {
  it("is refused as already running, with no runtime error and no exit, and the running session is left alone", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);
    const OTHER = "0199e0e7-0000-7000-8000-0000000000f8";
    const OTHER_REQUEST = "0199e0e7-0000-7000-8000-0000000000f7";

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* waitUntil("sent session.started", () => listSessionEvents(sent).length === 1);
        // The supervisor has no entry for OTHER, so only the adapter knows the session is hosted.
        fake.fails = new SessionAlreadyRunning({ message: "this session is already running" });
        yield* supervisor.start({ ...START, sessionId: OTHER, requestId: OTHER_REQUEST });
        yield* waitUntil("answered both starts", () => listInputResults(sent).length === 2);
        yield* supervisor.report;
      }),
    );

    expect(listInputResults(sent)[1]).toMatchObject({ requestId: OTHER_REQUEST, ok: false });
    expect(readRefusalTag(listInputResults(sent)[1])).toBe("SessionAlreadyRunning");
    expect(listSessionEvents(sent).map((frame) => frame.event._tag)).toEqual(["session.started"]);
    expect(fake.stops).toEqual([]);
  });
});

describe("an input the harness cannot steer into the running turn", () => {
  it("is answered as refused with the harness's message, and puts no runtime error in the thread", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);
    const message = "Not steered: the harness can't start this in the middle of a turn.";

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* waitUntil("sent session.started", () => listSessionEvents(sent).length === 1);
        Object.assign(fake.adapter, {
          sendInput: () => Effect.fail(new SteerRefused({ message })),
        });
        yield* supervisor.input({
          _tag: "sessionInput",
          requestId: REQUEST,
          sessionId: SESSION,
          input: { text: "$review it" },
        });
        yield* waitUntil("answered both inputs", () => listInputResults(sent).length === 2);
      }),
    );

    expect(listInputResults(sent)[1]).toEqual({
      _tag: "sessionInputResult",
      requestId: REQUEST,
      ok: false,
      error: new SteerRefused({ message }),
    });
    expect(listSessionEvents(sent).map((frame) => frame.event._tag)).toEqual(["session.started"]);
  });
});

describe("an input the harness fails on mid-session, with the conversation broken", () => {
  it("is answered as refused and reported in the thread, and the session keeps running", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);
    const message = "The Codex process went away before it answered.";

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* waitUntil("sent session.started", () => listSessionEvents(sent).length === 1);
        Object.assign(fake.adapter, {
          sendInput: () => Effect.fail(new HarnessProtocolError({ message })),
        });
        yield* supervisor.input({
          _tag: "sessionInput",
          requestId: REQUEST,
          sessionId: SESSION,
          input: { text: "go on" },
        });
        yield* waitUntil("sent the runtime error", () =>
          listSessionEvents(sent).some((frame) => frame.event._tag === "runtime.error"),
        );
        yield* supervisor.report;
      }),
    );

    expect(listInputResults(sent)[1]).toEqual({
      _tag: "sessionInputResult",
      requestId: REQUEST,
      ok: false,
      error: new HarnessProtocolError({ message }),
    });
    const events = listSessionEvents(sent).map((frame) => frame.event);
    expect(events.find((event) => event._tag === "runtime.error")).toMatchObject({
      class: "HarnessProtocolError",
      message,
    });
    // The controller has usually queued the input again by the time this
    // error arrives, so ending the session would make a resume run it twice.
    expect(fake.stops).toEqual([]);
    expect(listExitReasons(sent)).toEqual([]);
  });
});

describe("the images of an input", () => {
  const IMAGE = {
    id: "0199e0e7-0000-7000-8000-0000000000a1",
    name: "screenshot.png",
    mimeType: "image/png",
    sizeBytes: 68,
    sha256: "0".repeat(64),
  } as const;

  it("are handed to the adapter as files in the session's own directory, which goes when the session exits", async () => {
    const fake = createFake();
    const fetched: Array<{ readonly dir: string; readonly existed: boolean }> = [];
    const cache: AttachmentCache = {
      fetch: (dir, references) =>
        Effect.sync(() => {
          fetched.push({ dir, existed: existsSync(dir) });
          return references.map((reference) => ({ ...reference, path: join(dir, reference.id) }));
        }),
    };
    const { supervisor, sent, machine } = buildConnection(fake, cache);
    const dir = join(machine.attachmentsDir, SESSION);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.input({
          _tag: "sessionInput",
          requestId: REQUEST,
          sessionId: SESSION,
          input: { text: "what is this?", attachments: [IMAGE] },
        });
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* waitUntil("sent the exit", () => listSessionEvents(sent).length === 2);
      }),
    );

    // The harness learns the directory at start, so Claude can be allowed to
    // read it before any image arrives.
    expect(fake.contexts[0]?.attachmentsDir).toBe(dir);
    expect(fetched).toEqual([{ dir, existed: true }]);
    expect(fake.inputs[1]).toEqual({
      text: "what is this?",
      attachments: [{ ...IMAGE, path: join(dir, IMAGE.id) }],
    });
    expect(existsSync(dir)).toBe(false);
  });

  it("do not stop a session from ending when their directory cannot be removed", async () => {
    // An image download that outlived its input can still be writing into
    // the directory when the session ends, and removal then fails. A parent
    // the runner may not write to makes removal fail the same way, every time.
    const fake = createFake();
    const { supervisor, sent, machine } = buildConnection(fake);
    const dir = join(machine.attachmentsDir, SESSION);

    try {
      await runConnected(
        fake,
        supervisor,
        Effect.gen(function* () {
          yield* supervisor.start(START);
          chmodSync(machine.attachmentsDir, 0o500);
          yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
          yield* waitUntil("sent the exit", () => listSessionEvents(sent).length === 2);
          // The session is gone, so the same id starts again.
          yield* supervisor.start(START);
          yield* waitUntil("sent the second start", () => listSessionEvents(sent).length === 3);
        }),
      );
    } finally {
      chmodSync(machine.attachmentsDir, 0o700);
    }

    expect(existsSync(dir)).toBe(true);
    expect(fake.contexts).toHaveLength(2);
  });

  it("refuse the input without reaching the adapter when one cannot be fetched", async () => {
    const fake = createFake();
    const reason = 'the image "screenshot.png" could not be fetched from the controller: HTTP 404';
    const { supervisor, sent } = buildConnection(fake, { fetch: () => Effect.fail(reason) });

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.input({
          _tag: "sessionInput",
          requestId: REQUEST,
          sessionId: SESSION,
          input: { text: "what is this?", attachments: [IMAGE] },
        });
      }),
    );

    expect(fake.inputs).toEqual([START_INPUT]);
    expect(listInputResults(sent).at(-1)).toMatchObject({ requestId: REQUEST, ok: false });
    expect(readRefusalMessage(listInputResults(sent).at(-1))).toContain(reason);
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
      startSession: (sessionId: string, spec: SessionSpec, ctx: HarnessRunnerContext) => {
        gateEntered = true;
        return Effect.andThen(
          Effect.promise(() => gate),
          original(sessionId, spec, ctx),
        );
      },
    });

    const exit = await runConnected(
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
  it("is a no-op, and leaves the running session its working directory and its GitHub token", async () => {
    const fake = createFake();
    const { supervisor, sent, machine, githubTokenCopies } = buildConnection(fake);
    const scratch = join(machine.scratchDir, SESSION);
    // The replay carries the running session's own session token, so a hold
    // taken for it would be released together with the running session's.
    const withToken: SessionStart = {
      ...START,
      ghToken: "ghs_start-token",
      githubConnectionId: "the-connection",
    };

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(withToken);
        yield* waitUntil("sent the start", () => listSessionEvents(sent).length === 1);
        yield* Effect.sync(() => writeFileSync(join(scratch, "work.txt"), "half a turn"));
        // After a reconnect the controller sends again every command whose work
        // the runner did not report, so a start can arrive twice, and the
        // second must not be destructive (spec 03 section 2.3).
        yield* supervisor.start(withToken);
        // Wait for the watch to read past the duplicate before counting.
        // Otherwise an event the duplicate wrongly published could still be
        // in flight, and the count below would pass too early.
        yield* awaitMarker(fake);
        // Read from the copy the first start seeded: the fake controller never answers.
        expect(yield* Effect.promise(() => githubTokenCopies.read(START.token))).toEqual({
          token: "ghs_start-token",
        });
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

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        // The marker below only proves the watch has read past `session.started`,
        // not that the frame has been sent, so wait for the frame itself.
        yield* waitUntil("sent session.started", () => listSessionEvents(sent).length === 1);
        yield* supervisor.start(START);
        // Wait for the watch to read past the duplicate before counting.
        yield* awaitMarker(fake);
      }),
    );

    expect(fake.inputs).toEqual([START_INPUT]);
    // A duplicate writes no runtime error and ends nothing: the session it
    // duplicates is still running.
    expect(listSessionEvents(sent).map((frame) => frame.event._tag)).toEqual(["session.started"]);
    // Both frames carry the same row, and each is answered once.
    expect(listInputResults(sent)).toEqual([
      { _tag: "sessionInputResult", requestId: START_REQUEST, ok: true, delivery: "opened" },
      {
        _tag: "sessionInputResult",
        requestId: START_REQUEST,
        ok: false,
        error: new SessionAlreadyRunning({
          message: `session ${SESSION} is already running on this runner`,
        }),
      },
    ]);
  });
});

describe("an exit that arrives after the id was started again", () => {
  it("leaves the running session its directory and its place in the table", async () => {
    const fake = createFake();
    const { supervisor, sent, machine } = buildConnection(fake);
    const scratch = join(machine.scratchDir, SESSION);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* waitUntil("sent the start", () => listSessionEvents(sent).length === 1);
        // The exit of an earlier run under the same id, still on its way
        // through the watch when the new one started. The event has the same
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
      startSession: (sessionId: string, spec: SessionSpec, ctx: HarnessRunnerContext) => {
        startCalls += 1;
        if (startCalls === 2) {
          staleExitSentBeforeFreshStart = listSessionEvents(sent).length === 2;
        }
        return originalStartSession(sessionId, spec, ctx);
      },
    });

    await runConnected(
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

    await runConnected(
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
    const { supervisor, sent, machine } = buildConnection(fake);

    await runConnected(
      fake,
      supervisor,
      Effect.flatMap(supervisor.start(START), () =>
        waitUntil("sent the start", () => listSessionEvents(sent).length === 1),
      ),
    );
    // The harness ends between connections. The watch removes the session's
    // entry, but the exit reaches no controller, and nothing sends it again,
    // because there is no outbox.
    await Effect.runPromise(fake.adapter.stopSession(SESSION, "stopped"));
    // The watch handles the exit on its own fiber. Until the watch has removed
    // the entry, which also removes the session's directory, it can still send
    // the exit to the next connection, which would then receive it as an extra
    // event.
    await Effect.runPromise(
      waitUntil(
        "removed the ended session's directory",
        () => !existsSync(join(machine.scratchDir, SESSION)),
      ),
    );
    await runConnected(
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

  it("is started again at once when the supervisor stopped it, as its absolute timeout does", async () => {
    const fake = createFake();
    const { supervisor, sent, machine } = buildConnection(fake);

    await runConnected(
      fake,
      supervisor,
      Effect.flatMap(supervisor.start(START), () =>
        waitUntil("sent the start", () => listSessionEvents(sent).length === 1),
      ),
    );
    // The supervisor stops the harness between connections, the way a timer
    // that fires as a laptop wakes does. The exit reaches no controller.
    await Effect.runPromise(supervisor.stop({ _tag: "sessionStop", sessionId: SESSION }));
    await Effect.runPromise(
      waitUntil(
        "removed the stopped session's directory",
        () => !existsSync(join(machine.scratchDir, SESSION)),
      ),
    );
    // The test clock never moves, so a start that waited for an exit the
    // supervisor had missed would never be answered.
    await runConnectedOnTestClock(
      fake,
      supervisor,
      Effect.flatMap(supervisor.start({ ...START, requestId: REQUEST }), () =>
        waitOnWallClock("sent the second start", () => listSessionEvents(sent).length === 2),
      ),
    );

    expect(fake.contexts).toHaveLength(2);
    expect(listInputResults(sent).map((result) => result.ok)).toEqual([true, true]);
  });
});

describe("the GitHub token a start carries", () => {
  const WITH_TOKEN: SessionStart = {
    ...START,
    ghToken: "ghs_start-token",
    githubConnectionId: "the-connection",
  };
  const NOT_BOUND = { reason: "this runner holds no GitHub token for this session" };

  it("is held for the session from its start until its exit", async () => {
    const fake = createFake();
    const { supervisor, sent, githubTokenCopies } = buildConnection(fake);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(WITH_TOKEN);
        // Read from the copy the start seeded: the fake controller never answers.
        expect(yield* Effect.promise(() => githubTokenCopies.read(START.token))).toEqual({
          token: "ghs_start-token",
        });
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* waitUntil("sent the exit", () =>
          listSessionEvents(sent).some((frame) => frame.event._tag === "session.exited"),
        );
      }),
    );

    expect(await githubTokenCopies.read(START.token)).toEqual(NOT_BOUND);
  });

  it("is released when the adapter fails to start the session", async () => {
    const fake = createFake();
    fake.fails = new AdapterFailed({ message: "no fake-harness on this machine" });
    const { supervisor, githubTokenCopies } = buildConnection(fake);

    await runConnected(fake, supervisor, supervisor.start(WITH_TOKEN));

    expect(await githubTokenCopies.read(START.token)).toEqual(NOT_BOUND);
  });

  it("is released when the context cannot be resolved", async () => {
    const fake = createFake();
    const { supervisor, githubTokenCopies } = buildConnection(fake);

    await runConnected(
      fake,
      supervisor,
      supervisor.start({ ...WITH_TOKEN, spec: { ...SPEC, workspaceId: createId() } }),
    );

    expect(fake.contexts).toEqual([]);
    expect(await githubTokenCopies.read(START.token)).toEqual(NOT_BOUND);
  });

  it("is not held, and not asked for, when the start names no Connection, as from an older controller", async () => {
    const fake = createFake();
    const { supervisor, githubTokenCopies, asked } = buildConnectionAsking(fake, () => ({
      reason: "not reached",
    }));

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start({ ...START, ghToken: "ghs_start-token" });
        expect(yield* Effect.promise(() => githubTokenCopies.read(START.token))).toEqual(NOT_BOUND);
      }),
    );

    expect(fake.contexts[0]?.env["GH_TOKEN"]).toBe("ghs_start-token");
    expect(asked).toEqual([]);
  });

  it("keeps the Connection's copy while another session of it runs", async () => {
    const fake = createFake();
    const { supervisor, sent, githubTokenCopies } = buildConnection(fake);
    const OTHER = "0199e0e7-0000-7000-8000-0000000000c2";

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(WITH_TOKEN);
        yield* supervisor.start({
          ...WITH_TOKEN,
          sessionId: OTHER,
          requestId: "0199e0e7-0000-7000-8000-0000000000c3",
          token: "another-session-token",
        });
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* waitUntil("sent the exit", () =>
          listSessionEvents(sent).some((frame) => frame.event._tag === "session.exited"),
        );
        expect(yield* Effect.promise(() => githubTokenCopies.read(START.token))).toEqual(NOT_BOUND);
        expect(
          yield* Effect.promise(() => githubTokenCopies.read("another-session-token")),
        ).toEqual({
          token: "ghs_start-token",
        });
      }),
    );
  });
});

describe("the GH_TOKEN a session starts with", () => {
  const MINUTE = 60 * 1000;
  const CONNECTED: SessionStart = { ...START, githubConnectionId: "the-connection" };
  const expiresIn = (minutes: number): string =>
    new Date(Date.now() + minutes * MINUTE).toISOString();

  /** Starts a session on a controller that answers as `answer` says, and returns the session's environment, its `GH_TOKEN` and what was asked. */
  const startWith = async (
    frame: SessionStart,
    answer: (sessionToken: string) => ControllerReply,
  ) => {
    const fake = createFake();
    const { supervisor, asked } = buildConnectionAsking(fake, answer);
    await runConnected(fake, supervisor, supervisor.start(frame));
    return { env: fake.contexts[0]?.env["GH_TOKEN"], fullEnv: fake.contexts[0]?.env, asked };
  };

  it("is a fresh start token, without asking the controller", async () => {
    const { env, asked } = await startWith(
      { ...CONNECTED, ghToken: "ghs_start-token", ghTokenExpiresAt: expiresIn(8 * 60) },
      () => ({ token: "ghs_asked" }),
    );

    expect(env).toBe("ghs_start-token");
    expect(asked).toEqual([]);
  });

  it("is the controller's fresh token when the start token expires within 10 minutes", async () => {
    const { env, asked } = await startWith(
      { ...CONNECTED, ghToken: "ghs_start-token", ghTokenExpiresAt: expiresIn(5) },
      () => ({ token: "ghs_asked" }),
    );

    expect(env).toBe("ghs_asked");
    expect(asked).toEqual([START.token]);
  });

  it("is the controller's token when the start carries none", async () => {
    const { env, asked } = await startWith(CONNECTED, () => ({ token: "ghs_asked" }));

    expect(env).toBe("ghs_asked");
    expect(asked).toEqual([START.token]);
  });

  it("is the start token when the controller refuses the ask", async () => {
    const { env } = await startWith(
      { ...CONNECTED, ghToken: "ghs_start-token", ghTokenExpiresAt: expiresIn(5) },
      () => ({ reason: "the Connection is disabled" }),
    );

    expect(env).toBe("ghs_start-token");
  });

  it("is unset when the ask fails and the start carries no token, and the session still commits as the Connection's account", async () => {
    const { env, fullEnv, asked } = await startWith(
      { ...CONNECTED, gitIdentity: { name: "octocat", email: "octocat@users.noreply.github.com" } },
      () => new Error("no connection"),
    );

    expect(env).toBeUndefined();
    expect(asked).toEqual([START.token]);
    // The identity comes from the Connection, not from the token.
    expect(Object.values(fullEnv ?? {})).toContain("octocat@users.noreply.github.com");
  });

  it("starts nothing when a stop arrives while the controller is being asked", async () => {
    const fake = createFake();
    let asking = false;
    let answerAsk: () => void = () => {};
    const { supervisor, sent, githubTokenCopies } = buildConnection(
      fake,
      undefined,
      undefined,
      undefined,
      () =>
        new Promise((resolve) => {
          asking = true;
          answerAsk = () =>
            resolve({ _tag: "githubTokenAnswer", requestId: "r", token: "ghs_late" });
        }),
    );

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* Effect.forkChild(supervisor.start(CONNECTED));
        yield* waitUntil("the start asked the controller", () => asking);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        answerAsk();
        yield* waitUntil("the exit reached the wire", () =>
          listSessionEvents(sent).some((frame) => frame.event._tag === "session.exited"),
        );
      }),
    );

    expect(fake.contexts).toEqual([]);
    expect(listExitReasons(sent)).toEqual(["stopped"]);
    expect(await githubTokenCopies.read(START.token)).toEqual({
      reason: "this runner holds no GitHub token for this session",
    });
  });
});

describe("a session that cannot run here", () => {
  it("ends a session whose harness is not installed, telling the user how to install it", async () => {
    const fake = createFake();
    fake.fails = new HarnessNotInstalled({
      message: "Fake Harness is not installed on this runner.",
    });
    const { supervisor, sent, machine } = buildConnection(fake);

    await runConnected(fake, supervisor, supervisor.start(START));

    const events = listSessionEvents(sent).map((frame) => frame.event);
    expect(events.map((event) => event._tag)).toEqual(["runtime.error", "session.exited"]);
    expect(events[0]).toMatchObject({
      class: "HarnessNotInstalled",
      message: expect.stringContaining(
        `hercule runner install-harness ${RUNNER_ID} --harness fake`,
      ) as string,
    });
    // Not `stopped`: nobody asked for this, and there is nothing to resume.
    expect(events[1]).toMatchObject({ reason: "crash" });
    // And nothing of it is left on disk.
    expect(existsSync(join(machine.scratchDir, SESSION))).toBe(false);
    // The input never reached a harness, and the controller is told so, with the same fix.
    expect(fake.inputs).toEqual([]);
    expectStartInputRefused(
      sent,
      `hercule runner install-harness ${RUNNER_ID} --harness fake`,
      "HarnessNotInstalled",
    );
    // The answer comes before the exit, so the controller has it before the
    // exit closes the session.
    expect(sent.findIndex((frame) => frame._tag === "sessionInputResult")).toBeLessThan(
      sent.findIndex(
        (frame) => frame._tag === "sessionEvent" && frame.event._tag === "session.exited",
      ),
    );
  });

  it("ends a session whose adapter failed to start it for another reason, naming the error in the thread", async () => {
    const fake = createFake();
    fake.fails = new AdapterFailed({ message: "could not write the settings file" });
    const { supervisor, sent } = buildConnection(fake);

    await runConnected(fake, supervisor, supervisor.start(START));

    const events = listSessionEvents(sent).map((frame) => frame.event);
    expect(events.map((event) => event._tag)).toEqual(["runtime.error", "session.exited"]);
    expect(events[0]).toMatchObject({
      class: "AdapterFailed",
      message: "could not write the settings file",
    });
    expect(events[1]).toMatchObject({ reason: "crash" });
    expectStartInputRefused(sent, "could not write the settings file");
  });

  it("ends a start whose output schema is outside the subset, before any harness is asked", async () => {
    const fake = createFake();
    const { supervisor, sent, machine } = buildConnection(fake);

    await runConnected(
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

  it("ends a start for a harness this build has no adapter for", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnected(fake, supervisor, supervisor.start({ ...START, harnessId: "codex/codex" }));

    const events = listSessionEvents(sent).map((frame) => frame.event);
    expect(events[0]).toMatchObject({
      message: expect.stringContaining("does not support the harness") as unknown,
    });
    expect(events[1]).toMatchObject({ _tag: "session.exited", reason: "crash" });
    expectStartInputRefused(sent, "does not support the harness");
  });

  it("reports a defect on the session instead of letting it end the connection", async () => {
    const fake = createFake();
    const { supervisor, sent, machine } = buildConnection(fake);
    fake.dies = true;

    await runConnected(fake, supervisor, supervisor.start(START));

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

    await runConnected(
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

    await runConnected(
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
    expect(readRefusalTag(listInputResults(sent)[0])).toBe("SessionNotRunning");
    expect(readRefusalMessage(listInputResults(sent)[0])).toContain("not running");
  });
});

describe("what the runner sends back for input, interrupts and answers", () => {
  it("reports a delivered input with the delivery the adapter returned", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnected(
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

    await runConnected(
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

    await runConnected(
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

    await runConnected(
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

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.respondToQuestion({
          _tag: "sessionRespondToQuestion",
          sessionId: SESSION,
          requestId: PARK,
          answerId: "answer-1",
          answers,
          modelSelection: START.spec.modelSelection,
        });
      }),
    );

    expect(fake.answered).toEqual([[SESSION, PARK, { answers }]]);
  });

  /** Sends one `sessionRespondToQuestion` frame and returns the result frames the runner replied with. */
  const answerQuestion = async (
    sessionId: string,
    arrange?: (fake: Fake) => void,
  ): Promise<ReadonlyArray<RunnerToController>> => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);
    arrange?.(fake);
    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.respondToQuestion({
          _tag: "sessionRespondToQuestion",
          sessionId,
          requestId: PARK,
          answerId: "answer-1",
          answers: { Storage: "localStorage" },
          modelSelection: START.spec.modelSelection,
        });
      }),
    );
    return sent.filter((frame) => frame._tag === "sessionRespondToQuestionResult");
  };

  it("replies ok to an answer the adapter delivered", async () => {
    expect(await answerQuestion(SESSION)).toEqual([
      { _tag: "sessionRespondToQuestionResult", answerId: "answer-1", ok: true },
    ]);
  });

  it("replies with the adapter's message when it did not deliver the answer", async () => {
    const message = "The question is no longer open.";

    const replies = await answerQuestion(SESSION, (fake) => {
      fake.answerFails = message;
    });

    expect(replies).toEqual([
      { _tag: "sessionRespondToQuestionResult", answerId: "answer-1", ok: false, message },
    ]);
  });

  it("replies not ok to an answer for a session it does not hold", async () => {
    const replies = await answerQuestion("0199e0e7-0000-7000-8000-0000000000aa");

    expect(replies).toHaveLength(1);
    const [reply] = replies;
    expect(reply).toMatchObject({
      _tag: "sessionRespondToQuestionResult",
      answerId: "answer-1",
      ok: false,
    });
    expect(reply !== undefined && "message" in reply ? reply.message : "").toContain(
      "no longer running",
    );
  });
});

/**
 * Like `runConnected`, but with the test clock in place of the wall clock. The
 * watch is forked here when it is not running yet, so it reads the test clock
 * too. Only the supervision timers read it. Every wait on the watch stays on
 * the wall clock, because it waits for another fiber to run, and moving
 * virtual time does not make that happen.
 */
const runConnectedOnTestClock = <A>(
  fake: Fake,
  supervisor: SessionSupervisor,
  body: Effect.Effect<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startWatching(fake);
          yield* TestClock.withLive(awaitMarker(fake));
          yield* supervisor.attach({ controllerReadsFilesEdited: true });
          return yield* body;
        }),
      ),
      TestClock.layer(),
    ),
  );

/** Waits on the watch using the wall clock, while the test clock drives the timers. */
const waitOnWallClock = (what: string, ready: () => boolean): Effect.Effect<void> =>
  TestClock.withLive(waitUntil(what, ready));

/**
 * Waits until the watch has sent at least `count` session events. The watch
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
const buildSubagentAttribution = (subagentId: string | undefined) =>
  subagentId === undefined ? {} : { subagentId };

const emitTurnStarted = (fake: Fake, turnId: string, subagentId?: string): void =>
  fake.emit({
    _tag: "turn.started",
    eventId: `e-${turnId}-started`,
    sessionId: SESSION,
    at,
    turnId,
    ...buildSubagentAttribution(subagentId),
  });

const emitTurnCompleted = (fake: Fake, turnId: string, subagentId?: string): void =>
  fake.emit({
    _tag: "turn.completed",
    eventId: `e-${turnId}-done`,
    sessionId: SESSION,
    at,
    turnId,
    state: "completed",
    ...buildSubagentAttribution(subagentId),
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

    await runConnectedOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        // `session.started` and `turn.started`. The second one starts the
        // inactivity clock as it passes through the watch.
        yield* awaitForwarded(sent, 2);

        yield* TestClock.adjust(INACTIVITY_MS);
        // Wait for the exit frame itself, not only for the stop request to the
        // adapter: the two can be several ticks apart in the watch.
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

    await runConnectedOnTestClock(
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

    await runConnectedOnTestClock(
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

    await runConnectedOnTestClock(
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
    ...buildSubagentAttribution(subagentId),
    request: {
      requestId,
      itemId: "i-1",
      kind: "command_approval",
      decisions: ["allow", "allow_always", "deny", "cancel"],
      detail: { command: "ls -la" },
    },
  });

/**
 * Emits a `request.opened` for an async question: the asking agent does not
 * wait on it, so the supervisor ignores it: it stops neither the inactivity
 * watch nor the idle unload.
 */
const emitAsyncQuestionOpened = (fake: Fake, requestId: string): void =>
  fake.emit({
    _tag: "request.opened",
    eventId: `e-${requestId}-opened`,
    sessionId: SESSION,
    at,
    request: {
      requestId,
      itemId: "i-1",
      kind: "question",
      detail: {
        questions: [
          {
            question: "Which storage should drafts use?",
            header: "Question",
            options: [{ label: "localStorage" }],
            multiSelect: false,
          },
        ],
      },
      async: true,
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
    ...buildSubagentAttribution(subagentId),
  });

/**
 * One of the four events that decide whether the inactivity clock runs: its
 * tag, the turn or request id it carries, and the subagent it belongs to,
 * when it is not the session's own agent's.
 */
type Step = readonly [
  tag:
    | "turn.started"
    | "request.opened"
    | "async_question.opened"
    | "request.resolved"
    | "turn.completed",
  id: string,
  subagentId?: string,
];

const emitStep = (fake: Fake, [tag, id, subagentId]: Step): void => {
  if (tag === "turn.started") return emitTurnStarted(fake, id, subagentId);
  if (tag === "turn.completed") return emitTurnCompleted(fake, id, subagentId);
  if (tag === "request.opened") return emitRequestOpened(fake, id, subagentId);
  if (tag === "async_question.opened") return emitAsyncQuestionOpened(fake, id);
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
    // An async question does not make its agent wait, so the supervisor
    // ignores it and the clock keeps running.
    [
      [
        ["turn.started", "t-1"],
        ["async_question.opened", "r-1"],
      ],
      true,
    ],
    [
      [
        ["turn.started", "t-1"],
        ["async_question.opened", "r-1"],
        ["turn.completed", "t-1"],
        ["turn.started", "t-2"],
      ],
      true,
    ],
    // A blocking Request next to an async question still pauses the clock,
    // and its end resumes it. The async question stays open throughout.
    [
      [
        ["turn.started", "t-1"],
        ["async_question.opened", "r-1"],
        ["request.opened", "r-2"],
      ],
      false,
    ],
    [
      [
        ["turn.started", "t-1"],
        ["async_question.opened", "r-1"],
        ["request.opened", "r-2"],
        ["request.resolved", "r-2"],
      ],
      true,
    ],
  ];

  for (const [sequence, armed] of SEQUENCES) {
    const steps = sequence.map(describeStep).join(" -> ");
    it(`is ${armed ? "watched" : "left alone"} after ${steps}`, async () => {
      const fake = createFake();
      const { supervisor, sent } = buildConnection(fake);

      await runConnectedOnTestClock(
        fake,
        supervisor,
        Effect.gen(function* () {
          yield* supervisor.start(START);
          // Send one event at a time and wait for its frame. The watch updates
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
          // the adapter: the two are several ticks apart in the watch.
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

describe("a session that exits while a subagent's turn and Request are open", () => {
  // A subagent's Request stays open until it is answered, its own turn ends
  // or the session exits, the same rule the controller follows. A subagent
  // that never reports either keeps it open until the exit, and no longer:
  // the session started again under the same id begins with nothing open.
  it("leaves nothing open behind, so the next start is watched as usual", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnectedOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* awaitForwarded(sent, 1);
        const steps: ReadonlyArray<Step> = [
          ["turn.started", "t-1"],
          ["turn.started", "t-2", SUBAGENT],
          ["request.opened", "r-1", SUBAGENT],
          ["turn.completed", "t-1"],
        ];
        let count = 1;
        for (const step of steps) {
          count += 1;
          yield* Effect.sync(() => emitStep(fake, step));
          yield* awaitForwarded(sent, count);
        }

        // The subagent's open Request keeps the session from being watched.
        yield* TestClock.adjust(INACTIVITY_MS * 2);
        expect(fake.stops).toEqual([]);

        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* awaitForwarded(sent, 6);
        yield* supervisor.start(START);
        yield* awaitForwarded(sent, 7);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-3"));
        yield* awaitForwarded(sent, 8);

        yield* TestClock.adjust(INACTIVITY_MS);
        yield* waitOnWallClock("sent the second exit", () => listExitReasons(sent).length === 2);
      }),
    );

    expect(fake.stops).toEqual([
      { sessionId: SESSION, reason: "stopped" },
      { sessionId: SESSION, reason: "inactivity_timeout" },
    ]);
    expect(listExitReasons(sent)).toEqual(["stopped", "inactivity_timeout"]);
  });
});

describe("a session that has run for as long as it may", () => {
  it("is stopped at the absolute deadline, mid-turn and with events still arriving", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnectedOnTestClock(
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

    await runConnectedOnTestClock(
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

    await runConnectedOnTestClock(
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

    await runConnectedOnTestClock(
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

    await runConnectedOnTestClock(
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
      sendInput: () =>
        Effect.fail(new AdapterFailed({ message: "the harness is not ready for input" })),
    });

    await runConnectedOnTestClock(
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
        error: new AdapterFailed({ message: "the harness is not ready for input" }),
      },
    ]);
    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "idle_unload" }]);
    expect(listExitReasons(sent)).toEqual(["idle_unload"]);
  });

  it("is kept by an input frame, and waits idleMs again after the turn that input opened", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnectedOnTestClock(
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

    await runConnectedOnTestClock(
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
        fake.fails = new AdapterFailed({ message: "the harness is busy" });
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

    await runConnectedOnTestClock(
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
    expect(readRefusalTag(listInputResults(sent).at(-1))).toBe("SessionNotRunning");
    expect(readRefusalMessage(listInputResults(sent).at(-1))).toContain("is stopping");
    // The harness was never handed the input.
    expect(fake.inputs).toEqual([START_INPUT]);
  });

  it("is left alone while parked on a permission request, however long it waits", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnectedOnTestClock(
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

    await runConnectedOnTestClock(
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

    await runConnectedOnTestClock(
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

  it("is unloaded idleMs after its turn completed, even with an async question open", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnectedOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(IDLE_START);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        yield* awaitForwarded(sent, 2);
        yield* Effect.sync(() => emitAsyncQuestionOpened(fake, "r-1"));
        yield* awaitForwarded(sent, 3);
        yield* Effect.sync(() => emitTurnCompleted(fake, "t-1"));
        yield* awaitForwarded(sent, 4);

        // An unanswered async question must not pin the runner slot: the
        // session's exit closes it.
        yield* TestClock.adjust(IDLE_MS - 1);
        expect(fake.stops).toEqual([]);

        yield* TestClock.adjust(1);
        yield* waitOnWallClock("sent the exit", () => listExitReasons(sent).length === 1);
      }),
    );

    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "idle_unload" }]);
  });

  /** The frame that answers the open question `PARK`. */
  const ANSWER_FRAME = {
    _tag: "sessionRespondToQuestion",
    sessionId: SESSION,
    requestId: PARK,
    answerId: "answer-1",
    answers: { Storage: "localStorage" },
    modelSelection: START.spec.modelSelection,
  } as const;

  it("is kept by an answer frame, and waits idleMs again after the turn that answer opened", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnectedOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(IDLE_START);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        yield* awaitForwarded(sent, 2);
        yield* Effect.sync(() => emitTurnCompleted(fake, "t-1"));
        yield* awaitForwarded(sent, 3);

        yield* TestClock.adjust(IDLE_MS / 2);
        yield* supervisor.respondToQuestion(ANSWER_FRAME);

        // The first timer would fire now. The answer's turn has not started
        // yet, so only the answer frame can have cancelled the timer.
        yield* TestClock.adjust(IDLE_MS / 2);
        expect(fake.stops).toEqual([]);

        yield* Effect.sync(() => emitTurnStarted(fake, "t-2"));
        yield* Effect.sync(() => emitTurnCompleted(fake, "t-2"));
        yield* awaitForwarded(sent, 5);

        yield* TestClock.adjust(IDLE_MS - 1);
        expect(fake.stops).toEqual([]);

        yield* TestClock.adjust(1);
        yield* waitOnWallClock("sent the exit", () => listExitReasons(sent).length === 1);
      }),
    );

    expect(fake.answered).toEqual([[SESSION, PARK, { answers: ANSWER_FRAME.answers }]]);
    expect(listExitReasons(sent)).toEqual(["idle_unload"]);
  });

  it("waits idleMs again after the adapter refuses an answer", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnectedOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(IDLE_START);
        yield* Effect.sync(() => emitTurnStarted(fake, "t-1"));
        yield* awaitForwarded(sent, 2);
        yield* Effect.sync(() => emitTurnCompleted(fake, "t-1"));
        yield* awaitForwarded(sent, 3);

        // The answer frame cancels the wait, and the refused answer opens no
        // turn, so the session is idle again from the refusal on.
        yield* TestClock.adjust(IDLE_MS / 2);
        fake.answerFails = "The question is no longer open.";
        yield* supervisor.respondToQuestion(ANSWER_FRAME);

        yield* TestClock.adjust(IDLE_MS - 1);
        expect(fake.stops).toEqual([]);

        yield* TestClock.adjust(1);
        yield* waitOnWallClock("sent the exit", () => listExitReasons(sent).length === 1);
      }),
    );

    expect(listExitReasons(sent)).toEqual(["idle_unload"]);
  });

  it("is never unloaded when its spec has no idleMs", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnectedOnTestClock(
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

    await runConnected(
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

    await runConnected(
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

    await runConnected(
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
    const results = listInputResults(sent);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      _tag: "sessionInputResult",
      requestId: START_REQUEST,
      ok: true,
      delivery: "opened",
    });
    expect(results[1]).toMatchObject({ requestId: START_REQUEST, ok: false });
    expect(readRefusalTag(results[1])).toBe("AdapterFailed");
    expect(readRefusalMessage(results[1])).toContain("shutting down");
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
      startSession: (sessionId: string, spec: SessionSpec, ctx: HarnessRunnerContext) => {
        gateEntered = true;
        return Effect.andThen(
          Effect.promise(() => gate),
          original(sessionId, spec, ctx),
        );
      },
    });

    await runConnected(
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
    expectStartInputRefused(sent, "stopped before the input was delivered", "InputNotDelivered");
  });

  it("spawns no harness when it arrives while the start switches the workspace's branch", async () => {
    const fake = createFake();
    const { runner, machine, githubTokenCopies, steps, scope } = buildConnection(fake);
    const remote = makeRemote();
    addBranch(remote, "release");
    const workspaceId = createId();
    await Effect.runPromise(
      machine.workspaces.provision(
        buildProvisionFrame({
          workspaceId,
          kind: "primary",
          checkouts: [buildCheckout({ resourceId: createId(), remote: remote.url })],
        }),
      ),
    );
    const folder = Effect.runSync(machine.workspaces.resolve(workspaceId))!.cwd;

    // Other git work holds the workspace, so the start's branch switch waits
    // for it. `switchAsked` is set once the start asks for the workspace,
    // which is after its own check for a stop and before it adds its entry.
    let switchAsked = false;
    const sent: Array<RunnerToController> = [];
    const supervisor = runner.forConnection({
      scope,
      runnerId: RUNNER_ID,
      githubTokenCopies,
      machine: {
        ...machine,
        workspaces: {
          ...machine.workspaces,
          runExclusively: (id, work) => {
            switchAsked = true;
            return machine.workspaces.runExclusively(id, work);
          },
        },
      },
      workspaceSteps: steps,
      send: (frame) => Effect.sync(() => void sent.push(frame)),
    });
    let releaseWorkspace: () => void = () => {};
    const otherWork = new Promise<void>((resolve) => {
      releaseWorkspace = resolve;
    });

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* Effect.forkChild(
          machine.workspaces.runExclusively(
            workspaceId,
            Effect.promise(() => otherWork),
          ),
        );
        yield* Effect.forkChild(
          supervisor.start({
            ...START,
            spec: { ...SPEC, workspaceId },
            checkoutBranch: "release",
          }),
        );
        yield* waitUntil("the start asked to switch the branch", () => switchAsked);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        releaseWorkspace();
        yield* waitUntil("the exit reached the wire", () =>
          listSessionEvents(sent).some((frame) => frame.event._tag === "session.exited"),
        );
      }),
    );

    // The branch switch ran, but no harness was asked for, so there was none
    // to stop.
    expect(runGitOrThrow(folder, "rev-parse", "--abbrev-ref", "HEAD")).toBe("release");
    expect(fake.contexts).toEqual([]);
    expect(fake.stops).toEqual([]);
    expect(listSessionEvents(sent).map((frame) => frame.event._tag)).toEqual(["session.exited"]);
    expect(listExitReasons(sent)).toEqual(["stopped"]);
    expectStartInputRefused(sent, "stopped before the input was delivered", "InputNotDelivered");
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

    await runConnectedOnTestClock(
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
    expect(readRefusalTag(listInputResults(sent)[1])).toBe("SessionAlreadyRunning");
    expect(readRefusalMessage(listInputResults(sent)[1])).toContain("is still stopping");
    // No second harness was asked for, and the old one was not stopped twice.
    expect(fake.contexts).toHaveLength(1);
    expect(fake.stops).toEqual([{ sessionId: SESSION, reason: "stopped" }]);
  });

  it("keeps its entry when the old exit is handled after the adapter dropped the old session", async () => {
    const fake = createFake();
    const { runner, machine, githubTokenCopies, steps, scope } = buildConnection(fake);
    // The watch holds this event until the test lets it go, so the old exit,
    // published after it, is handled only then.
    const HOLD: HarnessEvent = { ...MARKER, eventId: "e-hold" };
    let releaseHold: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const sent: Array<RunnerToController> = [];
    const supervisor = runner.forConnection({
      scope,
      runnerId: RUNNER_ID,
      machine,
      githubTokenCopies,
      workspaceSteps: steps,
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
    // Set for the second start: its `listSessions` call lets the watch go, and
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
      startSession: (sessionId: string, spec: SessionSpec, ctx: HarnessRunnerContext) =>
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

    await runConnected(
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

    await runConnected(
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
    expectStartInputRefused(sent, "The runner is shutting down");
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

    await runConnected(
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

    await runConnected(
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

/** The agent step the tests' step input carries. */
const STEP: WorkspaceStepKey = {
  runId: "0199e0e7-0000-7000-8000-0000000000e1",
  stepId: "review",
  iteration: 1,
};

/** The input that starts the step's turn. The fake adapter opens turn `TURN` for it. */
const STEP_INPUT = {
  _tag: "sessionInput",
  requestId: REQUEST,
  sessionId: SESSION,
  input: { text: "Review the change.", step: STEP },
} as const;

/** The start the controller sends again for the step, to ask for its result. */
const STEP_START = {
  _tag: "workspaceStepStart",
  kind: "agent",
  ...STEP,
  sessionId: SESSION,
  workspaceId: null,
} as const;

const SCHEMA_START: SessionStart = { ...START, spec: { ...SPEC, outputSchema: FIXTURE_SCHEMA } };

/** A session start whose input is the step's prompt, as for a step's first turn. */
const STEP_SESSION_START: SessionStart = { ...START, input: STEP_INPUT.input };

const listStepResults = (
  sent: ReadonlyArray<RunnerToController>,
): ReadonlyArray<WorkspaceStepResult> =>
  sent.filter((frame): frame is WorkspaceStepResult => frame._tag === "workspaceStepResult");

/** Returns the position in `sent` of the first session event with the given tag, or -1. */
const findEventIndex = (
  sent: ReadonlyArray<RunnerToController>,
  tag: HarnessEvent["_tag"],
): number => sent.findIndex((frame) => frame._tag === "sessionEvent" && frame.event._tag === tag);

/** Emits the end of turn `TURN`, with the fields that say how it ended. */
const emitStepTurnEnd = (
  fake: Fake,
  fields: Pick<
    Extract<HarnessEvent, { _tag: "turn.completed" }>,
    "state" | "error" | "structuredResult"
  >,
): void =>
  fake.emit({
    _tag: "turn.completed",
    eventId: "e-step-turn-done",
    sessionId: SESSION,
    at,
    turnId: TURN,
    ...fields,
  });

const emitText = (fake: Fake, itemId: string, delta: string): void =>
  fake.emit({
    _tag: "content.delta",
    eventId: `e-${itemId}-${delta}`,
    sessionId: SESSION,
    at,
    turnId: TURN,
    itemId,
    streamKind: "assistant_text",
    delta,
  });

describe("an agent step's turn", () => {
  it("completes the step with the structured result, sent before the turn's end", async () => {
    const fake = createFake();
    const { supervisor, sent, steps } = buildConnection(fake);
    const verdict = { verdict: "accept", confidence: 0.9, summary: "A typo fix." };

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(SCHEMA_START);
        yield* supervisor.input(STEP_INPUT);
        expect(steps.listInFlight()).toEqual([STEP]);
        yield* Effect.sync(() =>
          emitStepTurnEnd(fake, {
            state: "completed",
            structuredResult: { outcome: "ok", value: verdict },
          }),
        );
        yield* waitUntil("sent the turn's end", () => findEventIndex(sent, "turn.completed") >= 0);
        // A start sent again after the turn ended is answered from the result file.
        yield* steps.start(STEP_START);
      }),
    );

    const results = listStepResults(sent);
    expect(results.map((frame) => frame.outcome)).toEqual([
      { status: "completed", output: verdict },
      { status: "completed", output: verdict },
    ]);
    expect(results[0]).toMatchObject(STEP);
    // The controller has the step's result before it sees the turn end.
    expect(sent.indexOf(results[0] as RunnerToController)).toBeLessThan(
      findEventIndex(sent, "turn.completed"),
    );
    expect(steps.listInFlight()).toEqual([]);
  });

  it("completes the step with the turn's final message when the session has no output schema", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.input(STEP_INPUT);
        yield* Effect.sync(() => {
          emitText(fake, "i-1", "Reading the diff.");
          fake.emit({
            _tag: "content.delta",
            eventId: "e-reasoning",
            sessionId: SESSION,
            at,
            turnId: TURN,
            itemId: "i-2",
            streamKind: "reasoning_text",
            delta: "Thinking about it.",
          });
          emitText(fake, "i-3", "All tests ");
          emitText(fake, "i-3", "pass.");
          emitStepTurnEnd(fake, { state: "completed" });
        });
        yield* waitUntil("sent the step result", () => listStepResults(sent).length === 1);
      }),
    );

    // Only the last assistant message counts, and reasoning is not a message.
    expect(listStepResults(sent)[0]?.outcome).toEqual({
      status: "completed",
      output: { text: "All tests pass.", exitStatus: "completed" },
    });
  });

  it("reads only the session's own agent: a subagent's turn end and text do not settle the step", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);
    const subagent = { subagentId: SUBAGENT };

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.input(STEP_INPUT);
        yield* Effect.sync(() => {
          emitText(fake, "i-1", "Asked a helper.");
          // A Claude Code subagent writes inside its parent's turn; a Codex
          // subagent runs a turn of its own.
          fake.emit({
            _tag: "content.delta",
            eventId: "e-sub-text",
            sessionId: SESSION,
            at,
            turnId: TURN,
            itemId: "i-sub",
            streamKind: "assistant_text",
            delta: "The helper's answer.",
            ...subagent,
          });
          fake.emit({
            _tag: "turn.started",
            eventId: "e-sub-turn",
            sessionId: SESSION,
            at,
            turnId: "t-sub",
            ...subagent,
          });
          fake.emit({
            _tag: "turn.completed",
            eventId: "e-sub-turn-done",
            sessionId: SESSION,
            at,
            turnId: "t-sub",
            state: "completed",
            ...subagent,
          });
        });
        yield* waitUntil(
          "sent the subagent's turn end",
          () => findEventIndex(sent, "turn.completed") >= 0,
        );
        expect(listStepResults(sent)).toEqual([]);
        yield* Effect.sync(() => emitStepTurnEnd(fake, { state: "completed" }));
        yield* waitUntil("sent the step result", () => listStepResults(sent).length === 1);
      }),
    );

    expect(listStepResults(sent)[0]?.outcome).toEqual({
      status: "completed",
      output: { text: "Asked a helper.", exitStatus: "completed" },
    });
  });

  it("fails the step with schema_failure when the result does not match the schema", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(SCHEMA_START);
        yield* supervisor.input(STEP_INPUT);
        yield* Effect.sync(() =>
          emitStepTurnEnd(fake, {
            state: "completed",
            structuredResult: { outcome: "schema-failure", reason: "missing property verdict" },
          }),
        );
        yield* waitUntil("sent the step result", () => listStepResults(sent).length === 1);
      }),
    );

    expect(listStepResults(sent)[0]?.outcome).toEqual({
      status: "failed",
      code: "schema_failure",
      message:
        "The turn gave no valid result for the step's output schema: missing property verdict",
    });
  });

  it("fails the step with schema_failure, naming the size, when the result is too large for one frame", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);
    const verdict = { verdict: "accept", confidence: 0.9, summary: "x".repeat(MAX_FRAME_BYTES) };

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(SCHEMA_START);
        yield* supervisor.input(STEP_INPUT);
        yield* Effect.sync(() =>
          emitStepTurnEnd(fake, {
            state: "completed",
            structuredResult: { outcome: "ok", value: verdict },
          }),
        );
        yield* waitUntil("sent the warning", () => findEventIndex(sent, "runtime.warning") >= 0);
      }),
    );

    const outcome = listStepResults(sent)[0]?.outcome;
    expect(outcome).toMatchObject({ status: "failed", code: "schema_failure" });
    expect(outcome?.status === "failed" ? outcome.message : "").toMatch(
      /^The turn gave no valid result for the step's output schema: The turn's structured result was 2\.\d\d MiB, too large to send \(the limit is 2 MiB\)\.$/,
    );
    // The turn still ends, for the controller as for the supervisor, and the
    // warning follows it.
    expect(findEventIndex(sent, "turn.completed")).toBeLessThan(
      findEventIndex(sent, "runtime.warning"),
    );
  });

  it("fails the step with session_failed when its turn fails", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.input(STEP_INPUT);
        yield* Effect.sync(() => emitStepTurnEnd(fake, { state: "failed", error: "rate limited" }));
        yield* waitUntil("sent the step result", () => listStepResults(sent).length === 1);
      }),
    );

    expect(listStepResults(sent)[0]?.outcome).toEqual({
      status: "failed",
      code: "session_failed",
      message: "The step's turn failed: rate limited",
    });
  });

  it("fails the step with session_failed when the session is stopped mid-turn, before the exit is sent", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.input(STEP_INPUT);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* waitUntil("sent the exit", () => listExitReasons(sent).length === 1);
      }),
    );

    const results = listStepResults(sent);
    expect(results.map((frame) => frame.outcome)).toEqual([
      {
        status: "failed",
        code: "session_failed",
        message: "The session ended before the step's turn finished, because it was stopped.",
      },
    ]);
    // The controller ignores the exit of a step's session, because the step's
    // result always arrives first.
    expect(sent.indexOf(results[0] as RunnerToController)).toBeLessThan(
      findEventIndex(sent, "session.exited"),
    );
  });

  it("fails the step when the session hits its inactivity timeout, before the exit is sent", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnectedOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.input(STEP_INPUT);
        yield* Effect.sync(() => emitTurnStarted(fake, TURN));
        yield* awaitForwarded(sent, 2);
        yield* TestClock.adjust(INACTIVITY_MS);
        yield* waitOnWallClock("sent the exit", () => listExitReasons(sent).length === 1);
      }),
    );

    expect(listExitReasons(sent)).toEqual(["inactivity_timeout"]);
    const results = listStepResults(sent);
    expect(results.map((frame) => frame.outcome)).toEqual([
      {
        status: "failed",
        code: "session_failed",
        message:
          "The session ended before the step's turn finished, because it reported nothing for longer than its inactivity timeout.",
      },
    ]);
    expect(sent.indexOf(results[0] as RunnerToController)).toBeLessThan(
      findEventIndex(sent, "session.exited"),
    );
  });

  it("sends no step result for a turn that no step input opened", async () => {
    const fake = createFake();
    const { supervisor, sent, steps } = buildConnection(fake);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.input({ ...STEP_INPUT, input: { text: "hi" } });
        yield* Effect.sync(() => emitStepTurnEnd(fake, { state: "completed" }));
        yield* waitUntil("sent the turn's end", () => findEventIndex(sent, "turn.completed") >= 0);
        yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
        yield* waitUntil("sent the exit", () => listExitReasons(sent).length === 1);
      }),
    );

    expect(listStepResults(sent)).toEqual([]);
    expect(steps.listInFlight()).toEqual([]);
  });

  it("sends no step result when the harness refuses the step's input, because no turn ran", async () => {
    const fake = createFake();
    const { supervisor, sent, steps } = buildConnection(fake);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* waitUntil("sent the start", () => listSessionEvents(sent).length === 1);
        fake.fails = new AdapterFailed({ message: "the harness is busy" });
        yield* supervisor.input(STEP_INPUT);
        expect(steps.listInFlight()).toEqual([]);
        // A turn that ends now is not the step's: the step's turn never opened.
        yield* Effect.sync(() => emitStepTurnEnd(fake, { state: "completed" }));
        yield* waitUntil("sent the turn's end", () => findEventIndex(sent, "turn.completed") >= 0);
      }),
    );

    expect(listInputResults(sent)).toMatchObject([
      { requestId: START_REQUEST, ok: true },
      { requestId: REQUEST, ok: false },
    ]);
    expect(listStepResults(sent)).toEqual([]);
  });

  it("holds a start sent again while the turn runs, and answers it once at the turn's end", async () => {
    const fake = createFake();
    const { supervisor, sent, steps } = buildConnection(fake);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.input(STEP_INPUT);
        yield* steps.start(STEP_START);
        expect(listStepResults(sent)).toEqual([]);
        yield* Effect.sync(() => emitStepTurnEnd(fake, { state: "completed" }));
        yield* waitUntil("sent the step result", () => listStepResults(sent).length === 1);
        // Read past the turn's end, so a second result would already be sent.
        yield* awaitMarker(fake);
      }),
    );

    expect(listStepResults(sent)).toHaveLength(1);
  });

  it("delivers a step's input in full when its connection closes while the harness takes it, and answers the step at the turn's end", async () => {
    const fake = createFake();
    const { supervisor, sent, steps } = buildConnection(fake);
    const gate = Deferred.makeUnsafe<void>();

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* waitUntil("sent the start", () => listSessionEvents(sent).length === 1);
        fake.inputGate = gate;
        // The connection handles each frame in a fiber, and interrupts that
        // fiber when its socket closes.
        const handling = yield* Effect.forkChild(supervisor.input(STEP_INPUT));
        // The start's own input was the first.
        yield* waitUntil("passed the input to the harness", () => fake.inputsBegun() === 2);
        // Signal the interrupt now, before the harness answers, as a socket
        // closing mid-input would. `Fiber.interrupt` forked here might only
        // run after the gate opens.
        handling.interruptUnsafe();
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.await(handling);
        expect(fake.inputs).toEqual([START_INPUT, STEP_INPUT.input]);
        expect(listInputResults(sent)).toMatchObject([
          { requestId: START_REQUEST, ok: true },
          { requestId: REQUEST, ok: true },
        ]);

        // The controller asks for the step's result once the runner is back.
        // The turn still runs, so the turn's end answers it.
        yield* steps.start(STEP_START);
        expect(listStepResults(sent)).toEqual([]);
        yield* Effect.sync(() => emitStepTurnEnd(fake, { state: "completed" }));
        yield* waitUntil("sent the step result", () => listStepResults(sent).length === 1);
      }),
    );

    expect(listStepResults(sent)[0]?.outcome).toMatchObject({ status: "completed" });
  });

  it("refuses the input of a step settled before its input arrived, so no turn runs for it", async () => {
    const fake = createFake();
    const { supervisor, sent, steps } = buildConnection(fake);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        // The run ended just as the controller sent the step's input, so the
        // settle arrived first. Stopping the session is the controller's call.
        yield* steps.settle({ _tag: "workspaceStepSettle", steps: [STEP] });
        yield* supervisor.input(STEP_INPUT);
        // Read past anything the refusal sent.
        yield* awaitMarker(fake);
      }),
    );

    // A turn of a run that has ended could still push or comment.
    expect(fake.inputs).toEqual([START_INPUT]);
    expect(listInputResults(sent).slice(1)).toEqual([
      {
        _tag: "sessionInputResult",
        requestId: REQUEST,
        ok: false,
        error: new InputNotDelivered({
          message:
            "the step ended before its prompt reached the harness, so the prompt was not run",
        }),
      },
    ]);
    expect(listStepResults(sent)).toEqual([]);
    expect(steps.listInFlight()).toEqual([]);
  });

  it("begins the step for a session start whose input carries it, and sends the step's result before that turn's end", async () => {
    const fake = createFake();
    const { supervisor, sent, steps } = buildConnection(fake);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        // A step's first prompt rides the start of its session.
        yield* supervisor.start(STEP_SESSION_START);
        expect(steps.listInFlight()).toEqual([STEP]);
        yield* Effect.sync(() => {
          emitText(fake, "i-1", "Looks good.");
          emitStepTurnEnd(fake, { state: "completed" });
        });
        yield* waitUntil("sent the turn's end", () => findEventIndex(sent, "turn.completed") >= 0);
      }),
    );

    expect(listInputResults(sent)).toMatchObject([{ requestId: START_REQUEST, ok: true }]);
    const results = listStepResults(sent);
    expect(results.map((frame) => frame.outcome)).toEqual([
      { status: "completed", output: { text: "Looks good.", exitStatus: "completed" } },
    ]);
    expect(sent.indexOf(results[0] as RunnerToController)).toBeLessThan(
      findEventIndex(sent, "turn.completed"),
    );
    expect(steps.listInFlight()).toEqual([]);
  });

  it("refuses the input of a session start that carries a settled step, and the idle unload ends the session", async () => {
    const fake = createFake();
    const { supervisor, sent, steps } = buildConnection(fake);

    await runConnectedOnTestClock(
      fake,
      supervisor,
      Effect.gen(function* () {
        // The run ended just as the controller sent the start, so the settle
        // arrived first.
        yield* steps.settle({ _tag: "workspaceStepSettle", steps: [STEP] });
        yield* supervisor.start({
          ...STEP_SESSION_START,
          spec: { ...SPEC, timeouts: { ...SPEC.timeouts, idleMs: IDLE_MS } },
        });
        expect(fake.stops).toEqual([]);
        // The refused input opened no turn, so nothing but the idle unload
        // would ever end the session.
        yield* TestClock.adjust(IDLE_MS);
        yield* waitOnWallClock("sent the exit", () => listExitReasons(sent).length === 1);
      }),
    );

    // A turn of a run that has ended could still push or comment.
    expect(fake.inputs).toEqual([]);
    expect(listInputResults(sent)).toEqual([
      {
        _tag: "sessionInputResult",
        requestId: START_REQUEST,
        ok: false,
        error: new InputNotDelivered({
          message:
            "the step ended before its prompt reached the harness, so the prompt was not run",
        }),
      },
    ]);
    expect(listExitReasons(sent)).toEqual(["idle_unload"]);
    expect(listStepResults(sent)).toEqual([]);
    expect(steps.listInFlight()).toEqual([]);
  });

  it("forgets the step when the harness refuses the step's input a session start carries", async () => {
    const fake = createFake();
    const { supervisor, sent, steps } = buildConnection(fake);
    Object.assign(fake.adapter, {
      sendInput: () =>
        Effect.fail(new AdapterFailed({ message: "the harness is not ready for input" })),
    });

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(STEP_SESSION_START);
        expect(steps.listInFlight()).toEqual([]);
        // The controller asks for the step's result once it has the refusal.
        // No turn ran, and the runner says so.
        yield* steps.start(STEP_START);
      }),
    );

    expect(listInputResults(sent)).toMatchObject([{ requestId: START_REQUEST, ok: false }]);
    expect(readRefusalMessage(listInputResults(sent)[0])).toBe(
      "the harness is not ready for input",
    );
    expect(listStepResults(sent).map((frame) => frame.outcome)).toMatchObject([
      { status: "failed", code: "interrupted" },
    ]);
  });

  it("is not ended by the exit of an earlier run under the same session id", async () => {
    const fake = createFake();
    const { supervisor, sent } = buildConnection(fake);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.input(STEP_INPUT);
        // The adapter still holds the session, so this exit belongs to an
        // earlier run that was still on its way through the watch.
        yield* Effect.sync(() =>
          fake.emit({
            _tag: "session.exited",
            eventId: "e-old",
            sessionId: SESSION,
            at,
            reason: "process_exit",
          }),
        );
        yield* waitUntil("sent the stale exit", () => listExitReasons(sent).length === 1);
        yield* Effect.sync(() => emitStepTurnEnd(fake, { state: "completed" }));
        yield* waitUntil("sent the step result", () => listStepResults(sent).length === 1);
      }),
    );

    expect(listStepResults(sent)[0]?.outcome).toMatchObject({ status: "completed" });
  });

  it("answers a start sent again with the session's failure when the session ended while no connection was attached", async () => {
    const fake = createFake();
    const { supervisor, sent, steps } = buildConnection(fake);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start(START);
        yield* supervisor.input(STEP_INPUT);
      }),
    );
    // The harness exits while no connection is attached. The watch still
    // reads the exit, and ends the step with it.
    await Effect.runPromise(fake.adapter.stopSession(SESSION, "process_exit"));
    await Effect.runPromise(waitUntil("ended the step", () => steps.listInFlight().length === 0));
    await Effect.runPromise(steps.start(STEP_START));

    expect(listStepResults(sent).map((frame) => frame.outcome)).toMatchObject([
      { status: "failed", code: "session_failed" },
      { status: "failed", code: "session_failed" },
    ]);
  });
});

it("reports current checkout facts after start and resume before any turn ends, without repeating setup", async () => {
  const fake = createFake();
  const { supervisor, sent, machine, under } = buildConnection(fake);
  const remote = makeRemote();
  addBranch(remote, "release");
  const setupMarker = join(under, "setup-count");
  const frame = buildProvisionFrame({
    kind: "primary",
    checkouts: [
      buildCheckout({
        resourceId: createId(),
        remote: remote.url,
        setupCommand: `printf 'setup\\n' >> '${setupMarker}'`,
      }),
    ],
  });
  expect((await Effect.runPromise(machine.workspaces.provision(frame))).status).toBe("ready");
  const cwd = Effect.runSync(machine.workspaces.resolve(frame.workspaceId))!.cwd;
  const reports = (): ReadonlyArray<WorkspaceReport> =>
    sent.filter((message): message is WorkspaceReport => message._tag === "workspaceReport");

  await runConnected(
    fake,
    supervisor,
    Effect.gen(function* () {
      yield* supervisor.start({
        ...START,
        spec: { ...SPEC, workspaceId: frame.workspaceId },
        checkoutBranch: "release",
      });
      yield* waitUntil("reported the branch selected at start", () =>
        reports().some((report) => report.checkouts?.[0]?.branch === "release"),
      );
      expect(reports()[0]?.checkouts?.[0]?.headCommit).toBe(
        runGitOrThrow(cwd, "rev-parse", "HEAD"),
      );
      expect(listSessionEvents(sent).map((event) => event.event._tag)).toEqual(["session.started"]);
      yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
      yield* waitUntil("reported the stopped checkout", () => reports().length >= 2);
      const beforeResume = reports().length;
      yield* supervisor.start({
        ...START,
        requestId: REQUEST,
        spec: {
          ...SPEC,
          workspaceId: frame.workspaceId,
          continue: { nativeSessionId: NATIVE, mode: "resume" },
        },
        checkoutBranch: "main",
      });
      yield* waitUntil(
        "reported the branch selected at resume",
        () =>
          reports().length > beforeResume && reports().at(-1)?.checkouts?.[0]?.branch === "main",
      );
      expect(reports().at(-1)?.checkouts?.[0]?.headCommit).toBe(
        runGitOrThrow(cwd, "rev-parse", "HEAD"),
      );
      expect(listSessionEvents(sent).map((event) => event.event._tag)).toEqual([
        "session.started",
        "session.exited",
        "session.started",
      ]);
      yield* supervisor.stop({ _tag: "sessionStop", sessionId: SESSION });
      yield* waitUntil("ended the resumed session", () => listSessionEvents(sent).length === 4);
    }),
  );
  expect(readFileSync(setupMarker, "utf8")).toBe("setup\n");
  expect(fake.contexts).toHaveLength(2);
  expect(fake.contexts.map((context) => context.cwd)).toEqual([cwd, cwd]);
});

describe("an agent step's turn that ends while no connection is attached", () => {
  it("saves the step's outcome, and a later connection is answered from it", async () => {
    const fake = createFake();
    const { supervisor, sent, steps } = buildConnection(fake);

    await runConnected(
      fake,
      supervisor,
      Effect.flatMap(supervisor.start(STEP_SESSION_START), () =>
        waitUntil("sent the start", () => listSessionEvents(sent).length === 1),
      ),
    );
    emitText(fake, "i-1", "All tests pass.");
    emitStepTurnEnd(fake, { state: "completed" });
    await Effect.runPromise(
      waitUntil("finished the step", () => steps.listInFlight().length === 0),
    );
    await runConnected(fake, supervisor, steps.start(STEP_START));

    expect(listStepResults(sent).at(-1)?.outcome).toEqual({
      status: "completed",
      output: { exitStatus: "completed", text: "All tests pass." },
    });
  });
});

describe("the files an edit changed", () => {
  /** Provisions a workspace with one checkout and returns what an edit is measured against. */
  const provisionRepository = async (machine: Machine, kind: WorkspaceKind = "primary") => {
    const resourceId = createId();
    const workspaceId = createId();
    await Effect.runPromise(
      machine.workspaces.provision(
        buildProvisionFrame({
          workspaceId,
          kind,
          checkouts: [
            buildCheckout({
              resourceId,
              remote: makeRemote().url,
              // An ephemeral workspace works on a branch of its own.
              ...(kind === "ephemeral" ? { branch: `work-${createId()}` } : {}),
            }),
          ],
        }),
      ),
    );
    return {
      resourceId,
      workspaceId,
      cwd: Effect.runSync(machine.workspaces.resolve(workspaceId))!.cwd,
    };
  };

  const completedEdit = (itemId: string, status: ItemStatus, extra: Partial<HarnessEvent> = {}) =>
    ({
      _tag: "item.completed",
      eventId: `e-done-${itemId}`,
      sessionId: SESSION,
      at,
      turnId: "t-1",
      itemId,
      kind: "file_change",
      status,
      ...extra,
    }) as HarnessEvent;

  /**
   * Starts a session in a fresh repository, emits `events`, and returns the
   * events that reached the wire once the last one has.
   */
  const runEdits = async (
    buildEvents: (repository: { readonly cwd: string }) => ReadonlyArray<HarnessEvent>,
  ): Promise<ReadonlyArray<HarnessEvent>> => {
    const fake = createFake();
    const { supervisor, sent, machine } = buildConnection(fake);
    const repository = await provisionRepository(machine);
    const events = buildEvents(repository);
    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start({
          ...START,
          spec: { ...SPEC, workspaceId: repository.workspaceId },
        });
        yield* waitUntil("sent the start", () => listSessionEvents(sent).length === 1);
        for (const event of events) fake.emit(event);
        fake.emit(buildLastEvent());
        yield* waitUntil("sent the last event", () =>
          listSessionEvents(sent).some((frame) => frame.event.eventId === "e-last"),
        );
      }),
    );
    return listSessionEvents(sent).map((frame) => frame.event);
  };

  const buildLastEvent = (): HarnessEvent => ({
    _tag: "runtime.warning",
    eventId: "e-last",
    sessionId: SESSION,
    at,
    message: "last",
  });

  const findCompleted = (events: ReadonlyArray<HarnessEvent>, itemId: string) =>
    events.find((event) => event._tag === "item.completed" && event.itemId === itemId);

  it("reports the paths of a completed event itself, relative to the working directory", async () => {
    const events = await runEdits(() => [
      completedEdit("i-1", "completed", { detail: { paths: ["a.ts", "b/c.ts"] } }),
    ]);
    expect(findCompleted(events, "i-1")).toMatchObject({
      editedFiles: [{ path: "a.ts" }, { path: "b/c.ts" }],
    });
  });

  it("reports no files for an edit that failed or was declined", async () => {
    const events = await runEdits(() => [
      completedEdit("i-1", "failed", { detail: { path: "a.ts" } }),
      completedEdit("i-2", "declined", { detail: { path: "a.ts" } }),
    ]);
    expect(findCompleted(events, "i-1")).not.toHaveProperty("editedFiles");
    expect(findCompleted(events, "i-2")).not.toHaveProperty("editedFiles");
  });

  it("reports nothing for a path outside the checkout, and for items of other kinds", async () => {
    const events = await runEdits(() => [
      completedEdit("i-1", "completed", { detail: { path: "/etc/hosts" } }),
      completedEdit("i-2", "completed", {
        kind: "command_execution",
        detail: { path: "a.ts" },
      }),
    ]);
    expect(findCompleted(events, "i-1")).not.toHaveProperty("editedFiles");
    expect(findCompleted(events, "i-2")).not.toHaveProperty("editedFiles");
  });

  it("records no files and writes no warning when an edit of only outside paths exceeds the examining budget", async () => {
    const paths = Array.from({ length: 1100 }, (_, index) => `/elsewhere/f${String(index)}.ts`);
    const events = await runEdits(() => [completedEdit("i-1", "completed", { detail: { paths } })]);
    expect(findCompleted(events, "i-1")).not.toHaveProperty("editedFiles");
    expect(
      events.filter((event) => event._tag === "runtime.warning" && event.eventId !== "e-last"),
    ).toEqual([]);
  });

  it("keeps a subagent's id on the completed event", async () => {
    const events = await runEdits(() => [
      completedEdit("i-1", "completed", { subagentId: SUBAGENT, detail: { path: "sub.ts" } }),
    ]);
    expect(findCompleted(events, "i-1")).toMatchObject({
      subagentId: SUBAGENT,
      editedFiles: [{ path: "sub.ts" }],
    });
  });

  it("keeps the first 256 files of a larger edit, and writes no warning about the rest", async () => {
    const paths = Array.from({ length: 300 }, (_, index) => `f${String(index)}.ts`);
    const events = await runEdits(() => [completedEdit("i-1", "completed", { detail: { paths } })]);
    const completed = findCompleted(events, "i-1");
    expect(completed?._tag === "item.completed" ? completed.editedFiles : undefined).toHaveLength(
      256,
    );
    expect(
      events.filter((event) => event._tag === "runtime.warning" && event.eventId !== "e-last"),
    ).toEqual([]);
  });

  describe("the files a command changed", () => {
    const SECOND_SESSION = "0199e0e7-0000-7000-8000-0000000000f9";

    const completedCommand = (
      itemId: string,
      status: ItemStatus = "completed",
      sessionId = SESSION,
    ) => ({
      ...completedEdit(itemId, status, { kind: "command_execution" }),
      eventId: `e-done-${itemId}-${sessionId}`,
      sessionId,
    });

    const startedCommand = (itemId: string, sessionId = SESSION) =>
      ({
        _tag: "item.started",
        eventId: `e-start-${itemId}-${sessionId}`,
        sessionId,
        at,
        turnId: "t-1",
        itemId,
        kind: "command_execution",
      }) as HarnessEvent;

    /**
     * Waits until the file clock has moved on, so that writes before this call
     * are strictly older than marks taken after it, even on a filesystem whose
     * clock ticks every few milliseconds.
     */
    const waitForClockTick = (machine: Machine) => {
      const before = machine.fileClock.takeMark();
      while (machine.fileClock.takeMark() <= before);
    };

    /**
     * Does what a harness's hook does before a command runs: writes its start
     * mark in the marks directory of the session's current start.
     */
    const markStart = (machine: Machine, itemId: string, sessionId = SESSION) => {
      waitForClockTick(machine);
      const sessionsDir = join(machine.editMarksDir, "sessions");
      const [sessionMarksDir] = readdirSync(sessionsDir).filter((name) =>
        name.startsWith(`${sessionId}-`),
      );
      writeStartMark(join(sessionsDir, sessionMarksDir!), { toolUseId: itemId });
    };

    const listFilesEdited = (sent: ReadonlyArray<RunnerToController>) =>
      sent.flatMap((frame) => (frame._tag === "filesEdited" ? [frame] : []));

    const listEditedPaths = (sent: ReadonlyArray<RunnerToController>) =>
      listFilesEdited(sent).flatMap((frame) => frame.editedFiles.map((file) => file.path));

    const listWarnings = (sent: ReadonlyArray<RunnerToController>, sessionId = SESSION) =>
      listSessionEvents(sent).flatMap((frame) =>
        frame.event._tag === "runtime.warning" &&
        frame.event.sessionId === sessionId &&
        frame.event.eventId.startsWith("e-last") === false
          ? [frame.event.message]
          : [],
      );

    /** Waits until the wire holds an event of this session with this id. */
    const waitForEvent = (sent: ReadonlyArray<RunnerToController>, eventId: string) =>
      waitUntil(`sent event ${eventId}`, () =>
        listSessionEvents(sent).some((frame) => frame.event.eventId === eventId),
      );

    /**
     * Emits an event that the event loop handles after every earlier one, and
     * waits for it to reach the wire. Once it has, the loop has finished what
     * the earlier events asked for, including forking a check.
     */
    const waitForLoop = (fake: Fake, sent: ReadonlyArray<RunnerToController>) =>
      Effect.suspend(() => {
        const eventId = `e-last-${crypto.randomUUID()}`;
        fake.emit({ ...buildLastEvent(), eventId });
        return waitForEvent(sent, eventId);
      });

    const startSession = (
      supervisor: SessionSupervisor,
      sent: ReadonlyArray<RunnerToController>,
      workspaceId: string | null,
      sessionId = SESSION,
    ) =>
      Effect.gen(function* () {
        yield* supervisor.start({
          ...START,
          sessionId,
          spec: { ...SPEC, workspaceId },
        });
        yield* waitUntil(`started ${sessionId}`, () =>
          listSessionEvents(sent).some(
            (frame) =>
              frame.event.sessionId === sessionId && frame.event._tag === "session.started",
          ),
        );
      });

    it("sends the files a finished command changed, in a frame beside the session's events", async () => {
      const fake = createFake();
      const { supervisor, sent, machine } = buildConnection(fake);
      const repository = await provisionRepository(machine, "ephemeral");
      await runConnected(
        fake,
        supervisor,
        Effect.gen(function* () {
          yield* startSession(supervisor, sent, repository.workspaceId);
          markStart(machine, "c-1");
          writeFileSync(join(repository.cwd, "made-by-sed.txt"), "x\n");
          fake.emit(completedCommand("c-1"));
          yield* waitUntil("sent the frame", () => listFilesEdited(sent).length === 1);
          expect(listFilesEdited(sent)[0]).toMatchObject({
            sessionId: SESSION,
            editedFiles: [{ path: "made-by-sed.txt" }],
          });
          expect(listWarnings(sent)).toEqual([]);
          // The command's own event went out without waiting for git.
          const eventIndex = sent.findIndex(
            (frame) =>
              frame._tag === "sessionEvent" && frame.event.eventId === `e-done-c-1-${SESSION}`,
          );
          expect(eventIndex).toBeGreaterThanOrEqual(0);
          expect(eventIndex).toBeLessThan(sent.findIndex((frame) => frame._tag === "filesEdited"));
        }),
      );
    });

    it("does not observe a session in the main workspace, and writes no warning to it", async () => {
      const fake = createFake();
      const { supervisor, sent, machine } = buildConnection(fake);
      const repository = await provisionRepository(machine, "primary");
      await runConnected(
        fake,
        supervisor,
        Effect.gen(function* () {
          yield* startSession(supervisor, sent, repository.workspaceId);
          writeFileSync(join(repository.cwd, "a.txt"), "x\n");
          fake.emit(completedCommand("c-1"));
          fake.emit(completedCommand("c-2"));
          yield* waitForLoop(fake, sent);
          expect(listFilesEdited(sent)).toEqual([]);
          expect(listWarnings(sent)).toEqual([]);
        }),
      );
    });

    it("observes both sessions of one workspace, each for its own commands", async () => {
      const fake = createFake();
      const { supervisor, sent, machine } = buildConnection(fake);
      const repository = await provisionRepository(machine, "ephemeral");
      await runConnected(
        fake,
        supervisor,
        Effect.gen(function* () {
          yield* startSession(supervisor, sent, repository.workspaceId);
          // A second session joins, as a reviewer joins a worker's workspace.
          yield* startSession(supervisor, sent, repository.workspaceId, SECOND_SESSION);
          markStart(machine, "c-1");
          writeFileSync(join(repository.cwd, "worker.txt"), "x\n");
          fake.emit(completedCommand("c-1"));
          yield* waitUntil("sent the worker's file", () => listFilesEdited(sent).length === 1);
          markStart(machine, "c-2", SECOND_SESSION);
          writeFileSync(join(repository.cwd, "reviewer.txt"), "x\n");
          fake.emit(completedCommand("c-2", "completed", SECOND_SESSION));
          yield* waitUntil("sent the reviewer's file", () => listFilesEdited(sent).length === 2);
          expect(
            listFilesEdited(sent).map((frame) => [
              frame.sessionId,
              frame.editedFiles.map((file) => file.path),
            ]),
          ).toEqual([
            [SESSION, ["worker.txt"]],
            [SECOND_SESSION, ["reviewer.txt"]],
          ]);
          expect(listWarnings(sent, SESSION)).toEqual([]);
          expect(listWarnings(sent, SECOND_SESSION)).toEqual([]);
        }),
      );
    });

    it("starts a fresh watch after the last one ended, without blaming the new session for old changes", async () => {
      const fake = createFake();
      const { supervisor, sent, machine } = buildConnection(fake);
      const repository = await provisionRepository(machine, "ephemeral");
      await runConnected(
        fake,
        supervisor,
        Effect.gen(function* () {
          yield* startSession(supervisor, sent, repository.workspaceId, SECOND_SESSION);
          yield* supervisor.stop({ _tag: "sessionStop", sessionId: SECOND_SESSION });
          yield* waitUntil("sent the exit", () =>
            listSessionEvents(sent).some((frame) => frame.event._tag === "session.exited"),
          );
          // The user leaves a change behind while no watch runs.
          writeFileSync(join(repository.cwd, "left-behind.txt"), "x\n");
          yield* startSession(supervisor, sent, repository.workspaceId);
          markStart(machine, "c-1");
          writeFileSync(join(repository.cwd, "new.txt"), "x\n");
          fake.emit(completedCommand("c-1"));
          yield* waitUntil("sent the frame", () => listFilesEdited(sent).length === 1);
          expect(listEditedPaths(sent)).toEqual(["new.txt"]);
        }),
      );
    });

    it("makes a second start in a workspace wait while the first takes the workspace's state, so a later session's files are not baked into the first one's baseline", async () => {
      const fake = createFake();
      const slowGit = makeSlowFirstReflog();
      const { supervisor, sent, machine } = buildConnection(fake, undefined, slowGit.path);
      const repository = await provisionRepository(machine, "ephemeral");
      slowGit.hold();
      await runConnected(
        fake,
        supervisor,
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(
            startSession(supervisor, sent, repository.workspaceId),
          );
          yield* waitUntil("entered the slow git", slowGit.hasEntered);
          const second = yield* Effect.forkChild(
            startSession(supervisor, sent, repository.workspaceId, SECOND_SESSION),
          );
          // Without the wait, the second start would finish while the first is held.
          yield* Effect.sleep(300);
          expect(
            listSessionEvents(sent).some((frame) => frame.event.sessionId === SECOND_SESSION),
          ).toBe(false);
          slowGit.release();
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          // The second session writes a file and ends. The first session's
          // read-only command must not be blamed for it.
          markStart(machine, "b-1", SECOND_SESSION);
          writeFileSync(join(repository.cwd, "b.txt"), "x\n");
          fake.emit(completedCommand("b-1", "completed", SECOND_SESSION));
          yield* waitUntil("sent the second session's file", () =>
            listFilesEdited(sent).some((frame) => frame.sessionId === SECOND_SESSION),
          );
          yield* supervisor.stop({ _tag: "sessionStop", sessionId: SECOND_SESSION });
          yield* waitUntil("sent the exit", () =>
            listSessionEvents(sent).some((frame) => frame.event._tag === "session.exited"),
          );
          markStart(machine, "a-1");
          fake.emit(completedCommand("a-1"));
          yield* waitForLoop(fake, sent);
          expect(
            listFilesEdited(sent).flatMap((frame) =>
              frame.sessionId === SESSION ? frame.editedFiles.map((file) => file.path) : [],
            ),
          ).toEqual([]);
        }),
      );
    });

    it("sends no file and no warning when both sessions' windows hold the write", async () => {
      const fake = createFake();
      const { supervisor, sent, machine } = buildConnection(fake);
      const repository = await provisionRepository(machine, "ephemeral");
      await runConnected(
        fake,
        supervisor,
        Effect.gen(function* () {
          yield* startSession(supervisor, sent, repository.workspaceId);
          yield* startSession(supervisor, sent, repository.workspaceId, SECOND_SESSION);
          for (const sessionId of [SESSION, SECOND_SESSION]) {
            markStart(machine, "c-1", sessionId);
            fake.emit(startedCommand("c-1", sessionId));
          }
          writeFileSync(join(repository.cwd, "who.txt"), "x\n");
          fake.emit(completedCommand("c-1"));
          fake.emit(completedCommand("c-1", "completed", SECOND_SESSION));
          yield* waitForEvent(sent, `e-done-c-1-${SECOND_SESSION}`);
          // A later command of one session alone shows that the listings are done.
          markStart(machine, "c-2");
          fake.emit(startedCommand("c-2"));
          writeFileSync(join(repository.cwd, "alone.txt"), "x\n");
          waitForClockTick(machine);
          fake.emit(completedCommand("c-2"));
          yield* waitUntil("sent the later file", () =>
            listEditedPaths(sent).includes("alone.txt"),
          );
          expect(listEditedPaths(sent)).toEqual(["alone.txt"]);
          expect(listWarnings(sent, SESSION)).toEqual([]);
          expect(listWarnings(sent, SECOND_SESSION)).toEqual([]);
        }),
      );
    });

    it("gives each session its own file when their commands overlap but the writes do not", async () => {
      const fake = createFake();
      const { supervisor, sent, machine } = buildConnection(fake);
      const repository = await provisionRepository(machine, "ephemeral");
      await runConnected(
        fake,
        supervisor,
        Effect.gen(function* () {
          yield* startSession(supervisor, sent, repository.workspaceId);
          yield* startSession(supervisor, sent, repository.workspaceId, SECOND_SESSION);
          // The first command writes a.txt and runs on. The second starts
          // after that write and writes b.txt after the first command ended.
          markStart(machine, "c-1");
          writeFileSync(join(repository.cwd, "a.txt"), "x\n");
          markStart(machine, "c-2", SECOND_SESSION);
          fake.emit(completedCommand("c-1"));
          yield* waitForEvent(sent, `e-done-c-1-${SESSION}`);
          waitForClockTick(machine);
          writeFileSync(join(repository.cwd, "b.txt"), "x\n");
          waitForClockTick(machine);
          fake.emit(completedCommand("c-2", "completed", SECOND_SESSION));
          yield* waitUntil("sent both files", () => listEditedPaths(sent).length === 2);
          expect(
            listFilesEdited(sent).map((frame) => [
              frame.sessionId,
              frame.editedFiles.map((file) => file.path),
            ]),
          ).toEqual([
            [SESSION, ["a.txt"]],
            [SECOND_SESSION, ["b.txt"]],
          ]);
          expect(listWarnings(sent, SESSION)).toEqual([]);
          expect(listWarnings(sent, SECOND_SESSION)).toEqual([]);
        }),
      );
    });

    it("sends the live sessions' files again on a new connection, and not those of the session that exited", async () => {
      const fake = createFake();
      const { supervisor, runner, sent, machine, githubTokenCopies, steps, scope } =
        buildConnection(fake);
      const exiting = await provisionRepository(machine, "ephemeral");
      const staying = await provisionRepository(machine, "ephemeral");
      await runConnected(
        fake,
        supervisor,
        Effect.gen(function* () {
          // The exiting session starts first, so a check of it would be the first on the new connection.
          yield* startSession(supervisor, sent, exiting.workspaceId, SECOND_SESSION);
          yield* startSession(supervisor, sent, staying.workspaceId);
          markStart(machine, "c-1", SECOND_SESSION);
          markStart(machine, "c-2");
          writeFileSync(join(exiting.cwd, "exiting.txt"), "x\n");
          writeFileSync(join(staying.cwd, "staying.txt"), "x\n");
          fake.emit(completedCommand("c-1", "completed", SECOND_SESSION));
          fake.emit(completedCommand("c-2"));
          yield* waitUntil("sent both files", () => listEditedPaths(sent).length === 2);
          yield* supervisor.stop({ _tag: "sessionStop", sessionId: SECOND_SESSION });
          yield* waitUntil("sent the exit", () =>
            listSessionEvents(sent).some((frame) => frame.event._tag === "session.exited"),
          );
        }),
      );
      await Effect.runPromise(Scope.close(scope, Exit.void));

      const nextScope = Effect.runSync(Scope.make());
      attachments.push(nextScope);
      // The test's watch ran in the closed scope, so it starts again in the new one.
      watchers.set(fake, { runner, scope: nextScope, watching: false });
      const nextSent: Array<RunnerToController> = [];
      const next = runner.forConnection({
        scope: nextScope,
        runnerId: RUNNER_ID,
        machine,
        githubTokenCopies,
        workspaceSteps: steps,
        send: (frame) => Effect.sync(() => void nextSent.push(frame)),
      });
      await runConnected(
        fake,
        next,
        Effect.gen(function* () {
          yield* waitUntil("sent the file", () => listEditedPaths(nextSent).length >= 1);
          // A command after the new connection's first round of checks. A check
          // of the exited session would have been forked first and finished by now.
          markStart(machine, "c-3");
          writeFileSync(join(staying.cwd, "later.txt"), "x\n");
          fake.emit(completedCommand("c-3"));
          yield* waitUntil("sent the later file", () =>
            listEditedPaths(nextSent).includes("later.txt"),
          );
        }),
      );
      expect(listEditedPaths(nextSent)).toEqual(["staying.txt", "later.txt"]);
    });
  });
});

/** Two Skill Revisions, for the starts that name skills. */
const IMPLEMENT = await buildTestSkillRevision({ "SKILL.md": "# implement" });
const REVIEW = await buildTestSkillRevision({ "SKILL.md": "# review" });

describe("the skills a start names", () => {
  const OTHER_SESSION = "0199e0e7-0000-7000-8000-0000000000ee";

  /** Starts a stub controller serving the given revisions. */
  const serve = (...revisions: ReadonlyArray<TestSkillRevision>): SkillControllerStub => {
    const stub = startSkillController(
      Object.fromEntries(revisions.map((revision) => [revision.revisionHash, revision.archive])),
    );
    stops.push(stub.stop);
    return stub;
  };
  const stops: Array<() => void> = [];
  afterAll(() => {
    for (const stop of stops.splice(0)) stop();
  });

  /** Stops a session and waits until its exit has been sent, which is after its teardown. */
  const stopAndAwaitExit = (
    supervisor: SessionSupervisor,
    sent: ReadonlyArray<RunnerToController>,
    sessionId: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const before = listExitReasons(sent).length;
      yield* supervisor.stop({ _tag: "sessionStop", sessionId });
      yield* waitUntil("sent the exit", () => listExitReasons(sent).length > before);
    });

  /** Returns the start folders in `session-skills/`, or an empty list when it does not exist. */
  const listSessionSkillsFolders = (under: string): ReadonlyArray<string> => {
    const dir = join(under, "session-skills");
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  /**
   * Waits until `session-skills/` holds exactly `expected`. A start's folder
   * is removed in the background after its session ends, so a test waits for
   * the removal rather than checking at once.
   */
  const waitForSessionSkillsFolders = (
    under: string,
    expected: ReadonlyArray<string>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const matches = () =>
        JSON.stringify([...listSessionSkillsFolders(under)].sort()) ===
        JSON.stringify([...expected].sort());
      yield* waitUntil(`left session-skills/ holding ${JSON.stringify(expected)}`, matches);
    });

  it("hands the harness a session skills folder of its own, and removes it when the session exits", async () => {
    const fake = createFake();
    const stub = serve(IMPLEMENT);
    const { supervisor, sent, under } = buildConnection(fake, undefined, undefined, stub.url);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start({
          ...START,
          skills: [buildTestLibrarySkillRevision("implement", IMPLEMENT)],
        });
        const folder = fake.contexts[0]?.librarySkillsFolder ?? "";
        expect(dirname(folder)).toBe(join(under, "session-skills"));
        expect(basename(folder).startsWith(`${SESSION}-`)).toBe(true);
        expect(readFileSync(join(folder, "skills", "implement", "SKILL.md"), "utf8")).toBe(
          "# implement",
        );
        expect(existsSync(join(folder, ".claude-plugin", "plugin.json"))).toBe(true);
        yield* stopAndAwaitExit(supervisor, sent, SESSION);
      }),
    );

    await Effect.runPromise(waitForSessionSkillsFolders(under, []));
  });

  it("gives a start that names no skills no folder", async () => {
    const fake = createFake();
    const { supervisor } = buildConnection(fake);

    await runConnected(fake, supervisor, supervisor.start(START));

    expect(fake.contexts[0]).toBeDefined();
    expect(fake.contexts[0]?.librarySkillsFolder).toBeUndefined();
    expect(fake.contexts[0]?.sessionSkillsFolder).toBeUndefined();
  });

  it("gives two sessions that name one revision each their own copy, and keeps one when the other exits", async () => {
    const fake = createFake();
    const stub = serve(IMPLEMENT, REVIEW);
    const { supervisor, sent, under } = buildConnection(fake, undefined, undefined, stub.url);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start({
          ...START,
          skills: [buildTestLibrarySkillRevision("implement", IMPLEMENT)],
        });
        yield* supervisor.start({
          ...START,
          requestId: REQUEST,
          sessionId: OTHER_SESSION,
          skills: [
            buildTestLibrarySkillRevision("implement", IMPLEMENT),
            buildTestLibrarySkillRevision("review", REVIEW),
          ],
        });
        const first = fake.contexts[0]?.librarySkillsFolder ?? "";
        const other = fake.contexts[1]?.librarySkillsFolder ?? "";
        expect(readdirSync(join(first, "skills"))).toEqual(["implement"]);
        expect(readdirSync(join(other, "skills")).sort()).toEqual(["implement", "review"]);
        yield* stopAndAwaitExit(supervisor, sent, SESSION);
        yield* waitForSessionSkillsFolders(under, [basename(other)]);
        yield* stopAndAwaitExit(supervisor, sent, OTHER_SESSION);
      }),
    );

    // Each start fetches every skill it names.
    expect([...stub.requested].sort()).toEqual(
      [IMPLEMENT.revisionHash, IMPLEMENT.revisionHash, REVIEW.revisionHash].sort(),
    );
    await Effect.runPromise(waitForSessionSkillsFolders(under, []));
  });

  it("gives a session started again a new folder, with the skills of the new start", async () => {
    const fake = createFake();
    const stub = serve(IMPLEMENT, REVIEW);
    const { supervisor, sent, under } = buildConnection(fake, undefined, undefined, stub.url);

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start({
          ...START,
          skills: [buildTestLibrarySkillRevision("implement", IMPLEMENT)],
        });
        yield* stopAndAwaitExit(supervisor, sent, SESSION);
        // The resume, after the library's `implement` skill was replaced by `review`.
        yield* supervisor.start({
          ...START,
          requestId: REQUEST,
          skills: [buildTestLibrarySkillRevision("review", REVIEW)],
        });
      }),
    );

    expect(fake.contexts).toHaveLength(2);
    const resumed = fake.contexts[1]?.librarySkillsFolder ?? "";
    expect(resumed).not.toBe(fake.contexts[0]?.librarySkillsFolder);
    expect(readdirSync(join(resumed, "skills"))).toEqual(["review"]);
    await Effect.runPromise(waitForSessionSkillsFolders(under, [basename(resumed)]));
  });

  /** Provisions a primary workspace and returns it with the directory of its one checkout. */
  const provisionWorkspace = async (machine: Machine) => {
    const workspaceId = createId();
    await Effect.runPromise(
      machine.workspaces.provision(
        buildProvisionFrame({
          workspaceId,
          kind: "primary",
          checkouts: [buildCheckout({ resourceId: createId(), remote: makeRemote().url })],
        }),
      ),
    );
    return { workspaceId, cwd: Effect.runSync(machine.workspaces.resolve(workspaceId))!.cwd };
  };

  /** Writes `<cwd>/.agents/skills/<folderName>/SKILL.md` with the given frontmatter lines. */
  const writeRepositorySkill = (cwd: string, folderName: string, frontmatter: string): string => {
    const folder = join(cwd, ".agents", "skills", folderName);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), `---\n${frontmatter}\n---\n`);
    return folder;
  };

  it("hands the harness the repository skills of the workspace, linked and not copied, and removes them when the session exits", async () => {
    const fake = createFake();
    const { supervisor, sent, machine, under } = buildConnection(fake);
    const { workspaceId, cwd } = await provisionWorkspace(machine);
    const skillFolder = writeRepositorySkill(cwd, "ship", "description: Ships it");
    // Skipped, and no reason to refuse the start.
    writeRepositorySkill(cwd, "Bad_Name", "description: Not a valid name");

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start({ ...START, spec: { ...SPEC, workspaceId } });
        const [pluginFolder, ...others] = fake.contexts[0]?.repositorySkillsFolders ?? [];
        expect(others).toEqual([]);
        expect(dirname(dirname(pluginFolder ?? ""))).toMatch(
          new RegExp(`session-skills/${SESSION}-[^/]+$`),
        );
        const plugin = JSON.parse(
          readFileSync(join(pluginFolder ?? "", ".claude-plugin", "plugin.json"), "utf8"),
        ) as { name: string };
        expect(plugin.name).toBe(`repo-${basename(pluginFolder ?? "")}`);
        expect(realpathSync(join(pluginFolder ?? "", "skills", "ship"))).toBe(
          realpathSync(skillFolder),
        );
        // The start named no skills of the library, but the folder that
        // holds the repository skills is the session skills folder.
        expect(fake.contexts[0]?.librarySkillsFolder).toBeUndefined();
        expect(fake.contexts[0]?.sessionSkillsFolder).toBe(dirname(dirname(pluginFolder ?? "")));
        // The adapter is told where the checkouts are.
        expect(fake.contexts[0]?.checkoutPaths?.map((path) => realpathSync(path))).toEqual([
          realpathSync(cwd),
        ]);
        yield* stopAndAwaitExit(supervisor, sent, SESSION);
      }),
    );

    await Effect.runPromise(waitForSessionSkillsFolders(under, []));
  });

  it("hands the adapter the Skill References of an input that name a skill the process loaded", async () => {
    const fake = createFake();
    const stub = serve(IMPLEMENT);
    const { supervisor, sent, machine, under } = buildConnection(
      fake,
      undefined,
      undefined,
      stub.url,
    );
    const { workspaceId, cwd } = await provisionWorkspace(machine);
    const shipFolder = writeRepositorySkill(cwd, "ship", "description: Ships it");

    await runConnected(
      fake,
      supervisor,
      Effect.gen(function* () {
        yield* supervisor.start({
          ...START,
          spec: { ...SPEC, workspaceId },
          skills: [buildTestLibrarySkillRevision("implement", IMPLEMENT)],
        });
        const checkoutName = basename(fake.contexts[0]?.repositorySkillsFolders?.[0] ?? "");
        // Added after the start: listed by a later read, but the process never loaded it.
        writeRepositorySkill(cwd, "late", "description: Too late");
        const text = `$implement then $${checkoutName}:ship, $${checkoutName}:late, $nope`;
        yield* supervisor.input({
          _tag: "sessionInput",
          requestId: REQUEST,
          sessionId: SESSION,
          input: { text },
        });
        const librarySkillsFolder = fake.contexts[0]?.librarySkillsFolder ?? "";
        expect(fake.inputs[1]).toEqual({
          text,
          skillReferences: [
            {
              source: "library",
              skillName: "implement",
              folder: join(librarySkillsFolder, "skills", "implement"),
              referenceName: "implement",
              start: 0,
              end: 10,
            },
            {
              source: "repository",
              skillName: "ship",
              checkoutName,
              folder: realpathSync(shipFolder),
              referenceName: `${checkoutName}:ship`,
              start: 16,
              end: 16 + 1 + checkoutName.length + ":ship".length,
            },
          ],
        });
        // An input without references carries no field.
        expect(fake.inputs[0]).toEqual(START_INPUT);
        yield* stopAndAwaitExit(supervisor, sent, SESSION);
      }),
    );

    await Effect.runPromise(waitForSessionSkillsFolders(under, []));
  });

  it("refuses a start whose repository skills cannot be staged, and removes the directories it made", async () => {
    const fake = createFake();
    const { supervisor, sent, machine, under } = buildConnection(fake);
    const { workspaceId, cwd } = await provisionWorkspace(machine);
    writeRepositorySkill(cwd, "ship", "description: Ships it");
    // A file where the session skills folders go, so staging into one fails.
    writeFileSync(join(under, "session-skills"), "not a directory");

    await runConnected(
      fake,
      supervisor,
      supervisor.start({ ...START, spec: { ...SPEC, workspaceId } }),
    );

    expectStartInputRefused(sent, "The Thread did not start.");
    expect(readRefusalMessage(listInputResults(sent)[0])).toContain(
      "The runner could not prepare the session's skills folder:",
    );
    expect(listExitReasons(sent)).toEqual(["crash"]);
    expect(fake.contexts).toEqual([]);
    // The directories the start made before it failed are gone.
    expect(existsSync(join(machine.attachmentsDir, SESSION))).toBe(false);
  });

  it("gives a session whose workspace holds no repository skills no folder and no field", async () => {
    const fake = createFake();
    const { supervisor, machine, under } = buildConnection(fake);
    const { workspaceId } = await provisionWorkspace(machine);

    await runConnected(
      fake,
      supervisor,
      supervisor.start({ ...START, spec: { ...SPEC, workspaceId } }),
    );

    expect(fake.contexts[0]).toBeDefined();
    expect(fake.contexts[0]?.repositorySkillsFolders).toBeUndefined();
    expect(listSessionSkillsFolders(under)).toEqual([]);
  });

  it("refuses a start whose skill cannot be fetched, naming the skill, and leaves nothing behind", async () => {
    const fake = createFake();
    const stub = serve();
    const { supervisor, sent, under } = buildConnection(fake, undefined, undefined, stub.url);

    await runConnected(
      fake,
      supervisor,
      supervisor.start({
        ...START,
        skills: [buildTestLibrarySkillRevision("implement", IMPLEMENT)],
      }),
    );

    const message = `Could not load skill \`implement\` (revision ${IMPLEMENT.revisionHash.slice(0, 8)}...) from the controller: No applied Skill Revision has this hash. The Thread did not start.`;
    expectStartInputRefused(sent, message);
    const events = listSessionEvents(sent).map((frame) => frame.event);
    expect(events.map((event) => event._tag)).toEqual(["runtime.error", "session.exited"]);
    expect(events[0]).toMatchObject({ message });
    expect(listExitReasons(sent)).toEqual(["crash"]);
    // No harness was asked for.
    expect(fake.contexts).toEqual([]);
    await Effect.runPromise(waitForSessionSkillsFolders(under, []));
  });

  it("refuses a resume whose skill cannot be fetched, with the same message", async () => {
    const fake = createFake();
    const stub = serve();
    const { supervisor, sent } = buildConnection(fake, undefined, undefined, stub.url);

    await runConnected(
      fake,
      supervisor,
      supervisor.start({
        ...START,
        spec: { ...SPEC, continue: { nativeSessionId: NATIVE, mode: "resume" } },
        skills: [buildTestLibrarySkillRevision("implement", IMPLEMENT)],
      }),
    );

    const message = `Could not load skill \`implement\` (revision ${IMPLEMENT.revisionHash.slice(0, 8)}...) from the controller: No applied Skill Revision has this hash. The Thread did not start.`;
    expectStartInputRefused(sent, message);
    const events = listSessionEvents(sent).map((frame) => frame.event);
    expect(events.map((event) => event._tag)).toEqual(["runtime.error", "session.exited"]);
    expect(events[0]).toMatchObject({ message });
    expect(fake.contexts).toEqual([]);
  });
});

describe("the Git boundary at a workspace root", () => {
  /**
   * Provisions an ephemeral workspace with `count` checkouts, each in a
   * folder of its own under the root, and returns the workspace and its root.
   */
  const provisionCheckouts = async (machine: Machine, count: number) => {
    const workspaceId = createId();
    await Effect.runPromise(
      machine.workspaces.provision(
        buildProvisionFrame({
          workspaceId,
          kind: "ephemeral",
          checkouts: Array.from({ length: count }, (_, at) =>
            buildCheckout({
              resourceId: createId(),
              remote: makeRemote().url,
              subdirectory: `repo-${String(at)}`,
              branch: `work-${createId()}`,
            }),
          ),
        }),
      ),
    );
    return { workspaceId, ...Effect.runSync(machine.workspaces.resolve(workspaceId))! };
  };

  it.each([0, 2])(
    "marks the root of a workspace with %i checkouts with an empty .git file",
    async (count) => {
      const fake = createFake();
      const { supervisor, machine } = buildConnection(fake);
      const { workspaceId, root, cwd } = await provisionCheckouts(machine, count);
      expect(cwd).toBe(root);
      expect(existsSync(join(root, ".git"))).toBe(false);

      await runConnected(
        fake,
        supervisor,
        supervisor.start({ ...START, spec: { ...SPEC, workspaceId } }),
      );

      expect(fake.contexts[0]?.cwd).toBe(root);
      expect(lstatSync(join(root, ".git")).isFile()).toBe(true);
      expect(readFileSync(join(root, ".git"), "utf8")).toBe("");
    },
  );

  it("leaves the checkout of a single-checkout workspace, and its root, alone", async () => {
    const fake = createFake();
    const { supervisor, machine } = buildConnection(fake);
    const { workspaceId, root, checkouts } = await provisionCheckouts(machine, 1);
    const checkout = checkouts[0]!.path;
    const before = hashContents(checkout);

    await runConnected(
      fake,
      supervisor,
      supervisor.start({ ...START, spec: { ...SPEC, workspaceId } }),
    );

    expect(fake.contexts[0]?.cwd).toBe(checkout);
    expect(hashContents(checkout)).toBe(before);
    expect(existsSync(join(root, ".git"))).toBe(false);
  });

  it("refuses a start whose root cannot be marked, without naming a path, and starts no harness", async () => {
    const fake = createFake();
    const { supervisor, sent, machine } = buildConnection(fake);
    const { workspaceId, root } = await provisionCheckouts(machine, 0);
    chmodSync(root, 0o500);

    try {
      await runConnected(
        fake,
        supervisor,
        supervisor.start({ ...START, spec: { ...SPEC, workspaceId } }),
      );
    } finally {
      chmodSync(root, 0o700);
    }

    expectStartInputRefused(
      sent,
      "The runner could not prepare the workspace folder for the session: the .git file that marks the workspace folder could not be created (EACCES). The Thread did not start.",
    );
    expect(readRefusalMessage(listInputResults(sent)[0])).not.toContain(root);
    expect(fake.contexts).toEqual([]);
    expect(existsSync(join(root, ".git"))).toBe(false);
  });
});
