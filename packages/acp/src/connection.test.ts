/**
 * Tests of `openAcpConnection` over an in-memory pipe pair. A scripted peer
 * (`./scripted-peer.testing`) plays the harness, and the tests check what the
 * client wrote, what its handlers received, and how its calls ended.
 */
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { AcpError } from "./error";
import {
  ALLOW,
  answerWith,
  APPROVAL_PARAMS,
  buildFailure,
  buildNotification,
  buildRequest,
  buildResult,
  buildSessionUpdate,
  callEverything,
  createPeer,
  createRecorder,
  ELICITATION_PARAMS,
  INITIALIZE_RESULT,
  MESSAGE_CHUNK,
  NEW_SESSION_RESULT,
  openConnection,
  PROMPT_RESULT,
  SESSION,
  SYNC_ADVICE,
  TEXT,
  TOOL_CALL,
  withUnknownFields,
  wroteMethod,
  wroteReplyTo,
  type Message,
  type Call,
  type Peer,
  type Recorder,
  type Script,
} from "./scripted-peer.testing";
import type { AcpConnection, ElicitationReply, ApprovalOutcome } from "./types";

// ---------------------------------------------------------------------------
// What the client writes
// ---------------------------------------------------------------------------

it.effect("introduces itself with its own name, version and capabilities", () =>
  Effect.gen(function* () {
    const peer = createPeer();
    yield* openConnection(peer, createRecorder());

    expect(peer.written[0]).toMatchObject({
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
  }),
);

it.effect("writes no trace of the library it is built on", () =>
  Effect.gen(function* () {
    const peer = createPeer();
    const recorder = createRecorder();
    const connection = yield* openConnection(peer, recorder);
    yield* callEverything(connection);
    peer.say(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS));
    peer.say(buildRequest("e1", "elicitation/create", ELICITATION_PARAMS));
    yield* peer.whenWritten("the answer to the elicitation", wroteReplyTo("e1"));

    expect(peer.written.length).toBeGreaterThan(10);
    expect(peer.lines.join("").toLowerCase()).not.toContain("t3");
  }),
);

it.effect("writes each call as ACP defines it, and cancel as a notification", () =>
  Effect.gen(function* () {
    const peer = createPeer();
    const connection = yield* openConnection(peer, createRecorder());
    yield* callEverything(connection);

    const params = (method: string) => peer.written.find(wroteMethod(method))?.["params"];
    expect(params("authenticate")).toEqual({ methodId: "oauth-personal" });
    expect(params("session/new")).toEqual({ cwd: "/work", mcpServers: [] });
    expect(params("session/resume")).toEqual({ sessionId: SESSION, cwd: "/work", mcpServers: [] });
    expect(params("session/set_mode")).toEqual({ sessionId: SESSION, modeId: "auto" });
    expect(params("session/set_config_option")).toEqual({
      sessionId: SESSION,
      configId: "model",
      value: "gemini",
    });
    expect(params("session/prompt")).toEqual({ sessionId: SESSION, prompt: TEXT });
    expect(params("session/close")).toEqual({ sessionId: SESSION });
    const cancel = peer.written.find(wroteMethod("session/cancel"));
    expect(cancel).toMatchObject({ params: { sessionId: SESSION } });
    // A JSON-RPC notification has no id. A harness may take a request with an id
    // for a request to answer.
    expect(cancel).not.toHaveProperty("id");
  }),
);

it.effect(
  "tells the harness about an MCP server over HTTP, with its headers, and about _meta, for a new and a resumed session",
  () =>
    Effect.gen(function* () {
      const peer = createPeer();
      const connection = yield* openConnection(peer, createRecorder());
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

      yield* connection.newSession(request);
      yield* connection.resumeSession({ ...request, nativeSessionId: SESSION });

      const sent = {
        cwd: "/work",
        mcpServers: [
          {
            type: "http",
            name: "tools",
            url: "http://127.0.0.1:9/mcp",
            headers: [{ name: "Authorization", value: "Bearer secret" }],
          },
        ],
        _meta: { antigravity: { systemPrompt: { append: "Be brief." } } },
      };
      expect(peer.written.find(wroteMethod("session/new"))?.["params"]).toEqual(sent);
      expect(peer.written.find(wroteMethod("session/resume"))?.["params"]).toEqual({
        sessionId: SESSION,
        ...sent,
      });
    }),
);

it.effect("writes a prompt with an image as ACP defines it", () =>
  Effect.gen(function* () {
    const peer = createPeer();
    const connection = yield* openConnection(peer, createRecorder());
    const prompt = [
      { type: "text", text: "What is this?" },
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
    ] as const;

    yield* connection.prompt(SESSION, prompt);

    expect(peer.written.find(wroteMethod("session/prompt"))?.["params"]).toEqual({
      sessionId: SESSION,
      prompt,
    });
  }),
);

// ---------------------------------------------------------------------------
// What the client returns
// ---------------------------------------------------------------------------

it.effect("describes the harness from the reply to initialize", () =>
  Effect.gen(function* () {
    const connection = yield* openConnection(createPeer(), createRecorder());

    expect(connection.harness).toEqual({
      name: "Antigravity ACP Server",
      version: "1.5.15",
      acceptsImages: true,
      acceptsHttpMcpServers: true,
      canResumeSession: true,
      canCloseSession: true,
      meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
    });
  }),
);

it.effect("returns the session id, modes and config options of a new session", () =>
  Effect.gen(function* () {
    const connection = yield* openConnection(createPeer(), createRecorder());

    const session = yield* connection.newSession({ cwd: "/work", mcpServers: [] });

    expect(session.nativeSessionId).toBe("54f853ac-6b2b-4622-bca4-16ec1cca394c");
    expect(session.modes?.currentModeId).toBe("default");
    expect(session.configOptions.map(({ id }) => id)).toEqual(["model", "thought_level", "mode"]);
    const model = session.configOptions[0];
    expect(model).toMatchObject({
      id: "model",
      type: "select",
      category: "model",
      currentValue: "gemini-4-hydrogen",
    });
    expect(model?.type === "select" ? model.options : []).toContainEqual({
      value: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
    });
  }),
);

it.effect("resumes a session when the harness replies with nothing", () =>
  Effect.gen(function* () {
    const connection = yield* openConnection(createPeer(), createRecorder());

    const resumed = yield* connection.resumeSession({
      nativeSessionId: SESSION,
      cwd: "/work",
      mcpServers: [],
    });

    expect(resumed).toEqual({ configOptions: [] });
  }),
);

it.effect("returns how a prompt ended and what it used", () =>
  Effect.gen(function* () {
    const connection = yield* openConnection(createPeer(), createRecorder());

    const reply = yield* connection.prompt(SESSION, TEXT);

    expect(reply).toEqual(PROMPT_RESULT);
  }),
);

it.effect("handles an update sent before the reply before the prompt returns", () =>
  Effect.gen(function* () {
    const peer = createPeer({
      "session/prompt": ({ id }) => [
        buildSessionUpdate(MESSAGE_CHUNK),
        buildResult(id, PROMPT_RESULT),
      ],
    });
    const recorder = createRecorder();
    const connection = yield* openConnection(peer, recorder);

    yield* connection.prompt(SESSION, TEXT);

    expect(recorder.updates.map(({ update }) => update.sessionUpdate)).toEqual([
      "agent_message_chunk",
    ]);
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
    const connection = yield* openConnection(
      createPeer({ "session/set_config_option": answerWith({ configOptions }) }),
      createRecorder(),
    );

    expect(yield* connection.setConfigOption(SESSION, "model", "m2")).toEqual(configOptions);
  }),
);

it.effect(
  "describes a harness that announces no capabilities as one that can do nothing extra",
  () =>
    Effect.gen(function* () {
      const connection = yield* openConnection(
        createPeer({ initialize: answerWith({ protocolVersion: 1 }) }),
        createRecorder(),
      );

      expect(connection.harness).toEqual({
        acceptsImages: false,
        acceptsHttpMcpServers: false,
        canResumeSession: false,
        canCloseSession: false,
      });
    }),
);

it.effect("returns the _meta of the reply to authenticate", () =>
  Effect.gen(function* () {
    const connection = yield* openConnection(
      createPeer({ authenticate: answerWith({ _meta: { account: "a@b.c" } }) }),
      createRecorder(),
    );

    expect(yield* connection.authenticate("oauth-personal")).toEqual({
      meta: { account: "a@b.c" },
    });
  }),
);

it.effect(
  "returns the models, modes and _meta of a session reply, for a new and a resumed session",
  () =>
    Effect.gen(function* () {
      const models = {
        currentModelId: "m1",
        availableModels: [{ modelId: "m1", name: "One" }],
      };
      const modes = { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }] };
      const reply = { models, modes, _meta: { fast: true } };
      const connection = yield* openConnection(
        createPeer({
          "session/new": answerWith({ sessionId: SESSION, ...reply }),
          "session/resume": answerWith(reply),
        }),
        createRecorder(),
      );
      const settings = { models, modes, configOptions: [], meta: { fast: true } };

      expect(yield* connection.newSession({ cwd: "/work", mcpServers: [] })).toEqual({
        nativeSessionId: SESSION,
        ...settings,
      });
      expect(
        yield* connection.resumeSession({ nativeSessionId: SESSION, cwd: "/work", mcpServers: [] }),
      ).toEqual(settings);
    }),
);

