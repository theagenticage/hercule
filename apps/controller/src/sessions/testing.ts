/**
 * Test helpers for a fleet of one joined, connected, logged-in runner, for a
 * test that spawns a session and drives its transcript over the real runner
 * socket. This domain's integration suite and the live socket's suite share
 * these helpers because both need the same socket and the same session. A
 * second copy of the WebSocket handshake would be a second place for the two
 * to drift apart.
 *
 * Each caller passes its own plugins, facts and models, because what a fleet
 * spawns sessions against is the test's own fixture. The exception is
 * `withAgentFleet` at the bottom, for suites that only need a session that
 * runs and has a token.
 */
import { expect } from "vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  AGENT_STEPS_CAPABILITY,
  ATTACHMENTS_CAPABILITY,
  WORKSPACE_LIFECYCLE_CAPABILITY,
  buildWorkspaceActionCapability,
  ControllerToRunner,
  PROTOCOL_VERSION,
  type ControllerToRunner as ControllerMessage,
  type Delivery,
  type FrameCarryingInput,
  type JoinAnswer,
  type ModelDescriptor,
  type ProbeRequest,
  type RunnerFacts,
  type RunnerToController as RunnerMessage,
  type ProviderEvent,
  type SessionStart,
} from "@hercule/protocol";
import type { Plugin } from "@hercule/plugin-host";
import type { Grant, Input, Notification, Profile, Runner, Session } from "@hercule/contract";
import { WORKSPACE_ACTION_IDS } from "../plugins";
import { createPluginFixture, buildProviderDefinition } from "../plugins/testing";
import {
  completeSetup,
  get,
  post,
  send,
  withServer,
  type ServerHarness,
  type ServerOptions,
} from "../http/testing";

const SOCKET_PATH = "/api/v1/runners/socket";

/**
 * The capabilities a runner of this build lists at hello: every workspace
 * action the controller's catalog knows, agent steps, and images in inputs.
 */
const CURRENT_CAPABILITIES: ReadonlyArray<string> = [
  ...[...WORKSPACE_ACTION_IDS].map(buildWorkspaceActionCapability),
  AGENT_STEPS_CAPABILITY,
  WORKSPACE_LIFECYCLE_CAPABILITY,
  ATTACHMENTS_CAPABILITY,
];

/**
 * How long `waitUntil` waits for the controller. Suites set vitest's test
 * timeout from it, with extra time for the fleet each test sets up first. A
 * wait longer than the test timeout never gets to fail on its own: vitest
 * kills the test first, and the failure names the test instead of the thing
 * that never happened.
 */
export const WAIT_DEADLINE_MS = 10_000;

/**
 * Polls `look` until it returns a value, and returns that value. Fails after
 * `WAIT_DEADLINE_MS` with an error that includes `what`, the thing the
 * controller never did.
 */
