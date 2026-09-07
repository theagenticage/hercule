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
 * Four things are asserted and nothing else is. Spawning writes the row the
 * runner is then told about, with both access modes on it where the fallback
 * moved one. The status axis follows the events. The stream holds one coalesced
 * row per item rather than one per delta, and every other event verbatim. And a
 * sequence number the controller has already applied writes nothing, however
 * many times it arrives.
 */
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
  ControllerToRunner,
  PROTOCOL_VERSION,
  type ControllerToRunner as ControllerMessage,
  type JoinAnswer,
  type ProbeRequest,
  type ProviderEvent,
  type RunnerFacts,
  type RunnerToController as RunnerMessage,
  type SessionStart,
  type SessionInput as SessionInputFrame,
} from "@hydra/protocol";
import type { Plugin, ProviderDefinition } from "@hydra/plugin-host";
import type { Session } from "@hydra/contract";
import { completeSetup, get, post, send, withServer, type ServerHarness } from "../http/testing";
import { fixture, providerDefinition } from "../plugins/testing";

const SOCKET_PATH = "/api/v1/runners/socket";

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

const decodeFrame = (raw: unknown): ControllerMessage =>
  Effect.runSync(Schema.decodeUnknownEffect(ControllerToRunner)(raw));

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for something the controller does on its own schedule, and names it. */
const until = async <A>(what: string, look: () => A | undefined | Promise<A | undefined>) => {
  const deadline = Date.now() + 4000;
  do {
    const found = await look();
    if (found !== undefined) return found;
    await delay(5);
  } while (Date.now() < deadline);
  throw new Error(`the controller never ${what}`);
};

/** One machine's end of the socket, answering probes on its own. */
interface Wire {
  readonly send: (message: RunnerMessage) => void;
  readonly frames: ReadonlyArray<ControllerMessage>;
  readonly close: () => void;
}

const framesOf = <T extends ControllerMessage>(wire: Wire, tag: T["_tag"]): ReadonlyArray<T> =>
  wire.frames.filter((frame): frame is T => frame._tag === tag);

/**
 * Opens the socket with a credential, says hello, and answers every probe with
 * a logged-in report, which is what gives the controller something to place on.
 */
