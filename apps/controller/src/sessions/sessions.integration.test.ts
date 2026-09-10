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
  type ProviderEvent,
  type RunnerFacts,
  type SessionInterrupt as SessionInterruptFrame,
  type SessionStart,
  type SessionStop as SessionStopFrame,
  type SessionInput,
} from "@hydra/protocol";
import type { Plugin, ProviderDefinition } from "@hydra/plugin-host";
import type { Profile, Runner, Session } from "@hydra/contract";
import {
  collecting,
  get,
  onSocket,
  post,
  send,
  settleLive,
  ticketFor,
  within,
  type Collected,
  type ServerHarness,
} from "../http/testing";
import { fixture, providerDefinition } from "../plugins/testing";
import {
  framesOf,
  framesWhen,
  report,
  spawn,
  spawned,
  until,
  WAIT_DEADLINE_MS,
  withFleet as sharedWithFleet,
  type Arranged,
  type Wire,
} from "./testing";

/** Everything native: the instance a plain spawn lands on. */
const FULL = providerDefinition("full-provider", { token: "t" });

/** The fallback's subject: it stops at `auto-accept-edits`. */
const LIMITED: ProviderDefinition = {
  ...providerDefinition("limited-provider", { token: "t" }),
  declared: {
    ...providerDefinition("limited-provider").declared,
    steering: "unsupported",
    accessModes: {
      "approval-required": "native",
      "auto-accept-edits": "native",
      auto: "unsupported",
      "full-access": "unsupported",
    },
  },
};

const registry = (): ReadonlyArray<Plugin> => [
  fixture({ id: "providers", definitions: [FULL, LIMITED] }).plugin,
];

const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["full-provider", "limited-provider"],
  identityPort: 4939,
};

const MODELS = [
  { slug: "fast", name: "Fast", options: [] },
  { slug: "clever", name: "Clever", isDefault: true, options: [] },
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

/** A controller with one enlisted, connected, logged-in machine on it, on this suite's own fleet. */
const withFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  sharedWithFleet(body, {
    plugins: registry(),
    facts: FACTS,
    models: MODELS,
    inputDeadline: INPUT_DEADLINE,
  });

const instanceOf = (arranged: Arranged, providerId: string): string => {
  const found = arranged.instances.find((instance) => instance.providerId === providerId);
  expect(found, providerId).toBeDefined();
  return found!.id;
};

const readSession = async (arranged: Arranged, id: string): Promise<Session> => {
  const response = await get(arranged.harness.base, `/api/v1/sessions/${id}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Session;
};

/** The session once it reads the way the test is waiting for. */
const sessionWhen = (
  arranged: Arranged,
  id: string,
  ready: (session: Session) => boolean,
): Promise<Session> =>
  until("moved the session", async () => {
    const session = await readSession(arranged, id);
    return ready(session) ? session : undefined;
  });

interface StreamRow {
  readonly position: number;
  readonly runner_seq: number;
  readonly tag: string;
  readonly event: string;
}

const streamOf = (harness: ServerHarness, id: string): Promise<ReadonlyArray<StreamRow>> =>
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
const transcript = (sessionId: string): ReadonlyArray<readonly [number, ProviderEvent]> => {
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

const inputsOf = async (arranged: Arranged, id: string): Promise<ReadonlyArray<StoredInput>> => {
  const response = await get(
    arranged.harness.base,
    `/api/v1/sessions/${id}/inputs`,
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<StoredInput> }).items;
};

/** The session, started and idle, with the prompt's own input frame answered. */
const started = async (arranged: Arranged, prompt: string): Promise<Session> => {
  const session = await spawned(arranged, { prompt });
  await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);
  report(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.started",
  });
  await sessionWhen(arranged, session.id, (one) => one.status === "idle");
  // The prompt's turn is opened after the transaction that set idle committed,
  // so the status is not evidence that its frame was written - and every count
  // of input frames below is taken relative to this one.
  await framesWhen<SessionInput>(arranged.wire, "sessionInput", 1);
  return session;
};

const inputFrames = (wire: Wire): ReadonlyArray<SessionInput> =>
  framesOf<SessionInput>(wire, "sessionInput");

/**
 * Waits until the controller has noticed the machine's socket go. The runner
 * reading anything but online is what says the connection map has let it go,
 * which is what makes a delivery fail for that reason rather than for a race.
 */
const wentAway = (arranged: Arranged): Promise<Runner> =>
  until("saw the machine go", async () => {
    const response = await get(
      arranged.harness.base,
      `/api/v1/runners/${arranged.runnerId}`,
      arranged.token,
    );
    const runner = (await response.json()) as Runner;
    return runner.connectivity === "online" ? undefined : runner;
  });

const exited = (wire: Wire, sessionId: string, seq: number): void =>
  report(wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "session.exited",
    reason: "stopped",
  });

/** A session ended the way a machine ends one, with its native id on the row. */
const ends = async (arranged: Arranged, session: Session, seq: number): Promise<Session> => {
  arranged.wire.send({
    _tag: "sessionsReport",
    sessions: [
      {
        sessionId: session.id,
        nativeSessionId: "native-1",
        instanceId: instanceOf(arranged, "full-provider"),
      },
    ],
  });
  await sessionWhen(arranged, session.id, (one) => one.nativeSessionId !== null);
  exited(arranged.wire, session.id, seq);
  return await sessionWhen(arranged, session.id, (one) => one.status === "exited");
};

/** The parent a continue asks for: exited, resumable, native id bound. */
const ended = async (arranged: Arranged, prompt: string): Promise<Session> =>
  ends(arranged, await started(arranged, prompt), 2);

const interrupt = (arranged: Arranged, id: string): Promise<Response> =>
  send("POST", arranged.harness.base, `/api/v1/sessions/${id}/interrupt`, {
    token: arranged.token,
  });

const stop = (arranged: Arranged, id: string): Promise<Response> =>
  send("POST", arranged.harness.base, `/api/v1/sessions/${id}/stop`, { token: arranged.token });

const carryOn = (arranged: Arranged, id: string, body: unknown): Promise<Response> =>
  post(arranged.harness.base, `/api/v1/sessions/${id}/continue`, body, arranged.token);

describe("session.spawn", () => {
  it("builds a thread from the shipped defaults and tells the machine to start it", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "hello" });

      expect(session.status).toBe("starting");
      expect(session.runnerId).toBe(arranged.runnerId);
      expect(session.instanceId).toBe(instanceOf(arranged, "full-provider"));
      expect(session.requestedAccessMode).toBe("approval-required");
      expect(session.accessMode).toBe("approval-required");
      expect(session.nativeSessionId).toBeNull();
      expect(session.resumable).toBe(false);

      const start = (await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
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
      const session = await spawned(arranged, { prompt: "hello", model: "fast" });
      const start = (await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;

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
      const session = await spawned(arranged, {
        prompt: "hello",
        instanceId: instanceOf(arranged, "limited-provider"),
        accessMode: "auto",
      });

      expect(session.requestedAccessMode).toBe("auto");
      expect(session.accessMode).toBe("auto-accept-edits");
      const start = (await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      // The runner is told the mode it will really run, never the request.
      expect(start.spec.accessMode).toBe("auto-accept-edits");
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

      const response = await spawn(arranged, { prompt: "hello" });

      expect(response.status).toBe(409);
      expect(await response.text()).toContain("no connected runner");
    });
  });

  it("refuses a workspace, because there are none to give it", async () => {
    await withFleet(async (arranged) => {
      const response = await spawn(arranged, {
        prompt: "hello",
        workspaceId: "0199e0e7-9999-7000-8000-000000000000",
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("workspaces are not built yet");
    });
  });

  it("sends the prompt as one turn's input once the harness is up", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "what is the time" });
      await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);

      report(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
      });

      const input = (await framesWhen<SessionInput>(arranged.wire, "sessionInput", 1))[0]!;
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
 * Naming a runner or a profile is for this one call: the tests above cover
 * what a caller gets by naming neither.
 */
describe("session.spawn with an explicit runner or profile", () => {
  it("places the session on the runner an explicit runnerId names", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "hello", runnerId: arranged.runnerId });

      expect(session.runnerId).toBe(arranged.runnerId);
      const start = (await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
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

      const session = await spawned(arranged, { prompt: "hello", runnerId: arranged.runnerId });

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

      const response = await spawn(arranged, { prompt: "hello", runnerId: arranged.runnerId });

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

      const response = await spawn(arranged, { prompt: "hello", runnerId: arranged.runnerId });

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

      const response = await spawn(arranged, {
        prompt: "hello",
        instanceId: instanceOf(arranged, "full-provider"),
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
      const response = await spawn(arranged, {
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

      const session = await spawned(arranged, {
        prompt: "hello",
        permissionProfileId: worker!.id,
      });

      expect(session.permissionProfileId).toBe(worker!.id);
    });
  });

  it("fails validation on a permissionProfileId naming no profile", async () => {
    await withFleet(async (arranged) => {
      const response = await spawn(arranged, {
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
      const session = await spawned(arranged, { prompt: "  Fix the login bug\n\nDetails..." });

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

      const session = await spawned(arranged, { prompt: `${longLine}\nmore detail below` });

      const title = (session as unknown as { title: string }).title;
      expect(title).toBe(longLine.slice(0, 80));
      expect(title).toHaveLength(80);
    });
  });

  it("skips leading blank lines and takes the first line with content", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, {
        prompt: "\n   \n\nActually, start here\nand then this",
      });

      expect((session as unknown as { title: string }).title).toBe("Actually, start here");
    });
  });

  it("carries the title on the sessions list, not only on a single read", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "Fix the login bug\n\nDetails..." });

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
      const session = await spawned(arranged, { prompt: "hello" });
      await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);
      const events = transcript(session.id);

      report(arranged.wire, ...events[0]!);
      expect(
        (await sessionWhen(arranged, session.id, (one) => one.status === "idle")).startedAt,
      ).not.toBeNull();

      report(arranged.wire, ...events[1]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "busy");

      for (const [seq, event] of events.slice(2, 6)) report(arranged.wire, seq, event);
      // The same frame again, as a replay after a reconnect would send it, and
      // ahead of the completion the test then waits for: frames off one socket
      // are handled in order, so a session reading idle is one whose replay has
      // already been dealt with. Behind it, the wait would prove nothing.
      report(arranged.wire, ...events[3]!);
      report(arranged.wire, ...events[6]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "idle");

      const rows = await until("wrote the turn", async () => {
        const found = await streamOf(arranged.harness, session.id);
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
      const session = await spawned(arranged, { prompt: "hello" });

      report(arranged.wire, ...transcript(session.id)[0]!);

      const bound = await sessionWhen(arranged, session.id, (one) => one.status === "idle");
      // The id and the status it explains are written together, so a session
      // reading idle is never one whose binding has not landed yet.
      expect(bound.nativeSessionId).toBe("native-1");
    });
  });

  it("records the native id a sessions report carries, for a session already up", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "hello" });
      const instanceId = instanceOf(arranged, "full-provider");

      arranged.wire.send({
        _tag: "sessionsReport",
        sessions: [{ sessionId: session.id, nativeSessionId: "reported-1", instanceId }],
      });

      const bound = await sessionWhen(arranged, session.id, (one) => one.nativeSessionId !== null);
      expect(bound.nativeSessionId).toBe("reported-1");
    });
  });

  it("ends the session, and an ended one whose machine still holds it is resumable", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "hello" });
      arranged.wire.send({
        _tag: "sessionsReport",
        sessions: [
          {
            sessionId: session.id,
            nativeSessionId: "native-1",
            instanceId: instanceOf(arranged, "full-provider"),
          },
        ],
      });
      await sessionWhen(arranged, session.id, (one) => one.nativeSessionId !== null);

      exited(arranged.wire, session.id, 1);

      const ended = await sessionWhen(arranged, session.id, (one) => one.status === "exited");
      expect(ended.exitedAt).not.toBeNull();
      expect(ended.resumable).toBe(true);
    });
  });

  it("ignores a machine reporting about a session that is not placed on it", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "hello" });
      const other = await arranged.harness.insertRunner({ name: "elsewhere" });
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE sessions SET runner_id = unhex(replace(${other.id}, '-', ''))
            WHERE id = unhex(replace(${session.id}, '-', ''))`,
        ),
      );

      report(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
      });
      // A second session, on the machine that really holds it, reported behind
      // the first. Frames are read off one socket in order, so this one landing
      // is what says the one before it has been dealt with - and waiting out a
      // clock would only say the controller had not got to it yet.
      const mine = await spawned(arranged, { prompt: "hello" });
      report(arranged.wire, 2, {
        eventId: crypto.randomUUID(),
        sessionId: mine.id,
        at,
        _tag: "session.started",
      });
      await sessionWhen(arranged, mine.id, (one) => one.status === "idle");

      expect(await streamOf(arranged.harness, session.id)).toEqual([]);
      expect((await readSession(arranged, session.id)).status).toBe("starting");
    });
  });
});

