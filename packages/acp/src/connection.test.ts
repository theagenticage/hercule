/**
 * Tests of `openAcpConnection` against the fake harness (`./testing`) for what
 * no recording shows. `connection.integration.test.ts` plays the recordings of
 * a real harness and owns how messages map to our types; this file owns how
 * the connection ends, how it fails, and what it does with a message it
 * cannot read.
 */
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import type { AcpError } from "./error";
import {
  ALLOW,
  APPROVAL_PARAMS,
  buildFailure,
  buildNotification,
  buildRequest,
  buildResult,
  buildSessionUpdate,
  callEverything,
  createTestHarness,
  ELICITATION_PARAMS,
  isMethod,
  isReplyTo,
  MESSAGE_CHUNK,
  PROMPT_RESULT,
  SESSION,
  SYNC_ADVICE,
  TEXT,
} from "./recorder.testing";
import { answerWith, type HarnessScript } from "./testing";
import type { AcpConnection, ApprovalOutcome, ElicitationReply } from "./types";

type TestHarness = ReturnType<typeof createTestHarness>;

// ---------------------------------------------------------------------------
// What the client writes
// ---------------------------------------------------------------------------

it.effect("introduces itself with its own name and version, and writes no trace of T3 Code", () =>
  Effect.gen(function* () {
    const harness = createTestHarness();
    const connection = yield* harness.open;

    expect(harness.fake.received[0]).toMatchObject({
      method: "initialize",
      params: {
        clientInfo: { name: "hercule", title: "Hercule", version: "9.9.9" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          elicitation: { form: {} },
        },
      },
    });

    yield* callEverything(connection);
    harness.say(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS));
    harness.say(buildRequest("e1", "elicitation/create", ELICITATION_PARAMS));
    yield* harness.whenWritten("the answer to the elicitation", isReplyTo("e1"));

    expect(harness.fake.received.length).toBeGreaterThan(10);
    expect(JSON.stringify(harness.fake.received).toLowerCase()).not.toContain("t3");
  }),
);

it.effect(
  "writes what no recording has: resume, close, an image, MCP servers over HTTP and _meta, and cancel as a notification",
  () =>
    Effect.gen(function* () {
      const harness = createTestHarness();
      const connection = yield* harness.open;
      const request = {
        cwd: "/work",
        mcpServers: [
          {
            name: "tools",
            url: "http://127.0.0.1:9/mcp",
            headers: [{ name: "Authorization", value: "Bearer secret" }],
          },
        ],
        meta: { antigravity: { systemPrompt: { append: "Be brief." } } },
      };
      const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" } as const;

      yield* connection.newSession(request);
      yield* connection.resumeSession({ ...request, nativeSessionId: SESSION });
      yield* Effect.flatten(connection.sendPrompt(SESSION, [...TEXT, image]));
      yield* connection.cancel(SESSION);
      yield* connection.closeSession(SESSION);

      const written = (method: string) => harness.fake.received.find(isMethod(method));
      const sent = {
        cwd: "/work",
        mcpServers: [{ type: "http", ...request.mcpServers[0] }],
        _meta: request.meta,
      };
      expect(written("session/new")?.params).toEqual(sent);
      expect(written("session/resume")?.params).toEqual({ sessionId: SESSION, ...sent });
      expect(written("session/prompt")?.params).toEqual({
        sessionId: SESSION,
        prompt: [...TEXT, image],
      });
      expect(written("session/close")?.params).toEqual({ sessionId: SESSION });
      // A JSON-RPC notification has no id. A harness may take a request with an id
      // for a request to answer.
      expect(written("session/cancel")).toMatchObject({ params: { sessionId: SESSION } });
      expect(written("session/cancel")).not.toHaveProperty("id");
    }),
);

// ---------------------------------------------------------------------------
// What the client returns
// ---------------------------------------------------------------------------

it.effect("describes a harness from its reply to initialize, and one that announces nothing", () =>
  Effect.gen(function* () {
    const full = yield* createTestHarness().open;
    const bare = yield* createTestHarness({
      scripts: { initialize: answerWith({ protocolVersion: 1 }) },
    }).open;

    expect(full.harness).toMatchObject({
      version: "1.5.15",
      acceptsImages: true,
      acceptsHttpMcpServers: true,
      meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
    });
    expect(bare.harness).toEqual({ acceptsImages: false, acceptsHttpMcpServers: false });
  }),
);

it.effect("returns the modes, models and config options of a resumed session", () =>
  Effect.gen(function* () {
    const models = { currentModelId: "m1", availableModels: [{ modelId: "m1", name: "One" }] };
    const modes = { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }] };
    const harness = createTestHarness({
      scripts: { "session/resume": answerWith({ models, modes }) },
    });
    const connection = yield* harness.open;

    expect(
      yield* connection.resumeSession({ nativeSessionId: SESSION, cwd: "/work", mcpServers: [] }),
    ).toEqual({ models, modes, configOptions: [] });
  }),
);

it.effect("returns every config option with its new value after a change", () =>
  Effect.gen(function* () {
    const configOptions = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "m2",
        options: [
          { value: "m1", name: "One" },
          { value: "m2", name: "Two" },
        ],
      },
    ];
    const connection = yield* createTestHarness({
      scripts: { "session/set_config_option": answerWith({ configOptions }) },
    }).open;

    expect(yield* connection.setConfigOption(SESSION, "model", "m2")).toEqual(configOptions);
  }),
);

it.effect("handles an update sent before the reply before the prompt returns", () =>
  Effect.gen(function* () {
    const harness = createTestHarness({
      scripts: {
        "session/prompt": ({ id }) => [
          buildSessionUpdate(MESSAGE_CHUNK),
          buildResult(id, PROMPT_RESULT),
        ],
      },
    });
    const connection = yield* harness.open;

    expect(yield* Effect.flatten(connection.sendPrompt(SESSION, TEXT))).toEqual(PROMPT_RESULT);

    expect(harness.updates.map(({ update }) => update.sessionUpdate)).toEqual([
      "agent_message_chunk",
    ]);
  }),
);

// ---------------------------------------------------------------------------
// How calls fail
// ---------------------------------------------------------------------------

it.effect("fails a refused call with the harness's code and message", () =>
  Effect.gen(function* () {
    const connection = yield* createTestHarness({
      scripts: {
        "session/set_config_option": ({ id }) => [
          buildFailure(id, -32602, "Unknown model ID: nope"),
        ],
      },
    }).open;

    const error = yield* Effect.flip(connection.setConfigOption(SESSION, "model", "nope"));

    expect(error).toMatchObject({
      reason: "refused",
      code: -32602,
      harnessMessage: "Unknown model ID: nope",
      message:
        "The harness refused session/set_config_option: Unknown model ID: nope (code -32602).",
    });
  }),
);