// ---------------------------------------------------------------------------
// How calls fail
// ---------------------------------------------------------------------------

it.effect("fails a refused call with the harness's code and message", () =>
  Effect.gen(function* () {
    const peer = createPeer({
      "session/set_config_option": ({ id }) => [buildFailure(id, -32602, "Unknown model ID: nope")],
    });
    const connection = yield* openConnection(peer, createRecorder());

    const error = yield* Effect.flip(connection.setConfigOption(SESSION, "model", "nope"));

    expect(error).toMatchObject({
      reason: "refused",
      code: -32602,
      method: "session/set_config_option",
    });
    expect(error.message).toContain("Unknown model ID: nope");
  }),
);

it.effect("times out a call the harness never answers, after 30 seconds", () =>
  Effect.gen(function* () {
    const peer = createPeer({ "session/close": () => [] });
    const connection = yield* openConnection(peer, createRecorder());

    const closing = yield* Effect.forkChild(Effect.flip(connection.closeSession(SESSION)));
    yield* peer.whenWritten("the close request", wroteMethod("session/close"));
    yield* TestClock.adjust("29 seconds");
    expect(closing.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust("1 second");

    expect(yield* Fiber.join(closing)).toMatchObject({
      reason: "timed-out",
      method: "session/close",
    });
  }),
);

it.effect("lets a prompt wait for its reply as long as the harness works", () =>
  Effect.gen(function* () {
    const peer = createPeer({ "session/prompt": () => [] });
    const connection = yield* openConnection(peer, createRecorder());

    const prompting = yield* Effect.forkChild(connection.prompt(SESSION, TEXT));
    yield* peer.whenWritten("the prompt", wroteMethod("session/prompt"));
    yield* TestClock.adjust("24 hours");

    expect(prompting.pollUnsafe()).toBeUndefined();
  }),
);

it.effect("fails a call on a connection that is over, without writing it", () =>
  Effect.gen(function* () {
    const peer = createPeer();
    const connection = yield* openConnection(peer, createRecorder());
    peer.endOutput();
    yield* connection.awaitClosed;
    const writtenBefore = peer.written.length;

    const error = yield* Effect.flip(connection.setMode(SESSION, "auto"));

    expect(error).toMatchObject({ reason: "closed", method: "session/set_mode" });
    expect(peer.written).toHaveLength(writtenBefore);
  }),
);

/** The sentence for a reply of `method` that holds a value this version cannot read. */
const describeUnreadableReply = (method: string, detail: string): string =>
  `The harness answered ${method} with a value this version cannot read: ${detail}. ${SYNC_ADVICE}`;

const SLIDER = { id: "volume", name: "Volume", type: "slider", currentValue: 3 };
const SEND_TEXT = (connection: AcpConnection) => connection.prompt(SESSION, TEXT);

/**
 * A reply of each call the client sends, with a value that ACP version 1 does
 * not allow, and the sentence that must name it. The vendored client refuses
 * some of these replies, and its looser schemas accept the others and empty
 * the value.
 */
const UNREADABLE_REPLIES: ReadonlyArray<{
  readonly method: string;
  readonly reply: unknown;
  readonly call: (connection: AcpConnection) => Effect.Effect<unknown, AcpError>;
  readonly detail: string;
}> = [
  {
    method: "authenticate",
    reply: { _meta: 5 },
    call: (connection) => connection.authenticate("oauth-personal"),
    detail: "_meta is 5",
  },
  {
    method: "session/new",
    reply: { sessionId: SESSION, configOptions: [SLIDER] },
    call: (connection) => connection.newSession({ cwd: "/work", mcpServers: [] }),
    detail: `configOptions[0] is ${JSON.stringify(SLIDER)}`,
  },
  {
    method: "session/new",
    reply: { sessionId: SESSION, models: { currentModelId: 1, availableModels: [] } },
    call: (connection) => connection.newSession({ cwd: "/work", mcpServers: [] }),
    detail: "models.currentModelId is 1",
  },
  {
    method: "session/resume",
    reply: { modes: { currentModeId: 5, availableModes: [] } },
    call: (connection) =>
      connection.resumeSession({ nativeSessionId: SESSION, cwd: "/work", mcpServers: [] }),
    detail: "modes.currentModeId is 5",
  },
  {
    method: "session/resume",
    reply: { models: { currentModelId: "m", availableModels: [{ modelId: 1, name: "x" }] } },
    call: (connection) =>
      connection.resumeSession({ nativeSessionId: SESSION, cwd: "/work", mcpServers: [] }),
    detail: "models.availableModels[0].modelId is 1",
  },
  {
    method: "session/close",
    reply: { _meta: 5 },
    call: (connection) => connection.closeSession(SESSION),
    detail: "_meta is 5",
  },
  {
    method: "session/set_mode",
    reply: { _meta: 5 },
    call: (connection) => connection.setMode(SESSION, "auto"),
    detail: "_meta is 5",
  },
  {
    method: "session/set_config_option",
    reply: { configOptions: 5 },
    call: (connection) => connection.setConfigOption(SESSION, "model", "m"),
    detail: "configOptions is 5",
  },
  {
    method: "session/prompt",
    reply: { stopReason: "quota" },
    call: SEND_TEXT,
    detail: 'stopReason is "quota"',
  },
  {
    method: "session/prompt",
    reply: {
      stopReason: "end_turn",
      usage: { totalTokens: "many", inputTokens: 1, outputTokens: 2 },
    },
    call: SEND_TEXT,
    detail: 'usage.totalTokens is "many"',
  },
  {
    method: "session/prompt",
    reply: {},
    call: SEND_TEXT,
    detail: "stopReason is missing",
  },
];

it.effect.each(UNREADABLE_REPLIES)(
  "fails the reply to $method with $detail, with the field, the value and the advice to sync",
  ({ method, reply, call, detail }) =>
    Effect.gen(function* () {
      const connection = yield* openConnection(
        createPeer({ [method]: answerWith(reply) }),
        createRecorder(),
      );

      const error = yield* Effect.flip(call(connection));

      expect(error).toMatchObject({ reason: "unreadable", method });
      expect(error.message).toBe(describeUnreadableReply(method, detail));
      expect(error).not.toHaveProperty("harnessMessage");
    }),
);

it.effect("has a description for the reply to every call it sends", () =>
  Effect.gen(function* () {
    const peer = createPeer();
    const connection = yield* openConnection(peer, createRecorder());
    yield* callEverything(connection);

    const repliedMethods = new Set(
      peer.written.flatMap((message) =>
        typeof message["method"] === "string" && message["id"] !== undefined
          ? [message["method"]]
          : [],
      ),
    );
    // The reply to initialize is described in the table of handshakes below.
    const describedMethods = new Set([
      ...UNREADABLE_REPLIES.map(({ method }) => method),
      "initialize",
    ]);
    expect(describedMethods).toEqual(repliedMethods);
  }),
);

/** The handshake of each way it can fail, and what the caller of `openAcpConnection` gets. */
const FAILING_HANDSHAKES: ReadonlyArray<{
  readonly name: string;
  readonly script: Script;
  /** What happens after the handshake was written, for a harness that does not answer at once. */
  readonly then?: Effect.Effect<void>;
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
    script: ({ endOutput }) => {
      endOutput();
      return [];
    },
    error: { reason: "closed" },
    message: "The call to initialize failed. The harness closed its output.",
  },
  {
    name: "the harness does not answer",
    script: () => [],
    then: TestClock.adjust("30 seconds"),
    error: { reason: "timed-out" },
    message:
      "The harness did not answer initialize within 30 seconds. It is not known whether it did what was asked.",
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
  {
    name: "the harness speaks ACP version 2",
    script: answerWith({ protocolVersion: 2, info: { name: "Future", version: "1" } }),
    error: { reason: "unreadable" },
    message:
      'The harness speaks ACP version 2, which this version does not: its reply to initialize has an "info" field, which only version 2 has.',
  },
];

it.effect.each(FAILING_HANDSHAKES)("fails to open when $name", (handshake) =>
  Effect.gen(function* () {
    const peer = createPeer({ initialize: handshake.script });
    const opening = yield* Effect.forkChild(Effect.flip(openConnection(peer, createRecorder())));
    yield* peer.whenWritten("the handshake", wroteMethod("initialize"));
    if (handshake.then !== undefined) yield* handshake.then;

    const error = yield* Fiber.join(opening);

    expect(error).toMatchObject({ ...handshake.error, method: "initialize" });
    expect(error.message).toBe(handshake.message);
  }),
);

it.effect("accepts a version 1 reply that says its protocol version is 2", () =>
  Effect.gen(function* () {
    const connection = yield* openConnection(
      createPeer({
        initialize: answerWith({
          protocolVersion: 2,
          agentInfo: { name: "Antigravity", version: "1" },
        }),
      }),
      createRecorder(),
    );

    expect(connection.harness).toMatchObject({ name: "Antigravity" });
  }),
);

it.effect(
  "stops reading the harness's output, and hands nothing on, after a failed handshake",
  () =>
    Effect.gen(function* () {
      const peer = createPeer({
        initialize: ({ id }) => [buildFailure(id, -32000, "Not signed in")],
      });
      const recorder = createRecorder();
      yield* Effect.flip(openConnection(peer, recorder));
      yield* peer.whenReadingStopped;

      peer.say(buildSessionUpdate(MESSAGE_CHUNK));
      peer.say(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS));

      expect(recorder.updates).toEqual([]);
      expect(recorder.approvalRequests).toEqual([]);
    }),
);