describe("session.input", () => {
  it("refuses input to a session that has exited", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "hello" });
      exited(arranged.wire, session.id, 1);
      await sessionWhen(arranged, session.id, (one) => one.status === "exited");

      const response = await sendInput(arranged, session.id, { text: "too late" });

      expect(response.status).toBe(409);
      expect(await response.text()).toContain("has exited");
    });
  });

  it("leaves the row queued, with a message, when an idle session's machine is gone", async () => {
    await withFleet(async (arranged) => {
      const session = await started(arranged, "hello");
      arranged.wire.close();
      await wentAway(arranged);

      const response = await sendInput(arranged, session.id, { text: "into the void" });

      expect(response.status).toBe(409);
      // A refused or unanswered delivery is not the user's own cancel: the row
      // stays visible, with the reason on it, for the next input to open a
      // turn to bring the boundary that tries it again.
      const row = (await inputsOf(arranged, session.id)).at(-1);
      expect(row).toMatchObject({ text: "into the void", status: "queued", delivery: null });
      expect(row!.sentAt).toBeNull();
      expect(typeof row!.reason).toBe("string");
    });
  });

  it("leaves the row queued, with a message, when an idle session's machine never answers", async () => {
    await withFleet(async (arranged) => {
      const session = await started(arranged, "hello");
      arranged.wire.answering(() => undefined);

      const response = await sendInput(arranged, session.id, { text: "into the silence" });

      expect(response.status).toBe(409);
      const row = (await inputsOf(arranged, session.id)).at(-1);
      expect(row).toMatchObject({ text: "into the silence", status: "queued", delivery: null });
      expect(row!.sentAt).toBeNull();
      expect(typeof row!.reason).toBe("string");
    });
  });
});

describe("session.input, queued by default", () => {
  it("queues a busy session's row without touching the wire", async () => {
    await withFleet(async (arranged) => {
      const session = await started(arranged, "hello");
      report(arranged.wire, ...transcript(session.id)[1]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "busy");
      const before = inputFrames(arranged.wire).length;

      const response = await sendInput(arranged, session.id, { text: "mid-turn" });

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ result: "queued" });
      expect(inputFrames(arranged.wire)).toHaveLength(before);
      expect((await inputsOf(arranged, session.id)).at(-1)).toMatchObject({
        text: "mid-turn",
        status: "queued",
        delivery: null,
        sentAt: null,
      });
    });
  });

  it("queues a starting session's row without touching the wire", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "hello" });

      const response = await sendInput(arranged, session.id, { text: "too soon" });

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ result: "queued" });
      expect(inputFrames(arranged.wire)).toEqual([]);
      expect((await inputsOf(arranged, session.id)).at(-1)).toMatchObject({
        text: "too soon",
        status: "queued",
        delivery: null,
        sentAt: null,
      });
    });
  });

  it("delivers to an idle session at once, and the answer is whatever the runner reports - never a value the controller picked", async () => {
    await withFleet(async (arranged) => {
      const session = await started(arranged, "hello");
      arranged.wire.answering(() => "steered");

      const response = await sendInput(arranged, session.id, { text: "again" });

      expect(response.status, await response.clone().text()).toBe(200);
      const answer = (await response.json()) as { inputId: string; result: string };
      expect(answer.result).toBe("steered");
      const sent = inputFrames(arranged.wire).at(-1)!;
      expect(sent.requestId).toBe(answer.inputId);
      expect(sent.input.text).toBe("again");
      expect((await inputsOf(arranged, session.id)).at(-1)).toMatchObject({
        id: answer.inputId,
        status: "delivered",
        delivery: "steered",
      });
    });
  });

  it("fails validation on a payload carrying a modelSelection", async () => {
    await withFleet(async (arranged) => {
      const session = await started(arranged, "hello");

      const response = await sendInput(arranged, session.id, {
        text: "hello",
        modelSelection: { model: "fast" },
      });

      expect(response.status, await response.clone().text()).toBe(400);
    });
  });
});

