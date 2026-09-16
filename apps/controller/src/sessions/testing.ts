/**
 * A fleet: one enlisted, connected, logged-in machine, for a test that spawns
 * a session and drives its transcript over the real runner socket. Shared
 * between this domain's own integration suite and the live socket's, because
 * both need the same wire and the same session - a second copy of a WebSocket
 * handshake is a second place for the two to drift apart.
 *
 * Each caller supplies its own plugins, facts and models: what a fleet spawns
 * sessions against is the test's own fixture, not this module's business. The
 * one exception is `withAgentFleet` at the bottom, for the suites that care
 * only that a session runs and carries a token.
 */
import { expect } from "vitest";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ControllerToRunner,
  PROTOCOL_VERSION,
  type ControllerToRunner as ControllerMessage,
  type Delivery,
  type JoinAnswer,
  type ModelDescriptor,
  type ProbeRequest,
  type RunnerFacts,
  type RunnerToController as RunnerMessage,
  type ProviderEvent,
  type SessionInput,
  type SessionStart,
} from "@hydra/protocol";
import type { Plugin } from "@hydra/plugin-host";
import type { Profile, Session } from "@hydra/contract";
import { fixture, providerDefinition } from "../plugins/testing";
import { completeSetup, get, post, send, withServer, type ServerHarness } from "../http/testing";

const SOCKET_PATH = "/api/v1/runners/socket";

/**
 * How long a wait on the controller is given, and vitest's own budget set from
 * it. A give-up wait longer than the test timeout never gets to give up: vitest
 * kills the test first, and the failure names the test rather than the thing
 * that never happened. The slack is for the fleet each case stands up first.
 */
export const WAIT_DEADLINE_MS = 10_000;