// ---------------------------------------------------------------------------
// Session updates
// ---------------------------------------------------------------------------

it.effect("reads the update kinds it uses, and calls every other kind other", () =>
  Effect.gen(function* () {
    const recorder = createRecorder();
    const peer = createPeer();
    yield* openConnection(peer, recorder);

    const updates = [
      MESSAGE_CHUNK,
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Hmm" } },
      { sessionUpdate: "tool_call", ...TOOL_CALL },
      // A tool kind and a status the vendored client does not list still arrive.
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        kind: "newkind",
        status: "newstatus",
      },
      { sessionUpdate: "usage_update", used: 10, size: 100 },
      { sessionUpdate: "current_mode_update", currentModeId: "auto" },
      { sessionUpdate: "config_option_update", configOptions: [] },
      { sessionUpdate: "available_commands_update", availableCommands: [] },
      { sessionUpdate: "brand_new", anything: 1 },
    ];
    for (const update of updates) peer.say(buildSessionUpdate(update));
    yield* recorder.waitUntil("nine updates arrived", () => recorder.updates.length === 9);

    expect(recorder.updates.map(({ update }) => update)).toEqual([
      expect.objectContaining({
        sessionUpdate: "agent_message_chunk",
        content: MESSAGE_CHUNK.content,
      }),
      expect.objectContaining({ sessionUpdate: "agent_thought_chunk" }),
      expect.objectContaining({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        kind: "execute",
      }),
      expect.objectContaining({
        sessionUpdate: "tool_call_update",
        kind: "newkind",
        status: "newstatus",
      }),
      expect.objectContaining({ sessionUpdate: "usage_update", used: 10, size: 100 }),
      expect.objectContaining({ sessionUpdate: "current_mode_update", currentModeId: "auto" }),
      expect.objectContaining({ sessionUpdate: "config_option_update", configOptions: [] }),
      { sessionUpdate: "other", name: "available_commands_update" },
      { sessionUpdate: "other", name: "brand_new" },
    ]);
    expect(recorder.unhandled).toEqual([]);
  }),
);

