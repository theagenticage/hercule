/**
 * Tests Antigravity sessions through the `HarnessAdapter` interface. A fake
 * `agy` plays the recordings in `packages/acp/src/recordings` over the pipes of
 * a real process. Where a test needs a message no recording has (an orphaned
 * request, a mode change, a process that does not answer), it starts from the
 * recording's handshake only and writes the messages itself. Time runs on a
 * `TestClock`.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import type { HarnessScript, JsonRpcMessage } from "@hercule/acp/testing";
import type { HarnessEvent, SessionSpec } from "@hercule/protocol";
import type { AdapterTurnInput } from "../index";
import { cleanupHomes, CWD, settle, waitUntil, writeTestImage } from "../testing";
import { makeAntigravityAdapter } from "./adapter";
import {
  answerConfigChange,
  answerNewSession,
  answerResume,
  BINARY,
  buildContext,
  buildFakeAgy,
  CONVERSATION,
  createConversationFiles,
  createSignedInHome,
  noAnswer,
  readRecordedSetup,
  refuse,
  type FakeAgyOptions,
} from "./fake-agy.testing";

afterEach(() => {
  cleanupHomes();
  configCalls = 0;
});

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const ACCOUNT = "0199e0e7-0000-7000-8000-00000000000a";

/** The model and level the recordings' `session/new` replies already hold. */
const SPEC: SessionSpec = {
  providerAccountId: ACCOUNT,
  workspaceId: null,
  modelSelection: { model: "gemini-4-hydrogen", options: { effort: "high" } },
  accessMode: "approval-required",
  timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
};

const buildInput = (text: string = "Do it.", extra: Partial<AdapterTurnInput> = {}) => ({
  text,
  ...extra,
});

interface HarnessOptions {
  /** The fake's options, which may depend on the Harness Home the test gets. */
  readonly fake?: FakeAgyOptions | ((home: string) => FakeAgyOptions);
  readonly orientation?: string;
  /** What every start of the test changes in `SPEC`. */
  readonly spec?: Partial<SessionSpec>;
}

const buildHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const home = createSignedInHome();
    const fake = buildFakeAgy(
      home,
      typeof options.fake === "function" ? options.fake(home) : options.fake,
    );
    const adapter = makeAntigravityAdapter(fake);
    const seen: Array<HarnessEvent> = [];
    yield* Effect.forkScoped(
      Stream.runForEach(adapter.events, (event) =>
        Effect.sync(() => {
          seen.push(event);
        }),
      ),
    );
    yield* Effect.promise(settle);
    yield* Effect.addFinalizer(() => adapter.stopSession(SESSION, "stopped"));
    const ctx = {
      ...buildContext(home, BINARY),
      cwd: CWD,
      mcpServers: [],
      herculeTool: { ...buildContext(home).herculeTool, orientation: options.orientation ?? "" },
    };
    const tags = <Tag extends HarnessEvent["_tag"]>(tag: Tag) =>
      seen.filter((event): event is Extract<HarnessEvent, { _tag: Tag }> => event._tag === tag);
    return {
      home,
      fake,
      adapter,
      seen,
      tags,
      start: (spec: Partial<SessionSpec> = {}) =>
        adapter.startSession(SESSION, { ...SPEC, ...options.spec, ...spec }, ctx),
      /** The messages the first `agy` process received, by method. */
      received: (method: string): ReadonlyArray<JsonRpcMessage> =>
        (fake.spawns[0]?.harness.received ?? []).filter((message) => message.method === method),
      /** Waits until the process received a message with `method`, `count` times. */
      untilReceived: (method: string, count = 1) =>
        Effect.promise(() =>
          waitUntil(
            `received ${method}`,
            () =>
              (fake.spawns[0]?.harness.received ?? []).filter((m) => m.method === method).length >=
              count,
          ),
        ),
      until: (what: string, ready: () => boolean) => Effect.promise(() => waitUntil(what, ready)),
      harness: () => fake.spawns[0]!.harness,
    };
  });

type Harness = Effect.Success<ReturnType<typeof buildHarness>>;