export const waitUntil = async <A>(
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

/** A runner's answer to an input: a delivery, or a refusal with its message. */
type Answer = Delivery | { readonly message: string };

type Answered = Answer | undefined;

/** Checks whether a frame sent to a runner carries an input the runner answers. */
export const carriesInput = (frame: ControllerMessage): frame is FrameCarryingInput =>
  frame._tag === "sessionInput" || frame._tag === "sessionStart";

/** A fake runner's end of the socket. It answers pings and probes by itself. */
export interface Wire {
  readonly send: (message: RunnerMessage) => void;
  readonly frames: ReadonlyArray<ControllerMessage>;
  readonly close: () => void;
  /**
   * Sets how this runner answers the input an input frame or a start frame
   * carries: with a delivery, with an error message, or with `undefined` to
   * leave the frame unanswered, like a runner that has stopped responding.
   */
  readonly answering: (delivery: (frame: FrameCarryingInput) => Answered) => void;
  /**
   * Answers every input this runner has left unanswered so far, with a
   * delivery or with a refusal.
   */
  readonly release: (answer: Answer) => void;
}

export const listFrames = <T extends ControllerMessage>(
  wire: Wire,
  tag: T["_tag"],
): ReadonlyArray<T> => wire.frames.filter((frame): frame is T => frame._tag === tag);

/**
 * Waits until at least `count` frames with this tag have arrived, and returns
 * them. An HTTP request can return as soon as the controller has written a
 * frame to the socket, before the frame has arrived. So a test that reads
 * `wire.frames` right after a response would be testing a race.
 */
export const waitForFrames = <T extends ControllerMessage>(
  wire: Wire,
  tag: T["_tag"],
  count: number,
): Promise<ReadonlyArray<T>> =>
  waitUntil(`sent ${String(count)} ${tag} frames`, () => {
    const found = listFrames<T>(wire, tag);
    return found.length >= count ? found : undefined;
  });

/** Sends one normalized event from this runner, with the given sequence number. */
export const reportEvent = (wire: Wire, seq: number, event: ProviderEvent): void =>
  wire.send({ _tag: "sessionEvent", seq, event });

const decodeFrame = (raw: unknown): ControllerMessage =>
  Effect.runSync(Schema.decodeUnknownEffect(ControllerToRunner)(raw));

/**
 * Opens the socket with a runner credential, sends the hello with
 * `capabilities`, and answers every probe with a logged-in report, so the
 * controller can place sessions on this runner.
 */
const dial = (
  base: string,
  credential: string,
  facts: RunnerFacts,
  models: ReadonlyArray<ModelDescriptor>,
  capabilities: ReadonlyArray<string> = CURRENT_CAPABILITIES,
): Promise<Wire> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace(/^http:/, "ws:")}${SOCKET_PATH}`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    const frames: Array<ControllerMessage> = [];
    let decideDelivery: (frame: FrameCarryingInput) => Answered = () => "opened";
    const withheld: Array<FrameCarryingInput> = [];
    const writeMessage = (message: RunnerMessage): void => socket.send(JSON.stringify(message));
    const writeAnswer = (frame: FrameCarryingInput, answer: Answer): void =>
      writeMessage(
        typeof answer === "string"
          ? { _tag: "sessionInputResult", requestId: frame.requestId, ok: true, delivery: answer }
          : { _tag: "sessionInputResult", requestId: frame.requestId, ok: false, ...answer },
      );
    socket.onmessage = (event) => {
      const frame = decodeFrame(JSON.parse(String(event.data)) as unknown);
      frames.push(frame);
      if (frame._tag === "ping") writeMessage({ _tag: "pong" });
      if (carriesInput(frame)) {
        const answer = decideDelivery(frame);
        if (answer === undefined) withheld.push(frame);
        else writeAnswer(frame, answer);
      }
      if (frame._tag === "probeRequest") {
        const request = frame satisfies ProbeRequest;
        writeMessage({
          _tag: "probeReport",
          requestId: request.requestId,
          instanceId: request.instanceId,
          result: { harnessVersion: "1.0.0", auth: { status: "ok" }, models },
        });
      }
    };
    socket.onopen = () => {
      writeMessage({
        _tag: "runnerHello",
        protocolVersion: PROTOCOL_VERSION,
        capabilities,
        binaryVersion: "0.1.0",
        nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
        facts,
      });
      resolve({
        frames,
        send: writeMessage,
        close: () => socket.close(),
        answering: (next) => {
          decideDelivery = next;
        },
        release: (answer) => {
          for (const held of withheld.splice(0)) writeAnswer(held, answer);
        },
      });
    };
    socket.onerror = () => reject(new Error("the controller rejected the WebSocket upgrade"));
    setTimeout(() => reject(new Error("the controller never upgraded the connection")), 3000);
  });

export interface ProviderInstance {
  readonly id: string;
  readonly providerId: string;
  readonly snapshots: ReadonlyArray<unknown>;
}

/** Waits until every provider instance has been probed on this runner, and returns the instances. */
const waitForEveryInstanceProbed = async (
  base: string,
  token: string,
): Promise<ReadonlyArray<ProviderInstance>> =>
  waitUntil("probed every instance", async () => {
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
  /** The credential the runner got when it joined, which it presents on the socket and on HTTP. */
  readonly credential: string;
  /**
   * Connects the same runner again, like one that restarted or lost its
   * connection: a second socket with the credential from the join.
   */
  readonly reconnect: (options?: {
    readonly capabilities?: ReadonlyArray<string>;
  }) => Promise<Wire>;
  /**
   * Adds a second runner to the same controller: joined with its own token,
   * connected, and probed, so a session can be placed on it by name. It is for
   * tests that need two separate runners, because one runner's reports do not
   * cover another runner's sessions.
   *
   * It lists the capabilities of a runner of this build at hello, unless
   * `capabilities` replaces them, for example to play a runner on an older
   * build that lacks a workspace action.
   */
  readonly enlist: (options?: {
    readonly capabilities?: ReadonlyArray<string>;
  }) => Promise<Enlisted>;
}

/** A second runner, and the id a placement uses for it. */
export interface Enlisted {
  readonly runnerId: string;
  readonly wire: Wire;
}

/**
 * The controller's server options, plus what the fleet needs: the runner's
 * facts and models, and the plugins, which a fleet cannot do without.
 */
export type FleetOptions = Omit<ServerOptions, "plugins" | "readLocalRunnerId"> & {
  readonly plugins: ReadonlyArray<Plugin>;
  readonly facts: RunnerFacts;
  readonly models: ReadonlyArray<ModelDescriptor>;
  /**
   * Makes the fleet's first runner the controller's local runner. Without it
   * the controller has no local runner. A runner added with `enlist` is never
   * the local one.
   */
  readonly firstRunnerIsLocal?: true;
};

/**
 * Runs `body` against a controller with one joined, connected, logged-in
 * runner.
 *
 * The fleet's own options are taken out and the rest are passed to the
 * controller unchanged, so a caller can use a new server option without this
 * file changing.
 */
export const withFleet = (
  body: (arranged: Arranged) => Promise<void>,
  { facts, models, firstRunnerIsLocal, ...server }: FleetOptions,
): Promise<void> => {
  // The runner's id is known only once it joins, after the server is up.
  let localRunnerId: string | undefined;
  const options = { ...server, readLocalRunnerId: () => localRunnerId };
  return withServer(async (harness) => {
    const token = await completeSetup(harness.base);
    const joined = await send("POST", harness.base, "/api/v1/runners/join", {
      body: {},
      token: await harness.joinToken(),
    });
    expect(joined.status, await joined.clone().text()).toBe(201);
    const answer = (await joined.json()) as JoinAnswer;
    // Set before the runner connects, so every dispatch to it sees it as the
    // local runner.
    if (firstRunnerIsLocal === true) localRunnerId = answer.runnerId;
    const wire = await dial(harness.base, answer.credential, facts, models);
    // A real runner reports its sessions right after its hello (none, on a
    // fresh connection). Most tests want dispatch working from their first
    // line, so this sends that report for them. A test that needs the gap
    // between the hello and the report uses `reconnect`, which does not send
    // one.
    wire.send({ _tag: "sessionsReport", sessions: [] });
    const wires: Array<Wire> = [wire];
    const reconnect = async (
      options: { readonly capabilities?: ReadonlyArray<string> } = {},
    ): Promise<Wire> => {
      const again = await dial(
        harness.base,
        answer.credential,
        facts,
        models,
        options.capabilities,
      );
      wires.push(again);
      return again;
    };
    const instances = await waitForEveryInstanceProbed(harness.base, token);
    let machines = 1;
    const enlist = async (
      options: { readonly capabilities?: ReadonlyArray<string> } = {},
    ): Promise<Enlisted> => {
      const second = await send("POST", harness.base, "/api/v1/runners/join", {
        body: {},
        token: await harness.joinToken(),
      });
      expect(second.status, await second.clone().text()).toBe(201);
      const enlisted = (await second.json()) as JoinAnswer;
      const its = await dial(
        harness.base,
        enlisted.credential,
        facts,
        models,
        options.capabilities,
      );
      its.send({ _tag: "sessionsReport", sessions: [] });
      wires.push(its);
      machines += 1;
      // There is one snapshot per runner per instance, so a session can be
      // placed on the new runner only once its own probes are in.
      await waitUntil("probed the machine it just enlisted", async () => {
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
        credential: answer.credential,
        reconnect,
        enlist,
      });
    } finally {
      for (const one of wires) one.close();
    }
  }, options);
};

/** Returns the id of the provider instance created for a provider, by the provider's id. */
export const findInstanceId = (arranged: Arranged, providerId: string): string => {
  const found = arranged.instances.find((instance) => instance.providerId === providerId);
  expect(found, providerId).toBeDefined();
  return found!.id;
};

/** Returns every session, as the API returns them. */
export const listSessions = async (arranged: Arranged): Promise<ReadonlyArray<Session>> => {
  const response = await get(arranged.harness.base, "/api/v1/sessions", arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Session> }).items;
};

/**
 * Returns the approval notifications about a session's requests, newest
 * first, as `notification.query` returns them. The query cannot filter by
 * subject, so the notifications about other sessions are dropped here.
 */
export const readApprovalNotifications = async (
  arranged: Arranged,
  sessionId: string,
): Promise<ReadonlyArray<Notification>> => {
  const response = await get(
    arranged.harness.base,
    "/api/v1/notifications?kind=core.approval",
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const page = (await response.json()) as { readonly items: ReadonlyArray<Notification> };
  return page.items.filter((notification) =>
    (notification.subject ?? []).some(
      (subject) => subject.kind === "request" && subject.sessionId === sessionId,
    ),
  );
};

/**
 * Waits until the one approval notification about a session's request is
 * resolved, and returns it.
 */
export const waitForResolvedApprovalNotification = (
  arranged: Arranged,
  sessionId: string,
): Promise<Notification> =>
  waitUntil("resolved the approval notification", async () => {
    const [notification] = await readApprovalNotifications(arranged, sessionId);
    return notification?.status === "resolved" ? notification : undefined;
  });

/** Returns one session's inputs, oldest first, as the API returns them. */
export const listInputs = async (arranged: Arranged, id: string): Promise<ReadonlyArray<Input>> => {
  const response = await get(
    arranged.harness.base,
    `/api/v1/sessions/${id}/inputs`,
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Input> }).items;
};

export const spawnSession = async (arranged: Arranged, body: unknown): Promise<Response> =>
  post(arranged.harness.base, "/api/v1/sessions", body, arranged.token);

export const spawnSessionOrFail = async (arranged: Arranged, body: unknown): Promise<Session> => {
  const response = await spawnSession(arranged, body);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Session;
};

/**
 * Below: the fleet for tests about what the agent inside a session may do.
 * Those tests do not care what the session runs, only that it runs and has a
 * token, so this module provides the fixture. Several suites use it, so the
 * runner, the profile lookup and the start frame are set up in one place.
 */

const AGENT_PROVIDER = buildProviderDefinition("full-provider", { token: "t" });

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

const AGENT_MODELS = [
  { slug: "fast", name: "Fast", acceptsImages: true, isDefault: true, options: [] },
];

/**
 * Runs `body` against a fleet whose one runner can run a session on any
 * built-in profile. The controller loads the agent provider's plugin, and
 * `plugins` beside it.
 */
export const withAgentFleet = (
  body: (arranged: Arranged) => Promise<void>,
  {
    plugins = [],
    ...options
  }: Omit<FleetOptions, "plugins" | "facts" | "models"> & {
    readonly plugins?: ReadonlyArray<Plugin>;
  } = {},
): Promise<void> =>
  withFleet(body, {
    plugins: [
      createPluginFixture({ id: "providers", definitions: [AGENT_PROVIDER] }).plugin,
      ...plugins,
    ],
    facts: AGENT_FACTS,
    models: AGENT_MODELS,
    ...options,
  });

/** The timestamp on every event a test reports. */
export const at = "2026-09-07T10:00:00.000Z";

/** Reports that a turn started on the session, as turn `t<seq>`, at sequence number `seq`. */
export const reportTurnStarted = (arranged: Arranged, sessionId: string, seq: number): void =>
  reportEvent(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "turn.started",
    turnId: `t${String(seq)}`,
  });

/**
 * Reports that the session's turn completed, at sequence number `seq`. The
 * turn is `t<seq - 1>`: the one `reportTurnStarted` opened at the sequence
 * number before.
 */
export const reportTurnCompleted = (arranged: Arranged, sessionId: string, seq: number): void =>
  reportEvent(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "turn.completed",
    turnId: `t${String(seq - 1)}`,
    state: "completed",
  });

/** Returns one of the controller's built-in profiles, by name. */
export const readProfileNamed = async (arranged: Arranged, name: string): Promise<Profile> => {
  const response = await get(arranged.harness.base, "/api/v1/profiles", arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  const items = ((await response.json()) as { items: ReadonlyArray<Profile> }).items;
  const found = items.find((one) => one.name === name);
  expect(found, name).toBeDefined();
  return found!;
};

/** Creates a profile with the given grants, for a grant set no built-in profile has. */
export const createProfile = async (
  arranged: Arranged,
  name: string,
  grants: ReadonlyArray<Grant>,
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

/** Waits until the controller has sent at least `count` start frames for a session, and returns them. */
export const waitForStartFrames = (
  arranged: Arranged,
  sessionId: string,
  count: number,
): Promise<ReadonlyArray<SessionStart>> =>
  waitUntil(`sent ${String(count)} start frames for the session`, () => {
    const found = listFrames<SessionStart>(arranged.wire, "sessionStart").filter(
      (frame) => frame.sessionId === sessionId,
    );
    return found.length >= count ? found : undefined;
  });

export const readSession = async (arranged: Arranged, id: string): Promise<Session> => {
  const response = await get(arranged.harness.base, `/api/v1/sessions/${id}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Session;
};

