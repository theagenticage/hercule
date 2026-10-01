import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
  MAX_ANSWERS_LENGTH,
  MAX_MESSAGE_LENGTH,
  ProviderEvent,
  SessionBinding,
  SessionRespond,
  SessionSpec,
  SessionStart,
  SessionStop,
  TurnInput,
  type ProviderEvent as Event,
} from "./sessions";

const decode = (
  schema:
    | typeof ProviderEvent
    | typeof SessionSpec
    | typeof SessionBinding
    | typeof SessionStart
    | typeof SessionStop,
  input: unknown,
) => Effect.runSyncExit(Schema.decodeUnknownEffect(schema)(input));

/** A copy of `message` without `key`, for asserting a field is required. */
const omitKey = (message: object, key: string) => {
  const copy: Record<string, unknown> = { ...message };
  delete copy[key];
  return copy;
};

const SESSION_ID = "0199c3f4-1f2a-7c31-9f0e-6d2b8a4e5c74";

/** The three base fields every event must have. */
const baseFields = {
  eventId: "0199c3f4-1f2a-7c31-9f0e-6d2b8a4e5c75",
  sessionId: SESSION_ID,
  at: "2026-09-07T10:00:00.000Z",
} as const;

const spec = {
  instanceId: "0199c3f4-1f2a-7c31-9f0e-6d2b8a4e5c73",
  workspaceId: null,
  modelSelection: { model: "sonnet", options: { thinking: true, effort: "medium" } },
  accessMode: "approval-required",
  timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
} as const;

const start = {
  _tag: "sessionStart",
  sessionId: SESSION_ID,
  providerId: "claude-code",
  config: {},
  /** `{}` rather than absent, for an instance with no credential stored. */
  secrets: {},
  spec,
  /** The session's own credential for the public API, created for each start. */
  token: "a-session-token",
} as const;

/**
 * One example per member, with the optional keys set on enough of them that
 * every optional field is exercised somewhere.
 */
const events: ReadonlyArray<Event> = [
  { _tag: "session.started", ...baseFields, providerRefs: { threadId: "abc" } },
  { _tag: "session.exited", ...baseFields, reason: "process_exit" },
  { _tag: "turn.started", ...baseFields, turnId: "t1", model: "sonnet" },
  {
    _tag: "turn.completed",
    ...baseFields,
    turnId: "t1",
    state: "interrupted",
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, costUsd: 0.02 },
    error: "the user pressed stop",
  },
  { _tag: "item.started", ...baseFields, turnId: "t1", itemId: "i1", kind: "command_execution" },
  {
    _tag: "item.completed",
    ...baseFields,
    turnId: "t1",
    itemId: "i1",
    kind: "file_change",
    status: "declined",
    detail: { path: "src/main.ts", nested: [1, null] },
  },
  {
    _tag: "content.delta",
    ...baseFields,
    turnId: "t1",
    itemId: "i1",
    streamKind: "reasoning_text",
    delta: "thinking",
  },
  {
    _tag: "session.usage.updated",
    ...baseFields,
    usage: { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 3 },
  },
  { _tag: "runtime.warning", ...baseFields, message: "retrying after a 529" },
  { _tag: "runtime.error", ...baseFields, class: "ContextWindowExceeded", message: "too long" },
  {
    _tag: "request.opened",
    ...baseFields,
    request: {
      requestId: "r1",
      itemId: "i1",
      kind: "command_approval",
      decisions: ["allow", "allow_always", "deny", "cancel"],
      detail: { command: "ls -la" },
    },
  },
  { _tag: "request.resolved", ...baseFields, requestId: "r1", decision: "allow" },
  {
    _tag: "request.resolved",
    ...baseFields,
    requestId: "r1",
    answers: { Storage: "localStorage", Features: ["Sync", "Search"] },
  },
];

/** One detail per request kind: five closed structs in one vocabulary. */
const requests = [
  { kind: "command_approval", detail: { command: "ls -la" } },
  { kind: "file_change_approval", detail: { paths: ["src/main.ts", "src/old.ts"] } },
  { kind: "file_read_approval", detail: { paths: ["/etc/hosts"] } },
  { kind: "tool_approval", detail: { toolName: "WebFetch" } },
  {
    kind: "question",
    detail: {
      questions: [
        {
          question: "Which branch should this land on?",
          header: "Branch",
          options: [
            { label: "main", description: "straight onto the default branch" },
            { label: "a branch", description: "a branch per ticket, as the conventions ask" },
          ],
          multiSelect: false,
        },
      ],
    },
  },
] as const;