const run = (
  test: (harness: Harness) => Effect.Effect<void, unknown, Scope.Scope>,
  options: HarnessOptions = {},
) =>
  Effect.runPromise(
    buildHarness(options).pipe(
      Effect.flatMap(test),
      Effect.scoped,
      Effect.provide(TestClock.layer()),
    ),
  );

/** A `session/update` the way `agy` writes it, for the conversation `id`. */
const buildUpdate = (
  update: Record<string, unknown>,
  id: string = CONVERSATION,
): JsonRpcMessage => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: id, update },
});

const buildModeUpdate = (modeId: string) =>
  buildUpdate({ sessionUpdate: "current_mode_update", currentModeId: modeId });

/** Returns a script for `session/new` whose reply is the default one after `change` edited its result. */
const changeNewSession =
  (home: string, change: (result: Record<string, unknown>) => void): HarnessScript =>
  (call, harness) => {
    const lines = answerNewSession(home)(call, harness);
    change((lines[0] as { result: Record<string, unknown> }).result);
    return lines;
  };

/** Returns a script for `session/set_mode` that confirms `modeId` the way `agy` does, with an update after the reply. */
const confirmMode =
  (modeId: string): HarnessScript =>
  ({ id }) => [{ jsonrpc: "2.0", id, result: {} }, buildModeUpdate(modeId)];

/**
 * The `cancel` recording ran in `auto` and its turn reports that mode again,
 * so a session over it starts in `auto` too. A session in any other mode
 * would see `agy` change its mode.
 */
const CANCEL_IN_AUTO: FakeAgyOptions = {
  recording: "cancel",
  scripts: { "session/set_mode": confirmMode("auto") },
};

/** How many `session/set_config_option` calls the test that counts them has seen. */
let configCalls = 0;

/** Runs a start in a fiber, so a test can move the clock while it waits. */
const startInFiber = (h: Harness, spec: Partial<SessionSpec> = {}) =>
  Effect.forkChild(Effect.flip(h.start(spec)));