const dial = (base: string, credential: string): Promise<Wire> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace(/^http:/, "ws:")}${SOCKET_PATH}`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    const frames: Array<ControllerMessage> = [];
    const write = (message: RunnerMessage): void => socket.send(JSON.stringify(message));
    socket.onmessage = (event) => {
      const frame = decodeFrame(JSON.parse(String(event.data)) as unknown);
      frames.push(frame);
      if (frame._tag === "ping") write({ _tag: "pong" });
      if (frame._tag === "probeRequest") {
        const request = frame satisfies ProbeRequest;
        write({
          _tag: "probeReport",
          requestId: request.requestId,
          instanceId: request.instanceId,
          result: { harnessVersion: "1.0.0", auth: { status: "ok" }, models: MODELS },
        });
      }
    };
    socket.onopen = () => {
      write({
        _tag: "runnerHello",
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [],
        binaryVersion: "0.1.0",
        nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
        facts: FACTS,
      });
      resolve({ frames, send: write, close: () => socket.close() });
    };
    socket.onerror = () => reject(new Error("the controller refused the upgrade"));
    setTimeout(() => reject(new Error("the controller never upgraded the connection")), 3000);
  });

interface ProviderInstance {
  readonly id: string;
  readonly providerId: string;
  readonly snapshots: ReadonlyArray<unknown>;
}

/** The instances, once every one of them has been probed on this machine. */
const probed = async (base: string, token: string): Promise<ReadonlyArray<ProviderInstance>> =>
  until("probed every instance", async () => {
    const response = await get(base, "/api/v1/providers", token);
    const instances = (await response.json()) as ReadonlyArray<ProviderInstance>;
    return instances.every((instance) => instance.snapshots.length === 1) ? instances : undefined;
  });

interface Arranged {
  readonly harness: ServerHarness;
  readonly token: string;
  readonly wire: Wire;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly runnerId: string;
}

/** A controller with one enlisted, connected, logged-in machine on it. */
const withFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  withServer(
    async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await send("POST", harness.base, "/api/v1/runners/join", {
        body: {},
        token: await harness.joinToken(),
      });
      expect(joined.status, await joined.clone().text()).toBe(201);
      const answer = (await joined.json()) as JoinAnswer;
      const wire = await dial(harness.base, answer.credential);
      const instances = await probed(harness.base, token);
      try {
        await body({ harness, token, wire, instances, runnerId: answer.runnerId });
      } finally {
        wire.close();
      }
    },
    { plugins: registry() },
  );

const instanceOf = (arranged: Arranged, providerId: string): string => {
  const found = arranged.instances.find((instance) => instance.providerId === providerId);
  expect(found, providerId).toBeDefined();
  return found!.id;
};

const spawn = async (arranged: Arranged, body: unknown): Promise<Response> =>
  post(arranged.harness.base, "/api/v1/sessions", body, arranged.token);

const spawned = async (arranged: Arranged, body: unknown): Promise<Session> => {
  const response = await spawn(arranged, body);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Session;
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

const report = (wire: Wire, seq: number, event: ProviderEvent): void =>
  wire.send({ _tag: "sessionEvent", seq, event });

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

      const start = await until(
        "sent a sessionStart",
        () => framesOf<SessionStart>(arranged.wire, "sessionStart")[0],
      );
      expect(start.sessionId).toBe(session.id);
      expect(start.providerId).toBe("full-provider");
      expect(start.spec).toEqual({
        instanceId: session.instanceId,
        workspaceId: null,
        // The instance's default model, since neither the settings nor the
        // call named one.
        modelSelection: { model: "clever", options: {} },
        accessMode: "approval-required",
      });
    });
  });

  it("stores the spec byte for byte as the frame carries it", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "hello", model: "fast" });
      const start = await until(
        "sent a sessionStart",
        () => framesOf<SessionStart>(arranged.wire, "sessionStart")[0],
      );

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
      const start = await until(
        "sent a sessionStart",
        () => framesOf<SessionStart>(arranged.wire, "sessionStart")[0],
      );
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
      await until(
        "sent a sessionStart",
        () => framesOf<SessionStart>(arranged.wire, "sessionStart")[0],
      );

      report(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
      });

      const input = await until(
        "sent the prompt",
        () => framesOf<SessionInputFrame>(arranged.wire, "sessionInput")[0],
      );
      expect(input.sessionId).toBe(session.id);
      expect(input.input).toEqual({ text: "what is the time" });
    });
  });
});

describe("what a machine reports", () => {
  it("moves the status axis, coalesces the deltas, and ignores a sequence sent twice", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "hello" });
      await until(
        "sent a sessionStart",
        () => framesOf<SessionStart>(arranged.wire, "sessionStart")[0],
      );
      const events = transcript(session.id);

      report(arranged.wire, ...events[0]!);
      expect(
        (await sessionWhen(arranged, session.id, (one) => one.status === "idle")).startedAt,
      ).not.toBeNull();

      report(arranged.wire, ...events[1]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "busy");

      for (const [seq, event] of events.slice(2)) report(arranged.wire, seq, event);
      // The same frame again, as a replay after a reconnect would send it.
      report(arranged.wire, ...events[3]!);
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

      report(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.exited",
        reason: "stopped",
      });

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
      await delay(100);

      expect(await streamOf(arranged.harness, session.id)).toEqual([]);
      expect((await readSession(arranged, session.id)).status).toBe("starting");
    });
  });
});

describe("session.input", () => {
  it("opens a turn on an idle session and steers one that is busy", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "hello" });
      const events = transcript(session.id);
      report(arranged.wire, ...events[0]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "idle");

      const opened = await post(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/input`,
        { text: "again" },
        arranged.token,
      );
      expect(opened.status, await opened.clone().text()).toBe(200);
      expect(await opened.json()).toEqual({ result: "opened" });

      report(arranged.wire, ...events[1]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "busy");

      const steered = await post(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/input`,
        { text: "and this" },
        arranged.token,
      );
      expect(steered.status, await steered.clone().text()).toBe(200);
      expect(await steered.json()).toEqual({ result: "steered" });
      const sent = framesOf<SessionInputFrame>(arranged.wire, "sessionInput").map(
        (frame) => frame.input.text,
      );
      // The spawn's own prompt went first, when the harness came up.
      expect(sent).toEqual(["hello", "again", "and this"]);
    });
  });

  it("refuses a session that has not started, and one that has exited", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, { prompt: "hello" });

      const early = await post(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/input`,
        { text: "too soon" },
        arranged.token,
      );
      expect(early.status).toBe(409);
      expect(await early.text()).toContain("has not started");

      report(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.exited",
        reason: "stopped",
      });
      await sessionWhen(arranged, session.id, (one) => one.status === "exited");

      const late = await post(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/input`,
        { text: "too late" },
        arranged.token,
      );
      expect(late.status).toBe(409);
      expect(await late.text()).toContain("has exited");
    });
  });

  it("refuses to steer a provider that takes no input mid-turn", async () => {
    await withFleet(async (arranged) => {
      const session = await spawned(arranged, {
        prompt: "hello",
        instanceId: instanceOf(arranged, "limited-provider"),
      });
      const events = transcript(session.id);
      report(arranged.wire, ...events[0]!);
      report(arranged.wire, ...events[1]!);
      await sessionWhen(arranged, session.id, (one) => one.status === "busy");

      const response = await post(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/input`,
        { text: "mid-turn" },
        arranged.token,
      );

      expect(response.status).toBe(409);
      expect(await response.text()).toContain("queued input is not built yet");
    });
  });
});

describe("session.query and session.read", () => {
  it("lists the sessions newest first and filters by status", async () => {
    await withFleet(async (arranged) => {
      const first = await spawned(arranged, { prompt: "one" });
      const second = await spawned(arranged, { prompt: "two" });
      report(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: first.id,
        at,
        _tag: "session.exited",
        reason: "stopped",
      });
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
      const exited = (await filtered.json()) as { items: ReadonlyArray<Session> };
      expect(exited.items.map((one) => one.id)).toEqual([first.id]);
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