/**
 * `input.steer`: `POST /api/v1/sessions/:id/inputs/:inputId/steer` reuses the
 * delivery path for a row already queued behind a running turn.
 */
describe("input.steer", () => {
  /** A busy session with one row still queued behind the turn already running. */
  const busyWithQueuedRow = async (
    arranged: Arranged,
    text = "steer me",
  ): Promise<{ readonly session: Session; readonly inputId: string }> => {
    const session = await started(arranged, "hello");
    report(arranged.wire, ...transcript(session.id)[1]!);
    await sessionWhen(arranged, session.id, (one) => one.status === "busy");
    const queued = await sendInput(arranged, session.id, { text });
    expect(queued.status, await queued.clone().text()).toBe(200);
    const { inputId } = (await queued.json()) as { inputId: string };
    return { session, inputId };
  };

  it("delivers the row's own text, and the answer is exactly what the runner reports", async () => {
    await withFleet(async (arranged) => {
      const { session, inputId } = await busyWithQueuedRow(arranged, "steer me");
      arranged.wire.answering(() => "steered");

      const response = await steerInput(arranged, session.id, inputId);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ inputId, result: "steered" });
      const sent = inputFrames(arranged.wire).at(-1)!;
      expect(sent.requestId).toBe(inputId);
      expect(sent.input.text).toBe("steer me");
      const row = (await inputsOf(arranged, session.id)).find((one) => one.id === inputId);
      expect(row).toMatchObject({ status: "delivered", delivery: "steered" });
    });
  });

  it("answers 'opened' rather than inventing a result, when the turn ended while the frame was in flight", async () => {
    await withFleet(async (arranged) => {
      const { session, inputId } = await busyWithQueuedRow(arranged);
      arranged.wire.answering(() => "opened");

      const response = await steerInput(arranged, session.id, inputId);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ inputId, result: "opened" });
      const row = (await inputsOf(arranged, session.id)).find((one) => one.id === inputId);
      expect(row).toMatchObject({ status: "delivered", delivery: "opened" });
    });
  });

  // The row is delivered already (`started` answers its own prompt), so the
  // session being idle is what this steer must be refused for.
  it("refuses an idle session's row, and sends no frame", async () => {
    await withFleet(async (arranged) => {
      const session = await started(arranged, "hello");
      const [prompt] = await inputsOf(arranged, session.id);
      const before = inputFrames(arranged.wire).length;

      const response = await steerInput(arranged, session.id, prompt!.id);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(inputFrames(arranged.wire)).toHaveLength(before);
    });
  });

  it("refuses a starting session's row, and sends no frame", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "hello" });
      const [prompt] = await inputsOf(arranged, session.id);

      const response = await steerInput(arranged, session.id, prompt!.id);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(inputFrames(arranged.wire)).toEqual([]);
    });
  });

  // As with the idle case, the exit cascade has already cancelled the row by
  // the time the session reads exited, so this also exercises "row not
  // queued" alongside "session exited" - both are valid grounds to refuse.
  it("refuses an exited session's row, and sends no frame", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "hello" });
      exited(arranged.wire, session.id, 1);
      await sessionWhen(arranged, session.id, (one) => one.status === "exited");
      const [prompt] = await inputsOf(arranged, session.id);

      const response = await steerInput(arranged, session.id, prompt!.id);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(inputFrames(arranged.wire)).toEqual([]);
    });
  });

  it("refuses a row that is already delivered", async () => {
    await withFleet(async (arranged) => {
      const { session, inputId } = await busyWithQueuedRow(arranged);
      arranged.wire.answering(() => "steered");
      const first = await steerInput(arranged, session.id, inputId);
      expect(first.status, await first.clone().text()).toBe(200);
      const before = inputFrames(arranged.wire).length;

      const again = await steerInput(arranged, session.id, inputId);

      expect(again.status, await again.clone().text()).toBe(409);
      expect(inputFrames(arranged.wire)).toHaveLength(before);
    });
  });

  it("refuses a row that has been cancelled", async () => {
    await withFleet(async (arranged) => {
      const { session, inputId } = await busyWithQueuedRow(arranged);
      const cancelled = await cancelInput(arranged, session.id, inputId);
      expect(cancelled.status, await cancelled.clone().text()).toBe(200);
      const before = inputFrames(arranged.wire).length;

      const response = await steerInput(arranged, session.id, inputId);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(inputFrames(arranged.wire)).toHaveLength(before);
    });
  });

  // Pinned by observable effect rather than the stored `sentAt` field: a
  // second steer call while the first is still out and unanswered must be
  // refused, and the runner must never see a second frame for the same row.
  it("refuses a row already on the wire, and sends it no second frame", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const { session, inputId } = await busyWithQueuedRow(arranged);
      const before = inputFrames(arranged.wire).length;

      const inFlight = steerInput(arranged, session.id, inputId);
      await framesWhen<SessionInput>(arranged.wire, "sessionInput", before + 1);

      const concurrent = await steerInput(arranged, session.id, inputId);

      expect(concurrent.status, await concurrent.clone().text()).toBe(409);
      expect(inputFrames(arranged.wire)).toHaveLength(before + 1);

      // Let the held frame resolve so the fleet has nothing outstanding when
      // the harness tears the socket down.
      arranged.wire.release("steered");
      await inFlight;
    });
  });

  it("leaves the row queued, still busy, when the runner never answers the steer", async () => {
    await withFleet(async (arranged) => {
      const { session, inputId } = await busyWithQueuedRow(arranged);
      arranged.wire.answering(() => undefined);

      const response = await steerInput(arranged, session.id, inputId);

      expect(response.status, await response.clone().text()).toBe(409);
      const row = (await inputsOf(arranged, session.id)).find((one) => one.id === inputId);
      expect(row).toMatchObject({ status: "queued", delivery: null });
    });
  });

  it("refuses a row on a provider that declares steering unsupported", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, {
        prompt: "hello",
        instanceId: instanceOf(arranged, "limited-provider"),
      });
      const events = transcript(session.id);
      report(arranged.wire, ...events[0]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "idle");
      await framesWhen<SessionInput>(arranged.wire, "sessionInput", 1);
      report(arranged.wire, ...events[1]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "busy");
      const queued = await sendInput(arranged, session.id, { text: "steer me" });
      expect(queued.status, await queued.clone().text()).toBe(200);
      const { inputId } = (await queued.json()) as { inputId: string };
      const before = inputFrames(arranged.wire).length;

      const response = await steerInput(arranged, session.id, inputId);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(inputFrames(arranged.wire)).toHaveLength(before);
    });
  });

  it("answers not_found for an input id belonging to another session", async () => {
    await withFleet(async (arranged) => {
      const { inputId } = await busyWithQueuedRow(arranged);
      const elsewhere = await spawned(arranged, { prompt: "elsewhere" });

      const response = await steerInput(arranged, elsewhere.id, inputId);

      expect(response.status).toBe(404);
    });
  });

  it("puts a refused row back to queued, sentAt cleared, with the runner's message on it", async () => {
    await withFleet(async (arranged) => {
      const { session, inputId } = await busyWithQueuedRow(arranged);
      arranged.wire.answering(() => ({ message: "no such model here" }));

      const response = await steerInput(arranged, session.id, inputId);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.text()).toContain("no such model here");
      const row = (await inputsOf(arranged, session.id)).find((one) => one.id === inputId);
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
    const session = await spawned(arranged, {
      prompt: "hello",
      instanceId: instanceOf(arranged, "limited-provider"),
    });
    const events = transcript(session.id);
    report(arranged.wire, ...events[0]!);
    await sessionWhen(arranged, session.id, (one) => one.status === "idle");
    await framesWhen<SessionInput>(arranged.wire, "sessionInput", 1);
    report(arranged.wire, ...events[1]!);
    await sessionWhen(arranged, session.id, (one) => one.status === "busy");
    // The provider declares no steering, so both of these queue.
    for (const text of ["second", "third"]) {
      const queued = await sendInput(arranged, session.id, { text });
      expect(queued.status, await queued.clone().text()).toBe(200);
    }
    const rows = await inputsOf(arranged, session.id);
    const cancelled = await cancelInput(arranged, session.id, rows[2]!.id);
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    return session;
  };

  it("lists them oldest first, whatever state each is in", async () => {
    await withFleet(async (arranged) => {
      const session = await withInputs(arranged);

      const rows = await inputsOf(arranged, session.id);

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
      const rows = await inputsOf(arranged, session.id);
      const ticket = await ticketFor(arranged.harness.base, arranged.token);

      await onSocket(arranged.harness.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const announced = yield* collecting(client, { topic: "session" });
          yield* Effect.promise(() => settleLive());

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
            within(2000, () =>
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
      const other = await spawned(arranged, { prompt: "elsewhere" });
      const rows = await inputsOf(arranged, session.id);

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
      await wentAway(arranged);
      // Placeable on the record and unreachable in fact, which is the machine
      // that goes away between being chosen and being spoken to.
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE runners SET connectivity = 'online'
            WHERE id = unhex(replace(${arranged.runnerId}, '-', ''))`,
        ),
      );

      const response = await spawn(arranged, { prompt: "never sent" });

      expect(response.status, await response.clone().text()).toBe(200);
      const session = (await response.json()) as Session;
      const waiting = await sessionWhen(arranged, session.id, (one) => one.status === "queued");
      expect(waiting.status).toBe("queued");
      expect(await inputsOf(arranged, session.id)).toMatchObject([
        { text: "never sent", status: "queued" },
      ]);
    });
  });

  it("sends a row the machine never answered for again at the next transition", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const session = await spawned(arranged, { prompt: "one" });
      await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);
      const events = transcript(session.id);

      report(arranged.wire, ...events[0]!);
      const first = await framesWhen<SessionInput>(arranged.wire, "sessionInput", 1);
      // The one wait on a clock here: a flush holds its row until it gives up
      // waiting for an answer, and nothing else says when it has.
      await delay(Duration.toMillis(INPUT_DEADLINE) + 1000);

      report(arranged.wire, ...events[1]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "busy");
      report(arranged.wire, ...events[6]!);

      const again = await framesWhen<SessionInput>(arranged.wire, "sessionInput", 2);
      expect(again.map((frame) => frame.requestId)).toEqual([
        first[0]!.requestId,
        first[0]!.requestId,
      ]);
      expect((await inputsOf(arranged, session.id))[0]).toMatchObject({ status: "queued" });
    });
  });

  it("cancels every input still queued when the session exits", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "one" });
      const queued = await sendInput(arranged, session.id, { text: "two" });
      expect(await queued.json()).toMatchObject({ result: "queued" });

      exited(arranged.wire, session.id, 1);
      await sessionWhen(arranged, session.id, (one) => one.status === "exited");

      const rows = await until("cancelled what was waiting", async () => {
        const found = await inputsOf(arranged, session.id);
        return found.every((row) => row.status !== "queued") ? found : undefined;
      });
      expect(rows.map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
      expect(inputFrames(arranged.wire)).toEqual([]);
    });
  });

  it("sends no second frame for a row a flush already has in flight", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering((frame) => (frame.input.text === "one" ? undefined : "opened"));
      const session = await spawned(arranged, { prompt: "one" });
      await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);
      const events = transcript(session.id);

      report(arranged.wire, ...events[0]!);
      await framesWhen<SessionInput>(arranged.wire, "sessionInput", 1);
      report(arranged.wire, ...events[1]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "busy");
      report(arranged.wire, ...events[6]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "idle");

      // A frame of its own, after the second transition to idle: frames cross
      // one socket in order, so a flush that had resent the first row would
      // have put it on the wire ahead of this one.
      const opened = await sendInput(arranged, session.id, { text: "two" });
      expect(opened.status, await opened.clone().text()).toBe(200);
      const sent = await framesWhen<SessionInput>(arranged.wire, "sessionInput", 2);
      expect(sent.map((frame) => frame.input.text)).toEqual(["one", "two"]);
      // The unanswered row is still waiting, which is why a second flush had
      // something to send twice and did not.
      expect(await inputsOf(arranged, session.id)).toMatchObject([
        { text: "one", status: "queued" },
        { text: "two", status: "delivered" },
      ]);
    });
  });

  it("refuses to call off an input the machine already has", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const session = await spawned(arranged, { prompt: "one" });
      await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);
      report(arranged.wire, ...transcript(session.id)[0]!);
      const sent = (await framesWhen<SessionInput>(arranged.wire, "sessionInput", 1))[0]!;

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
      const session = await spawned(arranged, { prompt: "one" });
      await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);
      const queued = await sendInput(arranged, session.id, { text: "two" });
      const { inputId } = (await queued.json()) as { inputId: string };

      report(arranged.wire, ...transcript(session.id)[0]!);
      await framesWhen<SessionInput>(arranged.wire, "sessionInput", 1);

      // Waiting behind the one on the wire, so it is still the caller's to
      // take back: nothing has claimed it, and only a claimed row is out of a
      // caller's reach.
      const gone = await cancelInput(arranged, session.id, inputId);
      expect(gone.status, await gone.clone().text()).toBe(200);

      // Answered at last, so the flush records it and looks for what is next.
      arranged.wire.release("opened");
      const rows = await until("recorded the first delivery", async () => {
        const found = await inputsOf(arranged, session.id);
        return found[0]!.status === "delivered" ? found : undefined;
      });

      expect(rows.map((row) => row.status)).toEqual(["delivered", "cancelled"]);
      expect(inputFrames(arranged.wire).map((frame) => frame.input.text)).toEqual(["one"]);
    });
  });

  it("sends the row behind it at the next transition, while the first is still unanswered", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering((frame) => (frame.input.text === "one" ? undefined : "steered"));
      const session = await spawned(arranged, { prompt: "one" });
      await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);
      const queued = await sendInput(arranged, session.id, { text: "two" });
      expect(await queued.json()).toMatchObject({ result: "queued" });

      const events = transcript(session.id);
      report(arranged.wire, ...events[0]!);
      await framesWhen<SessionInput>(arranged.wire, "sessionInput", 1);
      // A whole turn comes and goes while the machine has still said nothing
      // about the first input: the second transition to idle claims and sends
      // the row behind it on its own, independently of the first one still
      // being out.
      report(arranged.wire, ...events[1]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "busy");
      report(arranged.wire, ...events[6]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "idle");

      arranged.wire.release("opened");

      const sent = await framesWhen<SessionInput>(arranged.wire, "sessionInput", 2);
      expect(sent.map((frame) => frame.input.text)).toEqual(["one", "two"]);
    });
  });

  it("keeps applying another session's events while a flush waits for an answer", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const waiting = await spawned(arranged, { prompt: "one" });
      await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);
      report(arranged.wire, ...transcript(waiting.id)[0]!);
      await framesWhen<SessionInput>(arranged.wire, "sessionInput", 1);

      const other = await spawned(arranged, { prompt: "two" });
      report(arranged.wire, ...transcript(other.id)[0]!);

      await sessionWhen(arranged, other.id, (one) => one.status === "idle");
      // Still waiting on an answer nothing sent, so the ingest kept going
      // beside a flush rather than after one.
      expect(await inputsOf(arranged, waiting.id)).toMatchObject([
        { text: "one", status: "queued" },
      ]);
    });
  });
});

describe("session.query and session.read", () => {
  it("lists the sessions newest first and filters by status", async () => {
    await withFleet(async (arranged) => {
      const first = await spawned(arranged, { prompt: "one" });
      const second = await spawned(arranged, { prompt: "two" });
      exited(arranged.wire, first.id, 1);
      await sessionWhen(arranged, first.id, (one) => one.status === "exited");

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
  const transcriptOf = async (
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
      const session = await spawned(arranged, { prompt: "hello" });
      for (const [seq, event] of transcript(session.id)) report(arranged.wire, seq, event);
      await sessionWhen(arranged, session.id, (one) => one.status === "idle");

      const page = await until("wrote the turn", async () => {
        const found = await transcriptOf(arranged, session.id);
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
      const session = await spawned(arranged, { prompt: "hello" });
      for (const [seq, event] of transcript(session.id)) report(arranged.wire, seq, event);
      await until("wrote the turn", async () => {
        const found = await transcriptOf(arranged, session.id);
        return found.items.length === 6 ? found : undefined;
      });

      const first = await transcriptOf(arranged, session.id, "?limit=4");
      expect(first.items.map((row) => row.position)).toEqual([1, 2, 3, 4]);
      expect(first.nextCursor).toBeDefined();

      const rest = await transcriptOf(
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
      const session = await spawned(arranged, { prompt: "hello" });

      expect((await transcriptOf(arranged, session.id)).items).toEqual([]);

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
      const session = await started(arranged, "hello");
      const events = transcript(session.id);
      report(arranged.wire, ...events[1]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "busy");

      const response = await interrupt(arranged, session.id);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ id: session.id, status: "busy" });
      const sent = await framesWhen<SessionInterruptFrame>(arranged.wire, "sessionInterrupt", 1);
      expect(sent[0]!.sessionId).toBe(session.id);

      report(arranged.wire, 3, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "turn.completed",
        turnId: "t1",
        state: "interrupted",
      });

      await sessionWhen(arranged, session.id, (one) => one.status === "idle");
      const completed = await until("wrote the ended turn", async () => {
        const found = await streamOf(arranged.harness, session.id);
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
      const session = await spawned(arranged, { prompt: "hello" });
      await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);

      // The controller's status lags the machine's own stream, and only the
      // adapter knows whether a turn is open; its interrupt is a no-op where
      // there is none.
      const starting = await interrupt(arranged, session.id);
      expect(starting.status, await starting.clone().text()).toBe(200);

      report(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
      });
      await sessionWhen(arranged, session.id, (one) => one.status === "idle");
      const idle = await interrupt(arranged, session.id);
      expect(idle.status, await idle.clone().text()).toBe(200);

      const sent = await framesWhen<SessionInterruptFrame>(arranged.wire, "sessionInterrupt", 2);
      expect(sent.map((frame) => frame.sessionId)).toEqual([session.id, session.id]);
      expect(await arranged.harness.audit("session.interrupted")).toHaveLength(2);
    });
  });

  it("refuses a session that has exited, and tells the machine nothing", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "hello" });
      exited(arranged.wire, session.id, 1);
      await sessionWhen(arranged, session.id, (one) => one.status === "exited");

      const response = await interrupt(arranged, session.id);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.text()).toContain("has exited");
      expect(framesOf<SessionInterruptFrame>(arranged.wire, "sessionInterrupt")).toEqual([]);
      expect(await arranged.harness.audit("session.interrupted")).toHaveLength(0);
    });
  });
});

describe("session.stop", () => {
  it("tells the machine to stop, and the exit it reports ends the session", async () => {
    await withFleet(async (arranged) => {
      const session = await started(arranged, "hello");

      const response = await stop(arranged, session.id);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ id: session.id });
      const sent = await framesWhen<SessionStopFrame>(arranged.wire, "sessionStop", 1);
      expect(sent[0]!.sessionId).toBe(session.id);

      exited(arranged.wire, session.id, 2);

      const ended = await sessionWhen(arranged, session.id, (one) => one.status === "exited");
      expect(ended.exitedAt).not.toBeNull();
      const entries = await arranged.harness.audit("session.stopped");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("user");
    });
  });

  it("refuses a session that has already exited, and tells the machine nothing", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "hello" });
      exited(arranged.wire, session.id, 1);
      await sessionWhen(arranged, session.id, (one) => one.status === "exited");

      const response = await stop(arranged, session.id);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(framesOf<SessionStopFrame>(arranged.wire, "sessionStop")).toEqual([]);
      expect(await arranged.harness.audit("session.stopped")).toHaveLength(0);
    });
  });
});

describe("session.continue", () => {
  it("resumes the parent's native session on a new row that copies it", async () => {
    await withFleet(async (arranged) => {
      const parent = await ended(arranged, "hello");
      expect(parent.resumable).toBe(true);

      const response = await carryOn(arranged, parent.id, { mode: "resume", prompt: "carry on" });

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
        // A resume carries on the parent's own native session, so nothing
        // branched and there is no parent to point at.
        parentSessionId: null,
      });
      expect(child.modelSelection).toEqual({ model: "clever", options: {} });

      const starts = await framesWhen<SessionStart>(arranged.wire, "sessionStart", 2);
      expect(starts[1]!.sessionId).toBe(child.id);
      expect(starts[1]!.spec.continue).toEqual({ nativeSessionId: "native-1", mode: "resume" });
      expect(await inputsOf(arranged, child.id)).toMatchObject([
        { text: "carry on", status: "queued" },
      ]);

      const entries = await arranged.harness.audit("session.continued");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("user");
      expect(entries[0]?.payload).toMatchObject({
        sessionId: child.id,
        parentSessionId: parent.id,
        mode: "resume",
      });
    });
  });

  it("refuses a second resume while the first one is still live", async () => {
    await withFleet(async (arranged) => {
      const parent = await ended(arranged, "hello");

      const first = await carryOn(arranged, parent.id, { mode: "resume", prompt: "carry on" });
      expect(first.status, await first.clone().text()).toBe(200);

      const second = await carryOn(arranged, parent.id, { mode: "resume", prompt: "again" });

      expect(second.status, await second.clone().text()).toBe(409);
      expect(framesOf<SessionStart>(arranged.wire, "sessionStart")).toHaveLength(2);
      // A fork writes a transcript of its own, so it is safe beside the resume.
      const forked = await carryOn(arranged, parent.id, { mode: "fork", prompt: "elsewhere" });
      expect(forked.status, await forked.clone().text()).toBe(200);
    });
  });

  it("forks the parent's native session, and says which session it branched off", async () => {
    await withFleet(async (arranged) => {
      const parent = await ended(arranged, "hello");

      const response = await carryOn(arranged, parent.id, {
        mode: "fork",
        prompt: "the other way",
      });

      expect(response.status, await response.clone().text()).toBe(200);
      const child = (await response.json()) as Session;
      expect(child.parentSessionId).toBe(parent.id);
      const starts = await framesWhen<SessionStart>(arranged.wire, "sessionStart", 2);
      expect(starts[1]!.spec.continue).toEqual({ nativeSessionId: "native-1", mode: "fork" });
    });
  });

  it("refuses a parent that is live, one with no native session, and an id nobody holds", async () => {
    await withFleet(async (arranged) => {
      const running = await started(arranged, "hello");
      const stillLive = await carryOn(arranged, running.id, { mode: "resume", prompt: "no" });
      expect(stillLive.status, await stillLive.clone().text()).toBe(409);

      // Exited without ever reporting a binding: there is no native session to
      // carry on from.
      const unbound = await spawned(arranged, { prompt: "hello" });
      exited(arranged.wire, unbound.id, 1);
      await sessionWhen(arranged, unbound.id, (one) => one.status === "exited");
      const noNative = await carryOn(arranged, unbound.id, { mode: "resume", prompt: "no" });
      expect(noNative.status, await noNative.clone().text()).toBe(409);

      const missing = await carryOn(arranged, "0199e0e7-9999-7000-8000-000000000000", {
        mode: "resume",
        prompt: "no",
      });
      expect(missing.status).toBe(404);

      // One start each for the two sessions above, and none for a continue.
      expect(framesOf<SessionStart>(arranged.wire, "sessionStart")).toHaveLength(2);
    });
  });

  it("refuses a parent whose machine can no longer resume it", async () => {
    await withFleet(async (arranged) => {
      const retired = await ended(arranged, "hello");
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE runners SET lifecycle = 'retired'
            WHERE id = unhex(replace(${arranged.runnerId}, '-', ''))`,
        ),
      );

      const response = await carryOn(arranged, retired.id, { mode: "resume", prompt: "no" });

      expect(response.status, await response.clone().text()).toBe(409);
      expect((await readSession(arranged, retired.id)).resumable).toBe(false);
    });
  });

  it("refuses a parent whose machine is draining, and says that is why", async () => {
    await withFleet(async (arranged) => {
      const parent = await ended(arranged, "hello");
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

      const response = await carryOn(arranged, parent.id, { mode: "resume", prompt: "no" });

      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.text()).toContain("draining");
      expect(framesOf<SessionStart>(arranged.wire, "sessionStart")).toHaveLength(1);
    });
  });

  it("refuses a parent whose machine is not logged in to its provider instance", async () => {
    await withFleet(async (arranged) => {
      const parent = await ended(arranged, "hello");
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE capability_snapshots SET auth_status = 'unauthenticated'
            WHERE runner_id = unhex(replace(${arranged.runnerId}, '-', ''))`,
        ),
      );

      const response = await carryOn(arranged, parent.id, { mode: "resume", prompt: "no" });

      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.text()).toContain("logged in");
      expect(framesOf<SessionStart>(arranged.wire, "sessionStart")).toHaveLength(1);
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

  it("rewrites modelSelection.model, leaves options alone, and GET agrees", async () => {
    await withFleet(async (arranged) => {
      const session = await started(arranged, "hello");
      expect(session.modelSelection).toEqual({ model: "clever", options: {} });

      const patched = await patchSession(arranged, session.id, { model: "fast" });

      expect(patched.status, await patched.clone().text()).toBe(200);
      const body = (await patched.json()) as Session;
      expect(body.modelSelection).toEqual({ model: "fast", options: {} });

      const read = await readSession(arranged, session.id);
      expect(read.modelSelection).toEqual({ model: "fast", options: {} });
    });
  });

  it("leaves the stored spec byte-identical to what the machine was started with", async () => {
    await withFleet(async (arranged) => {
      const session = await started(arranged, "hello");
      const start = (await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;

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
      const session = await started(arranged, "hello");
      const ticket = await ticketFor(arranged.harness.base, arranged.token);

      await onSocket(arranged.harness.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const announced = yield* collecting(client, { topic: "session" });
          yield* Effect.promise(() => settleLive());

          const patched = yield* Effect.promise(() =>
            patchSession(arranged, session.id, { model: "fast" }),
          );
          expect(patched.status, yield* Effect.promise(() => patched.clone().text())).toBe(200);

          const heard = yield* Effect.promise(() =>
            within(2000, () =>
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
      const session = await spawned(arranged, { prompt: "one" });
      await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);
      const queued = await sendInput(arranged, session.id, { text: "two" });
      expect(await queued.json()).toMatchObject({ result: "queued" });

      report(arranged.wire, ...transcript(session.id)[0]!);
      await framesWhen<SessionInput>(arranged.wire, "sessionInput", 1);

      // The model changes while the prompt's own row is still on the wire,
      // unanswered - the row behind it has not been claimed yet, so this is
      // what it must read once its own transition to idle sends it.
      const patched = await patchSession(arranged, session.id, { model: "fast" });
      expect(patched.status, await patched.clone().text()).toBe(200);

      arranged.wire.release("opened");
      const events = transcript(session.id);
      report(arranged.wire, ...events[1]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "busy");
      arranged.wire.answering(() => "opened");
      report(arranged.wire, ...events[6]!);

      const sent = await framesWhen<SessionInput>(arranged.wire, "sessionInput", 2);
      expect(sent[1]!.input.modelSelection).toEqual({ model: "fast", options: {} });
    });
  });

  it("is carried into a continue's spec after the session exits", async () => {
    await withFleet(async (arranged) => {
      const session = await started(arranged, "hello");

      const patched = await patchSession(arranged, session.id, { model: "fast" });
      expect(patched.status, await patched.clone().text()).toBe(200);

      const parent = await ends(arranged, session, 2);
      const carried = await carryOn(arranged, parent.id, { mode: "resume", prompt: "and again" });
      expect(carried.status, await carried.clone().text()).toBe(200);
      const child = (await carried.json()) as Session;
      expect(child.modelSelection).toEqual({ model: "fast", options: {} });

      const starts = await framesWhen<SessionStart>(arranged.wire, "sessionStart", 2);
      expect(starts[1]!.spec.modelSelection).toEqual({ model: "fast", options: {} });
    });
  });

  it("refuses a session that has exited", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "hello" });
      exited(arranged.wire, session.id, 1);
      await sessionWhen(arranged, session.id, (one) => one.status === "exited");

      const response = await patchSession(arranged, session.id, { model: "fast" });

      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.text()).toContain("has exited");
    });
  });

  it("fails validation on an empty payload and on an empty model", async () => {
    await withFleet(async (arranged) => {
      const session = await started(arranged, "hello");

      const empty = await patchSession(arranged, session.id, {});
      expect(empty.status, await empty.clone().text()).toBe(400);

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
      const session = await spawned(arranged, { prompt: "one" });
      await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);
      for (const text of ["two", "three"]) {
        const queued = await sendInput(arranged, session.id, { text });
        expect(await queued.json()).toMatchObject({ result: "queued" });
      }

      report(arranged.wire, ...transcript(session.id)[0]!);

      const onWire = await until("put the oldest row on the wire", async () => {
        const found = await inputsOf(arranged, session.id);
        return typeof found[0]!.sentAt === "string" ? found : undefined;
      });
      expect(inputFrames(arranged.wire)).toHaveLength(1);
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
      const delivered = await until("delivered the first row", async () => {
        const found = await inputsOf(arranged, session.id);
        return found[0]!.status === "delivered" ? found : undefined;
      });
      expect(delivered[0]).toMatchObject({ status: "delivered", delivery: "opened", sentAt: null });
      expect(typeof delivered[0]!.deliveredAt).toBe("string");
      expect(delivered[1]).toMatchObject({ status: "queued", sentAt: null });
      expect(delivered[2]).toMatchObject({ status: "queued", sentAt: null });

      // The second transition to idle sends only the next row.
      arranged.wire.answering(() => "opened");
      report(arranged.wire, ...transcript(session.id)[1]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "busy");
      report(arranged.wire, ...transcript(session.id)[6]!);

      const secondSent = await framesWhen<SessionInput>(arranged.wire, "sessionInput", 2);
      expect(secondSent.map((frame) => frame.input.text)).toEqual(["one", "two"]);
      const afterSecond = await until("delivered the second row", async () => {
        const found = await inputsOf(arranged, session.id);
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
      const session = await spawned(arranged, { prompt: "one" });
      await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);

      report(arranged.wire, ...transcript(session.id)[0]!);

      const refused = await until("recorded the refusal", async () => {
        const found = await inputsOf(arranged, session.id);
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
      report(arranged.wire, ...transcript(session.id)[1]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "busy");
      report(arranged.wire, ...transcript(session.id)[6]!);

      const delivered = await until("delivered the retried row", async () => {
        const found = await inputsOf(arranged, session.id);
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
    await withFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const session = await spawned(arranged, { prompt: "one" });
      await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);

      report(arranged.wire, ...transcript(session.id)[0]!);
      await framesWhen<SessionInput>(arranged.wire, "sessionInput", 1);

      // The one wait on a clock here: the row is on the wire from the moment
      // the frame goes out, and nothing else says when the controller has
      // given up waiting for an answer.
      await delay(Duration.toMillis(INPUT_DEADLINE) + 1000);

      const rows = await inputsOf(arranged, session.id);
      expect(rows[0]).toMatchObject({ status: "queued", sentAt: null });
      expect(typeof rows[0]!.reason).toBe("string");
    });
  });

  it("cancels rows still waiting when the session exits, but leaves the one on the wire until it is answered", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.answering((frame) => (frame.input.text === "one" ? undefined : "opened"));
      const session = await spawned(arranged, { prompt: "one" });
      await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);
      const queued = await sendInput(arranged, session.id, { text: "two" });
      expect(await queued.json()).toMatchObject({ result: "queued" });

      report(arranged.wire, ...transcript(session.id)[0]!);
      await framesWhen<SessionInput>(arranged.wire, "sessionInput", 1);

      exited(arranged.wire, session.id, 2);
      await sessionWhen(arranged, session.id, (one) => one.status === "exited");

      const rows = await inputsOf(arranged, session.id);
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
      const session = await started(arranged, "hello");
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

      const rows = await inputsOf(arranged, session.id);
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
const setController = async (
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
      await setController(arranged, {
        "session.inactivityTimeout": 5,
        "session.absoluteTimeout": 60,
      });

      await spawned(arranged, { prompt: "hello" });

      const start = (await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      expect(start.spec.timeouts).toEqual({ inactivityMs: 300_000, absoluteMs: 3_600_000 });
    });
  });

  it("carries the same values onto a session continued from another", async () => {
    await withFleet(async (arranged) => {
      await setController(arranged, {
        "session.inactivityTimeout": 5,
        "session.absoluteTimeout": 60,
      });
      const parent = await ended(arranged, "hello");

      const response = await carryOn(arranged, parent.id, { mode: "resume", prompt: "carry on" });
      expect(response.status, await response.clone().text()).toBe(200);

      const starts = await framesWhen<SessionStart>(arranged.wire, "sessionStart", 2);
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
const capAt = async (arranged: Arranged, cap: number): Promise<void> => {
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
const watermarkAt = async (arranged: Arranged, bytes: number): Promise<void> => {
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
const reportsDisk = (wire: Wire, diskFreeBytes: number): void =>
  wire.send({
    _tag: "watermarkReport",
    watermark: { diskFreeBytes, availableMemoryBytes: 16 * GIB },
  });

/**
 * Long enough for a start the controller decided on to have crossed the socket.
 * Absence of a frame cannot be waited for, so it is given the time a frame the
 * same test does expect takes, and then asserted.
 */
const settled = (): Promise<void> => delay(250);

const starts = (wire: Wire): ReadonlyArray<SessionStart> =>
  framesOf<SessionStart>(wire, "sessionStart");

describe("session.spawn onto a runner that is full", () => {
  it("queues the spawn, tells the machine nothing, and starts it when a slot frees", async () => {
    await withFleet(async (arranged) => {
      await capAt(arranged, 1);
      const running = await started(arranged, "hello");

      const waiting = await spawned(arranged, { prompt: "after you" });

      expect(waiting.status).toBe("queued");
      expect(waiting.runnerId).toBe(arranged.runnerId);
      await settled();
      expect(starts(arranged.wire).map((frame) => frame.sessionId)).toEqual([running.id]);

      exited(arranged.wire, running.id, 2);

      await sessionWhen(arranged, waiting.id, (one) => one.status === "starting");
      const sent = await framesWhen<SessionStart>(arranged.wire, "sessionStart", 2);
      expect(sent[1]!.sessionId).toBe(waiting.id);
    });
  });

  it("starts the oldest first, and never more of them than there are free slots", async () => {
    await withFleet(async (arranged) => {
      await capAt(arranged, 1);
      const running = await started(arranged, "hello");
      const first = await spawned(arranged, { prompt: "second in line" });
      const second = await spawned(arranged, { prompt: "third in line" });
      expect([first.status, second.status]).toEqual(["queued", "queued"]);

      exited(arranged.wire, running.id, 2);

      // One slot freed, so one of the two moves, and it is the one that has
      // been waiting longest.
      await sessionWhen(arranged, first.id, (one) => one.status === "starting");
      await settled();
      expect(starts(arranged.wire).map((frame) => frame.sessionId)).toEqual([running.id, first.id]);
      expect((await readSession(arranged, second.id)).status).toBe("queued");

      exited(arranged.wire, first.id, 3);

      await sessionWhen(arranged, second.id, (one) => one.status === "starting");
      expect(starts(arranged.wire).map((frame) => frame.sessionId)).toEqual([
        running.id,
        first.id,
        second.id,
      ]);
    });
  });

  it("starts everything the raised cap has room for, at once", async () => {
    await withFleet(async (arranged) => {
      await capAt(arranged, 1);
      await started(arranged, "hello");
      const first = await spawned(arranged, { prompt: "second in line" });
      const second = await spawned(arranged, { prompt: "third in line" });
      expect([first.status, second.status]).toEqual(["queued", "queued"]);

      await capAt(arranged, 3);

      await sessionWhen(arranged, first.id, (one) => one.status === "starting");
      await sessionWhen(arranged, second.id, (one) => one.status === "starting");
      const sent = await framesWhen<SessionStart>(arranged.wire, "sessionStart", 3);
      expect(sent.slice(1).map((frame) => frame.sessionId)).toEqual([first.id, second.id]);
    });
  });

  it("starts nothing on a machine that is draining, however much room it has", async () => {
    await withFleet(async (arranged) => {
      await capAt(arranged, 1);
      const running = await started(arranged, "hello");
      const waiting = await spawned(arranged, { prompt: "after you" });
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

      exited(arranged.wire, running.id, 2);
      await sessionWhen(arranged, running.id, (one) => one.status === "exited");
      await settled();

      expect((await readSession(arranged, waiting.id)).status).toBe("queued");
      expect(starts(arranged.wire).map((frame) => frame.sessionId)).toEqual([running.id]);

      const undrained = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/runners/${arranged.runnerId}/undrain`,
        { body: {}, token: arranged.token },
      );
      expect(undrained.status, await undrained.clone().text()).toBe(200);

      await sessionWhen(arranged, waiting.id, (one) => one.status === "starting");
      const sent = await framesWhen<SessionStart>(arranged.wire, "sessionStart", 2);
      expect(sent[1]!.sessionId).toBe(waiting.id);
    });
  });

  it("ends a queued session on session.stop, without a word to the machine", async () => {
    await withFleet(async (arranged) => {
      await capAt(arranged, 1);
      await started(arranged, "hello");
      const waiting = await spawned(arranged, { prompt: "after you" });
      expect(waiting.status).toBe("queued");

      const response = await stop(arranged, waiting.id);

      expect(response.status, await response.clone().text()).toBe(200);
      const ended = await sessionWhen(arranged, waiting.id, (one) => one.status === "exited");
      expect(ended.exitedAt).not.toBeNull();
      await settled();
      expect(framesOf<SessionStopFrame>(arranged.wire, "sessionStop")).toEqual([]);
      expect(starts(arranged.wire)).toHaveLength(1);
    });
  });
});