describe("starting a session", () => {
  it("opens a new conversation and reports it", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const binding = yield* h.start({
            systemPrompt: "Persona.",
            coordination: "Coordination.",
            memory: "Memory.",
          });

          expect(binding).toEqual({
            sessionId: SESSION,
            nativeSessionId: CONVERSATION,
            providerAccountId: ACCOUNT,
          });
          expect(h.tags("session.started")).toMatchObject([
            { sessionId: SESSION, harnessRefs: { nativeSessionId: CONVERSATION } },
          ]);
          expect(h.fake.spawns[0]?.cwd).toBe(CWD);
          expect(h.fake.spawns[0]?.command).not.toContain("--dangerously-skip-permissions");
          // The conversation already holds this model, level and mode: nothing is set.
          expect(h.harness().received.map((message) => message.method)).toEqual([
            "initialize",
            "authenticate",
            "session/new",
          ]);
          expect(h.received("session/new")[0]?.params).toMatchObject({
            cwd: CWD,
            mcpServers: [],
            _meta: {
              antigravity: {
                systemPrompt: { append: "Orientation.\n\nPersona.\n\nCoordination.\n\nMemory." },
              },
            },
          });
          expect(yield* h.adapter.listSessions).toEqual([binding]);
        }),
      { orientation: "Orientation." },
    ));

  it("resumes a conversation, and draws nothing of its replay", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const binding = yield* h.start({
            continue: { nativeSessionId: CONVERSATION, mode: "resume" },
          });

          expect(binding.nativeSessionId).toBe(CONVERSATION);
          expect(h.received("session/resume")[0]?.params).toMatchObject({
            sessionId: CONVERSATION,
          });
          expect(h.received("session/new")).toHaveLength(0);
          expect(h.seen.map((event) => event._tag)).toEqual(["session.started"]);
        }),
      {
        fake: (home) => {
          createConversationFiles(home, CONVERSATION);
          return {
            scripts: {
              "session/resume": (call, harness) => [
                buildUpdate({
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "An old answer." },
                }),
                ...answerResume(home)(call, harness),
              ],
            },
          };
        },
      },
    ));

  it("draws an update that follows the reply of a resume, and drops the replay before it", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start({ continue: { nativeSessionId: CONVERSATION, mode: "resume" } });

          expect(h.tags("item.started").map((event) => event.kind)).toEqual(["assistant_message"]);
        }),
      {
        fake: (home) => {
          createConversationFiles(home, CONVERSATION);
          const chunk = (text: string) =>
            buildUpdate({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            });
          return {
            scripts: {
              "session/resume": (call, harness) => [
                chunk("Replayed."),
                ...answerResume(home)(call, harness),
                chunk("Live."),
              ],
            },
          };
        },
      },
    ));

  it("fails with ResumeTranscriptMissing when agy has no such conversation", () =>
    run((h) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          h.start({ continue: { nativeSessionId: CONVERSATION, mode: "resume" } }),
        );

        expect(failure._tag).toBe("ResumeTranscriptMissing");
        expect(h.tags("session.started")).toHaveLength(0);
        expect(yield* h.adapter.listSessions).toEqual([]);
      }),
    ));

  it("fails with HarnessNotInstalled for a runner without agy, and starts nothing", () =>
    run((h) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          h.adapter.startSession(SESSION, SPEC, {
            ...buildContext(h.home, undefined),
            binary: undefined,
            cwd: CWD,
            mcpServers: [],
          }),
        );

        expect(failure._tag).toBe("HarnessNotInstalled");
        expect(h.fake.spawns).toHaveLength(0);
      }),
    ));

  it("refuses an account that has no plan, and no session starts", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(h.start());

          expect(failure._tag).toBe("AdapterFailed");
          expect(failure.message).toContain("reported no plan");
          expect(h.tags("session.started")).toHaveLength(0);
          expect(h.received("session/set_config_option")).toHaveLength(0);
        }),
      { fake: { scripts: { authenticate: ({ id }) => [{ jsonrpc: "2.0", id, result: {} }] } } },
    ));

  it("starts agy with the permission flag in full-access, and sets and checks no mode", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.start({ accessMode: "full-access" });

        expect(h.fake.spawns[0]?.command).toContain("--dangerously-skip-permissions");
        expect(h.received("session/set_mode")).toHaveLength(0);
        // A mode change is then nothing to guard.
        h.harness().sendLine(JSON.stringify(buildModeUpdate("plan")));
        yield* Effect.promise(settle);
        expect(h.tags("runtime.error")).toHaveLength(0);
        expect(h.tags("session.exited")).toHaveLength(0);
      }),
    ));
});

describe("the model and level of a start", () => {
  it("are set when the conversation holds others", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.start({
          modelSelection: { model: "gemini-3.8-flash", options: { effort: "low" } },
        });

        expect(
          h.received("session/set_config_option").map((message) => message.params),
        ).toMatchObject([
          { configId: "model", value: "gemini-3.8-flash" },
          { configId: "thought_level", value: "low" },
        ]);
      }),
    ));

  it("fail the start, naming the model, when agy refuses the model", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            h.start({ modelSelection: { model: "no-such-model", options: {} } }),
          );

          expect(failure._tag).toBe("AdapterFailed");
          expect(failure.message).toContain("the model no-such-model");
          expect(h.received("session/prompt")).toHaveLength(0);
          expect(h.tags("session.started")).toHaveLength(0);
          yield* h.until("the process was stopped", () => h.fake.spawns[0]?.hasExited === true);
        }),
      {
        fake: {
          scripts: {
            "session/set_config_option": refuse(-32602, "Unknown model ID: no-such-model"),
          },
        },
      },
    ));

  it("fail the start, naming the level, when agy refuses the level", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            h.start({
              modelSelection: { model: "gemini-4-hydrogen", options: { effort: "ultra" } },
            }),
          );

          expect(failure._tag).toBe("AdapterFailed");
          expect(failure.message).toContain("the level ultra");
          expect(h.tags("session.started")).toHaveLength(0);
        }),
      { fake: { scripts: { "session/set_config_option": refuse(-32602, "Unknown level") } } },
    ));

  it("fail the start when agy does not answer in time", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const starting = yield* startInFiber(h, {
            modelSelection: { model: "gemini-3.8-flash", options: {} },
          });
          yield* h.untilReceived("session/set_config_option");
          yield* TestClock.adjust(Duration.seconds(3));

          const failed = yield* Fiber.join(starting);
          expect(failed._tag).toBe("AdapterFailed");
          expect(failed.message).toContain("did not answer");
        }),
      { fake: { scripts: { "session/set_config_option": noAnswer } } },
    ));
});

