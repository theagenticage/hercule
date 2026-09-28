/**
 * End-to-end tests for a session: the user spawns one over HTTP, a runner on
 * the real runner socket receives the start frame, and what that runner
 * reports comes back as rows and as a status the user can read.
 *
 * The runner here is a hand-written fake that sends its own frames, because
 * ingest is about the wire: the tests check what a real runner could actually
 * send. It answers every probe, so the controller has a capability snapshot to
 * place against. Then it reports a realistic turn (started, a turn, deltas, an
 * item, usage, a completion, an exit), including one sequence number sent
 * twice.
 *
 * What the tests check:
 *
 * - Spawning writes the row before the runner receives it, with both access
 *   modes on it when the fallback changed the mode.
 * - The status follows the events.
 * - The stream holds one merged row per item rather than one per delta, and
 *   every other event as is.
 * - A sequence number the controller has already applied writes nothing, however
 *   many times it arrives.
 * - An input is stored before it is sent, and its result is what the runner
 *   reported. An input that cannot be sent yet waits in the session's queue
 *   until the session is idle again.
 */
import { describe, expect, it, vi } from "vitest";
import { Duration, Effect, Exit, Fiber } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  type ModelDescriptor,
  type ProbeRequest,
  type ProviderEvent,
  type RunnerFacts,
  type SessionInterrupt as SessionInterruptFrame,
  type SessionStart,
  type SessionStop as SessionStopFrame,
  type SessionInput,
  type OpenRequest,
  type SessionRespond as SessionRespondFrame,
} from "@hercule/protocol";
import type { Plugin, ProviderDefinition } from "@hercule/plugin-host";
import type { Profile, Runner, Session } from "@hercule/contract";
import {
  collectMessages,
  get,
  onSocket,
  post,
  readErrorBody,
  send,
  waitForLiveToSettle,
  fetchTicket,
  waitWithin,
  type Collected,
  type ServerHarness,
} from "../http/testing";
import { Live } from "../daemon";
import { withTransaction } from "../db";
import { createPluginFixture, buildProviderDefinition } from "../plugins/testing";
import {
  listFrames,
  readApprovalNotifications,
  waitForFrames,
  waitForResolvedApprovalNotification,
  reportEvent,
  spawnSession,
  spawnSessionOrFail,
  waitForRunnerGone,
  waitForStartFrames,
  waitUntil,
  WAIT_DEADLINE_MS,
  withAgentFleet,
  withFleet as sharedWithFleet,
  type Arranged,
  type Wire,
} from "./testing";
import {
  readDefaultConversation,
  sendMessage,
  waitForConversationSessions,
} from "../conversations/testing";

/** A provider that supports everything natively: the instance a plain spawn uses. */
const FULL = buildProviderDefinition("full-provider", { token: "t" });

/** The provider for the access-mode fallback tests: it supports up to `auto-accept-edits`. */
const LIMITED: ProviderDefinition = {
  ...buildProviderDefinition("limited-provider", { token: "t" }),
  declared: {
    ...buildProviderDefinition("limited-provider").declared,
    steering: "unsupported",
    accessModes: {
      "approval-required": "native",
      "auto-accept-edits": "native",
      auto: "unsupported",
      "full-access": "unsupported",
    },
  },
};

/**
 * A provider that supports no access mode at all: even `approval-required` is
 * unsupported, so the fallback has no lower mode to substitute.
 */
const BARE: ProviderDefinition = {
  ...buildProviderDefinition("bare-provider", { token: "t" }),
  declared: {
    ...buildProviderDefinition("bare-provider").declared,
    accessModes: {
      "approval-required": "unsupported",
      "auto-accept-edits": "unsupported",
      auto: "unsupported",
      "full-access": "unsupported",
    },
  },
};

const buildPlugins = (): ReadonlyArray<Plugin> => [
  createPluginFixture({ id: "providers", definitions: [FULL, LIMITED, BARE] }).plugin,
];

const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["full-provider", "limited-provider", "bare-provider"],
  identityPort: 4939,
};

/**
 * Two models with different options: `clever` has an effort with three values
 * and a boolean, `fast` has an effort with two values and nothing else. The
 * pair covers what a single model cannot: an option value that is valid on one
 * model and unknown on the other.
 */
const MODELS: ReadonlyArray<ModelDescriptor> = [
  {
    slug: "fast",
    name: "Fast",
    options: [
      {
        id: "effort",
        label: "Effort",
        kind: "select",
        choices: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ],
        default: "high",
      },
    ],
  },
  {
    slug: "clever",
    name: "Clever",
    isDefault: true,
    options: [
      {
        id: "effort",
        label: "Effort",
        kind: "select",
        choices: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
        default: "medium",
      },
      { id: "fastMode", label: "Fast mode", kind: "boolean", default: false },
    ],
  },
];

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sets a timeout long enough for any one wait to fail on its own. Each wait
 * gives up after `WAIT_DEADLINE_MS`, and a test here takes under a second
 * when nothing is stuck, even with a dozen waits. So a change that never
 * happens fails the wait for it, and the error names that change instead of
 * the test. The rest is margin for a busy machine.
 */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 4 + 10_000 });

/**
 * How long the controller waits for a runner to answer an input frame. The
 * default ten seconds is too long for a test, and one test below has to wait
 * for it to time out.
 */
const INPUT_DEADLINE = Duration.seconds(2);

/**
 * Longer than any test here runs, so the pipeline never ticks and a test sees
 * only the work of its own requests. A test that checks an input going back to
 * waiting needs this, because a tick sends a waiting input again as soon as
 * the session can take it.
 */
const NO_TICK = Duration.hours(1);

/** Runs `body` against a controller with one joined, connected, logged-in runner, using this suite's providers and models. */
const withFleet = (
  body: (arranged: Arranged) => Promise<void>,
  options: { readonly eventRoutingInterval?: Duration.Duration } = {},
): Promise<void> =>
  sharedWithFleet(body, {
    plugins: buildPlugins(),
    facts: FACTS,
    models: MODELS,
    inputDeadline: INPUT_DEADLINE,
    ...options,
  });

const findInstanceId = (arranged: Arranged, providerId: string): string => {
  const found = arranged.instances.find((instance) => instance.providerId === providerId);
  expect(found, providerId).toBeDefined();
  return found!.id;
};

const readSession = async (arranged: Arranged, id: string): Promise<Session> => {
  const response = await get(arranged.harness.base, `/api/v1/sessions/${id}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Session;
};

/** Parses an error response into its code and the paths of its issues. */
const parseRefusal = async (
  response: Response,
): Promise<{ readonly code: string; readonly paths: ReadonlyArray<ReadonlyArray<string>> }> => {
  const body = (await response.json()) as {
    readonly error: {
      readonly code: string;
      readonly details?: {
        readonly issues?: ReadonlyArray<{ readonly path: ReadonlyArray<string> }>;
      };
    };
  };
  return {
    code: body.error.code,
    paths: (body.error.details?.issues ?? []).map((one) => one.path),
  };
};

/** Returns every session. After a rejected spawn there must be none. */
const listSessions = async (arranged: Arranged): Promise<ReadonlyArray<Session>> => {
  const listing = await get(arranged.harness.base, "/api/v1/sessions", arranged.token);
  expect(listing.status, await listing.clone().text()).toBe(200);
  return ((await listing.json()) as { items: ReadonlyArray<Session> }).items;
};

/** Waits until `ready` returns true for the session, and returns the session. */
const waitForSession = (
  arranged: Arranged,
  id: string,
  ready: (session: Session) => boolean,
): Promise<Session> =>
  waitUntil("moved the session", async () => {
    const session = await readSession(arranged, id);
    return ready(session) ? session : undefined;
  });

interface StreamRow {
  readonly position: number;
  readonly runner_seq: number;
  readonly tag: string;
  readonly event: string;
}

const readStreamRows = (harness: ServerHarness, id: string): Promise<ReadonlyArray<StreamRow>> =>
  Effect.runPromise(
    Effect.orDie(
      harness.sql<StreamRow>`
        SELECT position, runner_seq, json_extract(event, '$._tag') AS tag, event
        FROM session_stream WHERE session_id = unhex(replace(${id}, '-', ''))
        ORDER BY position`,
    ),
  );

const at = "2026-09-07T10:00:00.000Z";

/** Builds the events of one ordinary turn, each with its sequence number. */
const buildTranscript = (sessionId: string): ReadonlyArray<readonly [number, ProviderEvent]> => {
  const base = { eventId: crypto.randomUUID(), sessionId, at };
  const turnId = "t1";
  const itemId = "i1";
  return [
    [1, { ...base, _tag: "session.started", providerRefs: { nativeSessionId: "native-1" } }],
    [2, { ...base, _tag: "turn.started", turnId }],
    [
      3,
      { ...base, _tag: "content.delta", turnId, itemId, streamKind: "assistant_text", delta: "He" },
    ],
    [
      4,
      {
        ...base,
        _tag: "content.delta",
        turnId,
        itemId,
        streamKind: "assistant_text",
        delta: "llo",
      },
    ],
    [
      5,
      {
        ...base,
        _tag: "item.completed",
        turnId,
        itemId,
        kind: "assistant_message",
        status: "completed",
      },
    ],
    [
      6,
      {
        ...base,
        _tag: "session.usage.updated",
        usage: { inputTokens: 12, outputTokens: 34 },
      },
    ],
    [7, { ...base, _tag: "turn.completed", turnId, state: "completed" }],
  ];
};

/**
 * Reports `buildTranscript` for a spawned session in the order a runner does:
 * `session.started`, then the runner's answer that the prompt opened a turn,
 * then the rest of that turn. Waits until the session is `idle` again.
 */
const reportTranscript = async (arranged: Arranged, sessionId: string): Promise<void> => {
  const [started, ...turn] = buildTranscript(sessionId);
  reportEvent(arranged.wire, ...started!);
  await waitForSession(arranged, sessionId, (one) => one.status === "busy");
  for (const [seq, event] of turn) reportEvent(arranged.wire, seq, event);
  await waitForSession(arranged, sessionId, (one) => one.status === "idle");
};

/** One stored input, as the API returns it. */
interface StoredInput {
  readonly id: string;
  readonly sessionId: string;
  readonly source: string;
  readonly actor: string;
  readonly text: string;
  readonly status: "queued" | "delivered" | "cancelled";
  readonly delivery: "opened" | "steered" | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  /** Set while the frame is sent and unanswered; null once answered, or if never sent. */
  readonly sentAt: string | null;
  /** Why a queued row is not delivered yet; null once it is sent again. */
  readonly reason: string | null;
}

const sendInput = (arranged: Arranged, id: string, body: unknown): Promise<Response> =>
  post(arranged.harness.base, `/api/v1/sessions/${id}/input`, body, arranged.token);

const steerInput = (arranged: Arranged, sessionId: string, inputId: string): Promise<Response> =>
  send("POST", arranged.harness.base, `/api/v1/sessions/${sessionId}/inputs/${inputId}/steer`, {
    token: arranged.token,
  });

const patchInput = (
  arranged: Arranged,
  sessionId: string,
  inputId: string,
  body: unknown,
): Promise<Response> =>
  send("PATCH", arranged.harness.base, `/api/v1/sessions/${sessionId}/inputs/${inputId}`, {
    body,
    token: arranged.token,
  });

const cancelInput = (arranged: Arranged, sessionId: string, inputId: string): Promise<Response> =>
  send("DELETE", arranged.harness.base, `/api/v1/sessions/${sessionId}/inputs/${inputId}`, {
    token: arranged.token,
  });

const listInputs = async (arranged: Arranged, id: string): Promise<ReadonlyArray<StoredInput>> => {
  const response = await get(
    arranged.harness.base,
    `/api/v1/sessions/${id}/inputs`,
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<StoredInput> }).items;
};

/**
 * Spawns a session, starts it, and waits until its prompt's input frame is
 * sent and the session is `busy`. Returns the session as spawned.
 *
 * The fake runner answers the prompt with `opened`, and that answer alone
 * makes the session `busy`: the prompt's turn is running, even though the
 * runner has reported no `turn.started` yet. Use `startIdleSession` for a
 * session whose first turn has ended.
 *
 * The wait for the start frame looks for this session's own frame, not for a
 * count of frames. A test that starts a second session already has the first
 * session's frames on the wire, so a count of one would be met at once,
 * before this session's frames arrive.
 */
const startSession = async (arranged: Arranged, prompt: string): Promise<Session> => {
  const session = await spawnSessionOrFail(arranged, { prompt });
  await waitForStartFrames(arranged, session.id, 1);
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.started",
  });
  // Only the runner's answer to the prompt's input makes the session `busy`,
  // so every count of input frames below includes the prompt's frame.
  await waitForSession(arranged, session.id, (one) => one.status === "busy");
  return session;
};

/**
 * Starts a session, reports its prompt's turn as started and completed at
 * sequence numbers 2 and 3, and waits until the session is `idle`. Returns
 * the session as spawned. A test that reports more events on it starts at
 * sequence number 4.
 */
const startIdleSession = async (arranged: Arranged, prompt: string): Promise<Session> => {
  const session = await startSession(arranged, prompt);
  const base = { sessionId: session.id, at, turnId: `turn-${session.id}` };
  reportEvent(arranged.wire, 2, { ...base, eventId: crypto.randomUUID(), _tag: "turn.started" });
  reportEvent(arranged.wire, 3, {
    ...base,
    eventId: crypto.randomUUID(),
    _tag: "turn.completed",
    state: "completed",
  });
  await waitForSession(arranged, session.id, (one) => one.status === "idle");
  return session;
};

const listInputFrames = (wire: Wire): ReadonlyArray<SessionInput> =>
  listFrames<SessionInput>(wire, "sessionInput");

const reportExited = (wire: Wire, sessionId: string, seq: number): void =>
  reportEvent(wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "session.exited",
    reason: "stopped",
  });

/** Ends a session the way a runner does, after binding its native id on the row. */
const endSession = async (arranged: Arranged, session: Session, seq: number): Promise<Session> => {
  arranged.wire.send({
    _tag: "sessionsReport",
    sessions: [
      {
        sessionId: session.id,
        nativeSessionId: "native-1",
        instanceId: findInstanceId(arranged, "full-provider"),
      },
    ],
  });
  await waitForSession(arranged, session.id, (one) => one.nativeSessionId !== null);
  reportExited(arranged.wire, session.id, seq);
  return await waitForSession(arranged, session.id, (one) => one.status === "exited");
};

/** Starts and ends a session, which leaves a parent a continue can use: exited, resumable, with its native id bound. */
const startAndEndSession = async (arranged: Arranged, prompt: string): Promise<Session> =>
  endSession(arranged, await startSession(arranged, prompt), 2);

const interruptSession = (arranged: Arranged, id: string): Promise<Response> =>
  send("POST", arranged.harness.base, `/api/v1/sessions/${id}/interrupt`, {
    token: arranged.token,
  });

const stopSession = (arranged: Arranged, id: string): Promise<Response> =>
  send("POST", arranged.harness.base, `/api/v1/sessions/${id}/stop`, { token: arranged.token });

const continueSession = (arranged: Arranged, id: string, body: unknown): Promise<Response> =>
  post(arranged.harness.base, `/api/v1/sessions/${id}/continue`, body, arranged.token);

describe("session.spawn", () => {
  it("builds a thread from the default settings and sends the runner a start frame", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });

      expect(session.status).toBe("starting");
      expect(session.runnerId).toBe(arranged.runnerId);
      expect(session.instanceId).toBe(findInstanceId(arranged, "full-provider"));
      expect(session.requestedAccessMode).toBe("approval-required");
      expect(session.accessMode).toBe("approval-required");
      expect(session.nativeSessionId).toBeNull();
      expect(session.resumable).toBe(false);

      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      expect(start.sessionId).toBe(session.id);
      expect(start.providerId).toBe("full-provider");
      expect(start.spec).toEqual({
        instanceId: session.instanceId,
        workspaceId: null,
        // The instance's default model, since neither the settings nor the
        // call named one.
        modelSelection: { model: "clever", options: {} },
        accessMode: "approval-required",
        // Neither settings key is set, so the spec has the default timeouts.
        timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
      });
    });
  });

  it("stores the spec byte for byte as the start frame sends it", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello", model: "fast" });
      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;

      const [row] = await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql<{ readonly spec: string }>`
            SELECT spec FROM sessions WHERE id = unhex(replace(${session.id}, '-', ''))`,
        ),
      );

      expect(row?.spec).toBe(JSON.stringify(start.spec));
    });
  });

  it("falls back to the nearest less permissive mode, and records both modes on the session", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        instanceId: findInstanceId(arranged, "limited-provider"),
        accessMode: "auto",
      });

      expect(session.requestedAccessMode).toBe("auto");
      expect(session.accessMode).toBe("auto-accept-edits");
      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      // The runner receives the mode it will really run, never the requested one.
      expect(start.spec.accessMode).toBe("auto-accept-edits");
    });
  });

  it("rejects the spawn when the provider supports no mode at or below the requested one", async () => {
    await withFleet(async (arranged) => {
      const response = await spawnSession(arranged, {
        prompt: "hello",
        instanceId: findInstanceId(arranged, "bare-provider"),
        accessMode: "auto",
      });

      const said = await response.clone().text();
      expect(response.status, said).toBe(409);
      expect((await parseRefusal(response)).code).toBe("invalid_state");
      // The error names the requested mode and the provider that cannot run
      // it, so the user knows which of the two to change.
      expect(said).toContain("auto");
      expect(said).toContain("Provider bare-provider");
      // Nothing was substituted and nothing was started.
      expect(await listSessions(arranged)).toEqual([]);
      await delay(250);
      expect(listFrames<SessionStart>(arranged.wire, "sessionStart")).toEqual([]);
    });
  });

  it("never falls back to a reserved runner", async () => {
    await withFleet(async (arranged) => {
      // `reserved` is set directly on the row, because `runner.update` does not
      // allow reserving the fleet's default runner, and the one runner here is
      // the default.
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE runners SET reserved = 1
            WHERE id = unhex(replace(${arranged.runnerId}, '-', ''))`,
        ),
      );

      const response = await spawnSession(arranged, { prompt: "hello" });

      expect(response.status).toBe(409);
      expect(await response.text()).toContain("no connected runner");
    });
  });

  it("sends the prompt as one turn's input once the harness is up", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "what is the time" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);

      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
      });

      const input = (await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1))[0]!;
      expect(input.sessionId).toBe(session.id);
      // Every input frame carries the session's current model, which starts
      // as the spec's model.
      expect(input.input).toEqual({
        text: "what is the time",
        modelSelection: session.modelSelection,
      });
    });
  });
});

/**
 * The model options a spawn picks: validated against the capability snapshot
 * of the runner the session is placed on, stored on the row, and sent on both
 * frames that start the session.
 */
describe("session.spawn: the model options a call picks", () => {
  it("stores the options and sends them on the start frame and the first input frame", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        model: "clever",
        options: { effort: "high", fastMode: true },
      });
      const selection = { model: "clever", options: { effort: "high", fastMode: true } };

      expect(session.modelSelection).toEqual(selection);
      expect((await readSession(arranged, session.id)).modelSelection).toEqual(selection);

      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      expect(start.spec.modelSelection).toEqual(selection);

      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
      });
      const input = (await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1))[0]!;
      expect(input.input.modelSelection).toEqual(selection);
    });
  });

  it("stores no options at all when the call sends none", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello", model: "clever" });

      expect(session.modelSelection).toEqual({ model: "clever", options: {} });
    });
  });

  // One invalid option is enough here. `options.test.ts` covers the rules;
  // this test covers the wiring: the call is validated against the catalog of
  // the runner the session is placed on, and a rejected call spawns nothing.
  it("rejects a value the placed runner's catalog does not offer, and spawns nothing", async () => {
    await withFleet(async (arranged) => {
      const response = await spawnSession(arranged, {
        prompt: "hello",
        model: "clever",
        options: { effort: "extreme" },
      });

      expect(response.status, await response.clone().text()).toBe(400);
      const refused = await parseRefusal(response);
      expect(refused.code).toBe("validation");
      expect(refused.paths).toContainEqual(["options", "effort"]);
      expect(listFrames<SessionStart>(arranged.wire, "sessionStart")).toEqual([]);
      expect(await listSessions(arranged)).toEqual([]);
    });
  });
});