const listTags = (union: typeof ProviderEvent) =>
  union.members.map((member) => member.fields._tag.literal);

describe("the normalized event taxonomy", () => {
  it.each(events)("round-trips $_tag unchanged", (event) => {
    const encoded = Schema.encodeSync(ProviderEvent)(event);
    expect(Effect.runSync(Schema.decodeUnknownEffect(ProviderEvent)(encoded))).toEqual(event);
  });

  it("has exactly the members the round-trip cases cover", () => {
    expect(listTags(ProviderEvent)).toEqual(events.map((event) => event._tag));
  });

  it.each(requests)("accepts a $kind request with the detail that kind has", (request) => {
    const opened = {
      _tag: "request.opened",
      ...baseFields,
      request: { requestId: "r1", itemId: "i1", decisions: ["deny", "cancel"], ...request },
    };
    expect(Effect.runSync(Schema.decodeUnknownEffect(ProviderEvent)(opened))).toEqual(opened);
  });

  it("needs the base fields on every member", () => {
    for (const event of events) {
      for (const key of ["eventId", "sessionId", "at"]) {
        expect(
          decode(ProviderEvent, omitKey(event, key))._tag,
          `${event._tag} without ${key}`,
        ).toBe("Failure");
      }
    }
  });

  it("keeps an unmapped vendor message whole, as an unknown item with its raw", () => {
    const passthrough = {
      _tag: "item.completed",
      ...baseFields,
      turnId: "t1",
      itemId: "i9",
      kind: "unknown",
      status: "completed",
      raw: { source: "claude.sdk.message", payload: { type: "prompt_suggestion", ids: ["a"] } },
    };
    expect(Effect.runSync(Schema.decodeUnknownEffect(ProviderEvent)(passthrough))).toEqual(
      passthrough,
    );
  });

  it("rejects a kind, a reason, a state or a stream kind outside its vocabulary", () => {
    const item = {
      _tag: "item.started",
      ...baseFields,
      turnId: "t1",
      itemId: "i1",
      kind: "review",
    };
    expect(decode(ProviderEvent, item)._tag).toBe("Failure");
    expect(
      decode(ProviderEvent, { _tag: "session.exited", ...baseFields, reason: "killed" })._tag,
    ).toBe("Failure");
    expect(
      decode(ProviderEvent, { _tag: "turn.completed", ...baseFields, state: "aborted" })._tag,
    ).toBe("Failure");
    expect(
      decode(ProviderEvent, {
        _tag: "content.delta",
        ...baseFields,
        turnId: "t1",
        itemId: "i1",
        streamKind: "reasoning_summary_text",
        delta: "x",
      })._tag,
    ).toBe("Failure");
    expect(decode(ProviderEvent, { _tag: "request.opened", ...baseFields })._tag).toBe("Failure");
    // A detail that belongs to another kind: the kind and its detail are
    // validated as a pair, so a surface that reads the kind can trust the
    // detail.
    expect(
      decode(ProviderEvent, {
        _tag: "request.opened",
        ...baseFields,
        request: {
          requestId: "r1",
          itemId: "i1",
          kind: "command_approval",
          decisions: ["allow"],
          detail: { paths: ["src/main.ts"] },
        },
      })._tag,
    ).toBe("Failure");
  });

  it("accepts one or more structured questions, and rejects a request with none", () => {
    const decodeQuestionRequest = (questions: unknown) =>
      decode(ProviderEvent, {
        _tag: "request.opened",
        ...baseFields,
        request: {
          requestId: "r1",
          itemId: "i1",
          kind: "question",
          decisions: ["deny", "cancel"],
          detail: { questions },
        },
      })._tag;
    const one = {
      question: "Which database should this use?",
      header: "Database",
      options: [{ label: "SQLite", description: "the one Hercule ships" }],
      multiSelect: false,
    };

    expect(decodeQuestionRequest([one, { ...one, header: "Second" }])).toBe("Success");
    // The questions are the payload, so a request with none is a card with
    // nothing on it; the adapter falls back to something else rather than send
    // it.
    expect(decodeQuestionRequest([])).toBe("Failure");
    // The struct has no vendor extras: the Claude SDK's optional `preview` is
    // dropped when decoding, so what the user sees never depends on which
    // harness asked (ADR 0007).
    const withPreview = {
      _tag: "request.opened",
      ...baseFields,
      request: {
        requestId: "r1",
        itemId: "i1",
        kind: "question",
        decisions: ["deny", "cancel"],
        detail: {
          questions: [{ ...one, options: [{ label: "SQLite", description: "it", preview: "x" }] }],
        },
      },
    };
    expect(Effect.runSync(Schema.decodeUnknownEffect(ProviderEvent)(withPreview))).toEqual({
      ...withPreview,
      request: {
        ...withPreview.request,
        detail: {
          questions: [{ ...one, options: [{ label: "SQLite", description: "it" }] }],
        },
      },
    });
    expect(decodeQuestionRequest([omitKey(one, "multiSelect")])).toBe("Failure");
    expect(decodeQuestionRequest([{ ...one, header: "" }])).toBe("Failure");
  });

  it("requires the turn id on both the start and the completion of a turn", () => {
    for (const tag of ["turn.started", "turn.completed"]) {
      const complete = { _tag: tag, ...baseFields, turnId: "t1", state: "completed" };
      expect(decode(ProviderEvent, complete)._tag, tag).toBe("Success");
      expect(decode(ProviderEvent, omitKey(complete, "turnId"))._tag, tag).toBe("Failure");
    }
  });

  it("accepts a harness message far longer than a fact, and rejects only a document", () => {
    const decodeWarning = (message: string) =>
      decode(ProviderEvent, { _tag: "runtime.warning", ...baseFields, message })._tag;
    // Stack traces arrive here, and a rejected frame costs the runner its
    // socket, so the limit is well above a fact's.
    expect(decodeWarning("x".repeat(MAX_MESSAGE_LENGTH))).toBe("Success");
    expect(decodeWarning("x".repeat(MAX_MESSAGE_LENGTH + 1))).toBe("Failure");
  });

  it("gives a delta no length limit, because the payload is not a fact about a peer", () => {
    const delta = {
      _tag: "content.delta",
      ...baseFields,
      turnId: "t1",
      itemId: "i1",
      streamKind: "assistant_text",
      delta: "x".repeat(100_000),
    };
    expect(decode(ProviderEvent, delta)._tag).toBe("Success");
  });

  it("rejects a negative or fractional token count", () => {
    const decodeUsage = (value: unknown) =>
      decode(ProviderEvent, {
        _tag: "session.usage.updated",
        ...baseFields,
        usage: { inputTokens: value, outputTokens: 0 },
      })._tag;
    expect(decodeUsage(0)).toBe("Success");
    expect(decodeUsage(-1)).toBe("Failure");
    expect(decodeUsage(1.5)).toBe("Failure");
  });
});