it.effect("hands each update the params of its own line, with the fields it does not know", () =>
  Effect.gen(function* () {
    const recorder = createRecorder();
    const peer = createPeer();
    yield* openConnection(peer, recorder);

    // Sent in one burst: the params must not be mixed up between lines.
    const sent = [0, 1, 2, 3].map((n) => ({
      sessionId: SESSION,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `chunk ${n}`, zzContent: n },
        zzUpdate: n,
      },
      zzParams: n,
    }));
    for (const params of sent) peer.say(buildNotification("session/update", params));
    yield* recorder.waitUntil("four updates arrived", () => recorder.updates.length === 4);

    expect(recorder.updates.map(({ raw }) => raw)).toEqual(sent);
    expect(recorder.updates.map(({ nativeSessionId }) => nativeSessionId)).toEqual(
      sent.map(() => SESSION),
    );
  }),
);

it.effect("reports an update it cannot read, names the field and the value, and goes on", () =>
  Effect.gen(function* () {
    const recorder = createRecorder();
    const peer = createPeer();
    yield* openConnection(peer, recorder);

    const unreadable = buildSessionUpdate({ sessionUpdate: "agent_message_chunk", content: 3 });
    peer.say(unreadable);
    peer.say(buildSessionUpdate(MESSAGE_CHUNK));
    yield* recorder.waitUntil("the next update arrived", () => recorder.updates.length === 1);

    expect(recorder.unhandled).toEqual([
      {
        reason: `The harness sent session/update with a value this version cannot read: update.content is 3. ${SYNC_ADVICE}`,
        payload: unreadable,
      },
    ]);
    expect(recorder.updates[0]?.update).toMatchObject({ sessionUpdate: "agent_message_chunk" });
  }),
);

/** Updates that the vendored client lets through although a field that must be a string is not one. */
const UPDATES_WITHOUT_AN_IDENTIFIER = [
  {
    name: "a tool call whose id is a number",
    update: { sessionUpdate: "tool_call", toolCallId: 5, title: "Run ls" },
    detail: "update.toolCallId is 5",
  },
  {
    name: "a tool call update without an id",
    update: { sessionUpdate: "tool_call_update", status: "completed" },
    detail: "update.toolCallId is missing",
  },
  {
    name: "a mode change whose mode id is a number",
    update: { sessionUpdate: "current_mode_update", currentModeId: 3 },
    detail: "update.currentModeId is 3",
  },
] as const;

it.effect.each(UPDATES_WITHOUT_AN_IDENTIFIER)(
  "reports $name, does not hand it on, and goes on",
  ({ update, detail }) =>
    Effect.gen(function* () {
      const recorder = createRecorder();
      const peer = createPeer();
      yield* openConnection(peer, recorder);

      const sent = buildSessionUpdate(update);
      peer.say(sent);
      peer.say(buildSessionUpdate(MESSAGE_CHUNK));
      yield* recorder.waitUntil("the next update arrived", () => recorder.updates.length === 1);

      expect(recorder.unhandled).toEqual([
        {
          reason: `The harness sent session/update with a value this version cannot read: ${detail}. ${SYNC_ADVICE}`,
          payload: sent,
        },
      ]);
      expect(recorder.updates[0]?.update).toMatchObject({ sessionUpdate: "agent_message_chunk" });
    }),
);

it.effect(
  "reports a notification and a request it does not know, and answers the request with an error",
  () =>
    Effect.gen(function* () {
      const recorder = createRecorder();
      const peer = createPeer();
      yield* openConnection(peer, recorder);

      const note = buildNotification("_vendor/note", { a: 1 });
      const fileRequest = buildRequest("u1", "fs/read_text_file", {
        sessionId: SESSION,
        path: "/x",
      });
      peer.say(note);
      peer.say(fileRequest);
      yield* peer.whenWritten("the answer to u1", wroteReplyTo("u1"));
      yield* recorder.waitUntil("two reports", () => recorder.unhandled.length === 2);

      expect(peer.written.find(wroteReplyTo("u1"))).toMatchObject({ error: { code: -32601 } });
      expect(recorder.unhandled).toEqual([
        {
          reason:
            "The harness sent the notification _vendor/note, which this version does not use.",
          payload: note,
        },
        {
          reason:
            "The harness sent the request fs/read_text_file, which this version could not answer: Method not found: fs/read_text_file.",
          payload: fileRequest,
        },
      ]);
    }),
);

it.effect("is not stopped by a handler that throws", () =>
  Effect.gen(function* () {
    const seen: Array<string> = [];
    const recorder = createRecorder({
      onUnhandledMessage: () => {
        throw new Error("the reporter broke");
      },
      onSessionUpdate: (notification) => {
        seen.push(notification.update.sessionUpdate);
        throw new Error("the updater broke");
      },
    });
    const peer = createPeer();
    const connection = yield* openConnection(peer, recorder);

    peer.say(buildNotification("_vendor/note", {}));
    peer.say(buildSessionUpdate(MESSAGE_CHUNK));
    peer.say(buildSessionUpdate({ sessionUpdate: "usage_update", used: 1, size: 2 }));
    yield* recorder.waitUntil("both updates arrived", () => recorder.updates.length === 2);

    expect(seen).toEqual(["agent_message_chunk", "usage_update"]);
    expect(yield* connection.prompt(SESSION, TEXT)).toEqual(PROMPT_RESULT);
  }),
);

// ---------------------------------------------------------------------------
// Requests of the harness
// ---------------------------------------------------------------------------

it.effect(
  "hands an approval request to its handler with its id and params, and writes the outcome",
  () =>
    Effect.gen(function* () {
      const outcomes = new Map<string, ApprovalOutcome>([
        ["p-selected", { outcome: "selected", optionId: "deny" }],
        ["p-cancelled", { outcome: "cancelled" }],
      ]);
      const recorder = createRecorder({
        approval: ({ requestId }) =>
          Effect.succeed(outcomes.get(String(requestId)) ?? { outcome: "cancelled" }),
      });
      const peer = createPeer();
      yield* openConnection(peer, recorder);

      const sent = { ...APPROVAL_PARAMS, zzNew: { a: [1] } };
      peer.say(buildRequest("p-selected", "session/request_permission", sent));
      peer.say(buildRequest("p-cancelled", "session/request_permission", APPROVAL_PARAMS));
      peer.say(buildRequest(7, "session/request_permission", APPROVAL_PARAMS));
      yield* peer.whenWritten("the answer to 7", wroteReplyTo(7));

      expect(peer.written.find(wroteReplyTo("p-selected"))).toEqual(
        buildResult("p-selected", { outcome: { outcome: "selected", optionId: "deny" } }),
      );
      expect(peer.written.find(wroteReplyTo("p-cancelled"))).toEqual(
        buildResult("p-cancelled", { outcome: { outcome: "cancelled" } }),
      );
      expect(peer.written.find(wroteReplyTo(7))).toEqual(
        buildResult(7, { outcome: { outcome: "cancelled" } }),
      );
      const [first, , third] = recorder.approvalRequests;
      expect(first).toMatchObject({
        requestId: "p-selected",
        nativeSessionId: SESSION,
        toolCall: { toolCallId: "call_1", kind: "execute", name: "run_command" },
        options: APPROVAL_PARAMS.options,
        raw: sent,
      });
      // A numeric id stays a number.
      expect(third?.requestId).toBe(7);
    }),
);

