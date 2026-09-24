/**
 * A session end to end: the user spawns one over HTTP, a machine on the real
 * runner socket is told to start it, and what that machine reports comes back
 * as rows and as a status the user can read.
 *
 * The runner here is hand-written and drives its own frames, because the point
 * of the ingest is the wire: what is asserted is what a real machine could
 * actually send. It answers every probe so the controller has a capability
 * snapshot to place against, and then reports a realistic turn - started, a
 * turn, deltas, an item, usage, a completion, an exit - including one sequence
 * number sent twice.
 *
 * Spawning writes the row the runner is then told about, with both access modes
 * on it where the fallback moved one. The status axis follows the events. The
 * stream holds one coalesced row per item rather than one per delta, and every
 * other event verbatim, and a sequence number the controller has already
 * applied writes nothing however many times it arrives. Input is stored before
 * it is sent, is answered with what the machine reported it did, and what could
 * not be sent yet waits in the session's queue until it moves back to idle.
 */
import { describe, expect, it, vi } from "vitest";
import { Duration, Effect, Fiber } from "effect";
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
  send,
  waitForLiveToSettle,
  fetchTicket,
  waitWithin,
  type Collected,
  type ServerHarness,
} from "../http/testing";
import { createPluginFixture, buildProviderDefinition } from "../plugins/testing";
import {
  listFrames,
  waitForFrames,
  reportEvent,
  spawnSession,
  spawnSessionOrFail,
  waitUntil,
  WAIT_DEADLINE_MS,
  withFleet as sharedWithFleet,
  type Arranged,
  type Wire,
} from "./testing";

/** Everything native: the instance a plain spawn lands on. */
const FULL = buildProviderDefinition("full-provider", { token: "t" });

/** The fallback's subject: it stops at `auto-accept-edits`. */
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
 * A provider that declares no access mode at all: the floor of the fallback,
 * where even `approval-required` is not native and there is nothing below the
 * request to substitute.
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
 * Two models that do not offer the same choices: `clever` takes an effort of
 * three and a switch, `fast` takes an effort of two and nothing else. What the
 * pair is for is the case a single model cannot show - a pick that is valid on
 * one model and unknown on the other.
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
 * Four, because the longest case here waits for the fleet to be probed and then
 * for three moves of its own: a test whose waits can outlast the timeout never
 * gets to give up, and the failure names the test rather than the move that
 * never came. The slack is for the dial and the HTTP round trips between them.
 */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 4 + 10_000 });

/**
 * How long the controller here waits for a machine to say what it did with an
 * input. The shipped ten seconds is longer than a test can sit through, and one
 * case below has to watch it give up.
 */
const INPUT_DEADLINE = Duration.seconds(2);

/**
 * Longer than any case here runs, so the pipeline never ticks: what the case
 * then sees is its own request's work and nothing else's. A case that watches
 * a row go back to waiting needs it, because the tick sends a waiting row
 * again as soon as the session can take it.
 */
const NO_TICK = Duration.hours(1);

/** A controller with one enlisted, connected, logged-in machine on it, on this suite's own fleet. */
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

/** One refusal, read as the code it carries and the fields its issues name. */
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

/** The sessions the controller holds, which after a refused spawn must be none. */
const listSessions = async (arranged: Arranged): Promise<ReadonlyArray<Session>> => {
  const listing = await get(arranged.harness.base, "/api/v1/sessions", arranged.token);
  expect(listing.status, await listing.clone().text()).toBe(200);
  return ((await listing.json()) as { items: ReadonlyArray<Session> }).items;
};

/** The session once it reads the way the test is waiting for. */
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

/** The events one ordinary turn leaves behind, with the sequence each rides on. */
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

/** One stored input, as the API hands it back. */
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
  /** Set while the frame is out and unanswered; null once answered or never sent. */
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

/** The session, started and idle, with the prompt's own input frame answered. */
const startSession = async (arranged: Arranged, prompt: string): Promise<Session> => {
  const session = await spawnSessionOrFail(arranged, { prompt });
  await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.started",
  });
  await waitForSession(arranged, session.id, (one) => one.status === "idle");
  // The prompt's turn is opened after the transaction that set idle committed,
  // so the status is not evidence that its frame was written - and every count
  // of input frames below is taken relative to this one.
  await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);
  return session;
};

const listInputFrames = (wire: Wire): ReadonlyArray<SessionInput> =>
  listFrames<SessionInput>(wire, "sessionInput");

/**
 * Waits until the controller has noticed the machine's socket go. The runner
 * reading anything but online is what says the connection map has let it go,
 * which is what makes a delivery fail for that reason rather than for a race.
 */
const waitForRunnerGone = (arranged: Arranged): Promise<Runner> =>
  waitUntil("saw the machine go", async () => {
    const response = await get(
      arranged.harness.base,
      `/api/v1/runners/${arranged.runnerId}`,
      arranged.token,
    );
    const runner = (await response.json()) as Runner;
    return runner.connectivity === "online" ? undefined : runner;
  });

const reportExited = (wire: Wire, sessionId: string, seq: number): void =>
  reportEvent(wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "session.exited",
    reason: "stopped",
  });

/** A session ended the way a machine ends one, with its native id on the row. */
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

/** The parent a continue asks for: exited, resumable, native id bound. */
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
  it("builds a thread from the shipped defaults and tells the machine to start it", async () => {
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
        // Neither settings key is set, so the shipped defaults ride the spec.
        timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
      });
    });
  });

  it("stores the spec byte for byte as the frame carries it", async () => {
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

  it("substitutes the nearest less permissive mode, and says both on the record", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        instanceId: findInstanceId(arranged, "limited-provider"),
        accessMode: "auto",
      });

      expect(session.requestedAccessMode).toBe("auto");
      expect(session.accessMode).toBe("auto-accept-edits");
      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      // The runner is told the mode it will really run, never the request.
      expect(start.spec.accessMode).toBe("auto-accept-edits");
    });
  });

  it("refuses the spawn where the provider supports no mode at or below the request", async () => {
    await withFleet(async (arranged) => {
      const response = await spawnSession(arranged, {
        prompt: "hello",
        instanceId: findInstanceId(arranged, "bare-provider"),
        accessMode: "auto",
      });

      const said = await response.clone().text();
      expect(response.status, said).toBe(409);
      expect((await parseRefusal(response)).code).toBe("invalid_state");
      // The refusal names what was asked for and who could not give it, so the
      // user is never left guessing which of the two to change.
      expect(said).toContain("auto");
      expect(said).toContain("Provider bare-provider");
      // Nothing was substituted and nothing was started.
      expect(await listSessions(arranged)).toEqual([]);
      await delay(250);
      expect(listFrames<SessionStart>(arranged.wire, "sessionStart")).toEqual([]);
    });
  });

  it("never falls back onto a reserved machine", async () => {
    await withFleet(async (arranged) => {
      // Reserved is set on the row rather than through `runner.update`, which
      // refuses to reserve the fleet's default - and the one machine here is it.
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
      // The session's current model rides every frame, starting as the spec's.
      expect(input.input).toEqual({
        text: "what is the time",
        modelSelection: session.modelSelection,
      });
    });
  });
});