it.effect("times out a call the harness never answers, after 30 seconds", () =>
  Effect.gen(function* () {
    const harness = createTestHarness({ scripts: { "session/close": () => [] } });
    const connection = yield* harness.open;

    const closing = yield* Effect.forkChild(Effect.flip(connection.closeSession(SESSION)));
    yield* harness.whenWritten("the close request", isMethod("session/close"));
    yield* TestClock.adjust("29 seconds");
    expect(closing.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust("1 second");

    expect(yield* Fiber.join(closing)).toMatchObject({
      reason: "timed-out",
      message:
        "The harness did not answer session/close within 30 seconds. It is not known whether it did what was asked.",
    });
  }),
);

it.effect("lets a prompt wait for its reply as long as the harness works", () =>
  Effect.gen(function* () {
    const harness = createTestHarness({ scripts: { "session/prompt": () => [] } });
    const connection = yield* harness.open;

    const prompting = yield* Effect.forkChild(Effect.flatten(connection.sendPrompt(SESSION, TEXT)));
    yield* harness.whenWritten("the prompt", isMethod("session/prompt"));
    yield* TestClock.adjust("24 hours");

    expect(prompting.pollUnsafe()).toBeUndefined();
  }),
);

it.effect("sendPrompt succeeds once the request is written, before the reply", () =>
  Effect.gen(function* () {
    const harness = createTestHarness({ scripts: { "session/prompt": () => [] } });
    const connection = yield* harness.open;

    const waitForReply = yield* connection.sendPrompt(SESSION, TEXT);
    const reply = yield* Effect.forkChild(waitForReply);
    yield* Effect.yieldNow;
    expect(reply.pollUnsafe()).toBeUndefined();

    const id = harness.fake.received.find(isMethod("session/prompt"))?.id;
    harness.say(buildResult(id!, PROMPT_RESULT));
    expect(yield* Fiber.join(reply)).toEqual(PROMPT_RESULT);
  }),
);

it.effect("sendPrompt fails with not-sent when the write of the request is rejected", () =>
  Effect.gen(function* () {
    const harness = createTestHarness({
      writeWith: (write) => async (text) => {
        if (text.includes('"session/prompt"')) throw new Error("EPIPE");
        await write(text);
      },
    });
    const connection = yield* harness.open;

    const error = yield* Effect.flip(connection.sendPrompt(SESSION, TEXT));

    expect(error).toMatchObject({ reason: "not-sent" });
    expect(error.message).toContain("not handed to the harness");
  }),
);

it.effect(
  "sendPrompt fails with not-sent when the connection ended before the line was written",
  () =>
    Effect.gen(function* () {
      const harness = createTestHarness();
      const connection = yield* harness.open;
      harness.fake.end();
      yield* connection.awaitClosed;

      const error = yield* Effect.flip(connection.sendPrompt(SESSION, TEXT));

      expect(error).toMatchObject({ reason: "not-sent" });
      expect(harness.fake.received.some(isMethod("session/prompt"))).toBe(false);
    }),
);

it.effect(
  "sendPrompt fails with closed, not not-sent, when the harness read the line and the connection ended before the write was acknowledged",
  () =>
    Effect.gen(function* () {
      const release = Promise.withResolvers<void>();
      const harness = createTestHarness({
        scripts: { "session/prompt": () => [] },
        writeWith: (write) => async (text) => {
          await write(text);
          if (text.includes('"session/prompt"')) await release.promise;
        },
      });
      const connection = yield* harness.open;

      const sending = yield* Effect.forkChild(Effect.flip(connection.sendPrompt(SESSION, TEXT)));
      yield* harness.whenWritten("the prompt", isMethod("session/prompt"));
      harness.fake.end();
      yield* connection.awaitClosed;
      const error = yield* Fiber.join(sending);
      release.resolve();

      expect(error).toMatchObject({ reason: "closed" });
      expect(error.message).toContain("not known whether the harness got");
    }),
);

it.effect("sendPrompt succeeds when the reply arrives before the write is acknowledged", () =>
  Effect.gen(function* () {
    const release = Promise.withResolvers<void>();
    const harness = createTestHarness({
      writeWith: (write) => async (text) => {
        await write(text);
        if (text.includes('"session/prompt"')) await release.promise;
      },
    });
    const connection = yield* harness.open;

    const sending = yield* Effect.forkChild(connection.sendPrompt(SESSION, TEXT));
    yield* harness.whenWritten("the prompt", isMethod("session/prompt"));
    // The default script of the fake answers the prompt at once, while the write is still held.
    const waitForReply = yield* Fiber.join(sending);
    release.resolve();

    expect(yield* waitForReply).toMatchObject({ stopReason: expect.any(String) as unknown });
  }),
);

it.effect("does not take a response we write for the request of the same id as written", () =>
  Effect.gen(function* () {
    const releaseResponse = Promise.withResolvers<void>();
    const releasePrompt = Promise.withResolvers<void>();
    const harness = createTestHarness({
      scripts: { "session/prompt": () => [] },
      writeWith: (write) => async (text) => {
        await write(text);
        if (text.includes('"result"')) await releaseResponse.promise;
        if (text.includes('"session/prompt"')) await releasePrompt.promise;
      },
    });
    const connection = yield* harness.open;
    // The request ids the client uses count up, so the next call gets the next number.
    const promptId =
      Math.max(...harness.fake.received.map((message) => Number(message.id ?? -1))) + 1;

    // The response to the harness's request has the id the prompt is about to get.
    // It is written (and held in flight) while the prompt waits behind it.
    harness.say(buildRequest(promptId, "session/request_permission", APPROVAL_PARAMS));
    yield* harness.whenWritten("the response", isReplyTo(promptId));
    const sending = yield* Effect.forkChild(connection.sendPrompt(SESSION, TEXT));
    // Lets the prompt register its request before the response is acknowledged.
    for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
    releaseResponse.resolve();
    yield* harness.whenWritten("the prompt", isMethod("session/prompt"));
    expect(harness.fake.received.find(isMethod("session/prompt"))?.id).toBe(promptId);
    yield* Effect.yieldNow;

    expect(sending.pollUnsafe()).toBeUndefined();
    releasePrompt.resolve();
    yield* Fiber.join(sending);
  }),
);

it.effect("gives each overlapping sendPrompt its own write signal", () =>
  Effect.gen(function* () {
    const release = Promise.withResolvers<void>();
    let promptWrites = 0;
    const harness = createTestHarness({
      scripts: { "session/prompt": () => [] },
      writeWith: (write) => async (text) => {
        await write(text);
        if (text.includes('"session/prompt"') && promptWrites++ === 1) await release.promise;
      },
    });
    const connection = yield* harness.open;

    const first = yield* Effect.forkChild(connection.sendPrompt(SESSION, TEXT));
    const second = yield* Effect.forkChild(connection.sendPrompt(SESSION, TEXT));
    yield* harness.waitUntil(
      "both lines reached the pipe",
      () => harness.fake.received.filter(isMethod("session/prompt")).length === 2,
    );
    yield* Effect.yieldNow;
    const done = () => [first, second].filter((fiber) => fiber.pollUnsafe() !== undefined);
    expect(done()).toHaveLength(1);

    release.resolve();
    yield* Fiber.join(first);
    yield* Fiber.join(second);
  }),
);

it.effect("fails a call on a connection that is over, without writing it", () =>
  Effect.gen(function* () {
    const harness = createTestHarness();
    const connection = yield* harness.open;
    harness.fake.end();
    yield* connection.awaitClosed;
    const writtenBefore = harness.fake.received.length;

    const error = yield* Effect.flip(connection.setMode(SESSION, "auto"));

    expect(error).toMatchObject({ reason: "closed" });
    expect(error.message).toContain("session/set_mode");
    expect(harness.fake.received).toHaveLength(writtenBefore);
  }),
);

/** Describes a reply of `method` that holds a value this version cannot read. */
const describeUnreadableReply = (method: string, detail: string): string =>
  `The harness answered ${method} with a value this version cannot read: ${detail}. ${SYNC_ADVICE}`;

const SLIDER = { id: "volume", name: "Volume", type: "slider", currentValue: 3 };

/**
 * A reply with a value the vendored client cannot decode, for the calls whose
 * replies it checks, and the sentence that must name the field and the value.
 */
const UNREADABLE_REPLIES: ReadonlyArray<{
  readonly method: string;
  readonly reply: unknown;
  readonly call: (connection: AcpConnection) => Effect.Effect<unknown, AcpError>;
  readonly detail: string;
}> = [
  {
    method: "session/new",
    reply: { sessionId: SESSION, configOptions: [SLIDER] },
    call: (connection) => connection.newSession({ cwd: "/work", mcpServers: [] }),
    detail: `configOptions[0] (type "slider") is ${JSON.stringify(SLIDER)}`,
  },
  {
    method: "session/resume",
    reply: { configOptions: [SLIDER] },
    call: (connection) =>
      connection.resumeSession({ nativeSessionId: SESSION, cwd: "/work", mcpServers: [] }),
    detail: `configOptions[0] (type "slider") is ${JSON.stringify(SLIDER)}`,
  },
  {
    method: "session/set_config_option",
    reply: { configOptions: 5 },
    call: (connection) => connection.setConfigOption(SESSION, "model", "m"),
    detail: "configOptions is 5",
  },
  {
    method: "session/set_mode",
    reply: { _meta: 5 },
    call: (connection) => connection.setMode(SESSION, "auto"),
    detail: "_meta is 5",
  },
];

it.effect.each(UNREADABLE_REPLIES)(
  "fails the reply to $method with $detail, with the field, the value and the advice to sync",
  ({ method, reply, call, detail }) =>
    Effect.gen(function* () {
      const connection = yield* createTestHarness({ scripts: { [method]: answerWith(reply) } })
        .open;

      const error = yield* Effect.flip(call(connection));

      expect(error).toMatchObject({ reason: "unreadable" });
      expect(error.message).toBe(describeUnreadableReply(method, detail));
      expect(error).not.toHaveProperty("harnessMessage");
    }),
);

it.effect.each([
  { name: "has no stop reason", reply: {}, detail: "stopReason is missing" },
  {
    name: "has a stop reason the vendored client does not know",
    reply: { stopReason: "quota" },
    detail: 'stopReason is "quota"',
  },
])("fails a prompt whose reply $name, naming the field and the value", ({ reply, detail }) =>
  Effect.gen(function* () {
    const connection = yield* createTestHarness({
      scripts: { "session/prompt": answerWith(reply) },
    }).open;

    const error = yield* Effect.flip(Effect.flatten(connection.sendPrompt(SESSION, TEXT)));

    expect(error).toMatchObject({ reason: "unreadable" });
    expect(error.message).toBe(describeUnreadableReply("session/prompt", detail));
  }),
);

it.effect("names, in each of many overlapping calls, the value that call was answered with", () =>
  Effect.gen(function* () {
    // All requests are written before the first reply comes, and the replies come in one burst.
    const count = 96;
    const asked: Array<{ readonly id: string | number; readonly cwd: string }> = [];
    const harness = createTestHarness({
      scripts: {
        "session/new": ({ id, params }) => {
          asked.push({ id, cwd: (params as { cwd: string }).cwd });
          return asked.length < count
            ? []
            : asked.map((request) => buildResult(request.id, { sessionId: Number(request.cwd) }));
        },
      },
    });
    const connection = yield* harness.open;

    const errors = yield* Effect.forEach(
      Array.from({ length: count }, (_, n) => n),
      (n) => Effect.flip(connection.newSession({ cwd: String(n), mcpServers: [] })),
      { concurrency: "unbounded" },
    );

    expect(errors.map(({ message }) => message)).toEqual(
      errors.map((_, n) => describeUnreadableReply("session/new", `sessionId is ${n}`)),
    );
  }).pipe(
    // The vendored client gives other fibers a turn after this many steps, so
    // decoding the replies is interleaved.
    Effect.provideService(References.MaxOpsBeforeYield, 16),
  ),
);

it.effect(
  "names the type of an object it could not read, and quotes up to 500 characters of it",
  () =>
    Effect.gen(function* () {
      const option = { id: "x", name: "n".repeat(300), type: "slider", currentValue: 3 };
      const connection = yield* createTestHarness({
        scripts: { "session/new": answerWith({ sessionId: SESSION, configOptions: [option] }) },
      }).open;

      const error = yield* Effect.flip(connection.newSession({ cwd: "/work", mcpServers: [] }));

      expect(error.message).toContain('configOptions[0] (type "slider") is {"id":"x"');
      // The end of the value is past the 200 characters an earlier version quoted.
      expect(error.message).toContain('"currentValue":3}');
    }),
);

it.effect("fails a prompt as refused when the harness reports an error for the turn", () =>
  Effect.gen(function* () {
    // Only a harness on ACP version 2 reports the end of a turn this way.
    const harness = createTestHarness({
      scripts: {
        initialize: answerWith({ protocolVersion: 2, info: { name: "Future", version: "1" } }),
        "session/prompt": ({ id }) => [
          buildResult(id, {}),
          buildSessionUpdate({
            sessionUpdate: "state_update",
            state: "idle",
            error: { code: -32000, message: "Quota exceeded" },
          }),
        ],
      },
    });
    const connection = yield* harness.open;

    const error = yield* Effect.flip(Effect.flatten(connection.sendPrompt(SESSION, TEXT)));

    expect(error).toMatchObject({
      reason: "refused",
      code: -32000,
      harnessMessage: "Quota exceeded",
    });
  }),
);

/** The handshake of each way it can fail, and what the caller of `openAcpConnection` gets. */
const FAILING_HANDSHAKES: ReadonlyArray<{
  readonly name: string;
  readonly script: HarnessScript;
  readonly error: Readonly<Record<string, unknown>>;
  /** The whole message of the error. */
  readonly message: string;
}> = [
  {
    name: "the harness refuses it",
    script: ({ id }) => [buildFailure(id, -32000, "Not signed in")],
    error: { reason: "refused", code: -32000, harnessMessage: "Not signed in" },
    message: "The harness refused initialize: Not signed in (code -32000).",
  },
  {
    name: "the harness closes its output",
    script: (_call, harness) => {
      harness.end();
      return [];
    },
    error: { reason: "closed" },
    message: "The call to initialize failed. The harness closed its output.",
  },
  {
    name: "the reply holds a value it cannot read",
    script: answerWith({
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { image: "yes" } },
    }),
    error: { reason: "unreadable" },
    message: describeUnreadableReply(
      "initialize",
      'agentCapabilities.promptCapabilities.image is "yes"',
    ),
  },
];