it.effect("hands an elicitation to its handler and writes each kind of reply", () =>
  Effect.gen(function* () {
    const replies = new Map<string, ElicitationReply>([
      ["e-accept", { action: "accept", content: { q1: "2", q1_other: "Teal" } }],
      ["e-decline", { action: "decline" }],
      ["e-cancel", { action: "cancel" }],
    ]);
    const recorder = createRecorder({
      elicitation: ({ requestId }) =>
        Effect.succeed(replies.get(String(requestId)) ?? { action: "cancel" }),
    });
    const peer = createPeer();
    yield* openConnection(peer, recorder);

    const sent = { ...ELICITATION_PARAMS, zzNew: 1 };
    peer.say(buildRequest("e-accept", "elicitation/create", sent));
    peer.say(buildRequest("e-decline", "elicitation/create", ELICITATION_PARAMS));
    peer.say(buildRequest("e-cancel", "elicitation/create", ELICITATION_PARAMS));
    yield* peer.whenWritten("the answer to e-cancel", wroteReplyTo("e-cancel"));

    expect(peer.written.find(wroteReplyTo("e-accept"))).toEqual(
      buildResult("e-accept", { action: "accept", content: { q1: "2", q1_other: "Teal" } }),
    );
    expect(peer.written.find(wroteReplyTo("e-decline"))).toEqual(
      buildResult("e-decline", { action: "decline" }),
    );
    expect(peer.written.find(wroteReplyTo("e-cancel"))).toEqual(
      buildResult("e-cancel", { action: "cancel" }),
    );
    expect(recorder.elicitationRequests[0]).toMatchObject({
      requestId: "e-accept",
      nativeSessionId: SESSION,
      toolCallId: "call_2",
      message: "The agent has a question.",
      requestedSchema: { properties: { q1: { type: "string", title: "Which colour?" } } },
      raw: sent,
    });
  }),
);

it.effect("handles updates while an approval request waits for its answer", () =>
  Effect.gen(function* () {
    const answered = yield* Deferred.make<ApprovalOutcome>();
    const recorder = createRecorder({ approval: () => Deferred.await(answered) });
    const peer = createPeer();
    yield* openConnection(peer, recorder);

    peer.say(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS));
    yield* recorder.waitUntil(
      "the approval request arrived",
      () => recorder.approvalRequests.length === 1,
    );
    peer.say(buildSessionUpdate(MESSAGE_CHUNK));
    yield* recorder.waitUntil("the update arrived", () => recorder.updates.length === 1);
    expect(peer.written.some(wroteReplyTo("p1"))).toBe(false);
    yield* Deferred.succeed(answered, ALLOW);
    yield* peer.whenWritten("the answer to p1", wroteReplyTo("p1"));

    expect(peer.written.find(wroteReplyTo("p1"))).toEqual(
      buildResult("p1", { outcome: { outcome: "selected", optionId: "allow" } }),
    );
  }),
);

it.effect(
  "answers an approval request for a tool kind it does not know with an error, and reports it",
  () =>
    Effect.gen(function* () {
      const recorder = createRecorder();
      const peer = createPeer();
      yield* openConnection(peer, recorder);

      const sent = buildRequest("p1", "session/request_permission", {
        ...APPROVAL_PARAMS,
        toolCall: { ...APPROVAL_PARAMS.toolCall, kind: "newkind" },
      });
      peer.say(sent);
      yield* recorder.waitUntil("the report", () => recorder.unhandled.length === 1);

      expect(peer.written.find(wroteReplyTo("p1"))).toHaveProperty("error");
      expect(peer.written.find(wroteReplyTo("p1"))).not.toHaveProperty("result");
      expect(recorder.approvalRequests).toEqual([]);
      expect(recorder.unhandled).toEqual([
        {
          reason: `The harness sent session/request_permission with a value this version cannot read: toolCall.kind is "newkind". ${SYNC_ADVICE}`,
          payload: sent,
        },
      ]);
    }),
);

const HANDLER_FAILURES = [
  {
    name: "throws before it returns an effect",
    fail: (): never => {
      throw new Error("the screen crashed");
    },
  },
  { name: "dies", fail: () => Effect.die(new Error("the screen crashed")) },
] as const;

const REQUESTS_OF_THE_HARNESS = [
  { method: "session/request_permission", params: APPROVAL_PARAMS },
  { method: "elicitation/create", params: ELICITATION_PARAMS },
] as const;

it.effect.each(
  HANDLER_FAILURES.flatMap((failure) =>
    REQUESTS_OF_THE_HARNESS.map((request) => ({ ...failure, ...request })),
  ),
)("answers $method with an error, reports it and logs it when its handler $name", (failing) =>
  Effect.gen(function* () {
    const logged: Array<string> = [];
    const collecting = Logger.make<unknown, void>(({ message }) => {
      logged.push(String(message));
    });
    const recorder = createRecorder({ approval: failing.fail, elicitation: failing.fail });
    const peer = createPeer();
    yield* openConnection(peer, recorder).pipe(Effect.provide(Logger.layer([collecting])));

    const sent = buildRequest("r1", failing.method, failing.params);
    peer.say(sent);
    yield* recorder.waitUntil("the report", () => recorder.unhandled.length === 1);

    expect(peer.written.find(wroteReplyTo("r1"))).toHaveProperty("error");
    expect(recorder.unhandled).toEqual([
      {
        reason: `The harness sent the request ${failing.method}, which this version could not answer: Internal error.`,
        payload: sent,
      },
    ]);
    expect(
      logged.some((line) => line.startsWith(`ACP request handler failed for '${failing.method}'`)),
    ).toBe(true);
  }),
);

it.effect("refuses an approval request whose tool call was read differently, and reports it", () =>
  Effect.gen(function* () {
    const recorder = createRecorder();
    const peer = createPeer();
    yield* openConnection(peer, recorder);

    // A top-level `title` makes the vendored client read the request as ACP
    // version 2, and replace the tool call by one it builds itself.
    const sent = buildRequest("p1", "session/request_permission", {
      ...APPROVAL_PARAMS,
      title: "Run ls",
    });
    peer.say(sent);
    yield* recorder.waitUntil("the report", () => recorder.unhandled.length === 1);

    expect(peer.written.find(wroteReplyTo("p1"))).toMatchObject({ error: { code: -32602 } });
    expect(recorder.approvalRequests).toEqual([]);
    expect(recorder.unhandled).toEqual([
      {
        reason:
          "The harness sent the request session/request_permission, which this version could not answer: The tool call in this request was read differently from how the harness sent it, so it was not shown for approval.",
        payload: sent,
      },
    ]);
  }),
);