/**
 * The model options a spawn picks: validated against the snapshot the placement
 * resolved, stored on the row, and carried on both frames the session's start
 * writes.
 */
describe("session.spawn: the model options a call picks", () => {
  it("stores the picks and carries them on the start frame and the first input frame", async () => {
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

  it("stores no options at all when the call picks none", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello", model: "clever" });

      expect(session.modelSelection).toEqual({ model: "clever", options: {} });
    });
  });

  // One refusal is enough here: what makes a pick wrong is `options.test.ts`'s
  // to cover, and what this proves is the wiring - the placed machine's catalog
  // is what the call is judged against, and a refusal spawns nothing at all.
  it("refuses a value the placed machine's catalog does not offer, and spawns nothing", async () => {
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
 * Naming a runner or a profile is for this one call: the tests above cover
 * what a caller gets by naming neither.
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

  it("honours an explicit runnerId even when that runner is reserved", async () => {
    await withFleet(async (arranged) => {
      // Reserved is set on the row rather than through `runner.update`, which
      // refuses to reserve the fleet's default - and the one machine here is it.
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

  it("refuses a named runner that is draining, and says that is why", async () => {
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

  it("refuses a named runner that is retired, and says that - not draining", async () => {
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

  it("refuses a named runner that is online but not logged in to the instance, and says that is why", async () => {
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

  it("treats a runnerId naming no runner as validation, not a state conflict", async () => {
    await withFleet(async (arranged) => {
      const response = await spawnSession(arranged, {
        prompt: "hello",
        runnerId: "0199e0e7-9999-7000-8000-000000000000",
      });

      expect(response.status, await response.clone().text()).toBe(400);
    });
  });

  it("puts the session under the profile an explicit permissionProfileId names", async () => {
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

  it("fails validation on a permissionProfileId naming no profile", async () => {
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
describe("session.spawn: the title a prompt leaves on the session", () => {
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

  it("carries the title on the sessions list, not only on a single read", async () => {
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

describe("what a machine reports", () => {
  it("moves the status axis, coalesces the deltas, and ignores a sequence sent twice", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      const events = buildTranscript(session.id);

      reportEvent(arranged.wire, ...events[0]!);
      expect(
        (await waitForSession(arranged, session.id, (one) => one.status === "idle")).startedAt,
      ).not.toBeNull();

      reportEvent(arranged.wire, ...events[1]!);
      await waitForSession(arranged, session.id, (one) => one.status === "busy");

      for (const [seq, event] of events.slice(2, 6)) reportEvent(arranged.wire, seq, event);
      // The same frame again, as a replay after a reconnect would send it, and
      // ahead of the completion the test then waits for: frames off one socket
      // are handled in order, so a session reading idle is one whose replay has
      // already been dealt with. Behind it, the wait would prove nothing.
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
      // Idempotent on the runner's own sequence: the replayed frame is not here.
      expect(rows.map((row) => row.runner_seq)).toEqual([1, 2, 4, 5, 6, 7]);
      const coalesced = rows.find((row) => row.tag === "content.delta");
      expect((JSON.parse(coalesced!.event) as { delta: string }).delta).toBe("Hello");
    });
  });

  it("records the native id the harness came up under, with the move that says so", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });

      reportEvent(arranged.wire, ...buildTranscript(session.id)[0]!);

      const bound = await waitForSession(arranged, session.id, (one) => one.status === "idle");
      // The id and the status it explains are written together, so a session
      // reading idle is never one whose binding has not landed yet.
      expect(bound.nativeSessionId).toBe("native-1");
    });
  });

  it("records the native id a sessions report carries, for a session already up", async () => {
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

  it("ends the session, and an ended one whose machine still holds it is resumable", async () => {
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

  it("ignores a machine reporting about a session that is not placed on it", async () => {
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
      // A second session, on the machine that really holds it, reported behind
      // the first. Frames are read off one socket in order, so this one landing
      // is what says the one before it has been dealt with - and waiting out a
      // clock would only say the controller had not got to it yet.
      const mine = await spawnSessionOrFail(arranged, { prompt: "hello" });
      reportEvent(arranged.wire, 2, {
        eventId: crypto.randomUUID(),
        sessionId: mine.id,
        at,
        _tag: "session.started",
      });
      await waitForSession(arranged, mine.id, (one) => one.status === "idle");

      expect(await readStreamRows(arranged.harness, session.id)).toEqual([]);
      expect((await readSession(arranged, session.id)).status).toBe("starting");
    });
  });
});

describe("session.input", () => {
  it("leaves the row queued, with a message, when an idle session's machine is gone", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      arranged.wire.close();
      await waitForRunnerGone(arranged);

      const response = await sendInput(arranged, session.id, { text: "into the void" });

      expect(response.status).toBe(409);
      // A refused or unanswered delivery is not the user's own cancel: the row
      // stays visible, with the reason on it, for the next input to open a
      // turn to bring the boundary that tries it again.
      const row = (await listInputs(arranged, session.id)).at(-1);
      expect(row).toMatchObject({ text: "into the void", status: "queued", delivery: null });
      expect(row!.sentAt).toBeNull();
      expect(typeof row!.reason).toBe("string");
    });
  });

  it("leaves the row queued, with a message, when an idle session's machine never answers", async () => {
    await withFleet(
      async (arranged) => {
        const session = await startSession(arranged, "hello");
        arranged.wire.answering(() => undefined);

        const response = await sendInput(arranged, session.id, { text: "into the silence" });

        expect(response.status).toBe(409);
        const row = (await listInputs(arranged, session.id)).at(-1);
        expect(row).toMatchObject({ text: "into the silence", status: "queued", delivery: null });
        expect(row!.sentAt).toBeNull();
        expect(typeof row!.reason).toBe("string");
      },
      // The session is still idle and the row is still waiting, which is what
      // the tick sends again. The tick is stopped so that the row can be read
      // as the unanswered delivery left it.
      { eventRoutingInterval: NO_TICK },
    );
  });
});

describe("session.input, queued by default", () => {
  it("queues a busy session's row without touching the wire", async () => {
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

  it("queues a starting session's row without touching the wire", async () => {
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

  it("delivers to an idle session at once, and the answer is whatever the runner reports - never a value the controller picked", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
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
 * The model options one input carries: validated against the session's own
 * instance, merged over what the row already holds, and dropped wholesale when
 * the input changes the model, because the choices belong to the model.
 */
describe("session.input: the model options a submission carries", () => {
  /** What the session's model selection reads as now. */
  const readModelSelection = async (arranged: Arranged, id: string): Promise<unknown> =>
    (await readSession(arranged, id)).modelSelection;

  it("stores the picks and carries them on the frame delivered for that input", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");

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

  it("merges the picks over the ones the row already holds", async () => {
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

  it("leaves the options alone when the input restates the model it is already on", async () => {
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

  // The rules a pick is judged by are `options.test.ts`'s; what this proves is
  // that the session's own machine is asked, and that a refusal writes neither
  // the input row nor the selection.
  it("refuses a value the session's model does not offer, stores no row, and leaves the selection where it was", async () => {
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
 * `input.steer`: `POST /api/v1/sessions/:id/inputs/:inputId/steer` reuses the
 * delivery path for a row already queued behind a running turn.
 */
describe("input.steer", () => {
  /** A busy session with one row still queued behind the turn already running. */
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

  it("delivers the row's own text, and the answer is exactly what the runner reports", async () => {
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

  it("answers 'opened' rather than inventing a result, when the turn ended while the frame was in flight", async () => {
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

  // The row is delivered already (`started` answers its own prompt), so the
  // session being idle is what this steer must be refused for.
  it("refuses an idle session's row, and sends no frame", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      const [prompt] = await listInputs(arranged, session.id);
      const before = listInputFrames(arranged.wire).length;

      const response = await steerInput(arranged, session.id, prompt!.id);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(listInputFrames(arranged.wire)).toHaveLength(before);
    });
  });

  it("refuses a starting session's row, and sends no frame", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      const [prompt] = await listInputs(arranged, session.id);

      const response = await steerInput(arranged, session.id, prompt!.id);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(listInputFrames(arranged.wire)).toEqual([]);
    });
  });

  // As with the idle case, the exit cascade has already cancelled the row by
  // the time the session reads exited, so this also exercises "row not
  // queued" alongside "session exited" - both are valid grounds to refuse.
  it("refuses an exited session's row, and sends no frame", async () => {
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

  it("refuses a row that is already delivered", async () => {
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

  it("refuses a row that has been cancelled", async () => {
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

  // Pinned by observable effect rather than the stored `sentAt` field: a
  // second steer call while the first is still out and unanswered must be
  // refused, and the runner must never see a second frame for the same row.
  it("refuses a row already on the wire, and sends it no second frame", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const { session, inputId } = await makeBusyWithQueuedInput(arranged);
      const before = listInputFrames(arranged.wire).length;

      const inFlight = steerInput(arranged, session.id, inputId);
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", before + 1);

      const concurrent = await steerInput(arranged, session.id, inputId);

      expect(concurrent.status, await concurrent.clone().text()).toBe(409);
      expect(listInputFrames(arranged.wire)).toHaveLength(before + 1);

      // Let the held frame resolve so the fleet has nothing outstanding when
      // the harness tears the socket down.
      arranged.wire.release("steered");
      await inFlight;
    });
  });

  it("leaves the row queued, still busy, when the runner never answers the steer", async () => {
    await withFleet(async (arranged) => {
      const { session, inputId } = await makeBusyWithQueuedInput(arranged);
      arranged.wire.answering(() => undefined);

      const response = await steerInput(arranged, session.id, inputId);

      expect(response.status, await response.clone().text()).toBe(409);
      const row = (await listInputs(arranged, session.id)).find((one) => one.id === inputId);
      expect(row).toMatchObject({ status: "queued", delivery: null });
    });
  });

  it("refuses a row on a provider that declares steering unsupported", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        instanceId: findInstanceId(arranged, "limited-provider"),
      });
      const events = buildTranscript(session.id);
      reportEvent(arranged.wire, ...events[0]!);
      await waitForSession(arranged, session.id, (one) => one.status === "idle");
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);
      reportEvent(arranged.wire, ...events[1]!);
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      const queued = await sendInput(arranged, session.id, { text: "steer me" });
      expect(queued.status, await queued.clone().text()).toBe(200);
      const { inputId } = (await queued.json()) as { inputId: string };
      const before = listInputFrames(arranged.wire).length;

      const response = await steerInput(arranged, session.id, inputId);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(listInputFrames(arranged.wire)).toHaveLength(before);
    });
  });

  it("answers not_found for an input id belonging to another session", async () => {
    await withFleet(async (arranged) => {
      const { inputId } = await makeBusyWithQueuedInput(arranged);
      const elsewhere = await spawnSessionOrFail(arranged, { prompt: "elsewhere" });

      const response = await steerInput(arranged, elsewhere.id, inputId);

      expect(response.status).toBe(404);
    });
  });

  it("puts a refused row back to queued, sentAt cleared, with the runner's message on it", async () => {
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

describe("the inputs a session holds", () => {
  /** A session with one delivered input, one still queued, and one cancelled. */
  const withInputs = async (arranged: Arranged): Promise<Session> => {
    const session = await spawnSessionOrFail(arranged, {
      prompt: "hello",
      instanceId: findInstanceId(arranged, "limited-provider"),
    });
    const events = buildTranscript(session.id);
    reportEvent(arranged.wire, ...events[0]!);
    await waitForSession(arranged, session.id, (one) => one.status === "idle");
    await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);
    reportEvent(arranged.wire, ...events[1]!);
    await waitForSession(arranged, session.id, (one) => one.status === "busy");
    // The provider declares no steering, so both of these queue.
    for (const text of ["second", "third"]) {
      const queued = await sendInput(arranged, session.id, { text });
      expect(queued.status, await queued.clone().text()).toBe(200);
    }
    const rows = await listInputs(arranged, session.id);
    const cancelled = await cancelInput(arranged, session.id, rows[2]!.id);
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    return session;
  };

  it("lists them oldest first, whatever state each is in", async () => {
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

  it("rewrites a queued input, refuses a terminal one, and says the session changed", async () => {
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

  it("cancels a queued input, refuses a terminal one, and never reaches another session", async () => {
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
  it("puts the session back in the queue when the machine is gone before it is told", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.close();
      await waitForRunnerGone(arranged);
      // Placeable on the record and unreachable in fact, which is the machine
      // that goes away between being chosen and being spoken to.
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

  it("sends a row the machine never answered for again at the next transition", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const session = await spawnSessionOrFail(arranged, { prompt: "one" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      const events = buildTranscript(session.id);

      reportEvent(arranged.wire, ...events[0]!);
      const first = await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);
      // The one wait on a clock here: a flush holds its row until it gives up
      // waiting for an answer, and nothing else says when it has.
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

  it("sends no second frame for a row a flush already has in flight", async () => {
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

      // A frame of its own, after the second transition to idle: frames cross
      // one socket in order, so a flush that had resent the first row would
      // have put it on the wire ahead of this one.
      const opened = await sendInput(arranged, session.id, { text: "two" });
      expect(opened.status, await opened.clone().text()).toBe(200);
      const sent = await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 2);
      expect(sent.map((frame) => frame.input.text)).toEqual(["one", "two"]);
      // The unanswered row is still waiting, which is why a second flush had
      // something to send twice and did not.
      expect(await listInputs(arranged, session.id)).toMatchObject([
        { text: "one", status: "queued" },
        { text: "two", status: "delivered" },
      ]);
    });
  });

  it("refuses to call off an input the machine already has", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const session = await spawnSessionOrFail(arranged, { prompt: "one" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      reportEvent(arranged.wire, ...buildTranscript(session.id)[0]!);
      const sent = (await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1))[0]!;

      // The row still reads `queued` - it is waiting for an answer, not for a
      // turn - so a caller told it was called off would be told a lie.
      const response = await cancelInput(arranged, session.id, sent.requestId);

      expect(response.status).toBe(409);
      expect(await response.text()).toContain("already gone");
    });
  });

  it("does not send an input called off while the one before it is on the wire", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const session = await spawnSessionOrFail(arranged, { prompt: "one" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      const queued = await sendInput(arranged, session.id, { text: "two" });
      const { inputId } = (await queued.json()) as { inputId: string };

      reportEvent(arranged.wire, ...buildTranscript(session.id)[0]!);
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);

      // Waiting behind the one on the wire, so it is still the caller's to
      // take back: nothing has claimed it, and only a claimed row is out of a
      // caller's reach.
      const gone = await cancelInput(arranged, session.id, inputId);
      expect(gone.status, await gone.clone().text()).toBe(200);

      // Answered at last, so the flush records it and looks for what is next.
      arranged.wire.release("opened");
      const rows = await waitUntil("recorded the first delivery", async () => {
        const found = await listInputs(arranged, session.id);
        return found[0]!.status === "delivered" ? found : undefined;
      });

      expect(rows.map((row) => row.status)).toEqual(["delivered", "cancelled"]);
      expect(listInputFrames(arranged.wire).map((frame) => frame.input.text)).toEqual(["one"]);
    });
  });

  it("sends the row behind it at the next transition, while the first is still unanswered", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering((frame) => (frame.input.text === "one" ? undefined : "steered"));
      const session = await spawnSessionOrFail(arranged, { prompt: "one" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      const queued = await sendInput(arranged, session.id, { text: "two" });
      expect(await queued.json()).toMatchObject({ result: "queued" });

      const events = buildTranscript(session.id);
      reportEvent(arranged.wire, ...events[0]!);
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);
      // A whole turn comes and goes while the machine has still said nothing
      // about the first input: the second transition to idle claims and sends
      // the row behind it on its own, independently of the first one still
      // being out.
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
      // Still waiting on an answer nothing sent, so the ingest kept going
      // beside a flush rather than after one.
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

  it("filters by several statuses at once, repeated on the wire", async () => {
    // The runner page's capacity read is exactly this: `starting`, `idle` and
    // `busy` in one page, `exited` never in it.
    await withFleet(async (arranged) => {
      const waiting = await spawnSessionOrFail(arranged, { prompt: "one" });
      const idle = await startSession(arranged, "two");
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

  it("answers not_found for an id nobody holds", async () => {
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
 * The transcript over HTTP: the same rows the ingest wrote, encoded back out
 * through the contract, in position order and a page at a time.
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
      for (const [seq, event] of buildTranscript(session.id))
        reportEvent(arranged.wire, seq, event);
      await waitForSession(arranged, session.id, (one) => one.status === "idle");

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
      // The event survives the round trip whole, coalesced text and all.
      const delta = page.items.find((row) => row.event._tag === "content.delta")!.event;
      expect(delta._tag === "content.delta" ? delta.delta : undefined).toBe("Hello");
      expect(page.nextCursor).toBeUndefined();
    });
  });

  it("pages with a cursor that resumes exactly where the last page stopped", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      for (const [seq, event] of buildTranscript(session.id))
        reportEvent(arranged.wire, seq, event);
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

  it("is an empty transcript for a session that has said nothing, and not_found for no session", async () => {
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
  it("tells the machine to end the running turn, and the turn it ends reads interrupted", async () => {
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

  it("tells the machine to interrupt whatever the status the controller holds says", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);

      // The controller's status lags the machine's own stream, and only the
      // adapter knows whether a turn is open; its interrupt is a no-op where
      // there is none.
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

  it("refuses a session that has exited, and tells the machine nothing", async () => {
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
  it("tells the machine to stop, and the exit it reports ends the session", async () => {
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

  it("refuses a session that has already exited, and tells the machine nothing", async () => {
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
  it("branches off the parent's native session on a new row that copies it", async () => {
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
        // A fork branches off the parent, and says so.
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

  it("carries the document the parent was told - an agent's prompt, tools and schema - onto the fork", async () => {
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
      await waitForSession(arranged, spawnedFromAgent.id, (one) => one.status === "idle");
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

  it("refuses a parent that is live, one with no native session, and an id nobody holds", async () => {
    await withFleet(async (arranged) => {
      const running = await startSession(arranged, "hello");
      const stillLive = await continueSession(arranged, running.id, { mode: "fork", prompt: "no" });
      expect(stillLive.status, await stillLive.clone().text()).toBe(409);

      // Exited without ever reporting a binding: there is no native session to
      // carry on from.
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

      // One start each for the two sessions above, and none for a continue.
      expect(listFrames<SessionStart>(arranged.wire, "sessionStart")).toHaveLength(2);
    });
  });

  it("refuses a parent whose machine can no longer resume it", async () => {
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

  it("refuses a parent whose machine is draining, and says that is why", async () => {
    await withFleet(async (arranged) => {
      const parent = await startAndEndSession(arranged, "hello");
      // The transcript is still there, so the row reads resumable; the machine
      // is the one refusing, and it says so rather than reading as a
      // contradiction.
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

  it("refuses a parent whose machine is not logged in to its provider instance", async () => {
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

  /** The patch's own answer and what a read of the row says after it, which must agree. */
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

  it("rewrites modelSelection.options on their own, and GET agrees", async () => {
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

  it("rewrites modelSelection.model and drops the old model's options", async () => {
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

  it("rewrites both at once, against the model the same call names", async () => {
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

  it("changes nothing on a payload that names neither", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      await patchSessionOrFail(arranged, session.id, { options: { effort: "high" } });

      expect(await patchSessionOrFail(arranged, session.id, {})).toEqual({
        model: "clever",
        options: { effort: "high" },
      });
    });
  });

  it("refuses a value the model does not offer, and leaves the row where it was", async () => {
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

  it("leaves the stored spec byte-identical to what the machine was started with", async () => {
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
      // The change lands on the session's own row, never on the frozen spec the
      // machine was started with.
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

  it("carries a model changed while an earlier row is on the wire, once the next transition sends the row behind it", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const session = await spawnSessionOrFail(arranged, { prompt: "one" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      const queued = await sendInput(arranged, session.id, { text: "two" });
      expect(await queued.json()).toMatchObject({ result: "queued" });

      reportEvent(arranged.wire, ...buildTranscript(session.id)[0]!);
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);

      // The model changes while the prompt's own row is still on the wire,
      // unanswered - the row behind it has not been claimed yet, so this is
      // what it must read once its own transition to idle sends it.
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

  it("is carried into a continue's spec after the session exits", async () => {
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

  it("refuses a session that has exited", async () => {
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
 * "On the wire" as stored state (`sent_at`, `reason`), and a flush that sends
 * one waiting row per transition to idle rather than the whole queue at once.
 */
describe("the queue at the transition to idle, one row per boundary", () => {
  it("sends only the oldest row at each transition, marking it on the wire until it is answered", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const session = await spawnSessionOrFail(arranged, { prompt: "one" });
      await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
      for (const text of ["two", "three"]) {
        const queued = await sendInput(arranged, session.id, { text });
        expect(await queued.json()).toMatchObject({ result: "queued" });
      }

      reportEvent(arranged.wire, ...buildTranscript(session.id)[0]!);

      const onWire = await waitUntil("put the oldest row on the wire", async () => {
        const found = await listInputs(arranged, session.id);
        return typeof found[0]!.sentAt === "string" ? found : undefined;
      });
      expect(listInputFrames(arranged.wire)).toHaveLength(1);
      expect(onWire.map((row) => [row.text, row.status, typeof row.sentAt === "string"])).toEqual([
        ["one", "queued", true],
        ["two", "queued", false],
        ["three", "queued", false],
      ]);

      // On the wire, so neither a rewrite nor a cancel may take it back.
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

      // The second transition to idle sends only the next row.
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

  it("puts a refused row back to queued with the runner's message, and clears it once put on the wire again", async () => {
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

      // The next transition to idle resends it, clearing the reason the
      // instant it claims the row again - a stale reason must not linger
      // beside a row that is, once more, on its way to the machine. The
      // machine's own answer changes too, so this resend is what is asserted
      // rather than a second refusal.
      arranged.wire.answering(() => "opened");
      reportEvent(arranged.wire, ...buildTranscript(session.id)[1]!);
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      reportEvent(arranged.wire, ...buildTranscript(session.id)[6]!);

      const delivered = await waitUntil("delivered the retried row", async () => {
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

  it("leaves an unanswered row queued with sentAt cleared and a message once the deadline passes", async () => {
    await withFleet(
      async (arranged) => {
        arranged.wire.answering(() => undefined);
        const session = await spawnSessionOrFail(arranged, { prompt: "one" });
        await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);

        reportEvent(arranged.wire, ...buildTranscript(session.id)[0]!);
        await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);

        // The one wait on a clock here: the row is on the wire from the moment
        // the frame goes out, and nothing else says when the controller has
        // given up waiting for an answer.
        await delay(Duration.toMillis(INPUT_DEADLINE) + 1000);

        const rows = await listInputs(arranged, session.id);
        expect(rows[0]).toMatchObject({ status: "queued", sentAt: null });
        expect(typeof rows[0]!.reason).toBe("string");
      },
      // What the deadline leaves behind is a row waiting on an idle session,
      // which is exactly what the tick sends again. The tick is stopped so
      // that the row can be read as the deadline left it.
      { eventRoutingInterval: NO_TICK },
    );
  });

  it("cancels rows still waiting when the session exits, but leaves the one on the wire until it is answered", async () => {
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

      // Let the held frame resolve so the fleet has nothing outstanding when
      // the harness tears the socket down.
      arranged.wire.release("opened");
    });
  });
});

/**
 * A restart, over a database already holding session input rows: `reboot`
 * runs the boot's own idempotent steps again, on the same database a real
 * restart would find, which is what a row caught on the wire when the
 * previous process stopped looks like.
 */
describe("a restart", () => {
  it("cancels a row still on the wire, with a message, and leaves a waiting row untouched", async () => {
    await withFleet(async (arranged) => {
      const session = await startSession(arranged, "hello");
      // The `Id` schema requires a UUIDv7, the same as every id this build
      // mints, so a plain `crypto.randomUUID()` (v4) would fail decoding it
      // back out over `GET /inputs`.
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

/** Writes controller settings the way the only surface for them does. */
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

describe("the timeouts a session is started under", () => {
  it("carries what the settings say, whole minutes turned into milliseconds", async () => {
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

  it("carries the same values onto a session continued from another", async () => {
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
 * What a placement does when the machine it landed on cannot take it yet. The
 * queue is the session rows themselves, so what is asserted is the status the
 * caller reads back and the frames the machine did or did not get: a queued
 * session is one the runner has never been told about.
 */

/** The one machine's cap, set the way the runner page's edit form sets it. */
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

/** The disk watermark override, in bytes, as `runner.update` takes it. */
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

/** What this machine says about its disk, on the report the controller admits on. */
const reportDiskFree = (wire: Wire, diskFreeBytes: number): void =>
  wire.send({
    _tag: "watermarkReport",
    watermark: { diskFreeBytes, availableMemoryBytes: 16 * GIB },
  });

/**
 * Long enough for a start the controller decided on to have crossed the socket.
 * Absence of a frame cannot be waited for, so it is given the time a frame the
 * same test does expect takes, and then asserted.
 */
const waitToSettle = (): Promise<void> => delay(250);

const listStartFrames = (wire: Wire): ReadonlyArray<SessionStart> =>
  listFrames<SessionStart>(wire, "sessionStart");

describe("session.spawn onto a runner that is full", () => {
  it("queues the spawn, tells the machine nothing, and starts it when a slot frees", async () => {
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

      // One slot freed, so one of the two moves, and it is the one that has
      // been waiting longest.
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

  it("starts everything the raised cap has room for, at once", async () => {
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

  it("starts nothing on a machine that is draining, however much room it has", async () => {
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

  it("ends a queued session on session.stop, without a word to the machine", async () => {
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

describe("session.spawn and session.continue onto a runner nobody can reach", () => {
  it("queues a spawn onto a machine that is gone, and starts it when the machine is back", async () => {
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

  it("queues a continue onto a machine that is gone, and starts it when the machine is back", async () => {
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
  it("queues on that connection until the report lands, then starts", async () => {
    await withFleet(async (arranged) => {
      // A fresh connection for the same runner, the way a restart's does:
      // hello has gone out, but nothing has said yet what this connection
      // holds. Waited for by its own probe rather than a sleep: a probe is
      // sent only once the controller has processed this hello and made this
      // the runner's current connection, which an HTTP spawn racing the
      // WebSocket handshake cannot otherwise be sure of.
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
  it("queues under the watermark and starts on a report at or above it", async () => {
    await withFleet(async (arranged) => {
      // Nothing reported yet: a machine that has said nothing about its disk is
      // taken at its word and given work.
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

  it("starts a queued session when the owner lowers the watermark under the disk it has", async () => {
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
 * What a machine's report of what it holds says about what it does not.
 *
 * A runner that restarted comes back holding fewer sessions than the controller
 * believes it has, and the report is the only place that difference shows. So
 * what is asserted is a difference: the sessions the report leaves out end, the
 * one it lists is untouched, and a session on another machine is nobody else's
 * business, whatever this machine says.
 */

/**
 * How many messages a subscription has taken once nothing has arrived for two
 * coalescing windows. A record change is announced on a delay, so a test that
 * takes its baseline the moment it subscribes counts the traffic it caused
 * earlier as traffic it caused later.
 */
const waitForQuiet = async (announced: Collected): Promise<number> => {
  let seen = -1;
  while (seen !== announced.received.length) {
    seen = announced.received.length;
    await waitForLiveToSettle();
  }
  return seen;
};

/** Has this machine say it holds exactly these sessions, each under a native id. */
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

/** The session, started and then mid-turn: what the controller reads as busy. */
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

/** A session placed by name on a second machine, and reported up as busy there. */
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

describe("what a machine's report says it is no longer holding", () => {
  it("ends the sessions the report leaves out, and leaves the listed one and another machine's alone", async () => {
    await withFleet(async (arranged) => {
      // This machine's three first, while it is the only one there is: an
      // automatic placement picks a machine, and these three have to be on the
      // one whose report is the subject.
      const running = await startBusySession(arranged, "mid-turn here");
      const waiting = await startSession(arranged, "idle here");
      const opening = await spawnSessionOrFail(arranged, { prompt: "still starting" });
      expect(opening.status).toBe("starting");
      expect(opening.runnerId).toBe(arranged.runnerId);
      const other = await arranged.enlist();
      const elsewhere = await startBusySessionOn(arranged, other, "on the other machine");
      // Every one of them has a native id before the report that ends two of
      // them, because what an ended session's resumability rests on is that id
      // and not the reason it stopped.
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

      // One row per session the report ended, naming why - and none for the
      // one left running or the one another machine holds.
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

  it("tells the machine to stop a session it still holds that the controller has ended", async () => {
    // A machine that was suspended past a session's bound comes back with the
    // process still running: the controller ended the session while the
    // machine was out of reach.
    await withFleet(async (arranged) => {
      const running = await startBusySession(arranged, "outlived its bound");
      const kept = await startSession(arranged, "still running on both sides");
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
          // Everything the spawns and the binding left in flight is collected
          // first and counted, so what is asserted below is what the report
          // caused rather than what was already on its way.
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
      const waiting = await startSession(arranged, "idle here");
      const opening = await spawnSessionOrFail(arranged, { prompt: "still starting" });

      reportHeldSessions(arranged.wire, arranged, [running.id, waiting.id, opening.id]);
      await waitForSession(arranged, opening.id, (one) => one.nativeSessionId !== null);
      // A report is applied the moment it arrives; the wait is for a move that
      // must never come, so it is given the time one would have taken.
      await waitToSettle();

      expect((await readSession(arranged, running.id)).status).toBe("busy");
      expect((await readSession(arranged, waiting.id)).status).toBe("idle");
      expect((await readSession(arranged, opening.id)).status).toBe("starting");
    });
  });
});

/**
 * Input into a session whose harness has gone: the row is stored, the same
 * session id is resumed on the machine that still holds its transcript, and
 * what the user typed is delivered once the process says it is up. What is
 * asserted is the walk the caller can read - the status, the frames the
 * machine got, and the row - because a resume is the spawn's own path.
 */
describe("session.input into an exited session", () => {
  it("resumes the same session on its machine and delivers the input once it is up", async () => {
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
      // The last exit is what it says it is until there is another one.
      expect(starting.exitedAt).toBe(session.exitedAt);
      expect(listInputFrames(arranged.wire)).toHaveLength(before);

      reportEvent(arranged.wire, 3, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
      });

      await waitForSession(arranged, session.id, (one) => one.status === "idle");
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

      const bound = await waitForSession(arranged, session.id, (one) => one.status === "idle");
      expect(bound.nativeSessionId).toBe("native-2");
    });
  });

  it("refuses an exited session whose transcript is gone, and says that is why", async () => {
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

  it("refuses an exited session whose machine was retired, and says that is why", async () => {
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

  it("refuses an exited session whose machine is not logged in to its instance", async () => {
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

  it("refuses an exited session whose machine is draining, and says that is why", async () => {
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

  it("queues the resume while the machine is gone, and starts it when the machine is back", async () => {
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

  it("queues the resume while the machine is full, and starts it when a slot frees", async () => {
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

  it("queues the resume under the disk watermark, and starts it when the reading clears", async () => {
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

  it("calls off the waiting row when the resumed process exits before it is up, and resumes again on the next input", async () => {
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
      // The exit that is stamped is the last one, not the one before the resume.
      expect(Date.parse(gone.exitedAt!)).toBeGreaterThan(Date.parse(session.exitedAt!));
      const row = await waitUntil("called the row off", async () => {
        const found = (await listInputs(arranged, session.id)).find((one) => one.id === inputId);
        return found?.status === "cancelled" ? found : undefined;
      });
      expect(row.reason).toContain("exited (");
      // Nothing tries again on its own: a second start would be one nobody asked for.
      await waitToSettle();
      expect(listStartFrames(arranged.wire)).toHaveLength(2);

      const again = await sendInput(arranged, session.id, { text: "and now" });

      expect(again.status, await again.clone().text()).toBe(200);
      const sent = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 3);
      expect(sent[2]!.sessionId).toBe(session.id);
    });
  });

  it("takes the resumed process's sequence from its start, however far the stored stream got", async () => {
    await withFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      for (const [seq, event] of buildTranscript(session.id))
        reportEvent(arranged.wire, seq, event);
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
      // A machine that restarted numbers the session's events from one again.
      const again = await arranged.reconnect();
      await waitForFrames<ProbeRequest>(again, "probeRequest", 1);
      again.send({ _tag: "sessionsReport", sessions: [] });

      const response = await sendInput(arranged, session.id, { text: "after the restart" });
      expect(response.status, await response.clone().text()).toBe(200);
      await waitForFrames<SessionStart>(again, "sessionStart", 1);

      const base = { eventId: crypto.randomUUID(), sessionId: session.id, at };
      reportEvent(again, 1, { ...base, _tag: "session.started" });
      await waitForSession(arranged, session.id, (one) => one.status === "idle");
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
  it("branches a parent on fork, and refuses a mode that is not one", async () => {
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
 * The approval seam from the user's end: a machine reports a request it has
 * parked on, the request lands on the session row the client already refetches,
 * and the user's answer crosses the wire as one frame. It refuses every answer
 * it cannot place: a stale request id, no request at all, an answer the request
 * does not offer, a session that has gone, and a machine that is not there to
 * hear it.
 */
const REQUEST_ID = "req-1";

const DECISIONS = ["allow", "allow_always", "deny", "cancel"] as const;

const respondToRequest = (arranged: Arranged, id: string, body: unknown): Promise<Response> =>
  post(arranged.harness.base, `/api/v1/sessions/${id}/respond`, body, arranged.token);

const listRespondFrames = (wire: Wire): ReadonlyArray<SessionRespondFrame> =>
  listFrames<SessionRespondFrame>(wire, "sessionRespond");

/**
 * A session inside a running turn, parked on one open command approval. The
 * answers it offers are a parameter because a request that offers fewer is the
 * whole of the unoffered-decision case.
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
    "sends %s to the machine once, and leaves the request open until it says so",
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

  it("clears the open request when the machine reports it resolved", async () => {
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

  it("clears the park when the machine reports it no longer holds the session", async () => {
    await withFleet(async (arranged) => {
      const session = await startParkedSession(arranged);
      arranged.wire.close();
      await waitForRunnerGone(arranged);
      const again = await arranged.reconnect();
      again.send({ _tag: "sessionsReport", sessions: [] });

      const gone = await waitForSession(arranged, session.id, (one) => one.status === "exited");

      // An answer to a park nobody holds would name a request no harness ever
      // minted, so the request goes when the session it belonged to does.
      expect(gone.openRequest).toBeNull();
    });
  });

  it("refuses a request id that is not the open one, and tells the machine nothing", async () => {
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
      // The request the machine is really parked on is untouched.
      expect((await readSession(arranged, session.id)).openRequest).toMatchObject({
        requestId: REQUEST_ID,
      });
      expect(await arranged.harness.audit("session.responded")).toHaveLength(0);
    });
  });

  it("refuses an answer to a session with no open request", async () => {
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

  it("refuses a decision the open request does not offer, and sends nothing", async () => {
    await withFleet(async (arranged) => {
      // A request that may persist no rule offers no `allow_always`: answering
      // it as one cannot be quietly narrowed to a plain allow.
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
      // The offered answers still stand, so the card can be answered properly.
      expect((await readSession(arranged, session.id)).openRequest).toMatchObject({
        decisions: ["allow", "deny", "cancel"],
      });
    });
  });

  it("refuses a session that has exited, and tells the machine nothing", async () => {
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

  it("refuses the answer when the machine holding the park is gone", async () => {
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
    });
  });
});

/**
 * Spawning into a workspace.
 *
 * A spawn says which project the thread belongs to and which workspace it wants
 * - the repo's main workspace, a fresh worktree of its own, or one that is
 * already standing - and the session waits in `queued` while a machine makes
 * it. Git words live on checkouts; a workspace is a kind and a list of them.
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

/** The project a session says it belongs to; not on the contract's shape yet. */
const readProjectId = (session: Session): string | null =>
  (session as unknown as { readonly projectId?: string | null }).projectId ?? null;

/** Has the machine say the workspace is made, so dispatch can pick the session up. */
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

      // The machine has not made it yet, so the session waits rather than starting.
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
        branch: `hercule/run-${session.id.slice(-8)}`,
      });

      const frame = await waitForFrameTagged(arranged.wire, "workspaceProvision");
      expect(frame["workspaceId"]).toBe(workspace.id);
      expect(frame["kind"]).toBe("ephemeral");

      // A workspace a spawn brought into being is a workspace someone made, so
      // the log says so, exactly as `workspace.provision` does.
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

      // And both live on the row the API hands back afterwards.
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
      const branch = `hercule/run-${session.id.slice(-8)}`;
      expect(workspace.checkouts).toHaveLength(2);
      expect(workspace.checkouts.map((one) => one.subdirectory)).toEqual(["web", "api"]);
      expect(workspace.checkouts.map((one) => one.branch)).toEqual([branch, branch]);
    });
  });

  it("lays a repo whose name begins with a dot out beside the others", async () => {
    await withFleet(async (arranged) => {
      // A real repository, and a directory a workspace can hold: only `.`, `..`
      // and `.git` are names a directory cannot be called.
      const meta = await makeRepo(arranged, "https://github.com/acme/.github");
      const web = await makeRepo(arranged, "https://github.com/acme/web");

      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: meta }, { resourceId: web }] },
      });

      const workspace = await readWorkspace(arranged, String(session.workspaceId));
      expect(workspace.checkouts.map((one) => one.subdirectory)).toEqual([".github", "web"]);
      // And the machine is told, rather than the frame failing to encode.
      const frame = await waitForFrameTagged(arranged.wire, "workspaceProvision");
      expect(
        (frame["checkouts"] as ReadonlyArray<CheckoutRow>).map((one) => one.subdirectory),
      ).toEqual([".github", "web"]);
    });
  });

  it("makes a scratch workspace out of an empty list of checkouts", async () => {
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

  it("clones a primary when the machine has none, and reuses the one it has", async () => {
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
      // Cloned fresh: a spawn never adopts a folder in place.
      expect(checkouts[0]?.["path"] ?? null).toBeNull();

      reportWorkspaceReady(arranged, workspace);
      await waitForSession(arranged, first.id, (one) => one.status !== "queued");

      // The second thread in the same repo on the same machine shares it, and
      // asks the machine for nothing new.
      const second = await spawnSessionOrFail(arranged, {
        prompt: "again",
        workspace: { kind: "primary", resourceId: web, branch: "feature/x" },
      });
      expect(second.workspaceId).toBe(workspace.id);

      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2))[1]!;
      expect(start.sessionId).toBe(second.id);
      // Counted once the second start has crossed: anything the second spawn
      // asked the machine for would be on the wire ahead of it.
      expect(listFramesTagged(arranged.wire, "workspaceProvision")).toHaveLength(1);
      // The branch is a checkout word: it rides the start frame so the machine
      // switches before the harness sees the folder.
      expect((start as unknown as WorkspaceFrame)["checkoutBranch"]).toBe("feature/x");
    });
  });

  /**
   * The branch pick is used once only. The machine switches the main workspace
   * to that branch before this thread first runs. If a resume replayed the
   * pick, it would switch the branch under whatever the user has done in that
   * checkout since the thread last ran.
   */
  it("sends the branch pick once and never again when the thread is resumed", async () => {
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
      await waitForSession(arranged, session.id, (one) => one.status === "idle");
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);
      await endSession(arranged, session, 2);

      const response = await sendInput(arranged, session.id, { text: "still there?" });
      expect(response.status, await response.clone().text()).toBe(200);

      const again = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2))[1]!;
      expect(again.sessionId).toBe(session.id);
      expect(again.spec.continue).toEqual({ nativeSessionId: "native-1", mode: "resume" });
      // The row still records what the thread was started on - that is history -
      // but the machine is not told to switch again.
      expect((again as unknown as WorkspaceFrame)["checkoutBranch"] ?? null).toBeNull();
    });
  });

  it("takes the machine from a workspace that already stands, and refuses a second one", async () => {
    await withFleet(async (arranged) => {
      const other = await arranged.enlist();
      const web = await makeRepo(arranged, "https://github.com/acme/web");
      const first = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspace = await readWorkspace(arranged, String(first.workspaceId));

      // Still provisioning: a thread may not join a workspace that is not made.
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

  it("refuses a project the repo does not belong to", async () => {
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
   * Joining a workspace is not a way around the filing. A workspace that
   * already stands is still a set of repos. A thread filed under one project
   * must not reach a repo of another project, even if somebody else already
   * made a workspace that holds that repo.
   */
  it("refuses joining a standing workspace whose repos are not the project's", async () => {
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

      // And the same workspace under its own project is joined as before.
      const joined = await spawnSessionOrFail(arranged, {
        prompt: "again",
        projectId: hercule,
        workspace: { kind: "existing", workspaceId: workspace.id },
      });
      expect(joined.workspaceId).toBe(workspace.id);
    });
  });

  /**
   * A fork inherits its parent's workspace and its parent's project, and
   * `openFor` holds the repos in that workspace to that project, as it does
   * for any other opening. A repo that has left the project since then
   * therefore stops the fork, with the refusal a fresh spawn would also get.
   * That is intended: the filing decides which repos a thread may reach, and a
   * fork is a new thread.
   */
  it("refuses a fork whose parent's repo has left the project", async () => {
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
      await waitForSession(arranged, parent.id, (one) => one.status === "idle");
      await waitForFrames<SessionInput>(arranged.wire, "sessionInput", 1);
      await endSession(arranged, parent, 2);

      // The repo is filed under no project any more.
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

  it("ends the session when the machine could not make its workspace", async () => {
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
      // It never started, so the machine was never told to.
      expect(listFramesTagged(arranged.wire, "sessionStart")).toEqual([]);
    });
  });

  it("replaces a primary the machine could not make rather than joining it", async () => {
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

      // The next thread in that repo asks the machine again rather than
      // joining a workspace that was never made and waiting for ever.
      const second = await spawnSessionOrFail(arranged, {
        prompt: "again",
        workspace: { kind: "primary", resourceId: web },
      });
      expect(second.workspaceId).not.toBe(failed);
      // The frame crosses the socket after the spawn's transaction commits, so
      // the second one is waited for before it is counted.
      const frame = await waitForFrameTagged(arranged.wire, "workspaceProvision", 1);
      expect(frame["workspaceId"]).toBe(second.workspaceId);
      expect(listFramesTagged(arranged.wire, "workspaceProvision")).toHaveLength(2);
    });
  });

  it("refuses one repo named twice, and two repos that would share a directory", async () => {
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

  it("refuses a project that does not exist, whatever else the thread names", async () => {
    await withFleet(async (arranged) => {
      const response = await spawnSession(arranged, {
        prompt: "hello",
        projectId: "0199e0e7-9999-7000-8000-0000000000aa",
      });
      expect((await parseRefusal(response)).code).toBe("validation");
      expect(await listSessions(arranged)).toEqual([]);
    });
  });

  it("refuses to resume or fork a thread whose workspace has been disposed of", async () => {
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
      const idle = await waitForSession(arranged, session.id, (one) => one.status === "idle");
      const ended = await endSession(arranged, idle, 2);
      expect(ended.resumable).toBe(true);

      const disposed = await send(
        "DELETE",
        arranged.harness.base,
        `/api/v1/workspaces/${workspace.id}`,
        { token: arranged.token },
      );
      expect([200, 204], await disposed.clone().text()).toContain(disposed.status);

      // The transcript is still on the machine, but the files it worked in are
      // not: there is nowhere to pick it up.
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
      const idle = await waitForSession(arranged, parent.id, (one) => one.status === "idle");
      const ended = await endSession(arranged, idle, 2);

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
