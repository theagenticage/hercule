import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
  MAX_MESSAGE_LENGTH,
  ProviderEvent,
  SessionBinding,
  SessionSpec,
  TurnInput,
  type ProviderEvent as Event,
} from "./sessions";

const decode = (
  schema: typeof ProviderEvent | typeof SessionSpec | typeof SessionBinding,
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
    _tag: "item.updated",
    ...baseFields,
    turnId: "t1",
    itemId: "i1",
    kind: "tool_call",
    detail: { kind: "mcp", name: "mcp__github__list_issues" },
    raw: { source: "claude.sdk.message", payload: { type: "tool_use", nested: [1, null] } },
  },
  {
    _tag: "item.completed",
    ...baseFields,
    turnId: "t1",
    itemId: "i1",
    kind: "file_change",
    status: "declined",
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
];

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

  it("takes a workspace-less session as an explicit null, never as an absent key", () => {
    expect(decode(SessionSpec, { ...spec, workspaceId: "w1" })._tag).toBe("Success");
    expect(decode(SessionSpec, without(spec, "workspaceId"))._tag).toBe("Failure");
  });

  it("refuses an access mode the vocabulary does not have", () => {
    expect(decode(SessionSpec, { ...spec, accessMode: "yolo" })._tag).toBe("Failure");
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