/** Waits until `ready` returns true for the session, and returns the session. */
export const waitForSession = (
  arranged: Arranged,
  id: string,
  ready: (session: Session) => boolean,
): Promise<Session> =>
  waitUntil("moved the session", async () => {
    const session = await readSession(arranged, id);
    return ready(session) ? session : undefined;
  });

/**
 * Waits until the controller has seen the runner's socket close, and returns
 * the runner. Once the runner no longer reads `online`, the controller has
 * dropped its connection, so a frame sent then fails for that reason and not
 * because of a race. A socket that closes without a goodbye leaves the runner
 * `unreachable`.
 */
export const waitForRunnerGone = (arranged: Arranged): Promise<Runner> =>
  waitUntil("saw the runner disconnect", async () => {
    const response = await get(
      arranged.harness.base,
      `/api/v1/runners/${arranged.runnerId}`,
      arranged.token,
    );
    const runner = (await response.json()) as Runner;
    return runner.connectivity === "online" ? undefined : runner;
  });

/**
 * Returns the plaintext session token from a start frame. The frame is the
 * only place the plaintext appears, and the runner reads it from there too.
 */
export const readSessionToken = (frame: SessionStart): string => {
  const token: unknown = frame.token;
  expect(
    typeof token === "string" && token !== "",
    "the sessionStart frame carries a non-empty session token",
  ).toBe(true);
  return frame.token;
};