it.effect.each(FAILING_HANDSHAKES)("fails to open when $name", (handshake) =>
  Effect.gen(function* () {
    const harness = createTestHarness({ scripts: { initialize: handshake.script } });

    const error = yield* Effect.flip(harness.open);

    expect(error).toMatchObject(handshake.error);
    expect(error.message).toBe(handshake.message);
  }),
);

/** Ways to end a connection, and a check that nothing reaches a handler after it. */
const ENDS_WITHOUT_A_CALL: ReadonlyArray<{
  readonly name: string;
  readonly scripts?: Readonly<Record<string, HarnessScript>>;
  readonly end: (harness: TestHarness) => Effect.Effect<void, AcpError, Scope.Scope>;
}> = [
  {
    name: "the handshake failed",
    scripts: { initialize: ({ id }) => [buildFailure(id, -32000, "Not signed in")] },
    end: (harness) => Effect.ignore(harness.open),
  },
  {
    name: "a write failed",
    end: (harness) =>
      Effect.gen(function* () {
        const connection = yield* harness.open;
        harness.fake.failWrites();
        yield* Effect.ignore(connection.cancel(SESSION));
        yield* connection.awaitClosed;
      }),
  },
];

it.effect.each(ENDS_WITHOUT_A_CALL)(
  "stops reading the harness's output, and hands nothing on, after $name",
  ({ scripts, end }) =>
    Effect.gen(function* () {
      const harness = createTestHarness({ scripts });
      yield* end(harness);
      yield* harness.whenReadingStopped;

      harness.say(buildSessionUpdate(MESSAGE_CHUNK));
      harness.say(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS));

      expect(harness.updates).toEqual([]);
      expect(harness.approvalRequests).toEqual([]);
    }),
);