/**
 * A runner or a profile named on one spawn call. The tests above cover a call
 * that names neither.
 */
describe("session.spawn with an explicit runner or profile", () => {
  it("places the session on the runner an explicit runnerId names", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        runnerId: arranged.runnerId,
      });

      expect(session.runnerId).toBe(arranged.runnerId);
      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      expect(start.sessionId).toBe(session.id);
    });
  });

  it("uses an explicit runnerId even when that runner is reserved", async () => {
    await withFleet(async (arranged) => {
      // `reserved` is set directly on the row, because `runner.update` does not
      // allow reserving the fleet's default runner, and the one runner here is
      // the default.
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE runners SET reserved = 1
            WHERE id = unhex(replace(${arranged.runnerId}, '-', ''))`,
        ),
      );

      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        runnerId: arranged.runnerId,
      });

      expect(session.runnerId).toBe(arranged.runnerId);
    });
  });

  it("rejects a named runner that is draining, and says why", async () => {
    await withFleet(async (arranged) => {
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE runners SET lifecycle = 'draining'
            WHERE id = unhex(replace(${arranged.runnerId}, '-', ''))`,
        ),
      );

      const response = await spawnSession(arranged, {
        prompt: "hello",
        runnerId: arranged.runnerId,
      });

      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.text()).toContain("draining");
      const listing = await get(arranged.harness.base, "/api/v1/sessions", arranged.token);
      const page = (await listing.json()) as { items: ReadonlyArray<Session> };
      expect(page.items).toEqual([]);
    });
  });

  it("rejects a named runner that is retired, and says retired, not draining", async () => {
    await withFleet(async (arranged) => {
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE runners SET lifecycle = 'retired'
            WHERE id = unhex(replace(${arranged.runnerId}, '-', ''))`,
        ),
      );

      const response = await spawnSession(arranged, {
        prompt: "hello",
        runnerId: arranged.runnerId,
      });

      expect(response.status, await response.clone().text()).toBe(409);
      const text = await response.text();
      expect(text).toContain("retired");
      expect(text).not.toContain("draining");
      const listing = await get(arranged.harness.base, "/api/v1/sessions", arranged.token);
      const page = (await listing.json()) as { items: ReadonlyArray<Session> };
      expect(page.items).toEqual([]);
    });
  });

  it("rejects a named runner that is online but not logged in to the instance, and says why", async () => {
    await withFleet(async (arranged) => {
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE capability_snapshots SET auth_status = 'unauthenticated'
            WHERE runner_id = unhex(replace(${arranged.runnerId}, '-', ''))`,
        ),
      );

      const response = await spawnSession(arranged, {
        prompt: "hello",
        instanceId: findInstanceId(arranged, "full-provider"),
        runnerId: arranged.runnerId,
      });

      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.text()).toContain("logged in");
      const listing = await get(arranged.harness.base, "/api/v1/sessions", arranged.token);
      const page = (await listing.json()) as { items: ReadonlyArray<Session> };
      expect(page.items).toEqual([]);
    });
  });

  it("returns a validation error, not a state conflict, for a runnerId that matches no runner", async () => {
    await withFleet(async (arranged) => {
      const response = await spawnSession(arranged, {
        prompt: "hello",
        runnerId: "0199e0e7-9999-7000-8000-000000000000",
      });

      expect(response.status, await response.clone().text()).toBe(400);
    });
  });

  it("puts the session on the profile an explicit permissionProfileId names", async () => {
    await withFleet(async (arranged) => {
      const listing = await get(arranged.harness.base, "/api/v1/profiles", arranged.token);
      const body = await listing.clone().text();
      const worker = ((await listing.json()) as { items: ReadonlyArray<Profile> }).items.find(
        (one) => one.name === "worker",
      );
      expect(worker, body).toBeDefined();

      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        permissionProfileId: worker!.id,
      });

      expect(session.permissionProfileId).toBe(worker!.id);
    });
  });

  it("fails validation on a permissionProfileId that matches no profile", async () => {
    await withFleet(async (arranged) => {
      const response = await spawnSession(arranged, {
        prompt: "hello",
        permissionProfileId: "0199e0e7-9999-7000-8000-000000000000",
      });

      expect(response.status, await response.clone().text()).toBe(400);
    });
  });
});

/** The title a Thread shows in the sidebar, set once from the prompt that started it. */
describe("session.spawn: the title built from the prompt", () => {
  it("takes the prompt's first line, trimmed, as the title", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, {
        prompt: "  Fix the login bug\n\nDetails...",
      });

      expect((session as unknown as { title: string }).title).toBe("Fix the login bug");
      const read = await readSession(arranged, session.id);
      expect((read as unknown as { title: string }).title).toBe("Fix the login bug");
    });
  });

  it("cuts a first line over 80 characters down to exactly 80", async () => {
    await withFleet(async (arranged) => {
      const longLine =
        "the bug is somewhere in the login flow and nobody can pin down exactly where it is";
      expect(longLine.length).toBeGreaterThan(80);

      const session = await spawnSessionOrFail(arranged, {
        prompt: `${longLine}\nmore detail below`,
      });

      const title = (session as unknown as { title: string }).title;
      expect(title).toBe(longLine.slice(0, 80));
      expect(title).toHaveLength(80);
    });
  });

  it("skips leading blank lines and takes the first line with content", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, {
        prompt: "\n   \n\nActually, start here\nand then this",
      });

      expect((session as unknown as { title: string }).title).toBe("Actually, start here");
    });
  });

  it("returns the title on the sessions list, not only on a single read", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, {
        prompt: "Fix the login bug\n\nDetails...",
      });

      const listing = await get(arranged.harness.base, "/api/v1/sessions", arranged.token);
      const page = (await listing.json()) as {
        items: ReadonlyArray<Session & { title?: string }>;
      };
      const row = page.items.find((one) => one.id === session.id);

      expect(row?.title).toBe("Fix the login bug");
    });
  });
});