describe("what the controller sends for a session", () => {
  it("round-trips a spec, a binding and an input", () => {
    expect(Effect.runSync(Schema.encodeEffect(SessionSpec)(spec))).toEqual(spec);
    const binding = { sessionId: SESSION_ID, nativeSessionId: "native-1", instanceId: "inst-1" };
    expect(Effect.runSync(Schema.encodeEffect(SessionBinding)(binding))).toEqual(binding);
    expect(Effect.runSync(Schema.encodeEffect(TurnInput)({ text: "" }))).toEqual({ text: "" });
  });

  it("needs every field of the spec and of the binding", () => {
    for (const key of Object.keys(spec)) {
      expect(decode(SessionSpec, omitKey(spec, key))._tag, key).toBe("Failure");
    }
    expect(decode(SessionBinding, { sessionId: SESSION_ID, instanceId: "inst-1" })._tag).toBe(
      "Failure",
    );
  });

  it("requires both timeouts on the spec, so a runner never has to pick one", () => {
    // The runner reads its two time limits from here and has no default of its
    // own, so a spec missing either one is a controller bug the schema rejects.
    expect(decode(SessionSpec, { ...spec, timeouts: { inactivityMs: 1 } })._tag).toBe("Failure");
    expect(decode(SessionSpec, { ...spec, timeouts: { absoluteMs: 1 } })._tag).toBe("Failure");
    expect(
      decode(SessionSpec, { ...spec, timeouts: { inactivityMs: 1, absoluteMs: 2 } })._tag,
    ).toBe("Success");
  });

  it("has an exit reason for each of the runner's time limits", () => {
    // Only the supervisor knows why it stopped a session, so the reason has to
    // exist in the exit event's vocabulary.
    for (const reason of ["inactivity_timeout", "absolute_timeout"]) {
      expect(decode(ProviderEvent, { _tag: "session.exited", ...baseFields, reason })._tag).toBe(
        "Success",
      );
    }
  });

  it("accepts a session without a workspace as an explicit null, never as an absent key", () => {
    expect(decode(SessionSpec, { ...spec, workspaceId: "w1" })._tag).toBe("Success");
    expect(decode(SessionSpec, omitKey(spec, "workspaceId"))._tag).toBe("Failure");
  });

  it("rejects an access mode the vocabulary does not have", () => {
    expect(decode(SessionSpec, { ...spec, accessMode: "yolo" })._tag).toBe("Failure");
  });

  it("rejects a session id that could escape its directory", () => {
    // The runner names the scratch directory of a session without a workspace
    // after this id, and removes that directory when the session exits, so a
    // traversal here would be an `rm -rf` somewhere nobody chose.
    for (const sessionId of ["../../etc", "with/a/slash", ""]) {
      expect(decode(SessionStart, { ...start, sessionId })._tag, sessionId).toBe("Failure");
      expect(decode(SessionStop, { _tag: "sessionStop", sessionId })._tag, sessionId).toBe(
        "Failure",
      );
    }
  });

  it("requires a non-empty session token on every start", () => {
    // The token is the session's own credential on the public API, and the
    // frame is the only place its plaintext ever appears: a start without one
    // would leave the agent inside that session unable to reach Hercule at all,
    // and an empty one would be a credential that authenticates nobody.
    expect(decode(SessionStart, start)._tag).toBe("Success");
    expect(decode(SessionStart, omitKey(start, "token"))._tag).toBe("Failure");
    expect(decode(SessionStart, { ...start, token: "" })._tag).toBe("Failure");
  });

  it("rejects an instance id that could escape its directory, on the spec and on the binding", () => {
    // The runner uses this id as a directory name, so a traversal would arrive
    // in a spec.
    expect(decode(SessionSpec, { ...spec, instanceId: "../../etc" })._tag).toBe("Failure");
    expect(
      decode(SessionBinding, {
        sessionId: SESSION_ID,
        nativeSessionId: "native-1",
        instanceId: "../../etc",
      })._tag,
    ).toBe("Failure");
  });
});