// ---------------------------------------------------------------------------
// Messages the harness sends that are not simply handed on
// ---------------------------------------------------------------------------

it.effect("hands an update of a kind it does not know on as other, and keeps unknown words", () =>
  Effect.gen(function* () {
    const harness = createTestHarness();
    yield* harness.open;

    harness.say(buildSessionUpdate({ sessionUpdate: "brand_new", anything: 1 }));
    harness.say(buildSessionUpdate({ sessionUpdate: "usage_update", used: 10, size: 100 }));
    harness.say(
      buildSessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        kind: "newkind",
        status: "newstatus",
      }),
    );
    yield* harness.waitUntil("three updates arrived", () => harness.updates.length === 3);

    expect(harness.updates.map(({ update }) => update)).toEqual([
      { sessionUpdate: "other", name: "brand_new" },
      { sessionUpdate: "other", name: "usage_update" },
      expect.objectContaining({ sessionUpdate: "tool_call_update", kind: "newkind" }),
    ]);
    expect(harness.unhandled).toEqual([]);
  }),
);

it.effect("reports an update it cannot read with its method, reason and raw, and goes on", () =>
  Effect.gen(function* () {
    const harness = createTestHarness();
    yield* harness.open;

    const unreadable = buildSessionUpdate({ sessionUpdate: "agent_message_chunk", content: 3 });
    harness.say(unreadable);
    harness.say(buildSessionUpdate(MESSAGE_CHUNK));
    yield* harness.waitUntil("the next update arrived", () => harness.updates.length === 1);

    expect(harness.unhandled).toHaveLength(1);
    expect(harness.unhandled[0]).toMatchObject({
      method: "session/update",
      raw: unreadable.params,
    });
    expect(harness.unhandled[0]?.reason).toContain("with a value this version cannot read:");
    expect(harness.unhandled[0]?.reason).toContain(SYNC_ADVICE);
    expect(harness.updates[0]?.update).toMatchObject({ sessionUpdate: "agent_message_chunk" });
  }),
);

it.effect(
  "reports a notification and a request it does not know, and answers the request with an error",
  () =>
    Effect.gen(function* () {
      const harness = createTestHarness();
      yield* harness.open;

      const note = buildNotification("_vendor/note", { a: 1 });
      const fileRequest = buildRequest("u1", "fs/read_text_file", {
        sessionId: SESSION,
        path: "/x",
      });
      const complete = buildNotification("elicitation/complete", { elicitationId: "e1" });
      harness.say(note);
      harness.say(fileRequest);
      harness.say(complete);
      yield* harness.whenWritten("the answer to u1", isReplyTo("u1"));
      yield* harness.waitUntil("three reports", () => harness.unhandled.length === 3);

      expect(harness.fake.received.find(isReplyTo("u1"))).toMatchObject({
        error: { code: -32601 },
      });
      expect(harness.unhandled).toEqual([
        {
          method: "_vendor/note",
          reason:
            "The harness sent the notification _vendor/note, which this version does not use.",
          raw: note.params,
        },
        {
          method: "fs/read_text_file",
          reason:
            "The harness sent the request fs/read_text_file, which this version does not use.",
          raw: fileRequest.params,
        },
        {
          method: "elicitation/complete",
          reason:
            "The harness sent the notification elicitation/complete, which this version does not use.",
          raw: complete.params,
        },
      ]);
    }),
);

it.effect("is not stopped by a handler that throws", () =>
  Effect.gen(function* () {
    const seen: Array<string> = [];
    const harness = createTestHarness({
      answers: {
        onUnhandledMessage: () => {
          throw new Error("the reporter broke");
        },
        onSessionUpdate: (notification) => {
          seen.push(notification.update.sessionUpdate);
          throw new Error("the updater broke");
        },
      },
    });
    const logged: Array<string> = [];
    const collecting = Logger.make<unknown, void>(({ message }) => {
      logged.push(String(message));
    });
    const connection = yield* harness.open.pipe(Effect.provide(Logger.layer([collecting])));

    harness.say(buildNotification("_vendor/note", {}));
    harness.say(buildSessionUpdate(MESSAGE_CHUNK));
    harness.say(
      buildSessionUpdate({ sessionUpdate: "current_mode_update", currentModeId: "auto" }),
    );
    yield* harness.waitUntil("both updates arrived", () => harness.updates.length === 2);

    expect(seen).toEqual(["agent_message_chunk", "current_mode_update"]);
    expect(yield* Effect.flatten(connection.sendPrompt(SESSION, TEXT))).toEqual(PROMPT_RESULT);
    expect(logged.some((line) => line.includes("onUnhandledMessage threw"))).toBe(true);
  }),
);