it.effect(
  "answers an elicitation in a mode it did not advertise with an error, and reports it",
  () =>
    Effect.gen(function* () {
      const recorder = createRecorder();
      const peer = createPeer();
      yield* openConnection(peer, recorder);

      const sent = buildRequest("e1", "elicitation/create", {
        ...ELICITATION_PARAMS,
        mode: "future",
      });
      peer.say(sent);
      yield* recorder.waitUntil("the report", () => recorder.unhandled.length === 1);

      expect(peer.written.find(wroteReplyTo("e1"))).toMatchObject({ error: { code: -32602 } });
      expect(recorder.elicitationRequests).toEqual([]);
      expect(recorder.unhandled).toEqual([
        {
          reason:
            "The harness sent the request elicitation/create, which this version could not answer: This client only answers elicitations in the form mode, not future.",
          payload: sent,
        },
      ]);
    }),
);

// ---------------------------------------------------------------------------
// Fields the client does not know
// ---------------------------------------------------------------------------

/** Plays a session in which the harness replies and sends with `shape` applied to every message. */
const playSession = (shape: (value: unknown) => unknown) =>
  Effect.gen(function* () {
    const peer = createPeer({
      initialize: answerWith(shape(INITIALIZE_RESULT)),
      authenticate: answerWith(shape({})),
      "session/new": answerWith(shape(NEW_SESSION_RESULT)),
      "session/resume": answerWith(shape({ configOptions: [] })),
      "session/set_config_option": answerWith(shape({ configOptions: [] })),
      "session/prompt": answerWith(shape(PROMPT_RESULT)),
    });
    const recorder = createRecorder();
    const connection = yield* openConnection(peer, recorder);
    const authenticated = yield* connection.authenticate("oauth-personal");
    const session = yield* connection.newSession({ cwd: "/work", mcpServers: [] });
    const resumed = yield* connection.resumeSession({
      nativeSessionId: SESSION,
      cwd: "/work",
      mcpServers: [],
    });
    const configOptions = yield* connection.setConfigOption(SESSION, "model", "m");
    const prompted = yield* connection.prompt(SESSION, TEXT);
    for (const update of [
      MESSAGE_CHUNK,
      { sessionUpdate: "tool_call", ...TOOL_CALL },
      { sessionUpdate: "usage_update", used: 10, size: 100 },
    ]) {
      peer.say(shape(buildSessionUpdate(update)) as Message);
    }
    peer.say(shape(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS)) as Message);
    peer.say(shape(buildRequest("e1", "elicitation/create", ELICITATION_PARAMS)) as Message);
    yield* peer.whenWritten("the answer to e1", wroteReplyTo("e1"));
    return {
      harness: connection.harness,
      authenticated,
      session,
      resumed,
      configOptions,
      prompted,
      updates: recorder.updates.map(({ update }) => update.sessionUpdate),
      approval: recorder.approvalRequests.map((r) => ({
        id: r.requestId,
        session: r.nativeSessionId,
        tool: r.toolCall.toolCallId,
        options: r.options.map((option) => option.optionId),
      })),
      elicitation: recorder.elicitationRequests.map((r) => ({
        id: r.requestId,
        message: r.message,
        fields: Object.keys(r.requestedSchema.properties ?? {}),
      })),
      unhandled: recorder.unhandled,
    };
  });

it.effect("is not bothered by fields it does not know, at any level of a message", () =>
  Effect.gen(function* () {
    const plain = yield* playSession((value) => value);
    const decorated = yield* playSession(withUnknownFields);

    expect(plain.updates).toEqual(["agent_message_chunk", "tool_call", "usage_update"]);
    expect(plain.session.configOptions.length).toBeGreaterThan(0);
    expect(plain.approval).toHaveLength(1);
    expect(plain.elicitation).toHaveLength(1);
    expect(decorated).toEqual(plain);
  }),
);

// ---------------------------------------------------------------------------
// Frames the harness writes
// ---------------------------------------------------------------------------

/** Lines that make it impossible to tell which message is which, so the connection ends. */
const LINES_THAT_END_THE_CONNECTION = [
  {
    name: "a batch of messages",
    lines: [JSON.stringify([buildSessionUpdate(MESSAGE_CHUNK)])],
    reason:
      "The harness wrote a batch (a JSON array). ACP does not use batches, and the messages in it could not be told apart.",
  },
  {
    name: "a request whose id is still open",
    lines: [
      JSON.stringify(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS)),
      JSON.stringify(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS)),
    ],
    reason: 'The harness sent a second request with the id "p1" before the first was answered.',
  },
] as const;

it.effect.each(LINES_THAT_END_THE_CONNECTION)(
  "ends the connection when the harness writes $name",
  ({ lines, reason }) =>
    Effect.gen(function* () {
      const peer = createPeer({ "session/prompt": () => [] });
      const recorder = createRecorder({ approval: () => Effect.never });
      const connection = yield* openConnection(peer, recorder);
      const prompting = yield* Effect.forkChild(Effect.flip(connection.prompt(SESSION, TEXT)));
      yield* peer.whenWritten("the prompt", wroteMethod("session/prompt"));

      for (const line of lines) peer.say(line);

      expect(yield* connection.awaitClosed).toMatchObject({ reason: "closed", message: reason });
      expect((yield* Fiber.join(prompting)).message).toBe(
        `The call to session/prompt failed. ${reason}`,
      );
      // Only the first request of the duplicate pair, or nothing, reached a handler.
      expect(recorder.updates).toEqual([]);
      expect(recorder.approvalRequests.length).toBeLessThanOrEqual(1);
    }),
);

const NOT_A_MESSAGE =
  "The harness wrote a line that is JSON but not a message (not a JSON object).";

/** Lines that are no message of ours to handle, and are reported and then left alone. */
const REPORTED_LINES = [
  { name: "a number", line: "123", payload: 123, reason: NOT_A_MESSAGE },
  { name: "null", line: "null", payload: null, reason: NOT_A_MESSAGE },
] as const;

it.effect.each(REPORTED_LINES)("reports $name, and goes on", ({ line, payload, reason }) =>
  Effect.gen(function* () {
    const recorder = createRecorder();
    const peer = createPeer();
    const connection = yield* openConnection(peer, recorder);

    peer.say(line);
    peer.say(buildSessionUpdate(MESSAGE_CHUNK));
    yield* recorder.waitUntil("the next update arrived", () => recorder.updates.length === 1);

    expect(recorder.unhandled).toEqual([{ reason, payload }]);
    expect(yield* connection.prompt(SESSION, TEXT)).toEqual(PROMPT_RESULT);
  }),
);

/** Names that are also the names of what every JavaScript object has. */
const METHODS_NAMED_LIKE_OBJECT_MEMBERS = ["constructor", "__proto__"];

it.effect.each(METHODS_NAMED_LIKE_OBJECT_MEMBERS)(
  "answers a request named %s like any request it does not know, and goes on",
  (method) =>
    Effect.gen(function* () {
      const recorder = createRecorder();
      const peer = createPeer();
      const connection = yield* openConnection(peer, recorder);

      const sent = buildRequest("u1", method, {});
      peer.say(sent);
      peer.say(buildSessionUpdate(MESSAGE_CHUNK));
      yield* recorder.waitUntil("the next update arrived", () => recorder.updates.length === 1);

      expect(peer.written.find(wroteReplyTo("u1"))).toMatchObject({ error: { code: -32601 } });
      expect(recorder.unhandled).toEqual([
        {
          reason: `The harness sent the request ${method}, which this version could not answer: Method not found: ${method}.`,
          payload: sent,
        },
      ]);
      expect(yield* connection.prompt(SESSION, TEXT)).toEqual(PROMPT_RESULT);
    }),
);