describe("session.spawn and session.continue onto a runner nobody can reach", () => {
  it("queues a spawn onto a machine that is gone, and starts it when the machine is back", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.close();
      await wentAway(arranged);

      const response = await spawn(arranged, { prompt: "hello", runnerId: arranged.runnerId });

      expect(response.status, await response.clone().text()).toBe(200);
      const waiting = (await response.json()) as Session;
      expect(waiting.status).toBe("queued");
      expect(waiting.runnerId).toBe(arranged.runnerId);

      const again = await arranged.reconnect();
      again.send({ _tag: "sessionsReport", sessions: [] });

      await sessionWhen(arranged, waiting.id, (one) => one.status === "starting");
      const sent = await framesWhen<SessionStart>(again, "sessionStart", 1);
      expect(sent[0]!.sessionId).toBe(waiting.id);
    });
  });

  it("queues a continue onto a machine that is gone, and starts it when the machine is back", async () => {
    await withFleet(async (arranged) => {
      const parent = await ended(arranged, "hello");
      arranged.wire.close();
      await wentAway(arranged);

      const response = await carryOn(arranged, parent.id, { mode: "resume", prompt: "carry on" });

      expect(response.status, await response.clone().text()).toBe(200);
      const child = (await response.json()) as Session;
      expect(child.status).toBe("queued");
      expect(child.runnerId).toBe(arranged.runnerId);

      const again = await arranged.reconnect();
      again.send({ _tag: "sessionsReport", sessions: [] });

      await sessionWhen(arranged, child.id, (one) => one.status === "starting");
      const sent = await framesWhen<SessionStart>(again, "sessionStart", 1);
      expect(sent[0]!.spec.continue).toEqual({ nativeSessionId: "native-1", mode: "resume" });
    });
  });
});