it.effect(
  "is not stopped by a reporter that throws for a dropped update and for a request answered with an error",
  () =>
    Effect.gen(function* () {
      const harness = createTestHarness({
        answers: {
          onUnhandledMessage: () => {
            throw new Error("the reporter broke");
          },
        },
      });
      const connection = yield* harness.open;

      harness.say(buildSessionUpdate({ sessionUpdate: "agent_message_chunk", content: 3 }));
      harness.say(buildRequest("u1", "fs/read_text_file", { sessionId: SESSION, path: "/x" }));
      // The writer still writes the answer, and the reader still reads what follows.
      yield* harness.whenWritten("the answer to u1", isReplyTo("u1"));
      harness.say(buildSessionUpdate(MESSAGE_CHUNK));
      yield* harness.waitUntil("the next update arrived", () => harness.updates.length === 1);

      expect(harness.unhandled).toHaveLength(2);
      expect(yield* Effect.flatten(connection.sendPrompt(SESSION, TEXT))).toEqual(PROMPT_RESULT);
    }),
);

// ---------------------------------------------------------------------------
// Requests of the harness
// ---------------------------------------------------------------------------

it.effect("hands on an approval request and an elicitation, and writes each kind of answer", () =>
  Effect.gen(function* () {
    const outcomes = new Map<string, ApprovalOutcome | ElicitationReply>([
      ["p-selected", { outcome: "selected", optionId: "deny" }],
      ["p-cancelled", { outcome: "cancelled" }],
      ["e-accept", { action: "accept", content: { q1: "2", q1_other: "Teal" } }],
      ["e-decline", { action: "decline" }],
      ["e-cancel", { action: "cancel" }],
    ]);
    const answer = ({ requestId }: { readonly requestId: string }) =>
      Effect.succeed(outcomes.get(requestId) as never);
    const harness = createTestHarness({ answers: { approval: answer, elicitation: answer } });
    yield* harness.open;

    for (const id of ["p-selected", "p-cancelled"]) {
      harness.say(buildRequest(id, "session/request_permission", APPROVAL_PARAMS));
    }
    for (const id of ["e-accept", "e-decline", "e-cancel"]) {
      harness.say(buildRequest(id, "elicitation/create", ELICITATION_PARAMS));
    }
    yield* harness.whenWritten("the last answer", isReplyTo("e-cancel"));

    const written = (id: string) => harness.fake.received.find(isReplyTo(id));
    expect(written("p-selected")).toEqual(
      buildResult("p-selected", { outcome: { outcome: "selected", optionId: "deny" } }),
    );
    expect(written("p-cancelled")).toEqual(
      buildResult("p-cancelled", { outcome: { outcome: "cancelled" } }),
    );
    expect(written("e-accept")).toEqual(
      buildResult("e-accept", { action: "accept", content: { q1: "2", q1_other: "Teal" } }),
    );
    expect(written("e-decline")).toEqual(buildResult("e-decline", { action: "decline" }));
    expect(written("e-cancel")).toEqual(buildResult("e-cancel", { action: "cancel" }));
  }),
);

it.effect("reports that the reply to an approval request and to an elicitation was written", () =>
  Effect.gen(function* () {
    const harness = createTestHarness();
    yield* harness.open;

    harness.say(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS));
    harness.say(buildRequest("e1", "elicitation/create", ELICITATION_PARAMS));
    yield* harness.whenWritten("both answers", isReplyTo("e1"));
    yield* harness.whenWritten("the approval answer", isReplyTo("p1"));

    yield* harness.approvalRequests[0]!.replyWritten;
    yield* harness.elicitationRequests[0]!.replyWritten;
  }),
);

it.effect("handles updates while an approval request waits for its answer", () =>
  Effect.gen(function* () {
    const answered = yield* Deferred.make<ApprovalOutcome>();
    const harness = createTestHarness({ answers: { approval: () => Deferred.await(answered) } });
    yield* harness.open;

    harness.say(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS));
    yield* harness.waitUntil(
      "the approval request arrived",
      () => harness.approvalRequests.length === 1,
    );
    harness.say(buildSessionUpdate(MESSAGE_CHUNK));
    yield* harness.waitUntil("the update arrived", () => harness.updates.length === 1);
    expect(harness.fake.received.some(isReplyTo("p1"))).toBe(false);
    yield* Deferred.succeed(answered, ALLOW);
    yield* harness.whenWritten("the answer to p1", isReplyTo("p1"));

    expect(harness.fake.received.find(isReplyTo("p1"))).toEqual(
      buildResult("p1", { outcome: { outcome: "selected", optionId: "allow" } }),
    );
  }),
);

it.effect(
  "answers an approval request with a tool kind it does not know with an error, and reports it",
  () =>
    Effect.gen(function* () {
      const harness = createTestHarness();
      yield* harness.open;

      const sent = buildRequest("p1", "session/request_permission", {
        ...APPROVAL_PARAMS,
        toolCall: { ...APPROVAL_PARAMS.toolCall, kind: "newkind" },
      });
      harness.say(sent);
      yield* harness.whenWritten("the answer to p1", isReplyTo("p1"));
      yield* harness.waitUntil("the report", () => harness.unhandled.length === 1);

      expect(harness.fake.received.find(isReplyTo("p1"))).toHaveProperty("error");
      expect(harness.approvalRequests).toEqual([]);
      expect(harness.unhandled).toHaveLength(1);
      expect(harness.unhandled[0]).toMatchObject({
        method: "session/request_permission",
        raw: sent.params,
      });
      expect(harness.unhandled[0]?.reason).toContain("with a value this version cannot read:");
      expect(harness.unhandled[0]?.reason).toContain("kind");
    }),
);

it.effect("answers a request with an error, reports it and logs it when its handler throws", () =>
  Effect.gen(function* () {
    const logged: Array<string> = [];
    const collecting = Logger.make<unknown, void>(({ message }) => {
      logged.push(String(message));
    });
    const harness = createTestHarness({
      answers: {
        approval: () => {
          throw new Error("the screen crashed");
        },
      },
    });
    yield* harness.open.pipe(Effect.provide(Logger.layer([collecting])));

    const sent = buildRequest("r1", "session/request_permission", APPROVAL_PARAMS);
    harness.say(sent);
    yield* harness.whenWritten("the answer to r1", isReplyTo("r1"));
    yield* harness.waitUntil("the report", () => harness.unhandled.length === 1);

    expect(harness.fake.received.find(isReplyTo("r1"))).toHaveProperty("error");
    expect(harness.unhandled[0]).toMatchObject({
      method: "session/request_permission",
      raw: sent.params,
    });
    expect(logged.some((line) => line.startsWith("ACP request handler failed"))).toBe(true);
  }),
);

it.effect(
  "handles a request whose id the harness reuses after it was answered, with its own params",
  () =>
    Effect.gen(function* () {
      const harness = createTestHarness();
      yield* harness.open;
      const answers = () => harness.fake.received.filter(isReplyTo("p1")).length;

      const second = { ...APPROVAL_PARAMS, zzSecond: 1 };
      harness.say(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS));
      yield* harness.waitUntil("the first answer", () => answers() === 1);
      harness.say(buildRequest("p1", "session/request_permission", second));
      yield* harness.waitUntil("the second answer", () => answers() === 2);

      expect(harness.approvalRequests.map(({ raw }) => raw)).toEqual([APPROVAL_PARAMS, second]);
    }),
);