describe("what a runner reports", () => {
  it("changes the status, merges the deltas, and ignores a sequence number sent twice", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      const events = buildTranscript(session.id);

      reportEvent(arranged.wire, ...events[0]!);
      // The session is `idle` only until the runner answers the prompt, which
      // makes it `busy`, so the wait is for any status after `starting`.
      expect(
        (await waitForSession(arranged, session.id, (one) => one.status !== "starting")).startedAt,
      ).not.toBeNull();

      reportEvent(arranged.wire, ...events[1]!);
      await waitForSession(arranged, session.id, (one) => one.status === "busy");

      for (const [seq, event] of events.slice(2, 6)) reportEvent(arranged.wire, seq, event);
      // The same frame again, as a replay after a reconnect would send it. It
      // is sent before the completion the test then waits for. Frames from one
      // socket are handled in order, so once the session is idle the replay
      // has already been handled. Sent after the completion, the wait would
      // prove nothing.
      reportEvent(arranged.wire, ...events[3]!);
      reportEvent(arranged.wire, ...events[6]!);
      await waitForSession(arranged, session.id, (one) => one.status === "idle");

      const rows = await waitUntil("wrote the turn", async () => {
        const found = await readStreamRows(arranged.harness, session.id);
        return found.some((row) => row.tag === "turn.completed") ? found : undefined;
      });

      expect(rows.map((row) => row.tag)).toEqual([
        "session.started",
        "turn.started",
        // One row for both deltas, written at the item boundary.
        "content.delta",
        "item.completed",
        "session.usage.updated",
        "turn.completed",
      ]);
      expect(rows.map((row) => row.position)).toEqual([1, 2, 3, 4, 5, 6]);
      // Deduplicated on the runner's sequence number: the replayed frame is not here.
      expect(rows.map((row) => row.runner_seq)).toEqual([1, 2, 4, 5, 6, 7]);
      const coalesced = rows.find((row) => row.tag === "content.delta");
      expect((JSON.parse(coalesced!.event) as { delta: string }).delta).toBe("Hello");
    });
  });

  it("stores the native id the harness started with, together with the status change", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });

      reportEvent(arranged.wire, ...buildTranscript(session.id)[0]!);

      const bound = await waitForSession(arranged, session.id, (one) => one.status !== "starting");
      // The id and the status are written together, so a started session
      // always has its native id already.
      expect(bound.nativeSessionId).toBe("native-1");
    });
  });

  it("stores the native id from a sessions report, for a session already running", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      const instanceId = findInstanceId(arranged, "full-provider");

      arranged.wire.send({
        _tag: "sessionsReport",
        sessions: [{ sessionId: session.id, nativeSessionId: "reported-1", instanceId }],
      });

      const bound = await waitForSession(
        arranged,
        session.id,
        (one) => one.nativeSessionId !== null,
      );
      expect(bound.nativeSessionId).toBe("reported-1");
    });
  });

  it("ends the session, and an ended session whose runner still has it is resumable", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      arranged.wire.send({
        _tag: "sessionsReport",
        sessions: [
          {
            sessionId: session.id,
            nativeSessionId: "native-1",
            instanceId: findInstanceId(arranged, "full-provider"),
          },
        ],
      });
      await waitForSession(arranged, session.id, (one) => one.nativeSessionId !== null);

      reportExited(arranged.wire, session.id, 1);

      const ended = await waitForSession(arranged, session.id, (one) => one.status === "exited");
      expect(ended.exitedAt).not.toBeNull();
      expect(ended.resumable).toBe(true);
    });
  });

  it("ignores a runner reporting on a session that is not placed on it", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      const other = await arranged.harness.insertRunner({ name: "elsewhere" });
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE sessions SET runner_id = unhex(replace(${other.id}, '-', ''))
            WHERE id = unhex(replace(${session.id}, '-', ''))`,
        ),
      );

      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
      });
      // A second session, on the runner that really has it, reported after the
      // first. Frames from one socket are handled in order, so once this one is
      // applied, the one before it has been handled too. Waiting for a fixed
      // time would only show the controller had not got to it yet.
      const mine = await spawnSessionOrFail(arranged, { prompt: "hello" });
      reportEvent(arranged.wire, 2, {
        eventId: crypto.randomUUID(),
        sessionId: mine.id,
        at,
        _tag: "session.started",
      });
      await waitForSession(arranged, mine.id, (one) => one.status !== "starting");

      expect(await readStreamRows(arranged.harness, session.id)).toEqual([]);
      expect((await readSession(arranged, session.id)).status).toBe("starting");
    });
  });
});

describe("session.input", () => {
  it("leaves the input queued, with a reason, when an idle session's runner has disconnected", async () => {
    await withFleet(async (arranged) => {
      const session = await startIdleSession(arranged, "hello");
      arranged.wire.close();
      await waitForRunnerGone(arranged);

      const response = await sendInput(arranged, session.id, { text: "into the void" });

      expect(response.status).toBe(409);
      // A failed or unanswered delivery is not a cancel by the user. The input
      // stays visible, with the reason on it, and is tried again at the next
      // turn boundary.
      const row = (await listInputs(arranged, session.id)).at(-1);
      expect(row).toMatchObject({ text: "into the void", status: "queued", delivery: null });
      expect(row!.sentAt).toBeNull();
      expect(typeof row!.reason).toBe("string");
    });
  });

  it("leaves the input queued, with a reason, when an idle session's runner never answers", async () => {
    await withFleet(
      async (arranged) => {
        const session = await startIdleSession(arranged, "hello");
        arranged.wire.answering(() => undefined);

        const response = await sendInput(arranged, session.id, { text: "into the silence" });

        expect(response.status).toBe(409);
        const row = (await listInputs(arranged, session.id)).at(-1);
        expect(row).toMatchObject({ text: "into the silence", status: "queued", delivery: null });
        expect(row!.sentAt).toBeNull();
        expect(typeof row!.reason).toBe("string");
      },
      // The session is still idle and the input is still waiting, so a tick
      // would send it again. The tick is stopped so the test can read the
      // input as the unanswered delivery left it.
      { eventRoutingInterval: NO_TICK },
    );
  });
});

describe("session.input, queued by default", () => {
  it("queues a busy session's input without sending a frame", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      reportEvent(arranged.wire, ...buildTranscript(session.id)[1]!);
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      const before = listInputFrames(arranged.wire).length;

      const response = await sendInput(arranged, session.id, { text: "mid-turn" });

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ result: "queued" });
      expect(listInputFrames(arranged.wire)).toHaveLength(before);
      expect((await listInputs(arranged, session.id)).at(-1)).toMatchObject({
        text: "mid-turn",
        status: "queued",
        delivery: null,
        sentAt: null,
      });
    });
  });

  it("queues a starting session's input without sending a frame", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });

      const response = await sendInput(arranged, session.id, { text: "too soon" });

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ result: "queued" });
      expect(listInputFrames(arranged.wire)).toEqual([]);
      expect((await listInputs(arranged, session.id)).at(-1)).toMatchObject({
        text: "too soon",
        status: "queued",
        delivery: null,
        sentAt: null,
      });
    });
  });

  it("delivers to an idle session at once, and returns the result the runner reports, never one the controller chose", async () => {
    await withFleet(async (arranged) => {
      const session = await startIdleSession(arranged, "hello");
      arranged.wire.answering(() => "steered");

      const response = await sendInput(arranged, session.id, { text: "again" });

      expect(response.status, await response.clone().text()).toBe(200);
      const answer = (await response.json()) as { inputId: string; result: string };
      expect(answer.result).toBe("steered");
      const sent = listInputFrames(arranged.wire).at(-1)!;
      expect(sent.requestId).toBe(answer.inputId);
      expect(sent.input.text).toBe("again");
      expect((await listInputs(arranged, session.id)).at(-1)).toMatchObject({
        id: answer.inputId,
        status: "delivered",
        delivery: "steered",
      });
    });
  });

  it("fails validation on a payload carrying a modelSelection", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");

      const response = await sendInput(arranged, session.id, {
        text: "hello",
        modelSelection: { model: "fast" },
      });

      expect(response.status, await response.clone().text()).toBe(400);
    });
  });
});

/**
 * The model options one input sends: validated against the session's own
 * instance, merged over the options the row already has, and all dropped when
 * the input changes the model, because the options belong to the model.
 */
describe("session.input: the model options a submission carries", () => {
  /** Reads the session's current model selection. */
  const readModelSelection = async (arranged: Arranged, id: string): Promise<unknown> =>
    (await readSession(arranged, id)).modelSelection;

  it("stores the options and sends them on the frame for that input", async () => {
    await withFleet(async (arranged) => {
      const session = await startIdleSession(arranged, "hello");

      const response = await sendInput(arranged, session.id, {
        text: "again",
        options: { effort: "high" },
      });

      expect(response.status, await response.clone().text()).toBe(200);
      const { inputId } = (await response.json()) as { inputId: string };
      expect(await readModelSelection(arranged, session.id)).toEqual({
        model: "clever",
        options: { effort: "high" },
      });
      const frames = await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 2);
      const sent = frames.find((frame) => frame.requestId === inputId)!;
      expect(sent.input.modelSelection).toEqual({
        model: "clever",
        options: { effort: "high" },
      });
    });
  });

  it("merges the options over the ones the row already has", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      const first = await sendInput(arranged, session.id, {
        text: "again",
        options: { effort: "high" },
      });
      expect(first.status, await first.clone().text()).toBe(200);

      const second = await sendInput(arranged, session.id, {
        text: "and again",
        options: { fastMode: true },
      });

      expect(second.status, await second.clone().text()).toBe(200);
      expect(await readModelSelection(arranged, session.id)).toEqual({
        model: "clever",
        options: { effort: "high", fastMode: true },
      });
    });
  });

  it.each([
    ["keeps only what the new model was given", { effort: "low" }, { effort: "low" }],
    ["keeps nothing when the new model is given none", undefined, {}],
  ])("changes the model and %s", async (_what, options, stored) => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      const first = await sendInput(arranged, session.id, {
        text: "again",
        options: { effort: "high", fastMode: true },
      });
      expect(first.status, await first.clone().text()).toBe(200);

      const changed = await sendInput(arranged, session.id, {
        text: "on the other one",
        model: "fast",
        ...(options === undefined ? {} : { options }),
      });

      expect(changed.status, await changed.clone().text()).toBe(200);
      expect(await readModelSelection(arranged, session.id)).toEqual({
        model: "fast",
        options: stored,
      });
    });
  });

  it("keeps the options when the input names the model the session is already on", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      const first = await sendInput(arranged, session.id, {
        text: "again",
        options: { effort: "high", fastMode: true },
      });
      expect(first.status, await first.clone().text()).toBe(200);

      const restated = await sendInput(arranged, session.id, {
        text: "and again",
        model: "clever",
      });

      expect(restated.status, await restated.clone().text()).toBe(200);
      expect(await readModelSelection(arranged, session.id)).toEqual({
        model: "clever",
        options: { effort: "high", fastMode: true },
      });
    });
  });

  // `options.test.ts` covers the rules. This test covers the wiring: the
  // input is validated against the session's own runner, and a rejected input
  // stores neither the input nor the new selection.
  it("rejects a value the session's model does not offer, stores no input, and keeps the selection", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      const before = (await listInputs(arranged, session.id)).length;

      const response = await sendInput(arranged, session.id, {
        text: "again",
        options: { effort: "extreme" },
      });

      expect(response.status, await response.clone().text()).toBe(400);
      const refused = await parseRefusal(response);
      expect(refused.code).toBe("validation");
      expect(refused.paths).toContainEqual(["options", "effort"]);
      expect(await listInputs(arranged, session.id)).toHaveLength(before);
      expect(await readModelSelection(arranged, session.id)).toEqual({
        model: "clever",
        options: {},
      });
    });
  });
});

/**
 * `input.steer`: `POST /api/v1/sessions/:id/inputs/:inputId/steer` uses the
 * normal delivery path for an input already queued behind a running turn.
 */
describe("input.steer", () => {
  /** Starts a busy session with one input queued behind the running turn. */
  const makeBusyWithQueuedInput = async (
    arranged: Arranged,
    text = "steer me",
  ): Promise<{ readonly session: Session; readonly inputId: string }> => {
    const session = await startSession(arranged, "hello");
    reportEvent(arranged.wire, ...buildTranscript(session.id)[1]!);
    await waitForSession(arranged, session.id, (one) => one.status === "busy");
    const queued = await sendInput(arranged, session.id, { text });
    expect(queued.status, await queued.clone().text()).toBe(200);
    const { inputId } = (await queued.json()) as { inputId: string };
    return { session, inputId };
  };

  it("delivers the input's text, and returns exactly the result the runner reports", async () => {
    await withFleet(async (arranged) => {
      const { session, inputId } = await makeBusyWithQueuedInput(arranged, "steer me");
      arranged.wire.answering(() => "steered");

      const response = await steerInput(arranged, session.id, inputId);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ inputId, result: "steered" });
      const sent = listInputFrames(arranged.wire).at(-1)!;
      expect(sent.requestId).toBe(inputId);
      expect(sent.input.text).toBe("steer me");
      const row = (await listInputs(arranged, session.id)).find((one) => one.id === inputId);
      expect(row).toMatchObject({ status: "delivered", delivery: "steered" });
    });
  });

  it("returns 'opened', as the runner reports, when the turn ended while the frame was in flight", async () => {
    await withFleet(async (arranged) => {
      const { session, inputId } = await makeBusyWithQueuedInput(arranged);
      arranged.wire.answering(() => "opened");

      const response = await steerInput(arranged, session.id, inputId);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ inputId, result: "opened" });
      const row = (await listInputs(arranged, session.id)).find((one) => one.id === inputId);
      expect(row).toMatchObject({ status: "delivered", delivery: "opened" });
    });
  });

  // The prompt input is already delivered (the session start sends it), so
  // this steer must be rejected because the session is idle.
  it("rejects an input on an idle session, and sends no frame", async () => {
    await withFleet(async (arranged) => {
      const session = await startIdleSession(arranged, "hello");
      const [prompt] = await listInputs(arranged, session.id);
      const before = listInputFrames(arranged.wire).length;

      const response = await steerInput(arranged, session.id, prompt!.id);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(listInputFrames(arranged.wire)).toHaveLength(before);
    });
  });

  it("rejects an input on a starting session, and sends no frame", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      const [prompt] = await listInputs(arranged, session.id);

      const response = await steerInput(arranged, session.id, prompt!.id);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(listInputFrames(arranged.wire)).toEqual([]);
    });
  });

  // As in the idle case, the exit has already cancelled the input by the time
  // the session reads exited. So this covers both "input not queued" and
  // "session exited", and either is a valid reason to reject the steer.
  it("rejects an input on an exited session, and sends no frame", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      reportExited(arranged.wire, session.id, 1);
      await waitForSession(arranged, session.id, (one) => one.status === "exited");
      const [prompt] = await listInputs(arranged, session.id);

      const response = await steerInput(arranged, session.id, prompt!.id);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(listInputFrames(arranged.wire)).toEqual([]);
    });
  });

  it("rejects an input that is already delivered", async () => {
    await withFleet(async (arranged) => {
      const { session, inputId } = await makeBusyWithQueuedInput(arranged);
      arranged.wire.answering(() => "steered");
      const first = await steerInput(arranged, session.id, inputId);
      expect(first.status, await first.clone().text()).toBe(200);
      const before = listInputFrames(arranged.wire).length;

      const again = await steerInput(arranged, session.id, inputId);

      expect(again.status, await again.clone().text()).toBe(409);
      expect(listInputFrames(arranged.wire)).toHaveLength(before);
    });
  });

  it("rejects an input that has been cancelled", async () => {
    await withFleet(async (arranged) => {
      const { session, inputId } = await makeBusyWithQueuedInput(arranged);
      const cancelled = await cancelInput(arranged, session.id, inputId);
      expect(cancelled.status, await cancelled.clone().text()).toBe(200);
      const before = listInputFrames(arranged.wire).length;

      const response = await steerInput(arranged, session.id, inputId);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(listInputFrames(arranged.wire)).toHaveLength(before);
    });
  });

  // Tested by what the caller and the runner see, not by the stored `sentAt`
  // field: a second steer while the first is still unanswered must be
  // rejected, and the runner must never get a second frame for the same input.
  it("rejects an input already sent, and sends no second frame for it", async () => {
    await withFleet(async (arranged) => {
      const { session, inputId } = await makeBusyWithQueuedInput(arranged);
      arranged.wire.answering(() => undefined);
      const before = listInputFrames(arranged.wire).length;

      const inFlight = steerInput(arranged, session.id, inputId);
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", before + 1);

      const concurrent = await steerInput(arranged, session.id, inputId);

      expect(concurrent.status, await concurrent.clone().text()).toBe(409);
      expect(listInputFrames(arranged.wire)).toHaveLength(before + 1);

      // Answer the held frame, so nothing is outstanding when the test harness
      // closes the socket.
      arranged.wire.release("steered");
      await inFlight;
    });
  });

  it("leaves the input queued and the session busy when the runner never answers the steer", async () => {
    await withFleet(async (arranged) => {
      const { session, inputId } = await makeBusyWithQueuedInput(arranged);
      arranged.wire.answering(() => undefined);

      const response = await steerInput(arranged, session.id, inputId);

      expect(response.status, await response.clone().text()).toBe(409);
      const row = (await listInputs(arranged, session.id)).find((one) => one.id === inputId);
      expect(row).toMatchObject({ status: "queued", delivery: null });
    });
  });

  it("interrupts the running turn and sends the input as the next turn, on a provider that does not steer natively", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        instanceId: findInstanceId(arranged, "limited-provider"),
      });
      const events = buildTranscript(session.id);
      reportEvent(arranged.wire, ...events[0]!);
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);
      reportEvent(arranged.wire, ...events[1]!);
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      const queued = await sendInput(arranged, session.id, { text: "steer me" });
      expect(queued.status, await queued.clone().text()).toBe(200);
      const { inputId } = (await queued.json()) as { inputId: string };
      const before = listInputFrames(arranged.wire).length;

      const response = await steerInput(arranged, session.id, inputId);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ inputId, result: "queued" });
      const [interrupt] = await waitForFrames<SessionInterruptFrame>(
        arranged.wire,
        "sessionInterrupt",
        1,
      );
      expect(interrupt!.sessionId).toBe(session.id);
      // Nothing is sent into the turn being interrupted.
      expect(listInputFrames(arranged.wire)).toHaveLength(before);

      // The interrupted turn ends, and the input goes in as the next turn.
      reportEvent(arranged.wire, 3, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "turn.completed",
        turnId: "t1",
        state: "interrupted",
      });
      const delivered = await waitUntil("sent the input as the next turn", async () => {
        const row = (await listInputs(arranged, session.id)).find((one) => one.id === inputId);
        return row?.status === "delivered" ? row : undefined;
      });
      expect(delivered.delivery).toBe("opened");
      expect(
        listInputFrames(arranged.wire).filter((one) => one.input.text === "steer me"),
      ).toHaveLength(1);
    });
  });

  it("returns not_found for an input id that belongs to another session", async () => {
    await withFleet(async (arranged) => {
      const { inputId } = await makeBusyWithQueuedInput(arranged);
      const elsewhere = await spawnSessionOrFail(arranged, { prompt: "elsewhere" });

      const response = await steerInput(arranged, elsewhere.id, inputId);

      expect(response.status).toBe(404);
    });
  });

  it("puts an input the runner rejected back to queued, with sentAt cleared and the runner's message as the reason", async () => {
    await withFleet(async (arranged) => {
      const { session, inputId } = await makeBusyWithQueuedInput(arranged);
      arranged.wire.answering(() => ({ message: "no such model here" }));

      const response = await steerInput(arranged, session.id, inputId);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.text()).toContain("no such model here");
      const row = (await listInputs(arranged, session.id)).find((one) => one.id === inputId);
      expect(row).toMatchObject({
        status: "queued",
        sentAt: null,
        reason: "no such model here",
      });
    });
  });
});

describe("a session's inputs", () => {
  /** Starts a session with one delivered input, one still queued, and one cancelled. */
  const withInputs = async (arranged: Arranged): Promise<Session> => {
    const session = await spawnSessionOrFail(arranged, {
      prompt: "hello",
      instanceId: findInstanceId(arranged, "limited-provider"),
    });
    const events = buildTranscript(session.id);
    reportEvent(arranged.wire, ...events[0]!);
    await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);
    reportEvent(arranged.wire, ...events[1]!);
    await waitForSession(arranged, session.id, (one) => one.status === "busy");
    // The provider does not support steering, so both inputs are queued.
    for (const text of ["second", "third"]) {
      const queued = await sendInput(arranged, session.id, { text });
      expect(queued.status, await queued.clone().text()).toBe(200);
    }
    const rows = await listInputs(arranged, session.id);
    const cancelled = await cancelInput(arranged, session.id, rows[2]!.id);
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    return session;
  };

  it("lists them oldest first, whatever their status", async () => {
    await withFleet(async (arranged) => {
      const session = await withInputs(arranged);

      const rows = await listInputs(arranged, session.id);

      expect(rows.map((row) => [row.text, row.status, row.delivery])).toEqual([
        ["hello", "delivered", "opened"],
        ["second", "queued", null],
        ["third", "cancelled", null],
      ]);
      expect(rows[0]).toMatchObject({ sessionId: session.id, source: "user", actor: "user" });
      expect(typeof rows[0]!.createdAt).toBe("string");
      expect(typeof rows[0]!.deliveredAt).toBe("string");
      expect(rows[1]!.deliveredAt).toBeNull();
    });
  });

  it("edits a queued input, rejects a delivered or cancelled one, and announces the session change", async () => {
    await withFleet(async (arranged) => {
      const session = await withInputs(arranged);
      const rows = await listInputs(arranged, session.id);
      const ticket = await fetchTicket(arranged.harness.base, arranged.token);

      await onSocket(arranged.harness.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const announced = yield* collectMessages(client, { topic: "session" });
          yield* Effect.promise(() => waitForLiveToSettle());

          const edited = yield* Effect.promise(() =>
            patchInput(arranged, session.id, rows[1]!.id, { text: "second, rewritten" }),
          );
          expect(edited.status, yield* Effect.promise(() => edited.clone().text())).toBe(200);
          expect(yield* Effect.promise(() => edited.json())).toMatchObject({
            id: rows[1]!.id,
            text: "second, rewritten",
            status: "queued",
          });

          const heard = yield* Effect.promise(() =>
            waitWithin(2000, () =>
              announced.received.some((message) =>
                (message as { ids?: ReadonlyArray<string> }).ids?.includes(session.id),
              ),
            ),
          );
          expect(heard).toBe(true);
          yield* Fiber.interrupt(announced.fiber);
        }),
      );

      const delivered = await patchInput(arranged, session.id, rows[0]!.id, { text: "no" });
      expect(delivered.status).toBe(409);
      expect(await delivered.text()).toContain("delivered");

      const cancelled = await patchInput(arranged, session.id, rows[2]!.id, { text: "no" });
      expect(cancelled.status).toBe(409);
      expect(await cancelled.text()).toContain("cancelled");
    });
  });

  it("cancels a queued input, rejects a cancelled one, and never cancels another session's input", async () => {
    await withFleet(async (arranged) => {
      const session = await withInputs(arranged);
      const other = await spawnSessionOrFail(arranged, { prompt: "elsewhere" });
      const rows = await listInputs(arranged, session.id);

      const gone = await cancelInput(arranged, session.id, rows[1]!.id);
      expect(gone.status, await gone.clone().text()).toBe(200);
      expect(await gone.json()).toMatchObject({ id: rows[1]!.id, status: "cancelled" });

      const again = await cancelInput(arranged, session.id, rows[1]!.id);
      expect(again.status).toBe(409);
      expect(await again.text()).toContain("cancelled");

      const elsewhere = await cancelInput(arranged, other.id, rows[1]!.id);
      expect(elsewhere.status).toBe(404);
    });
  });
});

describe("the queue at the transition to idle", () => {
  it("puts the session back in the queue when its runner disconnects before the start frame is sent", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.close();
      await waitForRunnerGone(arranged);
      // The runner is online in the database but not connected, like a runner
      // that disconnects between being chosen and receiving the start frame.
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE runners SET connectivity = 'online'
            WHERE id = unhex(replace(${arranged.runnerId}, '-', ''))`,
        ),
      );

      const response = await spawnSession(arranged, { prompt: "never sent" });

      expect(response.status, await response.clone().text()).toBe(200);
      const session = (await response.json()) as Session;
      const waiting = await waitForSession(arranged, session.id, (one) => one.status === "queued");
      expect(waiting.status).toBe("queued");
      expect(await listInputs(arranged, session.id)).toMatchObject([
        { text: "never sent", status: "queued" },
      ]);
    });
  });

  it("sends an input the runner never answered again when the session is next idle", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const session = await spawnSessionOrFail(arranged, { prompt: "one" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      const events = buildTranscript(session.id);

      reportEvent(arranged.wire, ...events[0]!);
      const first = await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);
      // The only fixed-time wait here: a flush holds its input until it stops
      // waiting for an answer, and nothing else shows when that happens.
      await delay(Duration.toMillis(INPUT_DEADLINE) + 1000);

      reportEvent(arranged.wire, ...events[1]!);
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      reportEvent(arranged.wire, ...events[6]!);

      const again = await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 2);
      expect(again.map((frame) => frame.requestId)).toEqual([
        first[0]!.requestId,
        first[0]!.requestId,
      ]);
      expect((await listInputs(arranged, session.id))[0]).toMatchObject({ status: "queued" });
    });
  });

  it("cancels every input still queued when the session exits", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "one" });
      const queued = await sendInput(arranged, session.id, { text: "two" });
      expect(await queued.json()).toMatchObject({ result: "queued" });

      reportExited(arranged.wire, session.id, 1);
      await waitForSession(arranged, session.id, (one) => one.status === "exited");

      const rows = await waitUntil("cancelled what was waiting", async () => {
        const found = await listInputs(arranged, session.id);
        return found.every((row) => row.status !== "queued") ? found : undefined;
      });
      expect(rows.map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
      expect(listInputFrames(arranged.wire)).toEqual([]);
    });
  });

  it("sends no second frame for an input a flush has already sent", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering((frame) => (frame.input.text === "one" ? undefined : "opened"));
      const session = await spawnSessionOrFail(arranged, { prompt: "one" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      const events = buildTranscript(session.id);

      reportEvent(arranged.wire, ...events[0]!);
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);
      reportEvent(arranged.wire, ...events[1]!);
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      reportEvent(arranged.wire, ...events[6]!);
      await waitForSession(arranged, session.id, (one) => one.status === "idle");

      // A new input after the session is idle again. Frames on one socket
      // arrive in order, so a flush that sent the first input again would have
      // sent it before this one.
      const opened = await sendInput(arranged, session.id, { text: "two" });
      expect(opened.status, await opened.clone().text()).toBe(200);
      const sent = await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 2);
      expect(sent.map((frame) => frame.input.text)).toEqual(["one", "two"]);
      // The unanswered input is still queued, so a second flush could have
      // sent it twice, and did not.
      expect(await listInputs(arranged, session.id)).toMatchObject([
        { text: "one", status: "queued" },
        { text: "two", status: "delivered" },
      ]);
    });
  });

  it("rejects cancelling an input the runner already has", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const session = await spawnSessionOrFail(arranged, { prompt: "one" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      reportEvent(arranged.wire, ...buildTranscript(session.id)[0]!);
      const sent = (await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1))[0]!;

      // The input still reads `queued`, because it is waiting for an answer,
      // not for a turn. Reporting it as cancelled would be wrong.
      const response = await cancelInput(arranged, session.id, sent.requestId);

      expect(response.status).toBe(409);
      expect(await response.text()).toContain("already been sent");
    });
  });

  it("does not send an input cancelled while the input before it is unanswered", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const session = await spawnSessionOrFail(arranged, { prompt: "one" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      const queued = await sendInput(arranged, session.id, { text: "two" });
      const { inputId } = (await queued.json()) as { inputId: string };

      reportEvent(arranged.wire, ...buildTranscript(session.id)[0]!);
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);

      // It is waiting behind the unanswered input, so the caller can still
      // cancel it: nothing has claimed it, and only a claimed input cannot be
      // cancelled.
      const gone = await cancelInput(arranged, session.id, inputId);
      expect(gone.status, await gone.clone().text()).toBe(200);

      // The first input is answered now, so the flush records it and looks for
      // the next one.
      arranged.wire.release("opened");
      const rows = await waitUntil("recorded the first delivery", async () => {
        const found = await listInputs(arranged, session.id);
        return found[0]!.status === "delivered" ? found : undefined;
      });

      expect(rows.map((row) => row.status)).toEqual(["delivered", "cancelled"]);
      expect(listInputFrames(arranged.wire).map((frame) => frame.input.text)).toEqual(["one"]);
    });
  });

  it("sends the next input when the session is next idle, while the first is still unanswered", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering((frame) => (frame.input.text === "one" ? undefined : "steered"));
      const session = await spawnSessionOrFail(arranged, { prompt: "one" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      const queued = await sendInput(arranged, session.id, { text: "two" });
      expect(await queued.json()).toMatchObject({ result: "queued" });

      const events = buildTranscript(session.id);
      reportEvent(arranged.wire, ...events[0]!);
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);
      // A whole turn runs while the runner has still not answered the first
      // input. When the session is idle again, the next input is claimed and
      // sent, even though the first one is still unanswered.
      reportEvent(arranged.wire, ...events[1]!);
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      reportEvent(arranged.wire, ...events[6]!);
      await waitForSession(arranged, session.id, (one) => one.status === "idle");

      arranged.wire.release("opened");

      const sent = await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 2);
      expect(sent.map((frame) => frame.input.text)).toEqual(["one", "two"]);
    });
  });

  it("keeps applying another session's events while a flush waits for an answer", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const waiting = await spawnSessionOrFail(arranged, { prompt: "one" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      reportEvent(arranged.wire, ...buildTranscript(waiting.id)[0]!);
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);

      const other = await spawnSessionOrFail(arranged, { prompt: "two" });
      reportEvent(arranged.wire, ...buildTranscript(other.id)[0]!);

      await waitForSession(arranged, other.id, (one) => one.status === "idle");
      // The first input is still waiting for an answer that never comes, so
      // ingest kept running alongside the flush instead of waiting for it.
      expect(await listInputs(arranged, waiting.id)).toMatchObject([
        { text: "one", status: "queued" },
      ]);
    });
  });
});

describe("session.query and session.read", () => {
  it("lists the sessions newest first and filters by status", async () => {
    await withFleet(async (arranged) => {
      const first = await spawnSessionOrFail(arranged, { prompt: "one" });
      const second = await spawnSessionOrFail(arranged, { prompt: "two" });
      reportExited(arranged.wire, first.id, 1);
      await waitForSession(arranged, first.id, (one) => one.status === "exited");

      const listing = await get(arranged.harness.base, "/api/v1/sessions", arranged.token);
      expect(listing.status, await listing.clone().text()).toBe(200);
      const page = (await listing.json()) as { items: ReadonlyArray<Session> };
      expect(page.items.map((one) => one.id)).toEqual([second.id, first.id]);

      const filtered = await get(
        arranged.harness.base,
        "/api/v1/sessions?status=exited",
        arranged.token,
      );
      const gone = (await filtered.json()) as { items: ReadonlyArray<Session> };
      expect(gone.items.map((one) => one.id)).toEqual([first.id]);
    });
  });

  it("filters by several statuses at once, with the query parameter repeated", async () => {
    // The runner page reads capacity exactly like this: `starting`, `idle` and
    // `busy` in one page, and never `exited`.
    await withFleet(async (arranged) => {
      const waiting = await spawnSessionOrFail(arranged, { prompt: "one" });
      const idle = await startIdleSession(arranged, "two");
      const gone = await spawnSessionOrFail(arranged, { prompt: "three" });
      reportExited(arranged.wire, gone.id, 1);
      await waitForSession(arranged, gone.id, (one) => one.status === "exited");

      const filtered = await get(
        arranged.harness.base,
        "/api/v1/sessions?status=starting&status=idle",
        arranged.token,
      );
      expect(filtered.status, await filtered.clone().text()).toBe(200);
      const page = (await filtered.json()) as { items: ReadonlyArray<Session> };
      expect(new Set(page.items.map((one) => one.id))).toEqual(new Set([waiting.id, idle.id]));
    });
  });

  it("returns not_found for an id that matches no session", async () => {
    await withFleet(async (arranged) => {
      const response = await get(
        arranged.harness.base,
        "/api/v1/sessions/0199e0e7-9999-7000-8000-000000000000",
        arranged.token,
      );

      expect(response.status).toBe(404);
    });
  });
});

/**
 * The `conversationId` filter: the sessions that answered one conversation,
 * made through `conversation.send`. The newest of them is the conversation's
 * current session, which the web app reads with `limit=1`.
 */
describe("session.query by conversation", () => {
  it("lists a conversation's sessions newest first, and no Thread", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const { conversation } = await readDefaultConversation(arranged);
      await sendMessage(arranged, conversation.id, "hi");
      const [older] = await waitForConversationSessions(arranged, conversation.id, 1);
      await waitForStartFrames(arranged, older!.id, 1);
      // An exit before the runner reported a native id leaves nothing to
      // resume, so the next line places a new session.
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: older!.id,
        at,
        _tag: "session.exited",
        reason: "crash",
      });
      await waitForSession(arranged, older!.id, (one) => one.status === "exited" && !one.resumable);
      await sendMessage(arranged, conversation.id, "again");
      const [newer] = await waitForConversationSessions(arranged, conversation.id, 2);
      const thread = await spawnSessionOrFail(arranged, { prompt: "a thread" });

      const listing = await get(
        base,
        `/api/v1/sessions?conversationId=${conversation.id}`,
        arranged.token,
      );
      expect(listing.status, await listing.clone().text()).toBe(200);
      const page = (await listing.json()) as { items: ReadonlyArray<Session> };
      expect(page.items.map((one) => one.id)).toEqual([newer!.id, older!.id]);

      const current = await get(
        base,
        `/api/v1/sessions?conversationId=${conversation.id}&sort=createdAt:desc&limit=1`,
        arranged.token,
      );
      expect(current.status, await current.clone().text()).toBe(200);
      expect(
        ((await current.json()) as { items: ReadonlyArray<Session> }).items.map((one) => one.id),
      ).toEqual([newer!.id]);

      const nobody = await get(
        base,
        "/api/v1/sessions?conversationId=0199e0e7-9999-7000-8000-000000000000",
        arranged.token,
      );
      expect(nobody.status, await nobody.clone().text()).toBe(200);
      expect(((await nobody.json()) as { items: ReadonlyArray<Session> }).items).toEqual([]);

      // A Thread answers no conversation.
      expect((await readSession(arranged, thread.id)).conversationId).toBeNull();
    });
  });
});