describe("session.spawn onto a runner that is short of disk", () => {
  it("queues under the watermark and starts on a report at or above it", async () => {
    await withFleet(async (arranged) => {
      // Nothing reported yet: a machine that has said nothing about its disk is
      // taken at its word and given work.
      const first = await spawned(arranged, { prompt: "before any report" });
      expect(first.status).toBe("starting");
      exited(arranged.wire, first.id, 1);
      await sessionWhen(arranged, first.id, (one) => one.status === "exited");

      reportsDisk(arranged.wire, 4 * GIB);
      await until("stored the low reading", async () => {
        const response = await get(
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}`,
          arranged.token,
        );
        const runner = (await response.json()) as Runner;
        return runner.watermark?.diskFreeBytes === 4 * GIB ? runner : undefined;
      });

      const waiting = await spawned(arranged, { prompt: "no room" });

      expect(waiting.status).toBe("queued");
      await settled();
      expect(starts(arranged.wire).map((frame) => frame.sessionId)).toEqual([first.id]);

      reportsDisk(arranged.wire, 40 * GIB);

      await sessionWhen(arranged, waiting.id, (one) => one.status === "starting");
      const sent = await framesWhen<SessionStart>(arranged.wire, "sessionStart", 2);
      expect(sent[1]!.sessionId).toBe(waiting.id);
    });
  });

  it("starts a queued session when the owner lowers the watermark under the disk it has", async () => {
    await withFleet(async (arranged) => {
      reportsDisk(arranged.wire, 4 * GIB);
      await until("stored the low reading", async () => {
        const response = await get(
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}`,
          arranged.token,
        );
        const runner = (await response.json()) as Runner;
        return runner.watermark?.diskFreeBytes === 4 * GIB ? runner : undefined;
      });
      const waiting = await spawned(arranged, { prompt: "no room" });
      expect(waiting.status).toBe("queued");

      await watermarkAt(arranged, 1 * GIB);

      await sessionWhen(arranged, waiting.id, (one) => one.status === "starting");
      const sent = await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1);
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
const quiet = async (announced: Collected): Promise<number> => {
  let seen = -1;
  while (seen !== announced.received.length) {
    seen = announced.received.length;
    await settleLive();
  }
  return seen;
};

/** Has this machine say it holds exactly these sessions, each under a native id. */
const holds = (wire: Wire, arranged: Arranged, sessionIds: ReadonlyArray<string>): void =>
  wire.send({
    _tag: "sessionsReport",
    sessions: sessionIds.map((sessionId) => ({
      sessionId,
      nativeSessionId: `native-${sessionId}`,
      instanceId: instanceOf(arranged, "full-provider"),
    })),
  });

/** The session, started and then mid-turn: what the controller reads as busy. */
const busy = async (arranged: Arranged, prompt: string): Promise<Session> => {
  const session = await started(arranged, prompt);
  report(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "turn.started",
    turnId: `turn-${session.id}`,
  });
  return await sessionWhen(arranged, session.id, (one) => one.status === "busy");
};

/** A session placed by name on a second machine, and reported up as busy there. */
const busyOn = async (
  arranged: Arranged,
  machine: { readonly runnerId: string; readonly wire: Wire },
  prompt: string,
): Promise<Session> => {
  const session = await spawned(arranged, { prompt, runnerId: machine.runnerId });
  const base = { sessionId: session.id, at };
  report(machine.wire, 1, {
    ...base,
    eventId: crypto.randomUUID(),
    _tag: "session.started",
    providerRefs: { nativeSessionId: `native-${session.id}` },
  });
  report(machine.wire, 2, {
    ...base,
    eventId: crypto.randomUUID(),
    _tag: "turn.started",
    turnId: `turn-${session.id}`,
  });
  return await sessionWhen(arranged, session.id, (one) => one.status === "busy");
};

describe("what a machine's report says it is no longer holding", () => {
  it("ends the sessions the report leaves out, and leaves the listed one and another machine's alone", async () => {
    await withFleet(async (arranged) => {
      // This machine's three first, while it is the only one there is: an
      // automatic placement picks a machine, and these three have to be on the
      // one whose report is the subject.
      const running = await busy(arranged, "mid-turn here");
      const waiting = await started(arranged, "idle here");
      const opening = await spawned(arranged, { prompt: "still starting" });
      expect(opening.status).toBe("starting");
      expect(opening.runnerId).toBe(arranged.runnerId);
      const other = await arranged.enlist();
      const elsewhere = await busyOn(arranged, other, "on the other machine");
      // Every one of them has a native id before the report that ends two of
      // them, because what an ended session's resumability rests on is that id
      // and not the reason it stopped.
      holds(arranged.wire, arranged, [running.id, waiting.id, opening.id]);
      for (const id of [running.id, waiting.id, opening.id]) {
        await sessionWhen(arranged, id, (one) => one.nativeSessionId !== null);
      }

      holds(arranged.wire, arranged, [waiting.id]);

      for (const id of [running.id, opening.id]) {
        const gone = await sessionWhen(arranged, id, (one) => one.status === "exited");
        expect(gone.resumable, id).toBe(true);
        expect(gone.nativeSessionId, id).toBe(`native-${id}`);
        expect(gone.exitedAt, id).not.toBeNull();
      }
      expect((await readSession(arranged, waiting.id)).status).toBe("idle");
      expect((await readSession(arranged, elsewhere.id)).status).toBe("busy");
    });
  });

  it("announces the session topic for each session it ended", async () => {
    await withFleet(async (arranged) => {
      const running = await busy(arranged, "mid-turn here");
      const opening = await spawned(arranged, { prompt: "still starting" });
      holds(arranged.wire, arranged, [running.id, opening.id]);
      await sessionWhen(arranged, opening.id, (one) => one.nativeSessionId !== null);
      const ticket = await ticketFor(arranged.harness.base, arranged.token);

      await onSocket(arranged.harness.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const announced = yield* collecting(client, { topic: "session" });
          // Everything the spawns and the binding left in flight is collected
          // first and counted, so what is asserted below is what the report
          // caused rather than what was already on its way.
          const before = yield* Effect.promise(() => quiet(announced));

          yield* Effect.sync(() => holds(arranged.wire, arranged, []));

          const announces = (id: string): boolean =>
            announced.received
              .slice(before)
              .some((message) => (message as { ids?: ReadonlyArray<string> }).ids?.includes(id));
          for (const id of [running.id, opening.id]) {
            const heard = yield* Effect.promise(() => within(3000, () => announces(id)));
            expect(heard, id).toBe(true);
          }
          yield* Fiber.interrupt(announced.fiber);
        }),
      );
    });
  });

  it("changes nothing when the report still lists every session", async () => {
    await withFleet(async (arranged) => {
      const running = await busy(arranged, "mid-turn here");
      const waiting = await started(arranged, "idle here");
      const opening = await spawned(arranged, { prompt: "still starting" });

      holds(arranged.wire, arranged, [running.id, waiting.id, opening.id]);
      await sessionWhen(arranged, opening.id, (one) => one.nativeSessionId !== null);
      // A report is applied the moment it arrives; the wait is for a move that
      // must never come, so it is given the time one would have taken.
      await settled();

      expect((await readSession(arranged, running.id)).status).toBe("busy");
      expect((await readSession(arranged, waiting.id)).status).toBe("idle");
      expect((await readSession(arranged, opening.id)).status).toBe("starting");
    });
  });
});