describe("the mode of a start", () => {
  const AUTO: Partial<SessionSpec> = { accessMode: "auto" };
  const inUpdateOrder = {
    "before the reply": true,
    "after the reply": false,
  } as const;

  for (const [when, updateFirst] of Object.entries(inUpdateOrder)) {
    it(`is confirmed by agy's update ${when} to session/set_mode`, () =>
      run(
        (h) =>
          Effect.gen(function* () {
            yield* h.start(AUTO);

            expect(h.received("session/set_mode")[0]?.params).toMatchObject({ modeId: "auto" });
            expect(h.tags("session.started")).toHaveLength(1);
          }),
        {
          fake: {
            scripts: {
              "session/set_mode": ({ id }) => {
                const reply: JsonRpcMessage = { jsonrpc: "2.0", id, result: {} };
                return updateFirst
                  ? [buildModeUpdate("auto"), reply]
                  : [reply, buildModeUpdate("auto")];
              },
            },
          },
        },
      ));
  }

  it("sets nothing when agy is already in the mode", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.start();

        expect(h.received("session/set_mode")).toHaveLength(0);
      }),
    ));

  const NOT_SWITCHED = "Antigravity did not switch to Auto. Pick another access mode.";

  it("fails the start when agy does not offer the mode, and sets nothing", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(h.start(AUTO));

          expect(failure).toMatchObject({ _tag: "AdapterFailed", message: NOT_SWITCHED });
          expect(h.received("session/set_mode")).toHaveLength(0);
          expect(h.tags("session.started")).toHaveLength(0);
        }),
      {
        fake: (home) => ({
          scripts: {
            "session/new": changeNewSession(home, (result) => {
              const modes = result["modes"] as { availableModes: Array<{ id: string }> };
              modes.availableModes = modes.availableModes.filter((mode) => mode.id !== "auto");
            }),
          },
        }),
      },
    ));

  it("fails the start when agy lists no modes at all", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(h.start(AUTO));

          expect(failure).toMatchObject({ _tag: "AdapterFailed", message: NOT_SWITCHED });
          expect(h.received("session/set_mode")).toHaveLength(0);
        }),
      {
        fake: (home) => ({
          scripts: {
            "session/new": changeNewSession(home, (result) => {
              delete result["modes"];
            }),
          },
        }),
      },
    ));

  it("fails the start, and prompts nothing, when agy does not confirm the mode in 5 seconds", () =>
    run((h) =>
      Effect.gen(function* () {
        const starting = yield* startInFiber(h, AUTO);
        yield* h.untilReceived("session/set_mode");
        yield* TestClock.adjust(Duration.millis(4999));
        expect(starting.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(Duration.millis(1));

        expect(yield* Fiber.join(starting)).toMatchObject({
          _tag: "AdapterFailed",
          message: NOT_SWITCHED,
        });
        expect(h.received("session/prompt")).toHaveLength(0);
        expect(h.tags("session.started")).toHaveLength(0);
      }),
    ));
});