/**
 * The transcript over HTTP: the rows ingest wrote, encoded through the
 * contract, in position order and one page at a time.
 */
describe("transcript.read", () => {
  const readTranscript = async (
    arranged: Arranged,
    id: string,
    query = "",
  ): Promise<{
    items: ReadonlyArray<{ position: number; event: ProviderEvent }>;
    nextCursor?: string;
  }> => {
    const response = await get(
      arranged.harness.base,
      `/api/v1/sessions/${id}/transcript${query}`,
      arranged.token,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as never;
  };

  it("reads the whole normalized stream back, oldest first", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      await reportTranscript(arranged, session.id);

      const page = await waitUntil("wrote the turn", async () => {
        const found = await readTranscript(arranged, session.id);
        return found.items.some((row) => row.event._tag === "turn.completed") ? found : undefined;
      });

      expect(page.items.map((row) => row.position)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(page.items.map((row) => row.event._tag)).toEqual([
        "session.started",
        "turn.started",
        "content.delta",
        "item.completed",
        "session.usage.updated",
        "turn.completed",
      ]);
      // The whole event survives the round trip, including the merged text.
      const delta = page.items.find((row) => row.event._tag === "content.delta")!.event;
      expect(delta._tag === "content.delta" ? delta.delta : undefined).toBe("Hello");
      expect(page.nextCursor).toBeUndefined();
    });
  });

  it("pages with a cursor that continues exactly where the last page stopped", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      await reportTranscript(arranged, session.id);
      await waitUntil("wrote the turn", async () => {
        const found = await readTranscript(arranged, session.id);
        return found.items.length === 6 ? found : undefined;
      });

      const first = await readTranscript(arranged, session.id, "?limit=4");
      expect(first.items.map((row) => row.position)).toEqual([1, 2, 3, 4]);
      expect(first.nextCursor).toBeDefined();

      const rest = await readTranscript(
        arranged,
        session.id,
        `?cursor=${encodeURIComponent(first.nextCursor!)}`,
      );
      expect(rest.items.map((row) => row.position)).toEqual([5, 6]);
      expect(rest.nextCursor).toBeUndefined();
    });
  });

  it("returns an empty transcript for a session with no events, and not_found for a missing session", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });

      expect((await readTranscript(arranged, session.id)).items).toEqual([]);

      const missing = await get(
        arranged.harness.base,
        "/api/v1/sessions/0199e0e7-9999-7000-8000-000000000000/transcript",
        arranged.token,
      );
      expect(missing.status).toBe(404);
    });
  });
});

describe("session.interrupt", () => {
  it("sends the runner an interrupt for the running turn, and the turn ends as interrupted", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      const events = buildTranscript(session.id);
      reportEvent(arranged.wire, ...events[1]!);
      await waitForSession(arranged, session.id, (one) => one.status === "busy");

      const response = await interruptSession(arranged, session.id);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ id: session.id, status: "busy" });
      const sent = await waitForFrames<SessionInterruptFrame>(arranged.wire, "sessionInterrupt", 1);
      expect(sent[0]!.sessionId).toBe(session.id);

      reportEvent(arranged.wire, 3, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "turn.completed",
        turnId: "t1",
        state: "interrupted",
      });

      await waitForSession(arranged, session.id, (one) => one.status === "idle");
      const completed = await waitUntil("wrote the ended turn", async () => {
        const found = await readStreamRows(arranged.harness, session.id);
        return found.find((row) => row.tag === "turn.completed");
      });
      expect((JSON.parse(completed.event) as { state: string }).state).toBe("interrupted");

      const entries = await arranged.harness.audit("session.interrupted");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("user");
    });
  });

  it("sends the interrupt whatever status the controller has for the session", async () => {
    await withFleet(async (arranged) => {
      // The prompt is never answered, so the session stays `idle` once it
      // has started, instead of moving to `busy` for the prompt's turn.
      arranged.wire.answering(() => undefined);
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);

      // The controller's status lags behind the runner's stream, and only the
      // adapter knows whether a turn is running. The adapter ignores an
      // interrupt when no turn is running.
      const starting = await interruptSession(arranged, session.id);
      expect(starting.status, await starting.clone().text()).toBe(200);

      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
      });
      await waitForSession(arranged, session.id, (one) => one.status === "idle");
      const idle = await interruptSession(arranged, session.id);
      expect(idle.status, await idle.clone().text()).toBe(200);

      const sent = await waitForFrames<SessionInterruptFrame>(arranged.wire, "sessionInterrupt", 2);
      expect(sent.map((frame) => frame.sessionId)).toEqual([session.id, session.id]);
      expect(await arranged.harness.audit("session.interrupted")).toHaveLength(2);
    });
  });

  it("rejects a session that has exited, and sends the runner nothing", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      reportExited(arranged.wire, session.id, 1);
      await waitForSession(arranged, session.id, (one) => one.status === "exited");

      const response = await interruptSession(arranged, session.id);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.text()).toContain("has exited");
      expect(listFrames<SessionInterruptFrame>(arranged.wire, "sessionInterrupt")).toEqual([]);
      expect(await arranged.harness.audit("session.interrupted")).toHaveLength(0);
    });
  });
});

describe("session.stop", () => {
  it("sends the runner a stop, and the exit the runner reports ends the session", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");

      const response = await stopSession(arranged, session.id);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ id: session.id });
      const sent = await waitForFrames<SessionStopFrame>(arranged.wire, "sessionStop", 1);
      expect(sent[0]!.sessionId).toBe(session.id);

      reportExited(arranged.wire, session.id, 2);

      const ended = await waitForSession(arranged, session.id, (one) => one.status === "exited");
      expect(ended.exitedAt).not.toBeNull();
      const entries = await arranged.harness.audit("session.stopped");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("user");
    });
  });

  it("ends a queued session once when several stops race, and returns the session as it is now", async () => {
    await withFleet(async (arranged) => {
      // The runner's only slot is taken, so the second session waits in the
      // queue with no runner holding it.
      const capped = await send(
        "PATCH",
        arranged.harness.base,
        `/api/v1/runners/${arranged.runnerId}`,
        {
          body: { maxConcurrentSessions: 1 },
          token: arranged.token,
        },
      );
      expect(capped.status, await capped.clone().text()).toBe(200);
      await startSession(arranged, "take the slot");
      const queued = await spawnSessionOrFail(arranged, { prompt: "wait" });
      expect(queued.status).toBe("queued");

      // Each stop can read the session as queued before another one ends it.
      // The stops that lose the race change nothing and record nothing.
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => stopSession(arranged, queued.id)),
      );

      const answered = responses.filter((one) => one.status === 200);
      expect(answered.length).toBeGreaterThan(0);
      for (const response of answered) {
        expect(await response.json()).toMatchObject({ id: queued.id, status: "exited" });
      }
      for (const response of responses.filter((one) => one.status !== 200)) {
        expect(response.status, await response.clone().text()).toBe(409);
      }
      expect(await arranged.harness.audit("session.stopped")).toHaveLength(1);
      expect(
        listFrames<SessionStopFrame>(arranged.wire, "sessionStop").filter(
          (frame) => frame.sessionId === queued.id,
        ),
      ).toEqual([]);
    });
  });

  it("rejects a session that has already exited, and sends the runner nothing", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      reportExited(arranged.wire, session.id, 1);
      await waitForSession(arranged, session.id, (one) => one.status === "exited");

      const response = await stopSession(arranged, session.id);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(listFrames<SessionStopFrame>(arranged.wire, "sessionStop")).toEqual([]);
      expect(await arranged.harness.audit("session.stopped")).toHaveLength(0);
    });
  });
});