it.effect(
  "does not describe a request of the harness that is named like one of our calls as a reply",
  () =>
    Effect.gen(function* () {
      const recorder = createRecorder();
      const peer = createPeer();
      yield* openConnection(peer, recorder);

      const sent = buildRequest("u1", "session/prompt", { stopReason: "quota" });
      peer.say(sent);
      yield* recorder.waitUntil("the report", () => recorder.unhandled.length === 1);

      expect(recorder.unhandled[0]?.reason).toBe(
        "The harness sent the request session/prompt, which this version could not answer: Method not found: session/prompt.",
      );
    }),
);

it.effect("names, in each of two overlapping prompts, the reply that prompt got", () =>
  Effect.gen(function* () {
    const peer = createPeer({
      "session/prompt": ({ id, params }) => [
        buildResult(id, { stopReason: `quota-${(params as { sessionId: string }).sessionId}` }),
      ],
    });
    const connection = yield* openConnection(peer, createRecorder());

    const [first, second] = yield* Effect.all(
      [Effect.flip(connection.prompt("a", TEXT)), Effect.flip(connection.prompt("b", TEXT))],
      { concurrency: "unbounded" },
    );

    expect(first.message).toBe(
      describeUnreadableReply("session/prompt", 'stopReason is "quota-a"'),
    );
    expect(second.message).toBe(
      describeUnreadableReply("session/prompt", 'stopReason is "quota-b"'),
    );
  }),
);

// ---------------------------------------------------------------------------
// Text of the harness in messages
// ---------------------------------------------------------------------------

const BEARER_TOKEN = "Bearer sk-live-0123456789abcdef";

/** Opens a connection whose session was given the bearer token in an MCP server's header. */
const openSessionWithToken = (peer: Peer, recorder: Recorder) =>
  Effect.gen(function* () {
    const connection = yield* openConnection(peer, recorder);
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
const LONG_ECHO = `${BEARER_TOKEN} ${"z".repeat(300)}`;

/**
 * Each place where text of the harness is put into a sentence for a person, fed
 * `LONG_ECHO`, and the sentences that person reads. Every one must quote the
 * text: the token hidden and the text cut.
 */
const PLACES_OF_HARNESS_TEXT: ReadonlyArray<{
  readonly name: string;
  readonly scripts?: Readonly<Record<string, Script>>;
  readonly texts: (context: {
    readonly peer: Peer;
    readonly recorder: Recorder;
    readonly connection: AcpConnection;
  }) => Effect.Effect<ReadonlyArray<string>, unknown>;
}> = [
  {
    name: "the text of a refusal",
    scripts: {
      "session/set_mode": ({ id }) => [buildFailure(id, -32603, LONG_ECHO)],
    },
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
    name: "a value in an update that the vendored client drops",
    texts: ({ peer, recorder }) =>
      Effect.gen(function* () {
        peer.say(buildSessionUpdate({ sessionUpdate: "agent_message_chunk", content: LONG_ECHO }));
        yield* recorder.waitUntil("the report", () => recorder.unhandled.length === 1);
        return recorder.unhandled.map(({ reason }) => reason);
      }),
  },
  {
    name: "an identifier in an update that the vendored client lets through",
    texts: ({ peer, recorder }) =>
      Effect.gen(function* () {
        peer.say(
          buildSessionUpdate({ sessionUpdate: "current_mode_update", currentModeId: [LONG_ECHO] }),
        );
        yield* recorder.waitUntil("the report", () => recorder.unhandled.length === 1);
        return recorder.unhandled.map(({ reason }) => reason);
      }),
  },
  {
    name: "the name of a notification",
    texts: ({ peer, recorder }) =>
      Effect.gen(function* () {
        peer.say(buildNotification(`tools/${LONG_ECHO}`, {}));
        yield* recorder.waitUntil("the report", () => recorder.unhandled.length === 1);
        return recorder.unhandled.map(({ reason }) => reason);
      }),
  },
  {
    name: "the name of a request it refuses",
    texts: ({ peer, recorder }) =>
      Effect.gen(function* () {
        peer.say(buildRequest("u1", `tools/${LONG_ECHO}`, {}));
        yield* recorder.waitUntil("the report", () => recorder.unhandled.length === 1);
        return recorder.unhandled.map(({ reason }) => reason);
      }),
  },
  {
    name: "the id of a request",
    texts: ({ peer, connection }) =>
      Effect.gen(function* () {
        peer.say(buildRequest(LONG_ECHO, "session/request_permission", APPROVAL_PARAMS));
        peer.say(buildRequest(LONG_ECHO, "session/request_permission", APPROVAL_PARAMS));
        return [(yield* connection.awaitClosed).message];
      }),
  },
  {
    name: "a line that is not JSON",
    texts: ({ peer, connection }) =>
      Effect.gen(function* () {
        peer.say(`Warning: ${LONG_ECHO}`);
        return [(yield* connection.awaitClosed).message];
      }),
  },
];

it.effect.each(PLACES_OF_HARNESS_TEXT)(
  "hides the header values of the session and cuts the text when the harness echoes it in $name",
  ({ scripts, texts }) =>
    Effect.gen(function* () {
      const peer = createPeer(scripts);
      const recorder = createRecorder({ approval: () => Effect.never });
      const connection = yield* openSessionWithToken(peer, recorder);

      const read = yield* texts({ peer, recorder, connection });

      expect(read).toHaveLength(1);
      expect(read[0]).not.toContain("sk-live");
      expect(read[0]).toContain("[hidden]");
      expect(read[0]).not.toContain("z".repeat(201));
      expect(read[0]).toContain("...");
    }),
);

it.effect("hides a secret before it cuts the text, and keeps harnessMessage whole", () =>
  Effect.gen(function* () {
    const text = `${"y".repeat(195)}${BEARER_TOKEN}${"z".repeat(300)}`;
    const peer = createPeer({
      "session/set_mode": ({ id }) => [buildFailure(id, -32603, text)],
    });
    const connection = yield* openSessionWithToken(peer, createRecorder());

    const error = yield* Effect.flip(connection.setMode(SESSION, "auto"));

    expect(error.message).toBe(
      `The harness refused session/set_mode: ${"y".repeat(195)}[hidd... (code -32603).`,
    );
    expect(error.harnessMessage).toBe(`${"y".repeat(195)}[hidden]${"z".repeat(300)}`);
  }),
);

it.effect("hands the payload of an unhandled message on untouched, secrets included", () =>
  Effect.gen(function* () {
    const recorder = createRecorder();
    const peer = createPeer();
    yield* openSessionWithToken(peer, recorder);

    const sent = buildSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: BEARER_TOKEN,
    });
    peer.say(sent);
    yield* recorder.waitUntil("the report", () => recorder.unhandled.length === 1);

    expect(recorder.unhandled[0]?.payload).toEqual(sent);
  }),
);