/**
 * A Thread a test spawned: the session, which has no Agent behind it, and the
 * session token its runner received. A test calls the API with the token to
 * act as that session.
 */
export interface SpawnedThread {
  readonly session: Session;
  readonly token: string;
}

/**
 * Spawns and starts a Thread on a new profile with exactly these grants. The
 * profile is created for the test, because a session's grants are the only
 * way to limit what the agent inside it may do.
 */
export const spawnThreadWithGrants = async (
  arranged: Arranged,
  name: string,
  grants: ReadonlyArray<Grant>,
): Promise<SpawnedThread> =>
  spawnThreadUnder(arranged, await createProfile(arranged, name, grants));

/**
 * Spawns and starts a Thread on `profile`: a session with no Agent, so its
 * `agentId` is null. Waits until the runner has answered its prompt, and
 * returns the session, which is then `busy`, with its session token.
 *
 * A test that needs a session spawned from an Agent must create the Agent and
 * spawn from it; this helper never does.
 *
 * The start frame carries the prompt, and the fake runner answers it with
 * `opened` and reports no turn events, so the session stays `busy` with its
 * prompt's turn until the test reports that turn's end. The runner has
 * reported one event, `session.started` at sequence number 1, so the test's
 * next event is 2.
 */
export const spawnThreadUnder = async (
  arranged: Arranged,
  profile: Profile,
): Promise<SpawnedThread> => {
  const opened = await spawnSessionOrFail(arranged, {
    prompt: "hello",
    permissionProfileId: profile.id,
  });
  const token = readSessionToken((await waitForStartFrames(arranged, opened.id, 1))[0]!);
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: opened.id,
    at,
    _tag: "session.started",
    providerRefs: { nativeSessionId: "native-1" },
  });
  const session = await waitForSession(arranged, opened.id, (one) => one.status === "busy");
  return { session, token };
};