/** Waits for something the controller does on its own schedule, and names it. */
export const until = async <A>(
  what: string,
  look: () => A | undefined | Promise<A | undefined>,
): Promise<A> => {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  do {
    const found = await look();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  throw new Error(`the controller never ${what}`);
};

type Answered = Delivery | { readonly message: string } | undefined;

/** One machine's end of the socket, answering probes on its own. */
export interface Wire {
  readonly send: (message: RunnerMessage) => void;
  readonly frames: ReadonlyArray<ControllerMessage>;
  readonly close: () => void;
  /**
   * What this machine reports an input frame did: a delivery, a refusal with a
   * reason, or `undefined` to leave the frame unanswered, which is what a
   * machine that has gone quiet does.
   */
  readonly answering: (delivery: (frame: SessionInput) => Answered) => void;
  /** Answers every input frame this machine has been holding back, at last. */
  readonly release: (delivery: Delivery) => void;
}

export const framesOf = <T extends ControllerMessage>(
  wire: Wire,
  tag: T["_tag"],
): ReadonlyArray<T> => wire.frames.filter((frame): frame is T => frame._tag === tag);

/**
 * Waits until this many frames of a kind have arrived. A request is answered as
 * soon as the controller has written to the socket, which is before the frame
 * has crossed it: a test that reads `wire.frames` the moment a response lands
 * is asserting on a race rather than on an ordering.
 */
export const framesWhen = <T extends ControllerMessage>(
  wire: Wire,
  tag: T["_tag"],
  count: number,
): Promise<ReadonlyArray<T>> =>
  until(`sent ${String(count)} ${tag} frames`, () => {
    const found = framesOf<T>(wire, tag);
    return found.length >= count ? found : undefined;
  });

/** Has this machine report one normalized event, on the sequence it names. */
export const report = (wire: Wire, seq: number, event: ProviderEvent): void =>
  wire.send({ _tag: "sessionEvent", seq, event });

const decodeFrame = (raw: unknown): ControllerMessage =>
  Effect.runSync(Schema.decodeUnknownEffect(ControllerToRunner)(raw));

/**
 * Opens the socket with a credential, says hello, and answers every probe with
 * a logged-in report, which is what gives the controller something to place on.
 */
const dial = (
  base: string,
  credential: string,
  facts: RunnerFacts,
  models: ReadonlyArray<ModelDescriptor>,
): Promise<Wire> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace(/^http:/, "ws:")}${SOCKET_PATH}`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    const frames: Array<ControllerMessage> = [];
    let delivery: (frame: SessionInput) => Answered = () => "opened";
    const withheld: Array<SessionInput> = [];
    const write = (message: RunnerMessage): void => socket.send(JSON.stringify(message));
    socket.onmessage = (event) => {
      const frame = decodeFrame(JSON.parse(String(event.data)) as unknown);
      frames.push(frame);
      if (frame._tag === "ping") write({ _tag: "pong" });
      if (frame._tag === "sessionInput") {
        const answer = delivery(frame);
        if (typeof answer === "string") {
          write({
            _tag: "sessionInputResult",
            requestId: frame.requestId,
            ok: true,
            delivery: answer,
          });
        } else if (answer !== undefined) {
          write({ _tag: "sessionInputResult", requestId: frame.requestId, ok: false, ...answer });
        } else {
          withheld.push(frame);
        }
      }
      if (frame._tag === "probeRequest") {
        const request = frame satisfies ProbeRequest;
        write({
          _tag: "probeReport",
          requestId: request.requestId,
          instanceId: request.instanceId,
          result: { harnessVersion: "1.0.0", auth: { status: "ok" }, models },
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
        facts,
      });
      resolve({
        frames,
        send: write,
        close: () => socket.close(),
        answering: (next) => {
          delivery = next;
        },
        release: (answer) => {
          for (const held of withheld.splice(0)) {
            write({
              _tag: "sessionInputResult",
              requestId: held.requestId,
              ok: true,
              delivery: answer,
            });
          }
        },
      });
    };
    socket.onerror = () => reject(new Error("the controller refused the upgrade"));
    setTimeout(() => reject(new Error("the controller never upgraded the connection")), 3000);
  });

export interface ProviderInstance {
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

export interface Arranged {
  readonly harness: ServerHarness;
  readonly token: string;
  readonly wire: Wire;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly runnerId: string;
  /**
   * The same machine dialling in again, as one that was restarted or lost its
   * connection does: a second socket on the credential the join handed it.
   */
  readonly reconnect: () => Promise<Wire>;
  /**
   * A second machine on the same controller: joined on a token of its own,
   * dialled, and probed, so a session can be placed on it by name. What it is
   * for is the case that needs two machines to tell apart - what one machine
   * reports says nothing about what another one holds.
   */
  readonly enlist: () => Promise<Enlisted>;
}

/** A second machine, and the id a placement names it by. */
export interface Enlisted {
  readonly runnerId: string;
  readonly wire: Wire;
}

export interface FleetOptions {
  readonly plugins: ReadonlyArray<Plugin>;
  readonly facts: RunnerFacts;
  readonly models: ReadonlyArray<ModelDescriptor>;
  /** The shipped ten seconds is longer than a test that watches one give up can wait. */
  readonly inputDeadline?: Duration.Duration;
  /** The shipped ten minutes is longer than a test that watches the sweep can wait. */
  readonly workspaceSweepInterval?: Duration.Duration;
}

/** A controller with one enlisted, connected, logged-in machine on it. */
export const withFleet = (
  body: (arranged: Arranged) => Promise<void>,
  options: FleetOptions,
): Promise<void> =>
  withServer(
    async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await send("POST", harness.base, "/api/v1/runners/join", {
        body: {},
        token: await harness.joinToken(),
      });
      expect(joined.status, await joined.clone().text()).toBe(201);
      const answer = (await joined.json()) as JoinAnswer;
      const wire = await dial(harness.base, answer.credential, options.facts, options.models);
      // A real runner reports what it holds right after its hello (empty, on a
      // fresh connection); most callers want dispatch working from the first
      // line of their test body rather than plumbing this through themselves.
      // A test after the gap between hello and that report uses `reconnect`,
      // which leaves the new connection to send its own.
      wire.send({ _tag: "sessionsReport", sessions: [] });
      const wires: Array<Wire> = [wire];
      const reconnect = async (): Promise<Wire> => {
        const again = await dial(harness.base, answer.credential, options.facts, options.models);
        wires.push(again);
        return again;
      };
      const instances = await probed(harness.base, token);
      let machines = 1;
      const enlist = async (): Promise<Enlisted> => {
        const second = await send("POST", harness.base, "/api/v1/runners/join", {
          body: {},
          token: await harness.joinToken(),
        });
        expect(second.status, await second.clone().text()).toBe(201);
        const enlisted = (await second.json()) as JoinAnswer;
        const its = await dial(harness.base, enlisted.credential, options.facts, options.models);
        its.send({ _tag: "sessionsReport", sessions: [] });
        wires.push(its);
        machines += 1;
        // One snapshot per machine per instance, so a placement onto this one
        // has an answer to place against only once its own probes are in.
        await until("probed the machine it just enlisted", async () => {
          const response = await get(harness.base, "/api/v1/providers", token);
          const all = (await response.json()) as ReadonlyArray<ProviderInstance>;
          return all.every((instance) => instance.snapshots.length >= machines) ? all : undefined;
        });
        return { runnerId: enlisted.runnerId, wire: its };
      };
      try {
        await body({
          harness,
          token,
          wire,
          instances,
          runnerId: answer.runnerId,
          reconnect,
          enlist,
        });
      } finally {
        for (const one of wires) one.close();
      }
    },
    {
      plugins: options.plugins,
      ...(options.inputDeadline === undefined ? {} : { inputDeadline: options.inputDeadline }),
      ...(options.workspaceSweepInterval === undefined
        ? {}
        : { workspaceSweepInterval: options.workspaceSweepInterval }),
    },
  );

export const spawn = async (arranged: Arranged, body: unknown): Promise<Response> =>
  post(arranged.harness.base, "/api/v1/sessions", body, arranged.token);

export const spawned = async (arranged: Arranged, body: unknown): Promise<Session> => {
  const response = await spawn(arranged, body);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Session;
};

/**
 * Below: the fleet a test about *what the agent inside a session may do* needs.
 * That test does not care what the session runs, only that it runs and has a
 * token, so the fixture is this module's after all - and two suites arranging
 * the same machine, the same profile lookup and the same start frame twice is
 * two places for the arrangement to drift while the assertions stay put.
 */

const AGENT_PROVIDER = providerDefinition("full-provider", { token: "t" });

const AGENT_FACTS = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["full-provider"],
  identityPort: 4939,
} as const;

const AGENT_MODELS = [{ slug: "fast", name: "Fast", isDefault: true, options: [] }];

/** A fleet whose one machine can run a session on any shipped profile. */
export const withAgentFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  withFleet(body, {
    plugins: [fixture({ id: "providers", definitions: [AGENT_PROVIDER] }).plugin],
    facts: AGENT_FACTS,
    models: AGENT_MODELS,
  });

/** The instant every event a test reports carries. */
export const at = "2026-09-07T10:00:00.000Z";

/** One of the profiles the controller ships, by the name it ships under. */
export const profileNamed = async (arranged: Arranged, name: string): Promise<Profile> => {
  const response = await get(arranged.harness.base, "/api/v1/profiles", arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  const items = ((await response.json()) as { items: ReadonlyArray<Profile> }).items;
  const found = items.find((one) => one.name === name);
  expect(found, name).toBeDefined();
  return found!;
};

/** A profile of the test's own making, for a grant set no shipped one has. */
export const profileOf = async (
  arranged: Arranged,
  name: string,
  grants: ReadonlyArray<string>,
): Promise<Profile> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/profiles",
    { name, grants },
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Profile;
};

/** The start frames the controller has sent for one session, once there are this many. */
export const startFrames = (
  arranged: Arranged,
  sessionId: string,
  count: number,
): Promise<ReadonlyArray<SessionStart>> =>
  until(`sent ${String(count)} start frames for the session`, () => {
    const found = framesOf<SessionStart>(arranged.wire, "sessionStart").filter(
      (frame) => frame.sessionId === sessionId,
    );
    return found.length >= count ? found : undefined;
  });

export const readSession = async (arranged: Arranged, id: string): Promise<Session> => {
  const response = await get(arranged.harness.base, `/api/v1/sessions/${id}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Session;
};