describe("a turn", () => {
  it("runs a prompt and reports the turn, then takes the next input", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          const sent = yield* h.adapter.sendInput(SESSION, buildInput("Say hi."));

          expect(sent.delivery).toBe("opened");
          yield* h.until("the turn completed", () => h.tags("turn.completed").length === 1);
          expect(h.tags("turn.started")).toMatchObject([{ turnId: sent.turnId }]);
          expect(h.tags("turn.completed")).toMatchObject([
            { turnId: sent.turnId, state: "completed" },
          ]);
          expect(h.received("session/prompt")[0]?.params).toMatchObject({
            prompt: [{ type: "text", text: "Say hi." }],
          });
          const items = h.tags("item.completed");
          expect(items.some((event) => event.kind === "user_message")).toBe(true);
          expect(items.some((event) => event.kind === "assistant_message")).toBe(true);
        }),
      { fake: { recording: "bad-model" } },
    ));

  it("sends the images of an input after its text", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          const image = writeTestImage();

          yield* h.adapter.sendInput(SESSION, buildInput("Look.", { attachments: [image] }));
          yield* h.untilReceived("session/prompt");

          const prompt = h.received("session/prompt")[0]?.params as {
            prompt: Array<{ type: string; mimeType?: string }>;
          };
          expect(prompt.prompt.map((block) => block.type)).toEqual(["text", "image"]);
          expect(prompt.prompt[1]?.mimeType).toBe("image/png");
        }),
      { fake: { recording: "bad-model" } },
    ));

  it("refuses an input while a turn runs with SteerRefused, and prompts nothing for it", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());
          yield* h.untilReceived("session/prompt");

          const refused = yield* Effect.flip(h.adapter.sendInput(SESSION, buildInput("More.")));

          expect(refused._tag).toBe("SteerRefused");
          expect(h.received("session/prompt")).toHaveLength(1);
          expect(h.tags("turn.started")).toHaveLength(1);
        }),
      { fake: CANCEL_IN_AUTO, spec: { accessMode: "auto" } },
    ));

  it("is interrupted with session/cancel and ends interrupted, and the session goes on", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());
          yield* h.until("a call started", () =>
            h.tags("item.started").some((event) => event.kind !== "user_message"),
          );

          yield* h.adapter.interrupt(SESSION);

          yield* h.until("the turn completed", () => h.tags("turn.completed").length === 1);
          expect(h.tags("turn.completed")).toMatchObject([{ state: "interrupted" }]);
          expect(h.received("session/cancel")).toHaveLength(1);
          expect(h.tags("session.exited")).toHaveLength(0);
          expect(yield* h.adapter.listSessions).toHaveLength(1);
        }),
      { fake: CANCEL_IN_AUTO, spec: { accessMode: "auto" } },
    ));

  it("sends no cancel for an interrupt when no turn runs", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.start();

        yield* h.adapter.interrupt(SESSION);
        yield* h.adapter.interrupt(SESSION, "a-subagent");

        expect(h.received("session/cancel")).toHaveLength(0);
      }),
    ));

  it("ends agy's process when it does not answer an interrupt in 5 seconds", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());
          yield* h.untilReceived("session/prompt");

          const interrupting = yield* Effect.forkChild(h.adapter.interrupt(SESSION));
          yield* h.untilReceived("session/cancel");
          yield* TestClock.adjust(Duration.seconds(5));
          yield* Fiber.join(interrupting);
          yield* h.until("the session exited", () => h.tags("session.exited").length === 1);

          expect(h.tags("runtime.error")).toMatchObject([
            { message: "Antigravity did not stop, so Hercule ended its process." },
          ]);
          expect(h.tags("turn.completed")).toMatchObject([{ state: "interrupted" }]);
          expect(h.tags("session.exited")).toMatchObject([{ reason: "process_exit" }]);
          expect(h.fake.spawns[0]?.hasExited).toBe(true);
          // The session is gone, so the next input is refused.
          const next = yield* Effect.flip(h.adapter.sendInput(SESSION, buildInput()));
          expect(next._tag).toBe("SessionNotRunning");
        }),
      { fake: { recording: readRecordedSetup("cancel"), scripts: { "session/prompt": noAnswer } } },
    ));

  it("fails the input with ModelChangeRefused when agy refuses the new model, and the session goes on", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          const failure = yield* Effect.flip(
            h.adapter.sendInput(
              SESSION,
              buildInput("Hi.", {
                modelSelection: { model: "no-such-model", options: {} },
              }),
            ),
          );

          expect(failure._tag).toBe("ModelChangeRefused");
          expect(h.received("session/prompt")).toHaveLength(0);
          expect(h.tags("turn.started")).toHaveLength(0);
          // The model the session had is still the one asked for, so the next input needs no change.
          const sent = yield* h.adapter.sendInput(
            SESSION,
            buildInput("Hi.", {
              modelSelection: SPEC.modelSelection,
            }),
          );
          expect(sent.delivery).toBe("opened");
          expect(h.received("session/set_config_option")).toHaveLength(1);
        }),
      {
        fake: {
          recording: "bad-model",
          scripts: {
            "session/set_config_option": refuse(-32602, "Unknown model ID: no-such-model"),
          },
        },
      },
    ));

  it("sets the model again on the next input when agy did not answer the first change", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          const flash = { model: "gemini-3.8-flash", options: { effort: "low" } };

          const first = yield* Effect.forkChild(
            Effect.flip(h.adapter.sendInput(SESSION, buildInput("a", { modelSelection: flash }))),
          );
          yield* h.untilReceived("session/set_config_option");
          yield* TestClock.adjust(Duration.seconds(3));
          expect(yield* Fiber.join(first)).toMatchObject({ _tag: "HarnessProtocolError" });
          expect(h.tags("turn.started")).toHaveLength(0);
          expect(yield* h.adapter.listSessions).toHaveLength(1);

          // What agy holds is unknown now, so the next input sets the model again.
          const second = yield* h.adapter.sendInput(
            SESSION,
            buildInput("b", { modelSelection: flash }),
          );

          expect(second.delivery).toBe("opened");
          expect(
            h
              .received("session/set_config_option")
              .map((message) => (message.params as { configId: string }).configId),
          ).toEqual(["model", "model", "thought_level"]);
        }),
      {
        fake: {
          recording: "bad-model",
          scripts: {
            "session/set_config_option": (call, harness) =>
              ++configCalls === 1 ? [] : answerConfigChange("bad-model")(call, harness),
          },
        },
      },
    ));
});