it.effect("gives each request its own raw when the harness sends several in one line", () =>
  Effect.gen(function* () {
    const hold = yield* Deferred.make<never>();
    const harness = createTestHarness({
      answers: { approval: () => Deferred.await(hold), elicitation: () => Deferred.await(hold) },
    });
    yield* harness.open;

    // The vendored client splits the line into four messages, so there is no one
    // current message to take the params from.
    const approvals = ["a", "b"].map((id) => ({ ...APPROVAL_PARAMS, zzId: id }));
    const elicitations = ["a", "b"].map((id) => ({ ...ELICITATION_PARAMS, zzId: id }));
    harness.say(
      JSON.stringify([
        buildRequest("p-a", "session/request_permission", approvals[0]),
        buildRequest("e-a", "elicitation/create", elicitations[0]),
        buildRequest("p-b", "session/request_permission", approvals[1]),
        buildRequest("e-b", "elicitation/create", elicitations[1]),
      ]),
    );
    yield* harness.waitUntil(
      "all four requests arrived",
      () => harness.approvalRequests.length === 2 && harness.elicitationRequests.length === 2,
    );

    expect(harness.approvalRequests.map(({ raw }) => raw)).toEqual(approvals);
    expect(harness.elicitationRequests.map(({ raw }) => raw)).toEqual(elicitations);
  }),
);

it.effect(
  "ends the connection when the harness reuses the id of an open request, and reports no reply as written",
  () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<ApprovalOutcome>();
      const harness = createTestHarness({ answers: { approval: () => Deferred.await(hold) } });
      const connection = yield* harness.open;

      harness.say(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS));
      yield* harness.waitUntil(
        "the first request arrived",
        () => harness.approvalRequests.length === 1,
      );
      const replyWritten = yield* Effect.forkChild(
        Effect.exit(harness.approvalRequests[0]!.replyWritten),
      );
      harness.say(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS));

      const closed = yield* connection.awaitClosed;
      expect(closed.message).toContain("the harness reused the id");
      const written = yield* Fiber.join(replyWritten);
      expect(Exit.isFailure(written)).toBe(true);
      expect(Exit.isFailure(written) && String(written.cause)).toContain("ended before the reply");
      // The second request never reached the handler.
      expect(harness.approvalRequests).toHaveLength(1);
    }),
);

it.effect(
  "ends the connection when the harness reuses an id whose reply is queued but not written yet",
  () =>
    Effect.gen(function* () {
      const written = yield* Deferred.make<void>();
      let replyWrites = 0;
      const harness = createTestHarness({
        writeWith: (write) => async (text) => {
          await write(text);
          if (text.includes('"id":"p"') && replyWrites++ === 0)
            await Effect.runPromise(Deferred.await(written));
        },
      });
      const connection = yield* harness.open;
      const request = buildRequest("p", "session/request_permission", APPROVAL_PARAMS);

      harness.say(request);
      yield* harness.whenWritten("the first reply", isReplyTo("p"));
      harness.say(request);

      const closed = yield* connection.awaitClosed.pipe(Effect.timeout("1 second"));
      expect(closed.message).toContain("the harness reused the id");
      yield* Deferred.succeed(written, undefined);
    }),
);

/** Requests that the vendored client read as ACP version 2 although the harness sent a version 1 tool call. */
const APPROVALS_READ_AS_VERSION_TWO = [
  { name: "a title", extra: { title: "Run ls" } },
  {
    name: "a title and a subject that names another tool call",
    extra: {
      title: "Approval",
      subject: {
        type: "tool_call",
        toolCall: { toolCallId: "call_1", title: "Something else", kind: "read" },
      },
    },
  },
] as const;

it.effect.each(APPROVALS_READ_AS_VERSION_TWO)(
  "answers an approval request with $name beside its tool call with an error, and reports it",
  ({ extra }) =>
    Effect.gen(function* () {
      const harness = createTestHarness();
      yield* harness.open;

      const sent = buildRequest("p1", "session/request_permission", {
        ...APPROVAL_PARAMS,
        ...extra,
      });
      harness.say(sent);
      yield* harness.whenWritten("the answer to p1", isReplyTo("p1"));
      yield* harness.waitUntil("the report", () => harness.unhandled.length === 1);

      expect(harness.fake.received.find(isReplyTo("p1"))).toMatchObject({
        error: { code: -32602 },
      });
      expect(harness.approvalRequests).toEqual([]);
      expect(harness.unhandled).toHaveLength(1);
      expect(harness.unhandled[0]).toMatchObject({
        method: "session/request_permission",
        raw: sent.params,
      });
      expect(harness.unhandled[0]?.reason).toContain(
        "read differently from how the harness sent it",
      );
    }),
);

it.effect(
  "answers an elicitation in a mode it did not advertise with an error, and reports it",
  () =>
    Effect.gen(function* () {
      const harness = createTestHarness();
      yield* harness.open;

      const sent = buildRequest("e1", "elicitation/create", {
        ...ELICITATION_PARAMS,
        mode: "future",
      });
      harness.say(sent);
      yield* harness.whenWritten("the answer to e1", isReplyTo("e1"));
      yield* harness.waitUntil("the report", () => harness.unhandled.length === 1);

      expect(harness.fake.received.find(isReplyTo("e1"))).toMatchObject({
        error: { code: -32602 },
      });
      expect(harness.elicitationRequests).toEqual([]);
      expect(harness.unhandled[0]).toMatchObject({
        method: "elicitation/create",
        raw: sent.params,
      });
      expect(harness.unhandled[0]?.reason).toContain("form mode, not future");
    }),
);

// ---------------------------------------------------------------------------
// Secrets and text of the harness in messages
// ---------------------------------------------------------------------------

const BEARER_TOKEN = "Bearer sk-live-0123456789abcdef";

/** Opens a connection whose session was given the bearer token in an MCP server's header. */
const openSessionWithToken = (harness: TestHarness) =>
  Effect.gen(function* () {
    const connection = yield* harness.open;
    yield* connection.newSession({
      cwd: "/work",
      mcpServers: [
        {
          name: "tools",
          url: "http://127.0.0.1:9/mcp",
          headers: [{ name: "Authorization", value: BEARER_TOKEN }],
        },
      ],
    });
    return connection;
  });

/** Harness text that holds the token and is longer than any message may quote. */
const LONG_ECHO = `${BEARER_TOKEN} ${"z".repeat(600)}`;

/**
 * Each place where text of the harness is put into a sentence for a person,
 * fed `LONG_ECHO`, and the sentences that person reads. Every one must quote
 * the text: the token hidden and the text cut.
 */
