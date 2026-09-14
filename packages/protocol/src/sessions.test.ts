import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
  MAX_MESSAGE_LENGTH,
  ProviderEvent,
  SessionBinding,
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
const without = (message: object, key: string) => {
  const copy: Record<string, unknown> = { ...message };
  delete copy[key];
  return copy;
};

const SESSION_ID = "0199c3f4-1f2a-7c31-9f0e-6d2b8a4e5c74";

/** The three base fields no event may be without. */
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
  spec,
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
];

/** One detail per request kind: five closed structs, one vocabulary. */
const requests = [
  { kind: "command_approval", detail: { command: "ls -la" } },
  { kind: "file_change_approval", detail: { paths: ["src/main.ts", "src/old.ts"] } },
  { kind: "file_read_approval", detail: { paths: ["/etc/hosts"] } },
  { kind: "tool_approval", detail: { toolName: "WebFetch" } },
  {
    kind: "user_input",
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

const tagsOf = (union: typeof ProviderEvent) =>
  union.members.map((member) => member.fields._tag.literal);

describe("the normalized event taxonomy", () => {
  it.each(events)("round-trips $_tag unchanged", (event) => {
    const encoded = Schema.encodeSync(ProviderEvent)(event);
    expect(Effect.runSync(Schema.decodeUnknownEffect(ProviderEvent)(encoded))).toEqual(event);
  });

  it("holds exactly the members the round-trip cases cover", () => {
    expect(tagsOf(ProviderEvent)).toEqual(events.map((event) => event._tag));
  });

  it.each(requests)("takes a $kind request with the detail that kind carries", (request) => {
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
          decode(ProviderEvent, without(event, key))._tag,
          `${event._tag} without ${key}`,
        ).toBe("Failure");
      }
    }
  });

  it("carries an unmapped vendor message whole, as an unknown item with its raw", () => {
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

  it("refuses a kind, a reason, a state or a stream kind outside its vocabulary", () => {
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
    // A detail belonging to another kind: the pair is the vocabulary, not the
    // kind on its own, so a surface reading the kind can trust the detail.
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

  it("takes one to many structured questions, and refuses a request carrying none", () => {
    const asking = (questions: unknown) =>
      decode(ProviderEvent, {
        _tag: "request.opened",
        ...baseFields,
        request: {
          requestId: "r1",
          itemId: "i1",
          kind: "user_input",
          decisions: ["deny", "cancel"],
          detail: { questions },
        },
      })._tag;
    const one = {
      question: "Which database should this use?",
      header: "Database",
      options: [{ label: "SQLite", description: "the one Hydra ships" }],
      multiSelect: false,
    };

    expect(asking([one, { ...one, header: "Second" }])).toBe("Success");
    // A question is the payload, so a request with none of them is a card with
    // nothing on it; the adapter falls back rather than send this.
    expect(asking([])).toBe("Failure");
    // The struct carries no vendor extras: the Claude SDK's optional `preview`
    // is dropped on the way in, so what the user reads never depends on which
    // harness asked (ADR 0007).
    const withPreview = {
      _tag: "request.opened",
      ...baseFields,
      request: {
        requestId: "r1",
        itemId: "i1",
        kind: "user_input",
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
    expect(asking([without(one, "multiSelect")])).toBe("Failure");
    expect(asking([{ ...one, header: "" }])).toBe("Failure");
  });

  it("brackets a turn by an id neither end may omit", () => {
    for (const tag of ["turn.started", "turn.completed"]) {
      const complete = { _tag: tag, ...baseFields, turnId: "t1", state: "completed" };
      expect(decode(ProviderEvent, complete)._tag, tag).toBe("Success");
      expect(decode(ProviderEvent, without(complete, "turnId"))._tag, tag).toBe("Failure");
    }
  });

  it("takes a harness message far longer than a fact, and refuses only a document", () => {
    const warning = (message: string) =>
      decode(ProviderEvent, { _tag: "runtime.warning", ...baseFields, message })._tag;
    // A stack trace is what arrives here, and a refused frame costs the runner
    // its socket, so the limit sits well above anything a fact may be.
    expect(warning("x".repeat(MAX_MESSAGE_LENGTH))).toBe("Success");
    expect(warning("x".repeat(MAX_MESSAGE_LENGTH + 1))).toBe("Failure");
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

  it("refuses a negative or fractional token count", () => {
    const usage = (value: unknown) =>
      decode(ProviderEvent, {
        _tag: "session.usage.updated",
        ...baseFields,
        usage: { inputTokens: value, outputTokens: 0 },
      })._tag;
    expect(usage(0)).toBe("Success");
    expect(usage(-1)).toBe("Failure");
    expect(usage(1.5)).toBe("Failure");
  });
});

describe("what the controller authors for a session", () => {
  it("round-trips a spec, a binding and an input", () => {
    expect(Effect.runSync(Schema.encodeEffect(SessionSpec)(spec))).toEqual(spec);
    const binding = { sessionId: SESSION_ID, nativeSessionId: "native-1", instanceId: "inst-1" };
    expect(Effect.runSync(Schema.encodeEffect(SessionBinding)(binding))).toEqual(binding);
    expect(Effect.runSync(Schema.encodeEffect(TurnInput)({ text: "" }))).toEqual({ text: "" });
  });

  it("needs every field of the spec and of the binding", () => {
    for (const key of Object.keys(spec)) {
      expect(decode(SessionSpec, without(spec, key))._tag, key).toBe("Failure");
    }
    expect(decode(SessionBinding, { sessionId: SESSION_ID, instanceId: "inst-1" })._tag).toBe(
      "Failure",
    );
  });

  it("carries both timeouts on the spec, so a runner never has to pick one", () => {
    // The runner reads its two clocks off here and holds no default of its own,
    // so a spec missing either half is a controller bug the wire refuses.
    expect(decode(SessionSpec, { ...spec, timeouts: { inactivityMs: 1 } })._tag).toBe("Failure");
    expect(decode(SessionSpec, { ...spec, timeouts: { absoluteMs: 1 } })._tag).toBe("Failure");
    expect(
      decode(SessionSpec, { ...spec, timeouts: { inactivityMs: 1, absoluteMs: 2 } })._tag,
    ).toBe("Success");
  });

  it("names a session ended by either of the runner's clocks", () => {
    // The supervisor is the only thing that knows why it stopped a session, so
    // the reason has to exist in the vocabulary the exit event carries.
    for (const reason of ["inactivity_timeout", "absolute_timeout"]) {
      expect(decode(ProviderEvent, { _tag: "session.exited", ...baseFields, reason })._tag).toBe(
        "Success",
      );
    }
  });

  it("takes a workspace-less session as an explicit null, never as an absent key", () => {
    expect(decode(SessionSpec, { ...spec, workspaceId: "w1" })._tag).toBe("Success");
    expect(decode(SessionSpec, without(spec, "workspaceId"))._tag).toBe("Failure");
  });

  it("refuses an access mode the vocabulary does not have", () => {
    expect(decode(SessionSpec, { ...spec, accessMode: "yolo" })._tag).toBe("Failure");
  });

  it("refuses a session id a path could climb out of", () => {
    // The runner makes the workspace-less session's scratch directory of this
    // id and removes that directory when the session exits, so a traversal here
    // is an `rm -rf` somewhere nobody chose.
    for (const sessionId of ["../../etc", "with/a/slash", ""]) {
      expect(decode(SessionStart, { ...start, sessionId })._tag, sessionId).toBe("Failure");
      expect(decode(SessionStop, { _tag: "sessionStop", sessionId })._tag, sessionId).toBe(
        "Failure",
      );
    }
  });

  it("refuses an instance id a path could climb out of, on the spec and on the binding", () => {
    // The runner makes a directory of this id, so a spec is where a traversal
    // would arrive.
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