describe("session.continue", () => {
  it("forks the parent's native session into a new session that copies the parent", async () => {
    await withFleet(async (arranged) => {
      const parent = await startAndEndSession(arranged, "hello");
      expect(parent.resumable).toBe(true);

      const response = await continueSession(arranged, parent.id, {
        mode: "fork",
        prompt: "carry on",
      });

      expect(response.status, await response.clone().text()).toBe(200);
      const child = (await response.json()) as Session;
      expect(child.id).not.toBe(parent.id);
      expect(child).toMatchObject({
        status: "starting",
        runnerId: parent.runnerId,
        instanceId: parent.instanceId,
        permissionProfileId: parent.permissionProfileId,
        accessMode: parent.accessMode,
        requestedAccessMode: parent.requestedAccessMode,
        workspaceId: parent.workspaceId,
        // A fork records its parent.
        parentSessionId: parent.id,
      });
      expect(child.modelSelection).toEqual({ model: "clever", options: {} });

      const starts = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2);
      expect(starts[1]!.sessionId).toBe(child.id);
      expect(starts[1]!.spec.continue).toEqual({ nativeSessionId: "native-1", mode: "fork" });
      expect(await listInputs(arranged, child.id)).toMatchObject([
        { text: "carry on", status: "queued" },
      ]);

      const entries = await arranged.harness.audit("session.continued");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("user");
      expect(entries[0]?.payload).toMatchObject({
        sessionId: child.id,
        parentSessionId: parent.id,
        mode: "fork",
      });
    });
  });

  it("copies the parent's spec, including an agent's prompt, tools and schema, onto the fork", async () => {
    await withFleet(async (arranged) => {
      const listing = await get(arranged.harness.base, "/api/v1/profiles", arranged.token);
      const profiles = ((await listing.json()) as { items: ReadonlyArray<Profile> }).items;
      const worker = profiles.find((one) => one.name === "worker");
      expect(worker).toBeDefined();
      const created = await post(
        arranged.harness.base,
        "/api/v1/agents",
        {
          name: "assessor",
          systemPrompt: "You assess tasks.",
          instanceId: findInstanceId(arranged, "full-provider"),
          permissionProfileId: worker!.id,
          disallowedTools: ["edit", "shell"],
        },
        arranged.token,
      );
      expect(created.status, await created.clone().text()).toBe(200);
      const agent = (await created.json()) as { readonly id: string };
      const schema = {
        type: "object",
        additionalProperties: false,
        required: ["verdict"],
        properties: { verdict: { type: "string", enum: ["accept", "dismiss"] } },
      };

      const spawnedFromAgent = await spawnSessionOrFail(arranged, {
        agentId: agent.id,
        prompt: "assess this",
        outputSchema: schema,
      });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: spawnedFromAgent.id,
        at,
        _tag: "session.started",
      });
      await waitForSession(arranged, spawnedFromAgent.id, (one) => one.status === "busy");
      const parent = await endSession(arranged, spawnedFromAgent, 2);
      expect(parent.resumable).toBe(true);

      const response = await continueSession(arranged, parent.id, {
        mode: "fork",
        prompt: "carry on",
      });
      expect(response.status, await response.clone().text()).toBe(200);

      const starts = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2);
      expect(starts[1]!.spec.systemPrompt).toBe("You assess tasks.");
      expect(starts[1]!.spec.disallowedTools).toEqual(["edit", "shell"]);
      expect(starts[1]!.spec.outputSchema).toEqual(schema);
    });
  });

  it("rejects a parent that is live, one with no native session, and an id that matches no session", async () => {
    await withFleet(async (arranged) => {
      const running = await startSession(arranged, "hello");
      const stillLive = await continueSession(arranged, running.id, { mode: "fork", prompt: "no" });
      expect(stillLive.status, await stillLive.clone().text()).toBe(409);

      // Exited without ever reporting a binding, so there is no native session
      // to continue from.
      const unbound = await spawnSessionOrFail(arranged, { prompt: "hello" });
      reportExited(arranged.wire, unbound.id, 1);
      await waitForSession(arranged, unbound.id, (one) => one.status === "exited");
      const noNative = await continueSession(arranged, unbound.id, { mode: "fork", prompt: "no" });
      expect(noNative.status, await noNative.clone().text()).toBe(409);

      const missing = await continueSession(arranged, "0199e0e7-9999-7000-8000-000000000000", {
        mode: "fork",
        prompt: "no",
      });
      expect(missing.status).toBe(404);

      // One start frame for each of the two sessions above, and none for a continue.
      expect(listFrames<SessionStart>(arranged.wire, "sessionStart")).toHaveLength(2);
    });
  });

  it("rejects a parent whose runner can no longer resume it", async () => {
    await withFleet(async (arranged) => {
      const retired = await startAndEndSession(arranged, "hello");
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE runners SET lifecycle = 'retired'
            WHERE id = unhex(replace(${arranged.runnerId}, '-', ''))`,
        ),
      );

      const response = await continueSession(arranged, retired.id, { mode: "fork", prompt: "no" });

      expect(response.status, await response.clone().text()).toBe(409);
      expect((await readSession(arranged, retired.id)).resumable).toBe(false);
    });
  });

  it("rejects a parent whose runner is draining, and says why", async () => {
    await withFleet(async (arranged) => {
      const parent = await startAndEndSession(arranged, "hello");
      // The transcript is still there, so the session reads resumable. The
      // error message explains that the runner is draining, so the rejection
      // does not look like a contradiction.
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE runners SET lifecycle = 'draining'
            WHERE id = unhex(replace(${arranged.runnerId}, '-', ''))`,
        ),
      );
      expect((await readSession(arranged, parent.id)).resumable).toBe(true);

      const response = await continueSession(arranged, parent.id, { mode: "fork", prompt: "no" });

      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.text()).toContain("draining");
      expect(listFrames<SessionStart>(arranged.wire, "sessionStart")).toHaveLength(1);
    });
  });

  it("rejects a parent whose runner is not logged in to its provider instance", async () => {
    await withFleet(async (arranged) => {
      const parent = await startAndEndSession(arranged, "hello");
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE capability_snapshots SET auth_status = 'unauthenticated'
            WHERE runner_id = unhex(replace(${arranged.runnerId}, '-', ''))`,
        ),
      );

      const response = await continueSession(arranged, parent.id, { mode: "fork", prompt: "no" });

      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.text()).toContain("logged in");
      expect(listFrames<SessionStart>(arranged.wire, "sessionStart")).toHaveLength(1);
    });
  });
});

/** `session.update`: the model is plain session state, changed by `PATCH /api/v1/sessions/:id { model }`. */
describe("session.update", () => {
  const patchSession = (arranged: Arranged, id: string, body: unknown): Promise<Response> =>
    send("PATCH", arranged.harness.base, `/api/v1/sessions/${id}`, {
      body,
      token: arranged.token,
    });

  /** Patches the session, checks that a later read returns the same model selection, and returns it. */
  const patchSessionOrFail = async (
    arranged: Arranged,
    id: string,
    body: unknown,
  ): Promise<unknown> => {
    const response = await patchSession(arranged, id, body);
    expect(response.status, await response.clone().text()).toBe(200);
    const answered = ((await response.json()) as Session).modelSelection;
    expect((await readSession(arranged, id)).modelSelection).toEqual(answered);
    return answered;
  };

  it("changes only modelSelection.options, and GET returns the same", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      expect(session.modelSelection).toEqual({ model: "clever", options: {} });

      expect(
        await patchSessionOrFail(arranged, session.id, { options: { effort: "high" } }),
      ).toEqual({
        model: "clever",
        options: { effort: "high" },
      });
    });
  });

  it("changes modelSelection.model and drops the old model's options", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      await patchSessionOrFail(arranged, session.id, {
        options: { effort: "high", fastMode: true },
      });

      expect(await patchSessionOrFail(arranged, session.id, { model: "fast" })).toEqual({
        model: "fast",
        options: {},
      });
    });
  });

  it("changes both at once, validating the options against the model the same call names", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      await patchSessionOrFail(arranged, session.id, {
        options: { effort: "high", fastMode: true },
      });

      expect(
        await patchSessionOrFail(arranged, session.id, {
          model: "fast",
          options: { effort: "low" },
        }),
      ).toEqual({ model: "fast", options: { effort: "low" } });
    });
  });

  it("changes nothing on a payload with neither field", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      await patchSessionOrFail(arranged, session.id, { options: { effort: "high" } });

      expect(await patchSessionOrFail(arranged, session.id, {})).toEqual({
        model: "clever",
        options: { effort: "high" },
      });
    });
  });

  it("rejects a value the model does not offer, and leaves the row unchanged", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      await patchSessionOrFail(arranged, session.id, { options: { effort: "high" } });

      const response = await patchSession(arranged, session.id, {
        options: { effort: "extreme" },
      });

      expect(response.status, await response.clone().text()).toBe(400);
      const refused = await parseRefusal(response);
      expect(refused.code).toBe("validation");
      expect(refused.paths).toContainEqual(["options", "effort"]);
      expect((await readSession(arranged, session.id)).modelSelection).toEqual({
        model: "clever",
        options: { effort: "high" },
      });
    });
  });

  it("leaves the stored spec byte for byte as the runner was started with", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;

      const patched = await patchSession(arranged, session.id, { model: "fast" });
      expect(patched.status, await patched.clone().text()).toBe(200);

      const [row] = await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql<{ readonly spec: string }>`
            SELECT spec FROM sessions WHERE id = unhex(replace(${session.id}, '-', ''))`,
        ),
      );
      // The change is stored on the session row, never in the spec the runner
      // was started with.
      expect(row?.spec).toBe(JSON.stringify(start.spec));
    });
  });

  it("announces the session record topic on the live socket", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      const ticket = await fetchTicket(arranged.harness.base, arranged.token);

      await onSocket(arranged.harness.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const announced = yield* collectMessages(client, { topic: "session" });
          yield* Effect.promise(() => waitForLiveToSettle());

          const patched = yield* Effect.promise(() =>
            patchSession(arranged, session.id, { model: "fast" }),
          );
          expect(patched.status, yield* Effect.promise(() => patched.clone().text())).toBe(200);

          const heard = yield* Effect.promise(() =>
            waitWithin(2000, () =>
              announced.received.some((message) =>
                (message as { ids?: ReadonlyArray<string> }).ids?.includes(session.id),
              ),
            ),
          );
          expect(heard).toBe(true);
          yield* Fiber.interrupt(announced.fiber);
        }),
      );
    });
  });

  it("sends the new model on the next input, when the model changed while an earlier input was unanswered", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const session = await spawnSessionOrFail(arranged, { prompt: "one" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      const queued = await sendInput(arranged, session.id, { text: "two" });
      expect(await queued.json()).toMatchObject({ result: "queued" });

      reportEvent(arranged.wire, ...buildTranscript(session.id)[0]!);
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);

      // The model changes while the prompt input is still unanswered. The next
      // input has not been claimed yet, so it must carry the new model when
      // it is sent once the session is idle again.
      const patched = await patchSession(arranged, session.id, { model: "fast" });
      expect(patched.status, await patched.clone().text()).toBe(200);

      arranged.wire.release("opened");
      const events = buildTranscript(session.id);
      reportEvent(arranged.wire, ...events[1]!);
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      arranged.wire.answering(() => "opened");
      reportEvent(arranged.wire, ...events[6]!);

      const sent = await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 2);
      expect(sent[1]!.input.modelSelection).toEqual({ model: "fast", options: {} });
    });
  });

  it("is used in a continue's spec after the session exits", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");

      const patched = await patchSession(arranged, session.id, { model: "fast" });
      expect(patched.status, await patched.clone().text()).toBe(200);

      const parent = await endSession(arranged, session, 2);
      const carried = await continueSession(arranged, parent.id, {
        mode: "fork",
        prompt: "and again",
      });
      expect(carried.status, await carried.clone().text()).toBe(200);
      const child = (await carried.json()) as Session;
      expect(child.modelSelection).toEqual({ model: "fast", options: {} });

      const starts = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2);
      expect(starts[1]!.spec.modelSelection).toEqual({ model: "fast", options: {} });
    });
  });

  it("rejects a session that has exited", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      reportExited(arranged.wire, session.id, 1);
      await waitForSession(arranged, session.id, (one) => one.status === "exited");

      const response = await patchSession(arranged, session.id, { model: "fast" });

      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.text()).toContain("has exited");
    });
  });

  it("fails validation on an empty model", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");

      const blank = await patchSession(arranged, session.id, { model: "" });
      expect(blank.status, await blank.clone().text()).toBe(400);
    });
  });
});

/**
 * "Sent and unanswered" as stored state (`sent_at`, `reason`), and a flush that
 * sends one waiting input each time the session becomes idle, rather than the
 * whole queue at once.
 */
describe("the queue when the session becomes idle, one input at a time", () => {
  it("sends only the oldest input each time, and marks it as sent until it is answered", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const session = await spawnSessionOrFail(arranged, { prompt: "one" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      for (const text of ["two", "three"]) {
        const queued = await sendInput(arranged, session.id, { text });
        expect(await queued.json()).toMatchObject({ result: "queued" });
      }

      reportEvent(arranged.wire, ...buildTranscript(session.id)[0]!);

      // The claim commits `sent_at` before the frame is written, so wait for
      // the frame: once it is on the wire, the claim is already stored.
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);
      const onWire = await listInputs(arranged, session.id);
      expect(listInputFrames(arranged.wire)).toHaveLength(1);
      expect(onWire.map((row) => [row.text, row.status, typeof row.sentAt === "string"])).toEqual([
        ["one", "queued", true],
        ["two", "queued", false],
        ["three", "queued", false],
      ]);

      // It was sent, so it can no longer be edited or cancelled.
      const patched = await patchInput(arranged, session.id, onWire[0]!.id, { text: "no" });
      expect(patched.status, await patched.clone().text()).toBe(409);
      const cancelled = await cancelInput(arranged, session.id, onWire[0]!.id);
      expect(cancelled.status, await cancelled.clone().text()).toBe(409);

      arranged.wire.release("opened");
      const delivered = await waitUntil("delivered the first row", async () => {
        const found = await listInputs(arranged, session.id);
        return found[0]!.status === "delivered" ? found : undefined;
      });
      expect(delivered[0]).toMatchObject({ status: "delivered", delivery: "opened", sentAt: null });
      expect(typeof delivered[0]!.deliveredAt).toBe("string");
      expect(delivered[1]).toMatchObject({ status: "queued", sentAt: null });
      expect(delivered[2]).toMatchObject({ status: "queued", sentAt: null });

      // When the session is idle again, only the next input is sent.
      arranged.wire.answering(() => "opened");
      reportEvent(arranged.wire, ...buildTranscript(session.id)[1]!);
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      reportEvent(arranged.wire, ...buildTranscript(session.id)[6]!);

      const secondSent = await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 2);
      expect(secondSent.map((frame) => frame.input.text)).toEqual(["one", "two"]);
      const afterSecond = await waitUntil("delivered the second row", async () => {
        const found = await listInputs(arranged, session.id);
        return found[1]!.status === "delivered" ? found : undefined;
      });
      expect(afterSecond[1]).toMatchObject({ status: "delivered", delivery: "opened" });
      expect(afterSecond[2]).toMatchObject({ status: "queued", sentAt: null });
    });
  });

  it("puts an input the runner rejected back to queued with the runner's message, and clears the message when it is sent again", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering((frame) =>
        frame.input.text === "one" ? { message: "no such model here" } : undefined,
      );
      const session = await spawnSessionOrFail(arranged, { prompt: "one" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);

      reportEvent(arranged.wire, ...buildTranscript(session.id)[0]!);

      const refused = await waitUntil("recorded the refusal", async () => {
        const found = await listInputs(arranged, session.id);
        return found[0]!.reason !== null ? found : undefined;
      });
      expect(refused[0]).toMatchObject({
        status: "queued",
        sentAt: null,
        reason: "no such model here",
      });

      // When the session is idle again the input is sent again, and the claim
      // clears the reason: an old reason must not stay on an input that is
      // being sent to the runner again. The runner now accepts it, so the test
      // checks the retry rather than a second rejection.
      arranged.wire.answering(() => "opened");
      reportEvent(arranged.wire, ...buildTranscript(session.id)[1]!);
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      reportEvent(arranged.wire, ...buildTranscript(session.id)[6]!);

      const delivered = await waitUntil("delivered the retried input", async () => {
        const found = await listInputs(arranged, session.id);
        return found[0]!.status === "delivered" ? found : undefined;
      });
      expect(delivered[0]).toMatchObject({
        status: "delivered",
        delivery: "opened",
        sentAt: null,
        reason: null,
      });
    });
  });

  it("leaves an unanswered input queued, with sentAt cleared and a reason, once the deadline passes", async () => {
    await withFleet(
      async (arranged) => {
        arranged.wire.answering(() => undefined);
        const session = await spawnSessionOrFail(arranged, { prompt: "one" });
        await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);

        reportEvent(arranged.wire, ...buildTranscript(session.id)[0]!);
        await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);

        // The only fixed-time wait here: the input counts as sent from the
        // moment the frame goes out, and nothing else shows when the
        // controller stops waiting for an answer.
        await delay(Duration.toMillis(INPUT_DEADLINE) + 1000);

        const rows = await listInputs(arranged, session.id);
        expect(rows[0]).toMatchObject({ status: "queued", sentAt: null });
        expect(typeof rows[0]!.reason).toBe("string");
      },
      // After the deadline the input is waiting on an idle session, which a
      // tick would send again. The tick is stopped so the test can read the
      // input as the deadline left it.
      { eventRoutingInterval: NO_TICK },
    );
  });

  it("cancels waiting inputs when the session exits, but leaves the sent one until it is answered", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering((frame) => (frame.input.text === "one" ? undefined : "opened"));
      const session = await spawnSessionOrFail(arranged, { prompt: "one" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      const queued = await sendInput(arranged, session.id, { text: "two" });
      expect(await queued.json()).toMatchObject({ result: "queued" });

      reportEvent(arranged.wire, ...buildTranscript(session.id)[0]!);
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);

      reportExited(arranged.wire, session.id, 2);
      await waitForSession(arranged, session.id, (one) => one.status === "exited");

      const rows = await listInputs(arranged, session.id);
      expect(rows.map((row) => [row.text, row.status])).toEqual([
        ["one", "queued"],
        ["two", "cancelled"],
      ]);
      expect(typeof rows[0]!.sentAt).toBe("string");

      // Answer the held frame, so nothing is outstanding when the test harness
      // closes the socket.
      arranged.wire.release("opened");
    });
  });
});

/**
 * A controller restart over a database that already has session inputs.
 * `reboot` runs the boot's idempotent steps again on the same database, as a
 * real restart would. That is how the test gets an input that was sent but
 * unanswered when the previous process stopped.
 */
describe("a restart", () => {
  it("cancels an input that was sent and unanswered, with a reason, and leaves a waiting input untouched", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      // The `Id` schema requires a UUIDv7, like every id the controller
      // creates, so a plain `crypto.randomUUID()` (v4) would fail to decode
      // when read back over `GET /inputs`.
      const onWire = Bun.randomUUIDv7();
      const waiting = Bun.randomUUIDv7();
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            INSERT INTO session_inputs (id, session_id, source, actor, text, status,
                                         sent_at, created_at)
            VALUES (unhex(replace(${onWire}, '-', '')), unhex(replace(${session.id}, '-', '')),
                    'user', 'user', 'on the wire', 'queued', ${at}, ${at})
          `,
        ),
      );
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            INSERT INTO session_inputs (id, session_id, source, actor, text, status, created_at)
            VALUES (unhex(replace(${waiting}, '-', '')), unhex(replace(${session.id}, '-', '')),
                    'user', 'user', 'still waiting', 'queued', ${at})
          `,
        ),
      );

      await arranged.harness.reboot();

      const rows = await listInputs(arranged, session.id);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const onWireRow = byId.get(onWire);
      const waitingRow = byId.get(waiting);
      expect(onWireRow).toMatchObject({ status: "cancelled" });
      expect(typeof onWireRow?.reason).toBe("string");
      expect(waitingRow).toMatchObject({ status: "queued", sentAt: null });
    });
  });
});

/** Writes controller settings through the settings API. */
const setControllerSettings = async (
  arranged: Arranged,
  controller: Record<string, unknown>,
): Promise<void> => {
  const response = await send("PATCH", arranged.harness.base, "/api/v1/settings", {
    body: { controller },
    token: arranged.token,
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

describe("the timeouts a session starts with", () => {
  it("uses the values from the settings, converted from minutes to milliseconds", async () => {
    await withFleet(async (arranged) => {
      await setControllerSettings(arranged, {
        "session.inactivityTimeoutMinutes": 5,
        "session.absoluteTimeoutMinutes": 60,
      });

      await spawnSessionOrFail(arranged, { prompt: "hello" });

      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      expect(start.spec.timeouts).toEqual({ inactivityMs: 300_000, absoluteMs: 3_600_000 });
    });
  });

  it("uses the same values for a session continued from another", async () => {
    await withFleet(async (arranged) => {
      await setControllerSettings(arranged, {
        "session.inactivityTimeoutMinutes": 5,
        "session.absoluteTimeoutMinutes": 60,
      });
      const parent = await startAndEndSession(arranged, "hello");

      const response = await continueSession(arranged, parent.id, {
        mode: "fork",
        prompt: "carry on",
      });
      expect(response.status, await response.clone().text()).toBe(200);

      const starts = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2);
      const expected = { inactivityMs: 300_000, absoluteMs: 3_600_000 };
      expect(starts[0]!.spec.timeouts).toEqual(expected);
      expect(starts[1]!.spec.timeouts).toEqual(expected);
    });
  });
});

/**
 * Tests for a placement onto a runner that cannot take the session yet. The
 * queue is the session rows themselves, so the tests check the status the
 * caller reads back and which frames the runner did or did not get. The runner
 * never receives anything about a queued session.
 */

/** Sets the runner's session cap, the way the runner page's edit form does. */
const setSessionCap = async (arranged: Arranged, cap: number): Promise<void> => {
  const response = await send(
    "PATCH",
    arranged.harness.base,
    `/api/v1/runners/${arranged.runnerId}`,
    {
      body: { maxConcurrentSessions: cap },
      token: arranged.token,
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
};

/** Sets the runner's disk watermark override, in bytes, through `runner.update`. */
const setDiskWatermark = async (arranged: Arranged, bytes: number): Promise<void> => {
  const response = await send(
    "PATCH",
    arranged.harness.base,
    `/api/v1/runners/${arranged.runnerId}`,
    {
      body: { diskWatermarkBytes: bytes },
      token: arranged.token,
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
};

const GIB = 1024 * 1024 * 1024;

/** Sends a watermark report with the runner's free disk space, which admission reads. */
const reportDiskFree = (wire: Wire, diskFreeBytes: number): void =>
  wire.send({
    _tag: "watermarkReport",
    watermark: { diskFreeBytes, availableMemoryBytes: 16 * GIB },
  });

/**
 * Waits long enough for a start frame the controller decided to send to have
 * crossed the socket. A test cannot wait for a frame not to arrive, so it waits
 * as long as an expected frame takes, and then checks that none arrived.
 */
const waitToSettle = (): Promise<void> => delay(250);

const listStartFrames = (wire: Wire): ReadonlyArray<SessionStart> =>
  listFrames<SessionStart>(wire, "sessionStart");

describe("session.spawn onto a runner that is full", () => {
  it("queues the spawn, sends the runner nothing, and starts it when a slot frees up", async () => {
    await withFleet(async (arranged) => {
      await setSessionCap(arranged, 1);
      const running = await startSession(arranged, "hello");

      const waiting = await spawnSessionOrFail(arranged, { prompt: "after you" });

      expect(waiting.status).toBe("queued");
      expect(waiting.runnerId).toBe(arranged.runnerId);
      await waitToSettle();
      expect(listStartFrames(arranged.wire).map((frame) => frame.sessionId)).toEqual([running.id]);

      reportExited(arranged.wire, running.id, 2);

      await waitForSession(arranged, waiting.id, (one) => one.status === "starting");
      const sent = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2);
      expect(sent[1]!.sessionId).toBe(waiting.id);
    });
  });

  it("starts the oldest first, and never more of them than there are free slots", async () => {
    await withFleet(async (arranged) => {
      await setSessionCap(arranged, 1);
      const running = await startSession(arranged, "hello");
      const first = await spawnSessionOrFail(arranged, { prompt: "second in line" });
      const second = await spawnSessionOrFail(arranged, { prompt: "third in line" });
      expect([first.status, second.status]).toEqual(["queued", "queued"]);

      reportExited(arranged.wire, running.id, 2);

      // One slot freed up, so one of the two starts: the one that has been
      // waiting longest.
      await waitForSession(arranged, first.id, (one) => one.status === "starting");
      await waitToSettle();
      expect(listStartFrames(arranged.wire).map((frame) => frame.sessionId)).toEqual([
        running.id,
        first.id,
      ]);
      expect((await readSession(arranged, second.id)).status).toBe("queued");

      reportExited(arranged.wire, first.id, 3);

      await waitForSession(arranged, second.id, (one) => one.status === "starting");
      await waitToSettle();
      expect(listStartFrames(arranged.wire).map((frame) => frame.sessionId)).toEqual([
        running.id,
        first.id,
        second.id,
      ]);
    });
  });

  it("starts as many sessions as the raised cap has room for, at once", async () => {
    await withFleet(async (arranged) => {
      await setSessionCap(arranged, 1);
      await startSession(arranged, "hello");
      const first = await spawnSessionOrFail(arranged, { prompt: "second in line" });
      const second = await spawnSessionOrFail(arranged, { prompt: "third in line" });
      expect([first.status, second.status]).toEqual(["queued", "queued"]);

      await setSessionCap(arranged, 3);

      await waitForSession(arranged, first.id, (one) => one.status === "starting");
      await waitForSession(arranged, second.id, (one) => one.status === "starting");
      const sent = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 3);
      expect(sent.slice(1).map((frame) => frame.sessionId)).toEqual([first.id, second.id]);
    });
  });

  it("starts nothing on a runner that is draining, however much room it has", async () => {
    await withFleet(async (arranged) => {
      await setSessionCap(arranged, 1);
      const running = await startSession(arranged, "hello");
      const waiting = await spawnSessionOrFail(arranged, { prompt: "after you" });
      expect(waiting.status).toBe("queued");

      const drained = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/runners/${arranged.runnerId}/drain`,
        {
          body: {},
          token: arranged.token,
        },
      );
      expect(drained.status, await drained.clone().text()).toBe(200);

      reportExited(arranged.wire, running.id, 2);
      await waitForSession(arranged, running.id, (one) => one.status === "exited");
      await waitToSettle();

      expect((await readSession(arranged, waiting.id)).status).toBe("queued");
      expect(listStartFrames(arranged.wire).map((frame) => frame.sessionId)).toEqual([running.id]);

      const undrained = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/runners/${arranged.runnerId}/undrain`,
        { body: {}, token: arranged.token },
      );
      expect(undrained.status, await undrained.clone().text()).toBe(200);

      await waitForSession(arranged, waiting.id, (one) => one.status === "starting");
      const sent = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2);
      expect(sent[1]!.sessionId).toBe(waiting.id);
    });
  });

  it("ends a queued session on session.stop, without sending the runner anything", async () => {
    await withFleet(async (arranged) => {
      await setSessionCap(arranged, 1);
      await startSession(arranged, "hello");
      const waiting = await spawnSessionOrFail(arranged, { prompt: "after you" });
      expect(waiting.status).toBe("queued");

      const response = await stopSession(arranged, waiting.id);

      expect(response.status, await response.clone().text()).toBe(200);
      const ended = await waitForSession(arranged, waiting.id, (one) => one.status === "exited");
      expect(ended.exitedAt).not.toBeNull();
      await waitToSettle();
      expect(listFrames<SessionStopFrame>(arranged.wire, "sessionStop")).toEqual([]);
      expect(listStartFrames(arranged.wire)).toHaveLength(1);
    });
  });
});

describe("session.spawn and session.continue onto an unreachable runner", () => {
  it("queues a spawn onto a disconnected runner, and starts it when the runner reconnects", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.close();
      await waitForRunnerGone(arranged);

      const response = await spawnSession(arranged, {
        prompt: "hello",
        runnerId: arranged.runnerId,
      });

      expect(response.status, await response.clone().text()).toBe(200);
      const waiting = (await response.json()) as Session;
      expect(waiting.status).toBe("queued");
      expect(waiting.runnerId).toBe(arranged.runnerId);

      const again = await arranged.reconnect();
      again.send({ _tag: "sessionsReport", sessions: [] });

      await waitForSession(arranged, waiting.id, (one) => one.status === "starting");
      const sent = await waitForFrames<SessionStart>(again, "sessionStart", 1);
      expect(sent[0]!.sessionId).toBe(waiting.id);
    });
  });

  it("queues a continue onto a disconnected runner, and starts it when the runner reconnects", async () => {
    await withFleet(async (arranged) => {
      const parent = await startAndEndSession(arranged, "hello");
      arranged.wire.close();
      await waitForRunnerGone(arranged);

      const response = await continueSession(arranged, parent.id, {
        mode: "fork",
        prompt: "carry on",
      });

      expect(response.status, await response.clone().text()).toBe(200);
      const child = (await response.json()) as Session;
      expect(child.status).toBe("queued");
      expect(child.runnerId).toBe(arranged.runnerId);

      const again = await arranged.reconnect();
      again.send({ _tag: "sessionsReport", sessions: [] });

      await waitForSession(arranged, child.id, (one) => one.status === "starting");
      const sent = await waitForFrames<SessionStart>(again, "sessionStart", 1);
      expect(sent[0]!.spec.continue).toEqual({ nativeSessionId: "native-1", mode: "fork" });
    });
  });
});

describe("session.spawn between a runner's hello and its first sessions report", () => {
  it("queues the session until the report arrives, then starts it", async () => {
    await withFleet(async (arranged) => {
      // A new connection for the same runner, as after a restart: the hello
      // was sent, but no sessions report yet. The test waits for the probe on
      // the new connection rather than sleeping. A probe is sent only once the
      // controller has processed this hello and made this the runner's
      // current connection. Otherwise an HTTP spawn could race the WebSocket
      // handshake.
      const again = await arranged.reconnect();
      await waitForFrames<ProbeRequest>(again, "probeRequest", 1);

      const response = await spawnSession(arranged, {
        prompt: "hello",
        runnerId: arranged.runnerId,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const session = (await response.json()) as Session;
      expect(session.status).toBe("queued");
      expect(session.runnerId).toBe(arranged.runnerId);

      again.send({ _tag: "sessionsReport", sessions: [] });

      const started = await waitForSession(
        arranged,
        session.id,
        (one) => one.status === "starting",
      );
      expect(started.status).toBe("starting");
      const sent = await waitForFrames<SessionStart>(again, "sessionStart", 1);
      expect(sent[0]!.sessionId).toBe(session.id);
    });
  });
});

describe("session.spawn onto a runner that is short of disk", () => {
  it("queues below the watermark and starts on a report at or above it", async () => {
    await withFleet(async (arranged) => {
      // No disk report yet: a runner that has not reported its disk is
      // assumed to have room, and gets work.
      const first = await spawnSessionOrFail(arranged, { prompt: "before any report" });
      expect(first.status).toBe("starting");
      reportExited(arranged.wire, first.id, 1);
      await waitForSession(arranged, first.id, (one) => one.status === "exited");

      reportDiskFree(arranged.wire, 4 * GIB);
      await waitUntil("stored the low reading", async () => {
        const response = await get(
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}`,
          arranged.token,
        );
        const runner = (await response.json()) as Runner;
        return runner.watermark?.diskFreeBytes === 4 * GIB ? runner : undefined;
      });

      const waiting = await spawnSessionOrFail(arranged, { prompt: "no room" });

      expect(waiting.status).toBe("queued");
      await waitToSettle();
      expect(listStartFrames(arranged.wire).map((frame) => frame.sessionId)).toEqual([first.id]);

      reportDiskFree(arranged.wire, 40 * GIB);

      await waitForSession(arranged, waiting.id, (one) => one.status === "starting");
      const sent = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2);
      expect(sent[1]!.sessionId).toBe(waiting.id);
    });
  });

  it("starts a queued session when the owner lowers the watermark below the runner's free disk", async () => {
    await withFleet(async (arranged) => {
      reportDiskFree(arranged.wire, 4 * GIB);
      await waitUntil("stored the low reading", async () => {
        const response = await get(
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}`,
          arranged.token,
        );
        const runner = (await response.json()) as Runner;
        return runner.watermark?.diskFreeBytes === 4 * GIB ? runner : undefined;
      });
      const waiting = await spawnSessionOrFail(arranged, { prompt: "no room" });
      expect(waiting.status).toBe("queued");

      await setDiskWatermark(arranged, 1 * GIB);

      await waitForSession(arranged, waiting.id, (one) => one.status === "starting");
      const sent = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      expect(sent[0]!.sessionId).toBe(waiting.id);
    });
  });
});

/**
 * Tests for the sessions a runner's sessions report leaves out.
 *
 * A runner that restarted comes back with fewer sessions than the controller
 * thinks it has, and the report is the only place that difference shows. So
 * the tests check the difference:
 *
 * - the sessions the report leaves out are ended;
 * - the session it lists is untouched;
 * - a session on another runner is not affected by this runner's report.
 */

/**
 * Waits until no message has arrived for two coalescing windows, and returns
 * how many messages the subscription has received. A record change is
 * announced after a delay, so a test that counts from the moment it subscribes
 * would count messages caused by earlier steps as caused by later ones.
 */
const waitForQuiet = async (announced: Collected): Promise<number> => {
  let seen = -1;
  while (seen !== announced.received.length) {
    seen = announced.received.length;
    await waitForLiveToSettle();
  }
  return seen;
};

/** Sends a sessions report listing exactly these sessions, each with a native id. */
const reportHeldSessions = (
  wire: Wire,
  arranged: Arranged,
  sessionIds: ReadonlyArray<string>,
): void =>
  wire.send({
    _tag: "sessionsReport",
    sessions: sessionIds.map((sessionId) => ({
      sessionId,
      nativeSessionId: `native-${sessionId}`,
      instanceId: findInstanceId(arranged, "full-provider"),
    })),
  });

/** Starts a session and then a turn, so the controller reads the session as busy. */
const startBusySession = async (arranged: Arranged, prompt: string): Promise<Session> => {
  const session = await startSession(arranged, prompt);
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "turn.started",
    turnId: `turn-${session.id}`,
  });
  return await waitForSession(arranged, session.id, (one) => one.status === "busy");
};

/** Spawns a session on a second runner by id, and reports it as started and busy there. */
const startBusySessionOn = async (
  arranged: Arranged,
  machine: { readonly runnerId: string; readonly wire: Wire },
  prompt: string,
): Promise<Session> => {
  const session = await spawnSessionOrFail(arranged, { prompt, runnerId: machine.runnerId });
  const base = { sessionId: session.id, at };
  reportEvent(machine.wire, 1, {
    ...base,
    eventId: crypto.randomUUID(),
    _tag: "session.started",
    providerRefs: { nativeSessionId: `native-${session.id}` },
  });
  reportEvent(machine.wire, 2, {
    ...base,
    eventId: crypto.randomUUID(),
    _tag: "turn.started",
    turnId: `turn-${session.id}`,
  });
  return await waitForSession(arranged, session.id, (one) => one.status === "busy");
};

describe("sessions a runner's report leaves out", () => {
  it("ends the sessions the report leaves out, and leaves the listed one and another runner's alone", async () => {
    await withFleet(async (arranged) => {
      // This runner's three sessions first, while it is the only runner:
      // automatic placement picks a runner, and these three must be on the
      // runner whose report is tested.
      const running = await startBusySession(arranged, "mid-turn here");
      const waiting = await startIdleSession(arranged, "idle here");
      const opening = await spawnSessionOrFail(arranged, { prompt: "still starting" });
      expect(opening.status).toBe("starting");
      expect(opening.runnerId).toBe(arranged.runnerId);
      const other = await arranged.enlist();
      const elsewhere = await startBusySessionOn(arranged, other, "on the other runner");
      // Each session has a native id before the report that ends two of them,
      // because whether an ended session is resumable depends on that id, not
      // on why it ended.
      reportHeldSessions(arranged.wire, arranged, [running.id, waiting.id, opening.id]);
      for (const id of [running.id, waiting.id, opening.id]) {
        await waitForSession(arranged, id, (one) => one.nativeSessionId !== null);
      }

      reportHeldSessions(arranged.wire, arranged, [waiting.id]);

      for (const id of [running.id, opening.id]) {
        const gone = await waitForSession(arranged, id, (one) => one.status === "exited");
        expect(gone.resumable, id).toBe(true);
        expect(gone.nativeSessionId, id).toBe(`native-${id}`);
        expect(gone.exitedAt, id).not.toBeNull();
      }
      expect((await readSession(arranged, waiting.id)).status).toBe("idle");
      expect((await readSession(arranged, elsewhere.id)).status).toBe("busy");

      // One audit entry per session the report ended, with the reason, and
      // none for the session left running or the one on the other runner.
      const reconciled = await arranged.harness.audit("session.reconciled");
      expect(reconciled.map((row) => row.payload["sessionId"]).sort()).toEqual(
        [running.id, opening.id].sort(),
      );
      for (const row of reconciled) {
        expect(row.payload["runnerId"]).toBe(arranged.runnerId);
        expect(row.payload["reason"]).toBe("runner_restart");
      }
    });
  });

  it("tells the runner to stop a session it still has that the controller has ended", async () => {
    // A runner whose machine was suspended past a session's timeout comes back
    // with the process still running: the controller ended the session while
    // the runner was unreachable.
    await withFleet(async (arranged) => {
      const running = await startBusySession(arranged, "outlived its bound");
      const kept = await startIdleSession(arranged, "still running on both sides");
      reportHeldSessions(arranged.wire, arranged, [kept.id]);
      await waitForSession(arranged, running.id, (one) => one.status === "exited");
      expect(listFrames<SessionStopFrame>(arranged.wire, "sessionStop")).toEqual([]);

      reportHeldSessions(arranged.wire, arranged, [running.id, kept.id]);

      const sent = await waitForFrames<SessionStopFrame>(arranged.wire, "sessionStop", 1);
      expect(sent).toEqual([{ _tag: "sessionStop", sessionId: running.id }]);
      expect((await readSession(arranged, running.id)).status).toBe("exited");
      expect((await readSession(arranged, kept.id)).status).toBe("idle");
    });
  });

  it("announces the session topic for each session it ended", async () => {
    await withFleet(async (arranged) => {
      const running = await startBusySession(arranged, "mid-turn here");
      const opening = await spawnSessionOrFail(arranged, { prompt: "still starting" });
      reportHeldSessions(arranged.wire, arranged, [running.id, opening.id]);
      await waitForSession(arranged, opening.id, (one) => one.nativeSessionId !== null);
      const ticket = await fetchTicket(arranged.harness.base, arranged.token);

      await onSocket(arranged.harness.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const announced = yield* collectMessages(client, { topic: "session" });
          // Messages caused by the spawns and the binding are collected and
          // counted first, so the checks below count only what the report
          // caused.
          const before = yield* Effect.promise(() => waitForQuiet(announced));

          yield* Effect.sync(() => reportHeldSessions(arranged.wire, arranged, []));

          const isAnnounced = (id: string): boolean =>
            announced.received
              .slice(before)
              .some((message) => (message as { ids?: ReadonlyArray<string> }).ids?.includes(id));
          for (const id of [running.id, opening.id]) {
            const heard = yield* Effect.promise(() => waitWithin(3000, () => isAnnounced(id)));
            expect(heard, id).toBe(true);
          }
          yield* Fiber.interrupt(announced.fiber);
        }),
      );
    });
  });

  it("changes nothing when the report still lists every session", async () => {
    await withFleet(async (arranged) => {
      const running = await startBusySession(arranged, "mid-turn here");
      const waiting = await startIdleSession(arranged, "idle here");
      const opening = await spawnSessionOrFail(arranged, { prompt: "still starting" });

      reportHeldSessions(arranged.wire, arranged, [running.id, waiting.id, opening.id]);
      await waitForSession(arranged, opening.id, (one) => one.nativeSessionId !== null);
      // A report is applied as soon as it arrives. The test waits for a status
      // change that must not happen, so it waits as long as one would take.
      await waitToSettle();

      expect((await readSession(arranged, running.id)).status).toBe("busy");
      expect((await readSession(arranged, waiting.id)).status).toBe("idle");
      expect((await readSession(arranged, opening.id)).status).toBe("starting");
    });
  });
});

/**
 * `queueInput`: the form of `session.input` that stores the input in its
 * caller's transaction and delivers it only after that transaction commits.
 * No route calls it, so these tests run it in a transaction of their own.
 */
describe("queueInput", () => {
  /** Runs `queueInput` in a transaction that ends with `after`, as the user. */
  const queueInputThen = (
    arranged: Arranged,
    sessionId: string,
    text: string,
    after: Effect.Effect<void, string>,
  ) =>
    arranged.harness.runWithLiveSessions(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const live = yield* Live;
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const row = yield* live.queueInput({ id: sessionId, text });
            yield* after;
            return row;
          }),
        );
      }),
    );

  it("stores the input and sends it to an idle session once the caller commits", async () => {
    await withFleet(async (arranged) => {
      const session = await startIdleSession(arranged, "hello");

      const exit = await queueInputThen(arranged, session.id, "after the commit", Effect.void);

      expect(Exit.isSuccess(exit), String(exit)).toBe(true);
      const row = Exit.isSuccess(exit) ? exit.value : undefined;
      expect(row).toMatchObject({ sessionId: session.id, text: "after the commit" });
      const frame = await waitUntil("sent the queued input", () =>
        listInputFrames(arranged.wire).find((one) => one.requestId === row?.id),
      );
      expect(frame.input.text).toBe("after the commit");
    });
  });

  it("stores and sends nothing when the caller's transaction rolls back", async () => {
    await withFleet(async (arranged) => {
      const session = await startIdleSession(arranged, "hello");
      const before = listInputFrames(arranged.wire).length;

      const exit = await queueInputThen(
        arranged,
        session.id,
        "never committed",
        Effect.fail("a later write in the caller's transaction failed"),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      await delay(250);
      expect(listInputFrames(arranged.wire)).toHaveLength(before);
      expect((await listInputs(arranged, session.id)).map((one) => one.text)).not.toContain(
        "never committed",
      );
    });
  });

  it("resumes an exited session once the caller commits, and sends the input when it starts", async () => {
    await withFleet(async (arranged) => {
      const session = await startAndEndSession(arranged, "hello");

      const exit = await queueInputThen(arranged, session.id, "still there?", Effect.void);

      expect(Exit.isSuccess(exit), String(exit)).toBe(true);
      const row = Exit.isSuccess(exit) ? exit.value : undefined;
      expect(row?.status).toBe("queued");
      const sent = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2);
      expect(sent[1]!.spec.continue).toEqual({ nativeSessionId: "native-1", mode: "resume" });

      reportEvent(arranged.wire, 3, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
      });
      const frame = await waitUntil("sent the input to the resumed session", () =>
        listInputFrames(arranged.wire).find((one) => one.requestId === row?.id),
      );
      expect(frame.input.text).toBe("still there?");
    });
  });
});

/**
 * Input into a session whose harness has exited: the input is stored, the same
 * session id is resumed on the runner that still has its transcript, and the
 * input is delivered once the process reports it has started. The tests check
 * what the caller can see (the status, the frames the runner got, and the
 * input), because a resume goes through the same path as a spawn.
 */
describe("session.input into an exited session", () => {
  it("resumes the same session on its runner and delivers the input once it has started", async () => {
    await withFleet(async (arranged) => {
      const session = await startAndEndSession(arranged, "hello");
      const before = listInputFrames(arranged.wire).length;

      const response = await sendInput(arranged, session.id, { text: "still there?" });

      expect(response.status, await response.clone().text()).toBe(200);
      const answer = (await response.json()) as { inputId: string; result: string };
      expect(answer.result).toBe("queued");

      const sent = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2);
      expect(sent[1]!.sessionId).toBe(session.id);
      expect(sent[1]!.spec.continue).toEqual({ nativeSessionId: "native-1", mode: "resume" });
      const starting = await waitForSession(
        arranged,
        session.id,
        (one) => one.status === "starting",
      );
      // `exitedAt` keeps the last exit time until the session exits again.
      expect(starting.exitedAt).toBe(session.exitedAt);
      expect(listInputFrames(arranged.wire)).toHaveLength(before);

      reportEvent(arranged.wire, 3, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
      });

      const delivered = await waitForFrames<SessionInput>(
        arranged.wire,
        "sessionInput",
        before + 1,
      );
      expect(delivered.at(-1)!.requestId).toBe(answer.inputId);
      expect(delivered.at(-1)!.input.text).toBe("still there?");

      reportEvent(arranged.wire, 4, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "turn.started",
        turnId: "t-resumed",
      });
      expect(
        (await waitForSession(arranged, session.id, (one) => one.status === "busy")).status,
      ).toBe("busy");
    });
  });

  it("binds the session to the native session the resumed process reports", async () => {
    await withFleet(async (arranged) => {
      const session = await startAndEndSession(arranged, "hello");

      const response = await sendInput(arranged, session.id, { text: "still there?" });
      expect(response.status, await response.clone().text()).toBe(200);
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2);

      reportEvent(arranged.wire, 3, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
        providerRefs: { nativeSessionId: "native-2" },
      });

      const bound = await waitForSession(arranged, session.id, (one) => one.status !== "starting");
      expect(bound.nativeSessionId).toBe("native-2");
    });
  });

  it("rejects an exited session whose transcript is gone, and says why", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      reportExited(arranged.wire, session.id, 1);
      await waitForSession(arranged, session.id, (one) => one.status === "exited");
      const before = (await listInputs(arranged, session.id)).length;

      const response = await sendInput(arranged, session.id, { text: "no transcript" });

      const said = await response.clone().text();
      expect(response.status, said).toBe(409);
      expect((await parseRefusal(response)).code).toBe("invalid_state");
      expect(said).toContain("transcript");
      expect(await listInputs(arranged, session.id)).toHaveLength(before);
      expect((await readSession(arranged, session.id)).status).toBe("exited");
    });
  });

  it("rejects an exited session whose runner was retired, and says why", async () => {
    await withFleet(async (arranged) => {
      const session = await startAndEndSession(arranged, "hello");
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE runners SET lifecycle = 'retired'
            WHERE id = unhex(replace(${arranged.runnerId}, '-', ''))`,
        ),
      );
      const before = (await listInputs(arranged, session.id)).length;

      const response = await sendInput(arranged, session.id, { text: "no machine" });

      const said = await response.clone().text();
      expect(response.status, said).toBe(409);
      expect((await parseRefusal(response)).code).toBe("invalid_state");
      expect(said).toContain("retired");
      expect(await listInputs(arranged, session.id)).toHaveLength(before);
      expect((await readSession(arranged, session.id)).status).toBe("exited");
    });
  });

  it("rejects an exited session whose runner is not logged in to its instance", async () => {
    await withFleet(async (arranged) => {
      const session = await startAndEndSession(arranged, "hello");
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE capability_snapshots SET auth_status = 'unauthenticated'
            WHERE runner_id = unhex(replace(${arranged.runnerId}, '-', ''))`,
        ),
      );
      const before = (await listInputs(arranged, session.id)).length;

      const response = await sendInput(arranged, session.id, { text: "nobody home" });

      const said = await response.clone().text();
      expect(response.status, said).toBe(409);
      expect((await parseRefusal(response)).code).toBe("invalid_state");
      expect(said).toContain("logged in");
      expect(await listInputs(arranged, session.id)).toHaveLength(before);
      expect((await readSession(arranged, session.id)).status).toBe("exited");
      await waitToSettle();
      expect(listStartFrames(arranged.wire)).toHaveLength(1);
    });
  });

  it("rejects an exited session whose runner is draining, and says why", async () => {
    await withFleet(async (arranged) => {
      const session = await startAndEndSession(arranged, "hello");
      const drained = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/runners/${arranged.runnerId}/drain`,
        { body: {}, token: arranged.token },
      );
      expect(drained.status, await drained.clone().text()).toBe(200);
      const before = (await listInputs(arranged, session.id)).length;

      const response = await sendInput(arranged, session.id, { text: "on the way out" });

      const said = await response.clone().text();
      expect(response.status, said).toBe(409);
      expect((await parseRefusal(response)).code).toBe("invalid_state");
      expect(said).toContain("draining");
      expect(await listInputs(arranged, session.id)).toHaveLength(before);
      expect((await readSession(arranged, session.id)).status).toBe("exited");
      await waitToSettle();
      expect(listStartFrames(arranged.wire)).toHaveLength(1);
    });
  });

  it("queues the resume while the runner is disconnected, and starts it when the runner reconnects", async () => {
    await withFleet(async (arranged) => {
      const session = await startAndEndSession(arranged, "hello");
      arranged.wire.close();
      await waitForRunnerGone(arranged);

      const response = await sendInput(arranged, session.id, { text: "when you are back" });

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ result: "queued" });
      expect((await readSession(arranged, session.id)).status).toBe("queued");

      const again = await arranged.reconnect();
      again.send({ _tag: "sessionsReport", sessions: [] });

      await waitForSession(arranged, session.id, (one) => one.status === "starting");
      const sent = await waitForFrames<SessionStart>(again, "sessionStart", 1);
      expect(sent[0]!.sessionId).toBe(session.id);
      expect(sent[0]!.spec.continue).toEqual({ nativeSessionId: "native-1", mode: "resume" });
    });
  });

  it("queues the resume while the runner is full, and starts it when a slot frees up", async () => {
    await withFleet(async (arranged) => {
      const session = await startAndEndSession(arranged, "hello");
      const running = await startSession(arranged, "busy here");
      await setSessionCap(arranged, 1);

      const response = await sendInput(arranged, session.id, { text: "after you" });

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ result: "queued" });
      expect((await readSession(arranged, session.id)).status).toBe("queued");
      await waitToSettle();
      expect(listStartFrames(arranged.wire).map((frame) => frame.sessionId)).toEqual([
        session.id,
        running.id,
      ]);

      reportExited(arranged.wire, running.id, 2);

      await waitForSession(arranged, session.id, (one) => one.status === "starting");
      const sent = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 3);
      expect(sent[2]!.sessionId).toBe(session.id);
    });
  });

  it("queues the resume below the disk watermark, and starts it once a report shows enough disk", async () => {
    await withFleet(async (arranged) => {
      const session = await startAndEndSession(arranged, "hello");
      reportDiskFree(arranged.wire, 4 * GIB);
      await waitUntil("stored the low reading", async () => {
        const response = await get(
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}`,
          arranged.token,
        );
        const runner = (await response.json()) as Runner;
        return runner.watermark?.diskFreeBytes === 4 * GIB ? runner : undefined;
      });

      const response = await sendInput(arranged, session.id, { text: "no room" });

      expect(response.status, await response.clone().text()).toBe(200);
      expect((await readSession(arranged, session.id)).status).toBe("queued");

      reportDiskFree(arranged.wire, 40 * GIB);

      await waitForSession(arranged, session.id, (one) => one.status === "starting");
      const sent = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2);
      expect(sent[1]!.sessionId).toBe(session.id);
    });
  });

  it("cancels the waiting input when the resumed process exits before it starts, and resumes again on the next input", async () => {
    await withFleet(async (arranged) => {
      const session = await startAndEndSession(arranged, "hello");
      const first = await sendInput(arranged, session.id, { text: "are you there" });
      expect(first.status, await first.clone().text()).toBe(200);
      const { inputId } = (await first.json()) as { inputId: string };
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2);
      await waitForSession(arranged, session.id, (one) => one.status === "starting");

      reportExited(arranged.wire, session.id, 3);

      const gone = await waitForSession(arranged, session.id, (one) => one.status === "exited");
      expect(gone.resumable).toBe(true);
      // `exitedAt` is the last exit, not the one before the resume.
      expect(Date.parse(gone.exitedAt!)).toBeGreaterThan(Date.parse(session.exitedAt!));
      const row = await waitUntil("cancelled the input", async () => {
        const found = (await listInputs(arranged, session.id)).find((one) => one.id === inputId);
        return found?.status === "cancelled" ? found : undefined;
      });
      expect(row.reason).toContain("exited (");
      // Nothing retries on its own: nobody asked for a second start.
      await waitToSettle();
      expect(listStartFrames(arranged.wire)).toHaveLength(2);

      const again = await sendInput(arranged, session.id, { text: "and now" });

      expect(again.status, await again.clone().text()).toBe(200);
      const sent = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 3);
      expect(sent[2]!.sessionId).toBe(session.id);
    });
  });

  it("accepts the resumed process's sequence numbers from the start, however far the stored stream got", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      await reportTranscript(arranged, session.id);
      await waitForSession(arranged, session.id, (one) => one.nativeSessionId !== null);
      await waitUntil("wrote the first turn", async () =>
        (await readStreamRows(arranged.harness, session.id)).some(
          (row) => row.tag === "turn.completed",
        )
          ? true
          : undefined,
      );
      reportExited(arranged.wire, session.id, 8);
      await waitForSession(arranged, session.id, (one) => one.status === "exited");
      // A runner that restarted numbers the session's events from one again.
      const again = await arranged.reconnect();
      await waitForFrames<ProbeRequest>(again, "probeRequest", 1);
      again.send({ _tag: "sessionsReport", sessions: [] });

      const response = await sendInput(arranged, session.id, { text: "after the restart" });
      expect(response.status, await response.clone().text()).toBe(200);
      await waitForFrames<SessionStart>(again, "sessionStart", 1);

      const base = { eventId: crypto.randomUUID(), sessionId: session.id, at };
      reportEvent(again, 1, { ...base, _tag: "session.started" });
      reportEvent(again, 2, { ...base, _tag: "turn.started", turnId: "t2" });
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      reportEvent(again, 3, {
        ...base,
        _tag: "content.delta",
        turnId: "t2",
        itemId: "i2",
        streamKind: "assistant_text",
        delta: "back",
      });
      reportEvent(again, 4, {
        ...base,
        _tag: "item.completed",
        turnId: "t2",
        itemId: "i2",
        kind: "assistant_message",
        status: "completed",
      });

      const page = await waitUntil("read the resumed turn back", async () => {
        const read = await get(
          arranged.harness.base,
          `/api/v1/sessions/${session.id}/transcript`,
          arranged.token,
        );
        expect(read.status, await read.clone().text()).toBe(200);
        const body = (await read.json()) as {
          items: ReadonlyArray<{ position: number; event: ProviderEvent }>;
        };
        return body.items.some(
          (row) => row.event._tag === "item.completed" && row.event.itemId === "i2",
        )
          ? body
          : undefined;
      });
      const delta = page.items.find(
        (row) => row.event._tag === "content.delta" && row.event.turnId === "t2",
      )!.event;
      expect(delta._tag === "content.delta" ? delta.delta : undefined).toBe("back");
    });
  });
});

describe("session.continue: the modes it takes", () => {
  it("forks a parent on mode fork, and rejects any other mode", async () => {
    await withFleet(async (arranged) => {
      const parent = await startAndEndSession(arranged, "hello");

      const forked = await continueSession(arranged, parent.id, {
        mode: "fork",
        prompt: "the other way",
      });
      expect(forked.status, await forked.clone().text()).toBe(200);

      // An exited session is resumed in place by its next input, so there is
      // no second way to ask for it here.
      const resumed = await continueSession(arranged, parent.id, {
        mode: "resume",
        prompt: "carry on",
      });

      expect(resumed.status, await resumed.clone().text()).toBe(400);
      expect((await parseRefusal(resumed)).code).toBe("validation");
    });
  });
});

/**
 * Approvals from the user's side: a runner reports a request the session is
 * waiting on, the request is stored on the session row the client already
 * refetches, and the user's answer is sent to the runner as one frame.
 * `session.respond` rejects every answer it cannot deliver:
 *
 * - an old request id;
 * - no open request at all;
 * - a decision the request does not offer;
 * - a session that has exited;
 * - a runner that is disconnected.
 */
const REQUEST_ID = "req-1";

const DECISIONS = ["allow", "allow_always", "deny", "cancel"] as const;

const respondToRequest = (arranged: Arranged, id: string, body: unknown): Promise<Response> =>
  post(arranged.harness.base, `/api/v1/sessions/${id}/respond`, body, arranged.token);

const listRespondFrames = (wire: Wire): ReadonlyArray<SessionRespondFrame> =>
  listFrames<SessionRespondFrame>(wire, "sessionRespond");

/**
 * Starts a session in a running turn, waiting on one open command approval.
 * The offered decisions are a parameter, because the test for a decision that
 * is not offered needs a request that offers fewer.
 */
const startParkedSession = async (
  arranged: Arranged,
  decisions: OpenRequest["decisions"] = DECISIONS,
): Promise<Session> => {
  const session = await startSession(arranged, "hello");
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "turn.started",
    turnId: "t1",
  });
  reportEvent(arranged.wire, 3, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "request.opened",
    request: {
      requestId: REQUEST_ID,
      itemId: "i1",
      kind: "command_approval",
      decisions,
      detail: { command: "ls -la" },
    },
  });
  return await waitForSession(
    arranged,
    session.id,
    (one) => one.openRequest?.requestId === REQUEST_ID,
  );
};

describe("session.respond", () => {
  it.each(DECISIONS)(
    "sends %s to the runner once, and leaves the request open until the runner resolves it",
    async (decision) => {
      await withFleet(async (arranged) => {
        const session = await startParkedSession(arranged);

        const response = await respondToRequest(arranged, session.id, {
          requestId: REQUEST_ID,
          decision,
        });

        expect(response.status, await response.clone().text()).toBe(200);
        const answered = (await response.json()) as Session;
        expect(answered.id).toBe(session.id);
        expect(answered.openRequest).toMatchObject({ requestId: REQUEST_ID });

        const sent = await waitForFrames<SessionRespondFrame>(arranged.wire, "sessionRespond", 1);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
          sessionId: session.id,
          requestId: REQUEST_ID,
          decision,
        });

        const entries = await arranged.harness.audit("session.responded");
        expect(entries).toHaveLength(1);
        expect(entries[0]?.actor).toBe("user");
      });
    },
  );

  it("clears the open request when the runner reports it resolved", async () => {
    await withFleet(async (arranged) => {
      const session = await startParkedSession(arranged);
      const response = await respondToRequest(arranged, session.id, {
        requestId: REQUEST_ID,
        decision: "allow",
      });
      expect(response.status, await response.clone().text()).toBe(200);
      await waitForFrames<SessionRespondFrame>(arranged.wire, "sessionRespond", 1);

      reportEvent(arranged.wire, 4, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "request.resolved",
        requestId: REQUEST_ID,
        decision: "allow",
      });

      const cleared = await waitForSession(arranged, session.id, (one) => one.openRequest === null);
      expect(cleared.openRequest).toBeNull();
    });
  });

  it("clears the open request when the runner reports it no longer has the session", async () => {
    await withFleet(async (arranged) => {
      const session = await startParkedSession(arranged);
      arranged.wire.close();
      await waitForRunnerGone(arranged);
      const again = await arranged.reconnect();
      again.send({ _tag: "sessionsReport", sessions: [] });

      const gone = await waitForSession(arranged, session.id, (one) => one.status === "exited");

      // No harness is waiting on the request any more, so an answer to it
      // could never be delivered. The request is cleared when its session
      // ends.
      expect(gone.openRequest).toBeNull();
    });
  });

  it("rejects a request id that is not the open one, and sends the runner nothing", async () => {
    await withFleet(async (arranged) => {
      const session = await startParkedSession(arranged);

      const response = await respondToRequest(arranged, session.id, {
        requestId: "req-somebody-else",
        decision: "allow",
      });

      expect(response.status, await response.clone().text()).toBe(409);
      expect((await parseRefusal(response)).code).toBe("invalid_state");
      await delay(250);
      expect(listRespondFrames(arranged.wire)).toEqual([]);
      // The request the session is really waiting on is untouched.
      expect((await readSession(arranged, session.id)).openRequest).toMatchObject({
        requestId: REQUEST_ID,
      });
      expect(await arranged.harness.audit("session.responded")).toHaveLength(0);
    });
  });

  it("rejects an answer to a session with no open request", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      expect(session.openRequest).toBeNull();

      const response = await respondToRequest(arranged, session.id, {
        requestId: REQUEST_ID,
        decision: "allow",
      });

      expect(response.status, await response.clone().text()).toBe(409);
      expect((await parseRefusal(response)).code).toBe("invalid_state");
      await delay(250);
      expect(listRespondFrames(arranged.wire)).toEqual([]);
      expect(await arranged.harness.audit("session.responded")).toHaveLength(0);
    });
  });

  it("rejects a decision the open request does not offer, and sends nothing", async () => {
    await withFleet(async (arranged) => {
      // A request that cannot store a rule does not offer `allow_always`. An
      // `allow_always` answer must not be silently turned into a plain allow.
      const session = await startParkedSession(arranged, ["allow", "deny", "cancel"]);

      const response = await respondToRequest(arranged, session.id, {
        requestId: REQUEST_ID,
        decision: "allow_always",
      });

      expect(response.status, await response.clone().text()).toBe(400);
      expect((await parseRefusal(response)).code).toBe("validation");
      await delay(250);
      expect(listRespondFrames(arranged.wire)).toEqual([]);
      expect(await arranged.harness.audit("session.responded")).toHaveLength(0);
      // The request stays open with its offered decisions, so the user can
      // still answer it properly.
      expect((await readSession(arranged, session.id)).openRequest).toMatchObject({
        decisions: ["allow", "deny", "cancel"],
      });
    });
  });

  it("rejects a session that has exited, and sends the runner nothing", async () => {
    await withFleet(async (arranged) => {
      const session = await startParkedSession(arranged);
      reportExited(arranged.wire, session.id, 4);
      await waitForSession(arranged, session.id, (one) => one.status === "exited");

      const response = await respondToRequest(arranged, session.id, {
        requestId: REQUEST_ID,
        decision: "deny",
      });

      expect(response.status, await response.clone().text()).toBe(409);
      expect((await parseRefusal(response)).code).toBe("invalid_state");
      await delay(250);
      expect(listRespondFrames(arranged.wire)).toEqual([]);
      expect(await arranged.harness.audit("session.responded")).toHaveLength(0);
    });
  });

  it("rejects the answer when the session's runner is disconnected", async () => {
    await withFleet(async (arranged) => {
      const session = await startParkedSession(arranged);
      arranged.wire.close();
      await waitForRunnerGone(arranged);

      const response = await respondToRequest(arranged, session.id, {
        requestId: REQUEST_ID,
        decision: "allow",
      });

      expect(response.status, await response.clone().text()).toBe(409);
      expect((await parseRefusal(response)).code).toBe("invalid_state");
      expect(listRespondFrames(arranged.wire)).toEqual([]);
      expect(await arranged.harness.audit("session.responded")).toHaveLength(0);
      // The answer was never delivered, so the question is still open.
      expect((await readApprovalNotifications(arranged, session.id))[0]?.status).toBe("open");
    });
  });
});

/**
 * The approval notification a request raises in the notification center. It
 * follows the request: raised when the session parks on it, resolved as
 * `decided` when the request is answered through the controller, and
 * withdrawn when the request stops waiting any other way.
 */
describe("session approval notifications", () => {
  it("raises one notification with the answers the request accepts when the session parks", async () => {
    await withFleet(async (arranged) => {
      const session = await startParkedSession(arranged);

      const notifications = await readApprovalNotifications(arranged, session.id);

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        title: "Run `ls -la`?",
        producer: { type: "core" },
        status: "open",
        subject: [
          { kind: "session", id: session.id },
          { kind: "request", sessionId: session.id, requestId: REQUEST_ID },
        ],
      });
      expect(
        notifications[0]?.actions.map((action) => [action.id, action.label, action.operation]),
      ).toEqual(
        [
          ["allow", "Allow", "allow"],
          ["allow-always", "Allow always", "allow_always"],
          ["deny", "Deny", "deny"],
          ["cancel", "Cancel", "cancel"],
        ].map(([id, label, decision]) => [
          id,
          label,
          {
            op: "session.respond",
            input: { sessionId: session.id, requestId: REQUEST_ID, decision },
          },
        ]),
      );
    });
  });

  it("resolves the notification as decided when the request is answered in the session view", async () => {
    await withFleet(async (arranged) => {
      const session = await startParkedSession(arranged);

      const response = await respondToRequest(arranged, session.id, {
        requestId: REQUEST_ID,
        decision: "allow_always",
      });
      expect(response.status, await response.clone().text()).toBe(200);

      // Resolved by the answer itself, before the runner reports anything.
      const [decided] = await readApprovalNotifications(arranged, session.id);
      expect(decided).toMatchObject({
        status: "resolved",
        resolution: { kind: "decided", actionId: "allow-always", actor: "user", origin: "web" },
      });

      // The runner's report that the request is resolved comes after the
      // answer, and leaves the notification as it was.
      reportEvent(arranged.wire, 4, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "request.resolved",
        requestId: REQUEST_ID,
        decision: "allow_always",
      });
      await waitForSession(arranged, session.id, (one) => one.openRequest === null);
      expect(await readApprovalNotifications(arranged, session.id)).toEqual([decided]);
    });
  });

  it("refuses a second answer to a request, and sends the runner only the first", async () => {
    await withFleet(async (arranged) => {
      const session = await startParkedSession(arranged);
      const first = await respondToRequest(arranged, session.id, {
        requestId: REQUEST_ID,
        decision: "allow",
      });
      expect(first.status, await first.clone().text()).toBe(200);

      // The runner has not reported the request resolved yet, so the session
      // still shows it open.
      const second = await respondToRequest(arranged, session.id, {
        requestId: REQUEST_ID,
        decision: "deny",
      });

      expect(second.status, await second.clone().text()).toBe(409);
      expect(await readErrorBody(second)).toMatchObject({
        code: "invalid_state",
        message:
          "that request was already answered, so this answer was not sent; " +
          "read the session again to see whether it is waiting on a request now",
      });
      await delay(250);
      expect(listRespondFrames(arranged.wire).map((frame) => frame.decision)).toEqual(["allow"]);
      expect(await arranged.harness.audit("session.responded")).toHaveLength(1);
    });
  });

  it("refuses an answer after the user interrupted the turn, and sends the runner nothing", async () => {
    await withFleet(async (arranged) => {
      const session = await startParkedSession(arranged);
      const interrupted = await interruptSession(arranged, session.id);
      expect(interrupted.status, await interrupted.clone().text()).toBe(200);

      // The runner has not reported the turn's end yet, so the session still
      // shows the request open.
      const response = await respondToRequest(arranged, session.id, {
        requestId: REQUEST_ID,
        decision: "allow",
      });

      expect(response.status, await response.clone().text()).toBe(409);
      expect(await readErrorBody(response)).toMatchObject({
        code: "invalid_state",
        message:
          "that request no longer waits for an answer: the turn was interrupted, the session was stopped, " +
          "or the harness moved on, so this answer was not sent; " +
          "read the session again to see whether it is waiting on a request now",
      });
      await delay(250);
      expect(listRespondFrames(arranged.wire)).toEqual([]);
      expect(await arranged.harness.audit("session.responded")).toEqual([]);
    });
  });

  it("withdraws the notification when the harness settles the request without an answer", async () => {
    await withFleet(async (arranged) => {
      const session = await startParkedSession(arranged);

      reportEvent(arranged.wire, 4, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "request.resolved",
        requestId: REQUEST_ID,
        decision: "deny",
      });

      expect(
        (await waitForResolvedApprovalNotification(arranged, session.id)).resolution,
      ).toMatchObject({
        kind: "withdrawn",
        origin: "core",
        reason: "The harness settled the request without this answer.",
      });
    });
  });

  it("withdraws the notification when the turn ends", async () => {
    await withFleet(async (arranged) => {
      const session = await startParkedSession(arranged);

      reportEvent(arranged.wire, 4, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "turn.completed",
        turnId: "t1",
        state: "interrupted",
      });

      expect(
        (await waitForResolvedApprovalNotification(arranged, session.id)).resolution,
      ).toMatchObject({
        kind: "withdrawn",
        reason: "The turn ended before the request was answered.",
      });
    });
  });

  it("withdraws the notification when the session exits", async () => {
    await withFleet(async (arranged) => {
      const session = await startParkedSession(arranged);

      reportExited(arranged.wire, session.id, 4);

      expect(
        (await waitForResolvedApprovalNotification(arranged, session.id)).resolution,
      ).toMatchObject({
        kind: "withdrawn",
        reason: "The session ended before the request was answered.",
      });
    });
  });

  it("withdraws the notification when the runner no longer has the session", async () => {
    await withFleet(async (arranged) => {
      const session = await startParkedSession(arranged);
      arranged.wire.close();
      await waitForRunnerGone(arranged);
      const again = await arranged.reconnect();
      again.send({ _tag: "sessionsReport", sessions: [] });

      expect(
        (await waitForResolvedApprovalNotification(arranged, session.id)).resolution,
      ).toMatchObject({
        kind: "withdrawn",
        reason: "The session ended before the request was answered.",
      });
    });
  });

  it("raises no notification for a question", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      reportEvent(arranged.wire, 2, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "request.opened",
        request: {
          requestId: REQUEST_ID,
          itemId: "i1",
          kind: "question",
          decisions: ["cancel"],
          detail: {
            questions: [
              { question: "Which one?", header: "Pick", options: [], multiSelect: false },
            ],
          },
        },
      });
      await waitForSession(arranged, session.id, (one) => one.openRequest !== null);

      expect(await readApprovalNotifications(arranged, session.id)).toEqual([]);
    });
  });
});

/**
 * Spawning into a workspace.
 *
 * A spawn names the project the thread belongs to and the workspace it wants:
 *
 * - the repo's main workspace;
 * - a new worktree of its own;
 * - an existing workspace.
 *
 * The session waits in `queued` while a runner creates the workspace. Git
 * terms such as branch belong to checkouts; a workspace is a kind and a list
 * of checkouts.
 */
type WorkspaceFrame = { readonly _tag: string } & Record<string, unknown>;

const listFramesTagged = (wire: Wire, tag: string): ReadonlyArray<WorkspaceFrame> =>
  (wire.frames as ReadonlyArray<WorkspaceFrame>).filter((frame) => frame._tag === tag);

const waitForFrameTagged = (wire: Wire, tag: string, index = 0): Promise<WorkspaceFrame> =>
  waitUntil(`sent ${String(index + 1)} ${tag} frames`, () => listFramesTagged(wire, tag)[index]);

interface CheckoutRow {
  readonly checkoutId?: string;
  readonly id?: string;
  readonly resourceId: string;
  readonly form: string;
  readonly subdirectory: string | null;
  readonly branch: string | null;
}

interface WorkspaceRow {
  readonly id: string;
  readonly runnerId: string;
  readonly kind: string;
  readonly status: string;
  readonly checkouts: ReadonlyArray<CheckoutRow>;
}

const makeProject = async (arranged: Arranged, name: string): Promise<string> => {
  const response = await post(arranged.harness.base, "/api/v1/projects", { name }, arranged.token);
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return ((await response.json()) as { id: string }).id;
};

const makeRepo = async (
  arranged: Arranged,
  remote: string,
  projectIds?: ReadonlyArray<string>,
): Promise<string> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/resources",
    { kind: "repo", remote, ...(projectIds === undefined ? {} : { projectIds }) },
    arranged.token,
  );
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return ((await response.json()) as { id: string }).id;
};

const readWorkspace = async (arranged: Arranged, id: string): Promise<WorkspaceRow> => {
  const response = await get(arranged.harness.base, `/api/v1/workspaces/${id}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as WorkspaceRow;
};

/** Reads the session's project id, which is not in the contract's `Session` type yet. */
const readProjectId = (session: Session): string | null =>
  (session as unknown as { readonly projectId?: string | null }).projectId ?? null;

/** Reports the workspace as ready from the runner, so dispatch can start the session. */
const reportWorkspaceReady = (arranged: Arranged, workspace: WorkspaceRow): void =>
  arranged.wire.send({
    _tag: "workspaceReport",
    workspaceId: workspace.id,
    status: "ready",
    checkouts: workspace.checkouts.map((checkout) => ({
      checkoutId: checkout.checkoutId ?? checkout.id,
      branch: checkout.branch ?? "main",
      branches: ["main"],
      defaultBranch: "main",
    })),
  } as never);

/**
 * `session.respond`, `session.interrupt` and `session.stop` send their frame
 * once their transaction commits. `notification.act` runs them inside its own
 * transaction, so the frame has to wait for that commit, and must never be
 * sent when it rolls back.
 */
describe("a frame whose caller's transaction rolls back", () => {
  /** Runs `operation` as the user, in a transaction that then fails. */
  const runThenRollBack = (
    arranged: Arranged,
    operation: (live: Live["Service"]) => Effect.Effect<unknown, unknown>,
  ) =>
    arranged.harness.runWithLiveSessions(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const live = yield* Live;
        yield* withTransaction(
          sql,
          Effect.andThen(
            operation(live),
            Effect.fail("a later write in the caller's transaction failed"),
          ),
        );
      }),
    );

  it("sends no answer and records none, so the request can still be answered", async () => {
    await withFleet(async (arranged) => {
      const session = await startParkedSession(arranged);

      const exit = await runThenRollBack(arranged, (live) =>
        live.respond({ id: session.id, requestId: REQUEST_ID, decision: "allow" }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      await delay(250);
      expect(listRespondFrames(arranged.wire)).toEqual([]);
      expect(await arranged.harness.audit("session.responded")).toEqual([]);
      const [notification] = await readApprovalNotifications(arranged, session.id);
      expect(notification?.status).toBe("open");

      const retried = await respondToRequest(arranged, session.id, {
        requestId: REQUEST_ID,
        decision: "allow",
      });
      expect(retried.status, await retried.clone().text()).toBe(200);
      await waitForFrames<SessionRespondFrame>(arranged.wire, "sessionRespond", 1);
    });
  });

  it("sends no interrupt and records none", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");

      const exit = await runThenRollBack(arranged, (live) => live.interrupt(session.id));

      expect(Exit.isFailure(exit)).toBe(true);
      await delay(250);
      expect(listFrames<SessionInterruptFrame>(arranged.wire, "sessionInterrupt")).toEqual([]);
      expect(await arranged.harness.audit("session.interrupted")).toEqual([]);
    });
  });

  it("sends no stop and records none", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");

      const exit = await runThenRollBack(arranged, (live) => live.stop(session.id));

      expect(Exit.isFailure(exit)).toBe(true);
      await delay(250);
      expect(listFrames<SessionStopFrame>(arranged.wire, "sessionStop")).toEqual([]);
      expect(await arranged.harness.audit("session.stopped")).toEqual([]);
    });
  });
});