const PLACES_OF_HARNESS_TEXT: ReadonlyArray<{
  readonly name: string;
  readonly scripts?: Readonly<Record<string, HarnessScript>>;
  readonly texts: (context: {
    readonly harness: TestHarness;
    readonly connection: AcpConnection;
  }) => Effect.Effect<ReadonlyArray<string>, unknown>;
}> = [
  {
    name: "the text of a refusal",
    scripts: { "session/set_mode": ({ id }) => [buildFailure(id, -32603, LONG_ECHO)] },
    texts: ({ connection }) =>
      Effect.flip(connection.setMode(SESSION, "auto")).pipe(Effect.map((error) => [error.message])),
  },
  {
    name: "a value in a reply that cannot be read",
    scripts: { "session/set_config_option": answerWith({ configOptions: LONG_ECHO }) },
    texts: ({ connection }) =>
      Effect.flip(connection.setConfigOption(SESSION, "model", "m")).pipe(
        Effect.map((error) => [error.message]),
      ),
  },
  {
    name: "the name of a notification",
    texts: ({ harness }) =>
      Effect.gen(function* () {
        harness.say(buildNotification(`tools/${LONG_ECHO}`, {}));
        yield* harness.waitUntil("the report", () => harness.unhandled.length === 1);
        return harness.unhandled.map(({ reason }) => reason);
      }),
  },
  {
    name: "the name of a request it answers with an error",
    texts: ({ harness }) =>
      Effect.gen(function* () {
        harness.say(buildRequest("u1", `tools/${LONG_ECHO}`, {}));
        yield* harness.waitUntil("the report", () => harness.unhandled.length === 1);
        return harness.unhandled.map(({ reason }) => reason);
      }),
  },
  {
    name: "a line that is not JSON",
    texts: ({ harness, connection }) =>
      Effect.gen(function* () {
        harness.say(`Warning: ${LONG_ECHO}`);
        return [(yield* connection.awaitClosed).message];
      }),
  },
  {
    name: "the exception of the pipe it reads",
    texts: ({ harness, connection }) =>
      Effect.gen(function* () {
        harness.fake.failOutput(new Error(LONG_ECHO));
        return [(yield* connection.awaitClosed).message];
      }),
  },
  {
    name: "the exception of the pipe it writes",
    texts: ({ harness, connection }) =>
      Effect.gen(function* () {
        harness.fake.failWrites(new Error(LONG_ECHO));
        yield* Effect.ignore(connection.cancel(SESSION));
        return [(yield* connection.awaitClosed).message];
      }),
  },
];

it.effect.each(PLACES_OF_HARNESS_TEXT)(
  "hides the header values of the session and cuts the text when the harness echoes it in $name",
  ({ scripts, texts }) =>
    Effect.gen(function* () {
      const harness = createTestHarness({
        scripts,
        answers: { approval: () => Effect.never },
      });
      const connection = yield* openSessionWithToken(harness);

      const read = yield* texts({ harness, connection });

      expect(read).toHaveLength(1);
      expect(read[0]).not.toContain("sk-live");
      expect(read[0]).toContain("[hidden]");
      expect(read[0]).not.toContain("z".repeat(501));
      expect(read[0]).toContain("...");
    }),
);

it.effect(
  "hides the secrets of a resumed session, and a credential echoed without its scheme",
  () =>
    Effect.gen(function* () {
      const credential = BEARER_TOKEN.slice("Bearer ".length);
      const harness = createTestHarness({
        scripts: {
          "session/set_mode": ({ id }) => [
            buildFailure(id, -32603, `token "${credential}" is invalid`),
          ],
        },
      });
      const connection = yield* harness.open;
      yield* connection.resumeSession({
        nativeSessionId: SESSION,
        cwd: "/work",
        mcpServers: [
          {
            name: "tools",
            url: "http://127.0.0.1:9/mcp",
            headers: [{ name: "Authorization", value: BEARER_TOKEN }],
          },
        ],
      });

      const error = yield* Effect.flip(connection.setMode(SESSION, "auto"));

      expect(error.message).toContain("[hidden]");
      expect(error.message).not.toContain("sk-live");
      expect(error.harnessMessage).toBe('token "[hidden]" is invalid');
    }),
);

it.effect("hides a secret that has a quote or a backslash, also as the sentence quotes it", () =>
  Effect.gen(function* () {
    const secret = 'Bearer sk-live-"quoted"\\back';
    const harness = createTestHarness({
      scripts: { "session/set_config_option": answerWith({ configOptions: secret }) },
    });
    const connection = yield* harness.open;
    yield* connection.newSession({
      cwd: "/work",
      mcpServers: [
        {
          name: "tools",
          url: "http://127.0.0.1:9/mcp",
          headers: [{ name: "Authorization", value: secret }],
        },
      ],
    });

    const error = yield* Effect.flip(connection.setConfigOption(SESSION, "model", "m"));

    expect(error.message).toContain(`configOptions is "[hidden]"`);
    expect(error.message).not.toContain("sk-live");
  }),
);

it.effect("hides a secret before it cuts the text, and keeps harnessMessage whole", () =>
  Effect.gen(function* () {
    const text = `${"y".repeat(495)}${BEARER_TOKEN}${"z".repeat(600)}`;
    const harness = createTestHarness({
      scripts: { "session/set_mode": ({ id }) => [buildFailure(id, -32603, text)] },
    });
    const connection = yield* openSessionWithToken(harness);

    const error = yield* Effect.flip(connection.setMode(SESSION, "auto"));

    expect(error.message).toBe(
      `The harness refused session/set_mode: ${"y".repeat(495)}[hidd... (code -32603).`,
    );
    expect(error.harnessMessage).toBe(`${"y".repeat(495)}[hidden]${"z".repeat(600)}`);
  }),
);

// ---------------------------------------------------------------------------
// The end of the connection
// ---------------------------------------------------------------------------

it.effect(
  "fails a line that is not a message with the start of the line, and ends the connection",
  () =>
    Effect.gen(function* () {
      const harness = createTestHarness({ scripts: { "session/prompt": () => [] } });
      const connection = yield* harness.open;
      const prompting = yield* Effect.forkChild(
        Effect.flip(Effect.flatten(connection.sendPrompt(SESSION, TEXT))),
      );
      yield* harness.whenWritten("the prompt", isMethod("session/prompt"));

      harness.say("this is a log line, not JSON");

      const error = yield* Fiber.join(prompting);
      expect(error).toMatchObject({ reason: "closed" });
      expect(error.message).toBe(
        "The call to session/prompt failed. The harness wrote a line that is not a JSON-RPC message, or ended in the middle of one, so nothing it sends can be trusted any more. The line starts with: this is a log line, not JSON",
      );
      expect(yield* connection.awaitClosed).toMatchObject({ reason: "closed" });
    }),
);

/** What happens right after the harness answered a prompt, in the same moment. */
const ENDS_RIGHT_AFTER_A_REPLY: ReadonlyArray<{
  readonly name: string;
  readonly afterReply: HarnessScript;
}> = [
  {
    name: "the harness closes its output",
    afterReply: (_call, harness) => {
      harness.end();
      return [];
    },
  },
  {
    name: "the process exits",
    afterReply: (_call, harness) => {
      harness.kill();
      return [];
    },
  },
  { name: "the harness writes a line that is not JSON", afterReply: () => ["Goodbye!"] },
  {
    name: "the harness's output fails",
    afterReply: (_call, harness) => {
      harness.failOutput(new Error("the pipe broke"));
      return [];
    },
  },
];