describe("approvals and questions", () => {
  it("allows every call of a turn that asks four times", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());

          for (let asked = 1; asked <= 4; asked += 1) {
            yield* h.until("a request opened", () => h.tags("request.opened").length === asked);
            yield* h.adapter.respondToApprovalRequest(
              SESSION,
              h.tags("request.opened")[asked - 1]!.request.requestId,
              "allow",
            );
          }

          yield* h.until("the turn completed", () => h.tags("turn.completed").length === 1);
          expect(h.tags("turn.completed")).toMatchObject([{ state: "completed" }]);
          expect(
            h
              .tags("request.resolved")
              .map((event) => ("decision" in event ? event.decision : undefined)),
          ).toEqual(["allow", "allow", "allow", "allow"]);
        }),
      { fake: { recording: "edit-shell" } },
    ));

  it("tells the model when a call is denied, and the turn goes on", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());
          yield* h.until("a request opened", () => h.tags("request.opened").length === 1);

          yield* h.adapter.respondToApprovalRequest(
            SESSION,
            h.tags("request.opened")[0]!.request.requestId,
            "deny",
          );

          yield* h.until("the turn completed", () => h.tags("turn.completed").length === 1);
          expect(h.tags("request.resolved")).toMatchObject([{ decision: "deny" }]);
          expect(h.tags("turn.completed")).toMatchObject([{ state: "completed" }]);
          const prompts = h
            .received("session/prompt")
            .map(
              (message) => (message.params as { prompt: Array<{ text: string }> }).prompt[0]?.text,
            );
          expect(prompts).toHaveLength(2);
          expect(prompts[1]).toContain("The user denied your last tool call");
        }),
      { fake: { recording: "deny2", scripts: { "session/prompt": answerEndTurn } } },
    ));

  it("delivers the answer to a question", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());
          yield* h.until("a question opened", () => h.tags("request.opened").length === 1);
          const opened = h.tags("request.opened")[0]!.request;

          yield* h.adapter.respondToQuestion(
            SESSION,
            opened.requestId,
            { Question: "Green" },
            SPEC.modelSelection,
          );

          yield* h.until("the turn completed", () => h.tags("turn.completed").length === 1);
          expect(h.tags("request.resolved")).toMatchObject([{ answers: { Question: "Green" } }]);
          expect(h.tags("turn.completed")).toMatchObject([{ state: "completed" }]);
        }),
      { fake: { recording: "question-elicit" } },
    ));

  it("fails an answer when no question is open", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.start();

        const failure = yield* Effect.flip(
          h.adapter.respondToQuestion(
            SESSION,
            "request-1",
            { Question: "Green" },
            SPEC.modelSelection,
          ),
        );

        expect(failure._tag).toBe("AnswerNotDelivered");
      }),
    ));

  it("cancels an approval that no running turn owns, and warns", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          h.harness().sendLine(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "jetski-acp-front:9",
              method: "session/request_permission",
              params: {
                sessionId: CONVERSATION,
                toolCall: { toolCallId: "call-unknown", name: "run_command", status: "pending" },
                options: [
                  { optionId: "allow", name: "Allow", kind: "allow_once" },
                  { optionId: "deny", name: "Deny", kind: "reject_once" },
                ],
              },
            }),
          );

          yield* h.until("the request was answered", () =>
            h.harness().received.some((message) => message.id === "jetski-acp-front:9"),
          );
          expect(
            h.harness().received.find((message) => message.id === "jetski-acp-front:9")?.result,
          ).toEqual({ outcome: { outcome: "cancelled" } });
          expect(h.tags("request.opened")).toHaveLength(0);
          expect(h.tags("runtime.warning")).toHaveLength(1);
        }),
      { fake: { recording: readRecordedSetup("cancel") } },
    ));
});