// ---------------------------------------------------------------------------
// The end of the connection
// ---------------------------------------------------------------------------

it.effect(
  "fails a line that is not a message with the start of the line, and ends the connection",
  () =>
    Effect.gen(function* () {
      const peer = createPeer({ "session/prompt": () => [] });
      const connection = yield* openConnection(peer, createRecorder());
      const prompting = yield* Effect.forkChild(Effect.flip(connection.prompt(SESSION, TEXT)));
      yield* peer.whenWritten("the prompt", wroteMethod("session/prompt"));

      peer.say("this is a log line, not JSON");

      const error = yield* Fiber.join(prompting);
      expect(error).toMatchObject({ reason: "closed", method: "session/prompt" });
      expect(error.message).toBe(
        "The call to session/prompt failed. The harness wrote a line that is not a JSON-RPC message, or ended in the middle of one, so nothing it sends can be trusted any more. The line starts with: this is a log line, not JSON",
      );
      expect(yield* connection.awaitClosed).toMatchObject({ reason: "closed" });
    }),
);

/** What happens right after the harness answered a prompt, in the same moment. */
const ENDS_RIGHT_AFTER_A_REPLY = [
  {
    name: "the harness closes its output",
    afterReply: (peer: Call) => {
      peer.endOutput();
      return [];
    },
  },
  {
    name: "the harness writes a line that is not JSON",
    afterReply: () => ["Goodbye!"],
  },
  {
    name: "the harness writes a batch",
    afterReply: () => [JSON.stringify([buildSessionUpdate(MESSAGE_CHUNK)])],
  },
  {
    name: "the harness's output fails",
    afterReply: (_call: Call, peer: Peer) => {
      peer.failOutput(new Error("the pipe broke"));
      return [];
    },
  },
] as const;

it.effect.each(ENDS_RIGHT_AFTER_A_REPLY)(
  "returns the reply of a prompt that the harness answered and then $name",
  ({ afterReply }) =>
    Effect.gen(function* () {
      const peer: Peer = createPeer({
        "session/prompt": (call) => [
          buildResult(call.id, PROMPT_RESULT),
          ...afterReply(call, peer),
        ],
      });
      const connection = yield* openConnection(peer, createRecorder());

      expect(yield* connection.prompt(SESSION, TEXT)).toEqual(PROMPT_RESULT);
      expect(yield* connection.awaitClosed).toMatchObject({ reason: "closed" });
    }),
);

it.effect(
  "returns the reply of a prompt although a write failed while the reply was on its way",
  () =>
    Effect.gen(function* () {
      const peer: Peer = createPeer({
        "session/prompt": ({ id }) => [
          buildRequest("p1", "session/request_permission", APPROVAL_PARAMS),
          buildResult(id, PROMPT_RESULT),
        ],
      });
      // The answer to the approval request is the write that fails.
      const recorder = createRecorder({
        approval: () => {
          peer.breakWrites();
          return Effect.succeed(ALLOW);
        },
      });
      const connection = yield* openConnection(peer, recorder);

      expect(yield* connection.prompt(SESSION, TEXT)).toEqual(PROMPT_RESULT);
      expect(yield* connection.awaitClosed).toMatchObject({
        message: "Could not write to the harness: Error: EPIPE",
      });
    }),
);

/** The ways a connection ends, each a function that makes it end. */
const ENDINGS = [
  {
    name: "the harness closes its output",
    end: (peer: Peer) => Effect.sync(() => peer.endOutput()),
    why: "The harness closed its output.",
  },
  {
    name: "the harness's output fails",
    end: (peer: Peer) => Effect.sync(() => peer.failOutput(new Error("the pipe broke"))),
    why: "The harness's output failed: Error: the pipe broke",
  },
  {
    name: "a write to the harness fails",
    end: (peer: Peer, connection: AcpConnection) =>
      Effect.sync(() => peer.breakWrites()).pipe(
        Effect.andThen(Effect.ignore(connection.cancel(SESSION))),
      ),
    why: "Could not write to the harness: Error: EPIPE",
  },
  {
    name: "the scope closes",
    end: (_peer: Peer, _connection: AcpConnection, scope: Scope.Closeable) =>
      Scope.close(scope, Exit.void),
    why: "The connection to the harness was closed.",
  },
] as const;

it.effect.each(ENDINGS)(
  "fails an open prompt and interrupts a parked handler when $name",
  (ending) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const peer = createPeer({ "session/prompt": () => [] });
      const interrupted = yield* Deferred.make<void>();
      const recorder = createRecorder({
        approval: () =>
          Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      });
      const connection = yield* openConnection(peer, recorder).pipe(Scope.provide(scope));
      const prompting = yield* Effect.forkChild(Effect.flip(connection.prompt(SESSION, TEXT)));
      yield* peer.whenWritten("the prompt", wroteMethod("session/prompt"));
      peer.say(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS));
      yield* recorder.waitUntil(
        "the handler is parked",
        () => recorder.approvalRequests.length === 1,
      );

      yield* ending.end(peer, connection, scope);

      const error = yield* Fiber.join(prompting);
      yield* Deferred.await(interrupted);
      const closed = yield* connection.awaitClosed;
      expect(closed).toMatchObject({ reason: "closed", message: ending.why });
      expect(error).toMatchObject({ reason: "closed", method: "session/prompt" });
      // A call and awaitClosed give the same reason, in the same words.
      expect(error.message).toBe(`The call to session/prompt failed. ${ending.why}`);
      expect(error).not.toHaveProperty("harnessMessage");
    }),
);

it.effect("does not wait for a handler that will not stop when the scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const peer = createPeer({ "session/prompt": () => [] });
    const release = yield* Deferred.make<void>();
    const recorder = createRecorder({
      approval: () => Deferred.await(release).pipe(Effect.as(ALLOW), Effect.uninterruptible),
    });
    const connection = yield* openConnection(peer, recorder).pipe(Scope.provide(scope));
    const prompting = yield* Effect.forkChild(Effect.flip(connection.prompt(SESSION, TEXT)));
    yield* peer.whenWritten("the prompt", wroteMethod("session/prompt"));
    peer.say(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS));
    yield* recorder.waitUntil(
      "the handler is parked",
      () => recorder.approvalRequests.length === 1,
    );

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

it.effect(
  "stops reading the harness's output, and hands nothing on, once the connection ended",
  () =>
    Effect.gen(function* () {
      const peer = createPeer();
      const recorder = createRecorder();
      const connection = yield* openConnection(peer, recorder);
      peer.breakWrites();
      yield* Effect.ignore(connection.cancel(SESSION));
      yield* connection.awaitClosed;
      yield* peer.whenReadingStopped;

      peer.say(buildSessionUpdate(MESSAGE_CHUNK));
      peer.say(buildRequest("p1", "session/request_permission", APPROVAL_PARAMS));

      expect(recorder.updates).toEqual([]);
      expect(recorder.approvalRequests).toEqual([]);
    }),
);