/** Waits until the session reads back the way the caller is waiting for. */
export const sessionWhen = (
  arranged: Arranged,
  id: string,
  ready: (session: Session) => boolean,
): Promise<Session> =>
  until("moved the session", async () => {
    const session = await readSession(arranged, id);
    return ready(session) ? session : undefined;
  });

/**
 * The plaintext session token off a start frame. The frame is the only place
 * the plaintext is ever seen, which is exactly what the runner reads it from.
 */
export const tokenOf = (frame: SessionStart): string => {
  const token: unknown = frame.token;
  expect(
    typeof token === "string" && token !== "",
    "the sessionStart frame carries a non-empty session token",
  ).toBe(true);
  return frame.token;
};

/** A session on a profile, started, with the token its machine was handed. */
export interface Agent {
  readonly session: Session;
  readonly token: string;
}

export const agentOn = async (arranged: Arranged, profile: Profile): Promise<Agent> => {
  const opened = await spawned(arranged, { prompt: "hello", permissionProfileId: profile.id });
  const token = tokenOf((await startFrames(arranged, opened.id, 1))[0]!);
  report(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: opened.id,
    at,
    _tag: "session.started",
    providerRefs: { nativeSessionId: "native-1" },
  });
  const session = await sessionWhen(arranged, opened.id, (one) => one.status === "idle");
  return { session, token };
};