describe("session.spawn into a workspace", () => {
  it("gives a thread its own worktree of one repo, on a branch named after it", async () => {
    await withFleet(async (arranged) => {
      const hercule = await makeProject(arranged, "Hercule");
      const web = await makeRepo(arranged, "https://github.com/acme/web", [hercule]);

      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        projectId: hercule,
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });

      // The runner has not created it yet, so the session waits rather than starting.
      expect(session.status).toBe("queued");
      expect(session.workspaceId).not.toBeNull();
      expect(readProjectId(session)).toBe(hercule);
      expect(listFramesTagged(arranged.wire, "sessionStart")).toEqual([]);

      const workspace = await readWorkspace(arranged, String(session.workspaceId));
      expect(workspace.kind).toBe("ephemeral");
      expect(workspace.runnerId).toBe(arranged.runnerId);
      expect(workspace.checkouts).toHaveLength(1);
      expect(workspace.checkouts[0]).toMatchObject({
        resourceId: web,
        form: "worktree",
        subdirectory: null,
        branch: `hercule/thread-${session.id.slice(-8)}`,
      });

      const frame = await waitForFrameTagged(arranged.wire, "workspaceProvision");
      expect(frame["workspaceId"]).toBe(workspace.id);
      expect(frame["kind"]).toBe("ephemeral");

      // A workspace created by a spawn was created by the user, so the event
      // log records it, the same way `workspace.provision` does.
      const log = (await (
        await get(arranged.harness.base, "/api/v1/events", arranged.token)
      ).json()) as {
        items: ReadonlyArray<{
          kind: string;
          actor: string | null;
          payload: Record<string, unknown>;
        }>;
      };
      const made = log.items.filter((entry) => entry.kind === "workspace.created");
      expect(made).toHaveLength(1);
      expect(made[0]?.actor).toBe("user");
      expect(made[0]?.payload).toMatchObject({
        workspaceId: workspace.id,
        runnerId: arranged.runnerId,
        kind: "ephemeral",
        resourceIds: [web],
      });

      reportWorkspaceReady(arranged, workspace);
      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      expect(start.sessionId).toBe(session.id);
      expect(start.spec.workspaceId).toBe(workspace.id);

      // Both are stored on the session the API returns afterwards.
      const read = await readSession(arranged, session.id);
      expect(read.workspaceId).toBe(workspace.id);
      expect(readProjectId(read)).toBe(hercule);
      const listed = (await listSessions(arranged)).find((one) => one.id === session.id);
      expect(listed?.workspaceId).toBe(workspace.id);
      expect(readProjectId(listed!)).toBe(hercule);
    });
  });

  it("puts each repo of a multi-repo workspace in a subdirectory of its own", async () => {
    await withFleet(async (arranged) => {
      const web = await makeRepo(arranged, "https://github.com/acme/web");
      const api = await makeRepo(arranged, "https://github.com/acme/api");

      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: {
          kind: "ephemeral",
          checkouts: [{ resourceId: web }, { resourceId: api, baseBranch: "develop" }],
        },
      });

      const workspace = await readWorkspace(arranged, String(session.workspaceId));
      const branch = `hercule/thread-${session.id.slice(-8)}`;
      expect(workspace.checkouts).toHaveLength(2);
      expect(workspace.checkouts.map((one) => one.subdirectory)).toEqual(["web", "api"]);
      expect(workspace.checkouts.map((one) => one.branch)).toEqual([branch, branch]);
    });
  });

  it("puts a repo whose name begins with a dot in its own subdirectory, like the others", async () => {
    await withFleet(async (arranged) => {
      // A real repository name, and a valid directory name: only `.`, `..` and
      // `.git` cannot be used as the directory.
      const meta = await makeRepo(arranged, "https://github.com/acme/.github");
      const web = await makeRepo(arranged, "https://github.com/acme/web");

      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: meta }, { resourceId: web }] },
      });

      const workspace = await readWorkspace(arranged, String(session.workspaceId));
      expect(workspace.checkouts.map((one) => one.subdirectory)).toEqual([".github", "web"]);
      // The runner receives the frame; it does not fail to encode.
      const frame = await waitForFrameTagged(arranged.wire, "workspaceProvision");
      expect(
        (frame["checkouts"] as ReadonlyArray<CheckoutRow>).map((one) => one.subdirectory),
      ).toEqual([".github", "web"]);
    });
  });

  it("creates a scratch workspace from an empty list of checkouts", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [] },
      });

      const workspace = await readWorkspace(arranged, String(session.workspaceId));
      expect(workspace.kind).toBe("ephemeral");
      expect(workspace.checkouts).toEqual([]);
    });
  });

  it("clones a primary workspace when the runner has none, and reuses the one it has", async () => {
    await withFleet(async (arranged) => {
      const web = await makeRepo(arranged, "https://github.com/acme/web");

      const first = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "primary", resourceId: web },
      });
      const workspace = await readWorkspace(arranged, String(first.workspaceId));
      expect(workspace.kind).toBe("primary");

      const frame = await waitForFrameTagged(arranged.wire, "workspaceProvision");
      expect(frame["kind"]).toBe("primary");
      const checkouts = frame["checkouts"] as ReadonlyArray<Record<string, unknown>>;
      // Cloned new: a spawn never adopts an existing folder in place.
      expect(checkouts[0]?.["path"] ?? null).toBeNull();

      reportWorkspaceReady(arranged, workspace);
      await waitForSession(arranged, first.id, (one) => one.status !== "queued");

      // The second thread in the same repo on the same runner shares it, and
      // sends the runner no new provision request.
      const second = await spawnSessionOrFail(arranged, {
        prompt: "again",
        workspace: { kind: "primary", resourceId: web, branch: "feature/x" },
      });
      expect(second.workspaceId).toBe(workspace.id);

      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2))[1]!;
      expect(start.sessionId).toBe(second.id);
      // Counted after the second start frame arrived: any frame the second
      // spawn sent to the runner would have arrived before it.
      expect(listFramesTagged(arranged.wire, "workspaceProvision")).toHaveLength(1);
      // The branch belongs to the checkout. It is sent on the start frame, so
      // the runner switches branch before the harness sees the folder.
      expect((start as unknown as WorkspaceFrame)["checkoutBranch"]).toBe("feature/x");
    });
  });

  /**
   * The chosen branch is used only once. The runner switches the main
   * workspace to that branch before this thread first runs. If a resume sent
   * it again, it would switch the branch under whatever the user has done in
   * that checkout since the thread last ran.
   */
  it("sends the chosen branch once, and not again when the thread is resumed", async () => {
    await withFleet(async (arranged) => {
      const web = await makeRepo(arranged, "https://github.com/acme/web");
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "primary", resourceId: web, branch: "feature/x" },
      });
      const workspace = await readWorkspace(arranged, String(session.workspaceId));
      reportWorkspaceReady(arranged, workspace);

      const first = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      expect((first as unknown as WorkspaceFrame)["checkoutBranch"]).toBe("feature/x");

      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
      });
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      await endSession(arranged, session, 2);

      const response = await sendInput(arranged, session.id, { text: "still there?" });
      expect(response.status, await response.clone().text()).toBe(200);

      const again = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2))[1]!;
      expect(again.sessionId).toBe(session.id);
      expect(again.spec.continue).toEqual({ nativeSessionId: "native-1", mode: "resume" });
      // The row still records the branch the thread started on, as history,
      // but the runner is not told to switch again.
      expect((again as unknown as WorkspaceFrame)["checkoutBranch"] ?? null).toBeNull();
    });
  });

  it("places a thread joining an existing workspace on that workspace's runner, and rejects another runner", async () => {
    await withFleet(async (arranged) => {
      const other = await arranged.enlist();
      const web = await makeRepo(arranged, "https://github.com/acme/web");
      const first = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspace = await readWorkspace(arranged, String(first.workspaceId));

      // Still provisioning: a thread may not join a workspace that is not ready.
      const early = await spawnSession(arranged, {
        prompt: "join",
        workspace: { kind: "existing", workspaceId: workspace.id },
      });
      expect((await parseRefusal(early)).code).toBe("invalid_state");

      reportWorkspaceReady(arranged, workspace);
      await waitForSession(arranged, first.id, (one) => one.status !== "queued");

      const clash = await spawnSession(arranged, {
        prompt: "join",
        workspace: { kind: "existing", workspaceId: workspace.id },
        runnerId: other.runnerId,
      });
      expect((await parseRefusal(clash)).code).toBe("validation");

      const joined = await spawnSessionOrFail(arranged, {
        prompt: "join",
        workspace: { kind: "existing", workspaceId: workspace.id },
      });
      expect(joined.workspaceId).toBe(workspace.id);
      expect(joined.runnerId).toBe(workspace.runnerId);
    });
  });

  it("rejects a project the repo does not belong to", async () => {
    await withFleet(async (arranged) => {
      const hercule = await makeProject(arranged, "Hercule");
      const side = await makeProject(arranged, "Side");
      const web = await makeRepo(arranged, "https://github.com/acme/web", [hercule]);

      const response = await spawnSession(arranged, {
        prompt: "hello",
        projectId: side,
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      expect((await parseRefusal(response)).code).toBe("validation");
      expect(await listSessions(arranged)).toEqual([]);
    });
  });

  /**
   * Joining a workspace is not a way around the project's repo list. An
   * existing workspace is still a set of repos. A thread in one project must
   * not reach a repo of another project, even if somebody else already
   * created a workspace that holds that repo.
   */
  it("rejects joining an existing workspace whose repos are not in the project", async () => {
    await withFleet(async (arranged) => {
      const hercule = await makeProject(arranged, "Hercule");
      const side = await makeProject(arranged, "Side");
      const web = await makeRepo(arranged, "https://github.com/acme/web", [hercule]);
      const first = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        projectId: hercule,
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspace = await readWorkspace(arranged, String(first.workspaceId));
      reportWorkspaceReady(arranged, workspace);
      await waitForSession(arranged, first.id, (one) => one.status !== "queued");

      const response = await spawnSession(arranged, {
        prompt: "again",
        projectId: side,
        workspace: { kind: "existing", workspaceId: workspace.id },
      });
      expect((await parseRefusal(response)).code).toBe("validation");

      // The same workspace can still be joined from its own project.
      const joined = await spawnSessionOrFail(arranged, {
        prompt: "again",
        projectId: hercule,
        workspace: { kind: "existing", workspaceId: workspace.id },
      });
      expect(joined.workspaceId).toBe(workspace.id);
    });
  });

  /**
   * A fork inherits its parent's workspace and project, and `openFor` checks
   * that the repos in that workspace belong to that project, as for any other
   * spawn. So a repo that has left the project since then stops the fork, with
   * the same error a new spawn would get. That is intended: the project's repo
   * list decides which repos a thread may reach, and a fork is a new thread.
   */
  it("rejects a fork whose parent's repo has left the project", async () => {
    await withFleet(async (arranged) => {
      const hercule = await makeProject(arranged, "Hercule");
      const web = await makeRepo(arranged, "https://github.com/acme/web", [hercule]);
      const parent = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        projectId: hercule,
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspace = await readWorkspace(arranged, String(parent.workspaceId));
      reportWorkspaceReady(arranged, workspace);
      await waitForSession(arranged, parent.id, (one) => one.status !== "queued");
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: parent.id,
        at,
        _tag: "session.started",
      });
      await waitForSession(arranged, parent.id, (one) => one.status === "busy");
      await endSession(arranged, parent, 2);

      // The repo no longer belongs to any project.
      const moved = await send("PATCH", arranged.harness.base, `/api/v1/resources/${web}`, {
        body: { projectIds: [] },
        token: arranged.token,
      });
      expect(moved.status, await moved.clone().text()).toBe(200);

      const response = await continueSession(arranged, parent.id, {
        mode: "fork",
        prompt: "branch off",
      });
      expect((await parseRefusal(response)).code).toBe("validation");
    });
  });

  it("ends the session when the runner could not create its workspace", async () => {
    await withFleet(async (arranged) => {
      const web = await makeRepo(arranged, "https://github.com/acme/web");
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspaceId = String(session.workspaceId);
      await waitForFrameTagged(arranged.wire, "workspaceProvision");

      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId,
        status: "failed",
        message: "fatal: could not read from remote repository",
      } as never);

      await waitForSession(arranged, session.id, (one) => one.status === "exited");
      const stream = await readStreamRows(arranged.harness, session.id);
      const exit = stream.find((row) => row.tag === "session.exited");
      expect(exit, "the session never reported an exit").toBeDefined();
      expect(exit!.event).toContain("workspace_failed");
      expect(exit!.event).toContain("could not read from remote repository");
      // The session never started, so the runner never got a start frame.
      expect(listFramesTagged(arranged.wire, "sessionStart")).toEqual([]);
    });
  });

  it("creates a new primary workspace when the runner failed to create the last one, rather than joining it", async () => {
    await withFleet(async (arranged) => {
      const web = await makeRepo(arranged, "https://github.com/acme/web");
      const first = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "primary", resourceId: web },
      });
      const failed = String(first.workspaceId);
      await waitForFrameTagged(arranged.wire, "workspaceProvision");
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: failed,
        status: "failed",
        message: "fatal: could not read from remote repository",
      } as never);
      await waitForSession(arranged, first.id, (one) => one.status === "exited");

      // The next thread in that repo asks the runner again, rather than
      // joining a workspace that was never created and waiting forever.
      const second = await spawnSessionOrFail(arranged, {
        prompt: "again",
        workspace: { kind: "primary", resourceId: web },
      });
      expect(second.workspaceId).not.toBe(failed);
      // The frame is sent after the spawn's transaction commits, so the test
      // waits for the second frame before counting.
      const frame = await waitForFrameTagged(arranged.wire, "workspaceProvision", 1);
      expect(frame["workspaceId"]).toBe(second.workspaceId);
      expect(listFramesTagged(arranged.wire, "workspaceProvision")).toHaveLength(2);
    });
  });

  it("rejects one repo named twice, and two repos that would share a directory", async () => {
    await withFleet(async (arranged) => {
      const web = await makeRepo(arranged, "https://github.com/acme/web");
      const fork = await makeRepo(arranged, "https://github.com/other/web");

      const twice = await spawnSession(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }, { resourceId: web }] },
      });
      expect((await parseRefusal(twice)).code).toBe("validation");

      const sameName = await spawnSession(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }, { resourceId: fork }] },
      });
      expect((await parseRefusal(sameName)).code).toBe("validation");
      expect(await listSessions(arranged)).toEqual([]);
    });
  });

  it("rejects a project that does not exist, whatever else the spawn names", async () => {
    await withFleet(async (arranged) => {
      const response = await spawnSession(arranged, {
        prompt: "hello",
        projectId: "0199e0e7-9999-7000-8000-0000000000aa",
      });
      expect((await parseRefusal(response)).code).toBe("validation");
      expect(await listSessions(arranged)).toEqual([]);
    });
  });

  it("rejects resuming or forking a thread whose workspace has been disposed of", async () => {
    await withFleet(async (arranged) => {
      const web = await makeRepo(arranged, "https://github.com/acme/web");
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspace = await readWorkspace(arranged, String(session.workspaceId));
      reportWorkspaceReady(arranged, workspace);
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
      });
      const running = await waitForSession(arranged, session.id, (one) => one.status === "busy");
      const ended = await endSession(arranged, running, 2);
      expect(ended.resumable).toBe(true);

      const disposed = await send(
        "DELETE",
        arranged.harness.base,
        `/api/v1/workspaces/${workspace.id}`,
        { token: arranged.token },
      );
      expect([200, 204], await disposed.clone().text()).toContain(disposed.status);

      // The transcript is still on the runner, but the files the thread worked
      // on are gone, so there is nowhere to continue it.
      const read = await readSession(arranged, session.id);
      expect(read.resumable).toBe(false);

      const resumed = await post(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/input`,
        { text: "carry on" },
        arranged.token,
      );
      const refusedResume = await resumed.clone().text();
      expect((await parseRefusal(resumed)).code).toBe("invalid_state");
      expect(refusedResume).toContain("workspace");

      const forked = await continueSession(arranged, session.id, {
        mode: "fork",
        prompt: "carry on",
      });
      const refusedFork = await forked.clone().text();
      expect((await parseRefusal(forked)).code).toBe("invalid_state");
      expect(refusedFork).toContain("workspace");
    });
  });

  it("keeps the workspace and the project when a thread is forked", async () => {
    await withFleet(async (arranged) => {
      const hercule = await makeProject(arranged, "Hercule");
      const web = await makeRepo(arranged, "https://github.com/acme/web", [hercule]);
      const parent = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        projectId: hercule,
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspace = await readWorkspace(arranged, String(parent.workspaceId));
      reportWorkspaceReady(arranged, workspace);
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: parent.id,
        at,
        _tag: "session.started",
      });
      const running = await waitForSession(arranged, parent.id, (one) => one.status === "busy");
      const ended = await endSession(arranged, running, 2);

      const response = await continueSession(arranged, ended.id, {
        mode: "fork",
        prompt: "carry on",
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const fork = (await response.json()) as Session;
      expect(fork.id).not.toBe(ended.id);
      expect(fork.workspaceId).toBe(workspace.id);
      expect(readProjectId(fork)).toBe(hercule);
    });
  });
});