describe("what agy sends that does not belong to the session", () => {
  it("drops an update of another conversation", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          h.harness().sendLine(
            JSON.stringify(
              buildUpdate(
                { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi." } },
                "another-conversation",
              ),
            ),
          );
          yield* Effect.promise(settle);

          expect(h.seen.map((event) => event._tag)).toEqual(["session.started"]);
        }),
      { fake: { recording: readRecordedSetup("cancel") } },
    ));

  it("stops the session as crashed when agy changes its own mode", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          h.harness().sendLine(JSON.stringify(buildModeUpdate("auto")));

          yield* h.until("the session exited", () => h.tags("session.exited").length === 1);
          expect(h.tags("runtime.error")).toMatchObject([
            {
              message:
                "Antigravity changed its own permission mode from default to auto, so Hercule stopped it.",
            },
          ]);
          expect(h.tags("session.exited")).toMatchObject([{ reason: "crash" }]);
          expect(h.fake.spawns[0]?.hasExited).toBe(true);
          expect(yield* h.adapter.listSessions).toEqual([]);
        }),
      { fake: { recording: readRecordedSetup("cancel") } },
    ));
});

describe("the end of a session", () => {
  it("is reported with the reason of the stop, after the process is gone", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.start();

        yield* h.adapter.stopSession(SESSION, "idle_unload");

        expect(h.tags("session.exited")).toMatchObject([
          { sessionId: SESSION, reason: "idle_unload" },
        ]);
        expect(h.fake.spawns[0]?.hasExited).toBe(true);
        expect(yield* h.adapter.listSessions).toEqual([]);
        // A second stop has nothing left to do, and the first reason stays.
        yield* h.adapter.stopSession(SESSION, "stopped");
        expect(h.tags("session.exited")).toHaveLength(1);
      }),
    ));

  it("ends the running turn as interrupted before it reports the exit", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());
          yield* h.until("a call started", () =>
            h.tags("item.started").some((event) => event.kind !== "user_message"),
          );

          yield* h.adapter.stopSession(SESSION, "stopped");

          const order = h.seen
            .filter((event) => event._tag === "turn.completed" || event._tag === "session.exited")
            .map((event) => event._tag);
          expect(order).toEqual(["turn.completed", "session.exited"]);
          expect(h.tags("turn.completed")).toMatchObject([{ state: "interrupted" }]);
          expect(h.received("session/cancel")).toHaveLength(0);
        }),
      { fake: CANCEL_IN_AUTO, spec: { accessMode: "auto" } },
    ));

  it("is reported as a process exit when agy dies mid-turn, and the turn fails", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());
          yield* h.until("a call started", () =>
            h.tags("item.started").some((event) => event.kind !== "user_message"),
          );

          h.harness().kill();

          yield* h.until("the session exited", () => h.tags("session.exited").length === 1);
          expect(h.tags("turn.completed")).toMatchObject([{ state: "failed" }]);
          expect(h.tags("session.exited")).toMatchObject([{ reason: "process_exit" }]);
          // The call that never answered is closed too.
          expect(
            h.tags("item.completed").filter((event) => event.status === "failed"),
          ).toHaveLength(1);
          const next = yield* Effect.flip(h.adapter.sendInput(SESSION, buildInput()));
          expect(next._tag).toBe("SessionNotRunning");
        }),
      { fake: CANCEL_IN_AUTO, spec: { accessMode: "auto" } },
    ));

  it("fails a start whose process dies before it is ready, with no event", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(h.start());

          expect(failure._tag).toBe("AdapterFailed");
          expect(h.seen).toEqual([]);
          expect(yield* h.adapter.listSessions).toEqual([]);
        }),
      {
        fake: {
          scripts: {
            "session/new": (_call, harness) => {
              harness.end();
              return [];
            },
          },
        },
      },
    ));
});