describe("the answer the controller sends to a parked session", () => {
  it("decodes a frame that answers a question with answers keyed by header", () => {
    // A single-select question is answered with one string, a multi-select
    // question with a list.
    const frame = {
      _tag: "sessionRespond",
      sessionId: SESSION_ID,
      requestId: "r1",
      answers: { Storage: "localStorage", Features: ["Sync", "Search"] },
    };
    expect(Effect.runSync(Schema.decodeUnknownEffect(SessionRespond)(frame))).toEqual(frame);
  });

  it("still decodes a frame that answers with a decision", () => {
    const frame = {
      _tag: "sessionRespond",
      sessionId: SESSION_ID,
      requestId: "r1",
      decision: "deny",
    };
    expect(Effect.runSync(Schema.decodeUnknownEffect(SessionRespond)(frame))).toEqual(frame);
  });

  it("refuses an answer that is only spaces", () => {
    const frame = {
      _tag: "sessionRespond",
      sessionId: SESSION_ID,
      requestId: "r1",
      answers: { Storage: "  " },
    };
    expect(Effect.runSyncExit(Schema.decodeUnknownEffect(SessionRespond)(frame))._tag).toBe(
      "Failure",
    );
  });

  it("refuses answers that together hold more characters than the limit, though each fits", () => {
    // Each answer is at most a full message, so only the limit on all of them
    // together, headers included, keeps the frame within what the socket carries.
    const full = "x".repeat(MAX_MESSAGE_LENGTH);
    const buildFrame = (lastLength: number) => ({
      _tag: "sessionRespond",
      sessionId: SESSION_ID,
      requestId: "r1",
      answers: {
        F: [
          ...Array.from({ length: MAX_ANSWERS_LENGTH / MAX_MESSAGE_LENGTH - 1 }, () => full),
          "x".repeat(lastLength),
        ],
      },
    });
    const decodeFrame = (lastLength: number) =>
      Effect.runSyncExit(Schema.decodeUnknownEffect(SessionRespond)(buildFrame(lastLength)))._tag;
    // The one-character header and the answers fill the limit exactly.
    expect(decodeFrame(MAX_MESSAGE_LENGTH - 1)).toBe("Success");
    expect(decodeFrame(MAX_MESSAGE_LENGTH)).toBe("Failure");
  });

  it("keeps a header no question could have, so the controller can refuse it by name", () => {
    // A header that is empty or too long can match no question. Dropping it
    // here would accept the rest of the answers as if it had never been sent.
    const frame = {
      _tag: "sessionRespond",
      sessionId: SESSION_ID,
      requestId: "r1",
      answers: { "": "x", ["h".repeat(600)]: "y", Storage: "localStorage" },
    };
    expect(Effect.runSync(Schema.decodeUnknownEffect(SessionRespond)(frame))).toEqual(frame);
  });
});