it.effect.each(ENDS_RIGHT_AFTER_A_REPLY)(
  "returns the reply of a prompt that the harness answered and then $name",
  ({ afterReply }) =>
    Effect.gen(function* () {
      const harness = createTestHarness({
        scripts: {
          "session/prompt": (call, fake) => [
            buildResult(call.id, PROMPT_RESULT),
            ...afterReply(call, fake),
          ],
        },
      });
      const connection = yield* harness.open;

      expect(yield* Effect.flatten(connection.sendPrompt(SESSION, TEXT))).toEqual(PROMPT_RESULT);
      expect(yield* connection.awaitClosed).toMatchObject({ reason: "closed" });
    }),
);

it.effect(
  "returns the reply of a prompt although a write failed while the reply was on its way",
  () =>
    Effect.gen(function* () {
      const harness: TestHarness = createTestHarness({
        scripts: {
          "session/prompt": ({ id }) => [
            buildRequest("p1", "session/request_permission", APPROVAL_PARAMS),
            buildResult(id, PROMPT_RESULT),
          ],
        },
        answers: {
          // The answer to the approval request is the write that fails.
          approval: () => {
            harness.fake.failWrites();
            return Effect.succeed(ALLOW);
          },
        },
      });
      const connection = yield* harness.open;

      expect(yield* Effect.flatten(connection.sendPrompt(SESSION, TEXT))).toEqual(PROMPT_RESULT);
      expect(yield* connection.awaitClosed).toMatchObject({
        message: "Could not write to the harness: Error: EPIPE",
      });
      // The failed write is the reply to the approval request.
      expect(yield* Effect.flip(harness.approvalRequests[0]!.replyWritten)).toMatchObject({
        reason: "closed",
      });
    }),
);

it.effect(
  "reports a reply as not written when the write of the reply rejects, while the output is open",
  () =>
    Effect.gen(function* () {
      const harness = createTestHarness({
        writeWith: (realWrite) => (text) =>
          text.includes('"result"') ? Promise.reject(new Error("EPIPE")) : realWrite(text),
      });
      yield* harness.open;

      harness.say(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS));
      yield* harness.waitUntil(
        "the approval request arrived",
        () => harness.approvalRequests.length === 1,
      );

      expect(yield* Effect.flip(harness.approvalRequests[0]!.replyWritten)).toMatchObject({
        reason: "closed",
        message: expect.stringContaining("Could not write to the harness") as unknown,
      });
      expect(harness.fake.received.some(isReplyTo("p1"))).toBe(false);
    }),
);

it.effect(
  "ends the connection after a short while when the process exited and its output did not",
  () =>
    Effect.gen(function* () {
      let exit: (code: number) => void = () => undefined;
      const exited = new Promise<number>((resolve) => {
        exit = resolve;
      });
      const harness = createTestHarness({ scripts: { "session/prompt": () => [] }, exited });
      const connection = yield* harness.open;
      const prompting = yield* Effect.forkChild(
        Effect.flip(Effect.flatten(connection.sendPrompt(SESSION, TEXT))),
      );
      const closed = yield* Effect.forkChild(connection.awaitClosed);
      yield* harness.whenWritten("the prompt", isMethod("session/prompt"));

      exit(3);
      // Lets the connection see the exit before the clock moves.
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      yield* TestClock.adjust("249 millis");
      expect(closed.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 millis");

      const why = "The harness exited with code 3, and its output did not end.";
      expect(yield* Fiber.join(closed)).toMatchObject({ reason: "closed", message: why });
      expect((yield* Fiber.join(prompting)).message).toBe(
        `The call to session/prompt failed. ${why}`,
      );
    }),
);

/** The ways a connection ends, each a function that makes it end. */
const ENDINGS = [
  {
    name: "the harness closes its output",
    end: (harness: TestHarness) => Effect.sync(() => harness.fake.end()),
    why: "The harness closed its output.",
  },
  {
    name: "the harness's output fails",
    end: (harness: TestHarness) =>
      Effect.sync(() => harness.fake.failOutput(new Error("the pipe broke"))),
    why: "The harness's output failed: Error: the pipe broke",
  },
  {
    name: "a write to the harness fails",
    end: (harness: TestHarness, connection: AcpConnection) =>
      Effect.sync(() => harness.fake.failWrites()).pipe(
        Effect.andThen(Effect.ignore(connection.cancel(SESSION))),
      ),
    why: "Could not write to the harness: Error: EPIPE",
  },
  {
    name: "the scope closes",
    end: (_harness: TestHarness, _connection: AcpConnection, scope: Scope.Closeable) =>
      Scope.close(scope, Exit.void),
    why: "The connection to the harness was closed.",
  },
] as const;

it.effect.each(ENDINGS)(
  "fails an open prompt and interrupts a parked handler when $name",
  (ending) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const interrupted = yield* Deferred.make<void>();
      const harness = createTestHarness({
        scripts: { "session/prompt": () => [] },
        answers: {
          approval: () =>
            Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
        },
      });
      const connection = yield* harness.open.pipe(Scope.provide(scope));
      const prompting = yield* Effect.forkChild(
        Effect.flip(Effect.flatten(connection.sendPrompt(SESSION, TEXT))),
      );
      yield* harness.whenWritten("the prompt", isMethod("session/prompt"));
      harness.say(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS));
      yield* harness.waitUntil(
        "the handler is parked",
        () => harness.approvalRequests.length === 1,
      );
      const replyWritten = yield* Effect.forkChild(
        Effect.flip(harness.approvalRequests[0]!.replyWritten),
      );

      yield* ending.end(harness, connection, scope);

      // The reply was never written, and `replyWritten` says so.
      expect(yield* Fiber.join(replyWritten)).toMatchObject({ reason: "closed" });
      const error = yield* Fiber.join(prompting);
      yield* Deferred.await(interrupted);
      const closed = yield* connection.awaitClosed;
      expect(closed).toMatchObject({ reason: "closed", message: ending.why });
      // A call and awaitClosed give the same reason, in the same words.
      expect(error).toMatchObject({
        reason: "closed",
        message: `The call to session/prompt failed. ${ending.why}`,
      });
      expect(error).not.toHaveProperty("harnessMessage");
    }),
);

it.effect("does not wait for a handler that will not stop when the scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const release = yield* Deferred.make<void>();
    const harness = createTestHarness({
      scripts: { "session/prompt": () => [] },
      answers: {
        approval: () => Deferred.await(release).pipe(Effect.as(ALLOW), Effect.uninterruptible),
      },
    });
    const connection = yield* harness.open.pipe(Scope.provide(scope));
    const prompting = yield* Effect.forkChild(
      Effect.flip(Effect.flatten(connection.sendPrompt(SESSION, TEXT))),
    );
    yield* harness.whenWritten("the prompt", isMethod("session/prompt"));
    harness.say(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS));
    yield* harness.waitUntil("the handler is parked", () => harness.approvalRequests.length === 1);

    const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));

    expect(yield* Fiber.join(prompting)).toMatchObject({ reason: "closed" });
    expect(yield* connection.awaitClosed).toMatchObject({ reason: "closed" });
    expect(yield* Effect.flip(connection.setMode(SESSION, "auto"))).toMatchObject({
      reason: "closed",
    });
    // The scope itself waits for the handler, which is why the calls above must not.
    expect(closing.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(closing);
  }),
);