describe("an interrupt with no input running", () => {
  it("cancels and ends the synthetic turn of output that came with no prompt", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          h.harness().sendLine(
            JSON.stringify(
              buildUpdate({
                sessionUpdate: "tool_call",
                toolCallId: "call-bg",
                name: "run_command",
                kind: "execute",
                status: "in_progress",
                rawInput: { CommandLine: "sleep 90" },
              }),
            ),
          );
          yield* h.until("a synthetic turn opened", () => h.tags("turn.started").length === 1);

          yield* h.adapter.interrupt(SESSION);

          yield* h.untilReceived("session/cancel");
          expect(h.tags("turn.completed")).toMatchObject([{ state: "interrupted" }]);
        }),
      { fake: { recording: readRecordedSetup("cancel") } },
    ));
});

describe("a start that is interrupted", () => {
  it("does not hold the session id", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const starting = yield* Effect.forkChild(h.start());
          yield* h.untilReceived("session/new");
          yield* Fiber.interrupt(starting);

          // The id is free again: a second start runs, instead of failing with SessionAlreadyRunning.
          const second = yield* Effect.forkChild(Effect.flip(h.start()));
          yield* h.until("a second process started", () => h.fake.spawns.length === 2);
          yield* Fiber.interrupt(second);
        }),
      { fake: { scripts: { "session/new": noAnswer } } },
    ));
});

describe("the sessions of the adapter", () => {
  it("lists live sessions only, and refuses a second start of the same session id", () =>
    run((h) =>
      Effect.gen(function* () {
        const binding = yield* h.start();

        const second = yield* Effect.flip(h.start());

        expect(second._tag).toBe("SessionAlreadyRunning");
        expect(h.fake.spawns).toHaveLength(1);
        expect(yield* h.adapter.listSessions).toEqual([binding]);
        yield* h.adapter.stopSession(SESSION, "stopped");
        expect(yield* h.adapter.listSessions).toEqual([]);
        // Once the session has exited, its id can start again.
        yield* h.start();
        expect(h.fake.spawns).toHaveLength(2);
      }),
    ));
});

// ---- Scripts these tests need besides the fake's defaults ----

/** Answers a follow-up prompt with the end of its turn. */
const answerEndTurn: HarnessScript = ({ id }) => [
  { jsonrpc: "2.0", id, result: { stopReason: "end_turn" } },
];
