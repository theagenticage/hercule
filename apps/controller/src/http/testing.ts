/**
 * Test helpers that run the controller over a real socket. The repositories
 * are the real ones; nothing is mocked.
 *
 * Everything a request passes through in production is in this stack: the
 * envelope, the pre-setup gate, the derived routes, both credential
 * middlewares and every service. Only the database (`:memory:`), the master
 * key (a file in a temporary home) and the port (ephemeral) differ.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import {
  live,
  type LiveMessage,
  type LiveTopic,
  type Runner,
  type RunnerConnectivity,
  type RunnerLifecycle,
} from "@hercule/contract";
import type { Plugin } from "@hercule/plugin-host";
import { buildHomePaths } from "@hercule/home";
import { HerculeHome } from "../config";
import { ConnectionServiceLayer, ConnectionTypesLayer } from "../connections";
import { CredentialsLayer, hashToken } from "../credentials";
import {
  cancelStrandedInputsAndReportLostWakeUps,
  EventRoutingInterval,
  LostRunnerSweepInterval,
  RunFibers,
  SessionInputDeadline,
  WorkspaceSweepInterval,
} from "../daemon";
import { ExpressionBudget } from "../expressions";
import { nowIso } from "../db";
import { TestDatabase } from "../db/testing";
import {
  AuditLog,
  AuditLogLayer,
  PlatformEvents,
  PlatformEventsLayer,
  type AuditKind,
  type AuditRow,
  type PlatformEventKind,
  type PlatformEventRow,
} from "../events";
import { ControllerIdentity, controllerIdentityLayer } from "../identity";
import { COALESCE_WINDOW_MS, LiveTopics } from "../live";
import { masterKeyLayer, secretsLayer } from "../secrets";
import { PermissionProfilesLayer, SessionTokensLayer } from "../permissions";
import { PluginConfigsLayer, PluginHost, PluginHostLayer, PluginsLayer } from "../plugins";
import { createPluginFixture } from "../plugins/testing";
import {
  ensureProviderInstances,
  ProviderLoginDeadline,
  ProviderProbeDeadline,
  ProviderProbeInterval,
  ProviderProbesLayer,
  ProviderServiceLayer,
} from "../providers";
import { SessionServiceLayer } from "../sessions";
import { AssistantSessionObserverLayer } from "../assistants";
import { ConversationMessagesLayer } from "../conversations";
import { ResourceServiceLayer } from "../resources";
import { EvaluationErrorNotifier, EvaluationErrorNotifierLayer } from "../subscriptions";
import { SettingsLayer } from "../settings";
import { RunWorkspaceStepActivityLayer } from "../runs";
import { WorkspaceServiceLayer } from "../workspaces";
import {
  JoinTokens,
  JoinTokensLayer,
  RunnerFactsDeadline,
  RunnerPingSchedule,
  RunnerConnectionsLayer,
  runnerRepository,
  type RunnerPings,
} from "../runners";
import { resumeUnfinishedRuns } from "../runs";
import { PasswordCost, TEST_PASSWORD_PARAMS, UsersLayer } from "../users";
import { seed } from "../seed";
import { operationLayers } from "./routes";
import { bodyLimits, serve } from "./server";
import type { WebBundle } from "./static";

/** The setup token the test server starts with, and the password `completeSetup` sets. */
export const SETUP_TOKEN = "a-setup-token";
export const PASSWORD = "correct horse battery staple";
export const USERNAME = "rogier";

/**
 * Every service the routes use, on one `:memory:` database. The plugin host is
 * built here rather than with the operation layers, because the boot and the
 * routes must share one instance: a request must read the status the boot's
 * activation wrote.
 */
const buildServices = (home: string, notifier: Layer.Layer<EvaluationErrorNotifier>) =>
  // The routes' layer includes the controller daemon, which uses the session
  // and workspace services and the plugin host. So this block's output is
  // provided to it rather than merged next to it, just as the real boot
  // provides what `withPlugins` built to the operation layers.
  operationLayers.pipe(
    Layer.provide(notifier),
    Layer.provideMerge(
      Layer.mergeAll(
        PluginsLayer,
        ProviderServiceLayer,
        // Observed by the assistants domain, as in the real boot, so a
        // session's replies and notices reach its conversation.
        SessionServiceLayer.pipe(
          Layer.provide(AssistantSessionObserverLayer),
          Layer.provide(ConversationMessagesLayer),
        ),
        ConnectionServiceLayer,
        ResourceServiceLayer,
      ).pipe(
        // As in the real boot: sessions take and release workspace leases,
        // and the workspace service asks the runs domain whether a workspace
        // step is running.
        Layer.provideMerge(WorkspaceServiceLayer),
        Layer.provideMerge(RunWorkspaceStepActivityLayer),
      ),
    ),
    // One connection map and one probe driver: the socket route and every
    // service must use the same `RunnerConnections`. The catalog is provided
    // to the probe driver, which reads provider definitions from it.
    Layer.provideMerge(
      ProviderProbesLayer.pipe(
        Layer.provideMerge(RunnerConnectionsLayer),
        Layer.provideMerge(
          PluginHostLayer.pipe(
            Layer.provideMerge(ConnectionTypesLayer),
            Layer.provideMerge(PluginConfigsLayer),
          ),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        UsersLayer,
        CredentialsLayer,
        SettingsLayer,
        PermissionProfilesLayer,
        AuditLogLayer,
        PlatformEventsLayer,
        controllerIdentityLayer,
        JoinTokensLayer,
        SessionTokensLayer,
      ),
    ),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HerculeHome, buildHomePaths(home, join(home, "data")))),
  );

/**
 * Returns the plugins a test controller boots: the test's own, plus a
 * provider plugin when none of the test's plugins offers providers. Setup
 * creates the default assistant, which needs a provider instance, so a
 * controller with no provider cannot finish setup. The provider plugin is
 * built per call, so it holds nothing from a controller that has finished.
 */
const buildPluginRegistry = (plugins: ReadonlyArray<Plugin>): ReadonlyArray<Plugin> =>
  plugins.some((plugin) => plugin.manifest.capabilities.includes("providers"))
    ? plugins
    : [...plugins, createPluginFixture({ id: "test" }).plugin];

/** Returns an address `fetch` can use; the server binds an ephemeral port on loopback. */
export const baseUrl = Effect.map(HttpServer.HttpServer, (server) => {
  const address = server.address;
  if (address._tag !== "TcpAddress") throw new Error("expected a TCP address");
  return `http://127.0.0.1:${address.port}`;
});

/** Reads back what a request wrote to the audit log. */
export type AuditReader = (kind: AuditKind) => Promise<ReadonlyArray<AuditRow>>;

/** Reads back the platform events of one kind the controller emitted, oldest first. */
export type PlatformEventReader = (
  kind: PlatformEventKind,
) => Promise<ReadonlyArray<PlatformEventRow>>;

/**
 * Inserts a runner row. No operation adds a runner (a runner joins over the
 * runner protocol), so a test that needs a fleet writes one through the same
 * repository the join uses.
 */
export type RunnerArranger = (fields: {
  readonly name: string;
  readonly connectivity?: RunnerConnectivity;
  readonly lifecycle?: RunnerLifecycle;
  readonly reserved?: boolean;
  readonly labels?: ReadonlyArray<string>;
  /** A session cap override. When absent, the cap is derived from what the runner reports. */
  readonly maxConcurrentSessions?: number;
}) => Promise<Runner>;

/**
 * Mints a join token. A person gets one through `runner.createJoinToken`, but
 * that needs a credential, and a runner can join before anyone has one. The
 * controller's first boot mints a token for its local runner through this
 * same repository.
 */
export type JoinTokenArranger = () => Promise<string>;

/**
 * Restarts the controller in place: stops the fibers executing runs, then
 * runs the boot's idempotent steps again, as a restart does on a database
 * already in use, and resumes the unfinished runs.
 */
export type RebootArranger = () => Promise<void>;

/**
 * The services the boot steps need. The type is inferred rather than listed,
 * so a step added to the boot cannot leave a stale list behind.
 */
const makeRepeatable = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<() => Promise<A>, never, R> =>
  Effect.map(
    Effect.context<R>(),
    (services) => () => Effect.runPromiseWith(services)(Effect.orDie(effect)),
  );

/** Reads the subscriptions the controller holds for clients on its live socket. */
export interface LiveReader {
  readonly subscriberCount: (topic: LiveTopic) => Promise<number>;
}

/** What a test receives: the running controller, and helpers to inspect it. */
export interface ServerHarness {
  /** An address a fetch can use. */
  readonly base: string;
  readonly audit: AuditReader;
  readonly platformEvents: PlatformEventReader;
  readonly sql: SqlClient.SqlClient;
  readonly live: LiveReader;
  readonly insertRunner: RunnerArranger;
  readonly joinToken: JoinTokenArranger;
  readonly reboot: RebootArranger;
  /**
   * Checks whether a fiber is still executing the run. A cancelled run's
   * fiber lives on until its steps have stopped, so a test that checks what a
   * step does after the cancel waits for this to turn false first.
   */
  readonly isRunExecuting: (runId: string) => boolean;
}

/** The options a test can set on the controller it runs. */
export interface ServerOptions {
  readonly bundle?: WebBundle;
  /**
   * How often the controller pings a connected runner, and how long a runner
   * may stay silent. The defaults are tens of seconds, which no test can wait
   * for, and a real Bun listener cannot use a `TestClock`, so a test about
   * liveness sets its own.
   */
  readonly pings?: RunnerPings;
  /**
   * How long the controller waits for a runner to reply to a request for its
   * facts. The default of ten seconds is longer than a test can wait.
   */
  readonly factsDeadline?: Duration.Duration;
  /** The default fifteen seconds and one hour are both longer than a test can wait. */
  readonly probeDeadline?: Duration.Duration;
  readonly probeInterval?: Duration.Duration;
  readonly loginDeadline?: Duration.Duration;
  /** How long a delivered input waits for the runner to report what it did with it. */
  readonly inputDeadline?: Duration.Duration;
  /** The default ten minutes is longer than a test can wait. */
  readonly workspaceSweepInterval?: Duration.Duration;
  /** The default second is too long for a test that waits several ticks. */
  readonly eventRoutingInterval?: Duration.Duration;
  /** The default minute is longer than a test can wait. */
  readonly lostRunnerSweepInterval?: Duration.Duration;
  /**
   * How long one evaluation of a condition may run before it is reported as
   * over budget. A test that wants every evaluation reported sets a budget no
   * evaluation can stay under, because the evaluator has no other option for
   * this.
   */
  readonly expressionBudget?: Duration.Duration;
  /**
   * Where notifications of evaluation errors go. The default notifier does
   * nothing, so a test that checks notifications passes its own.
   */
  readonly evaluationErrorNotifier?: Layer.Layer<EvaluationErrorNotifier>;
  /**
   * The plugin registry. The real one is compiled in, so a test passes its
   * own. A provider plugin is added when none of these offers providers.
   */
  readonly plugins?: ReadonlyArray<Plugin>;
}

/**
 * Runs the real controller application over a real socket while `body` runs,
 * in a temporary home that is removed afterwards.
 *
 * Without `bundle`, the controller serves only the API, like a checkout that
 * was never built. Without `pings`, the default intervals apply.
 */
export const withServer = (
  body: (harness: ServerHarness) => Promise<void>,
  options: ServerOptions = {},
): Promise<void> => {
  const bundle = options.bundle;
  const home = mkdtempSync(join(tmpdir(), "hercule-http-"));
  writeFileSync(join(home, "setup-url"), `http://127.0.0.1:4937/setup?token=${SETUP_TOKEN}\n`);

  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO setup_state (singleton, token_hash, completed_at)
                   VALUES (1, ${hashToken(SETUP_TOKEN)}, NULL)`;
        // The boot's steps, in the boot's order, so a request sees what a real
        // controller would have. Kept as one effect because `reboot` runs them
        // again.
        const bootSteps = Effect.gen(function* () {
          yield* cancelStrandedInputsAndReportLostWakeUps;
          yield* Effect.flatMap(ControllerIdentity, (identity) => identity.ensure);
          yield* seed;
          yield* Effect.flatMap(PluginHost, (host) =>
            host.boot(buildPluginRegistry(options.plugins ?? [])),
          );
          yield* ensureProviderInstances;
        });
        yield* bootSteps;
        // A restart first interrupts every run's fiber and waits until they
        // have stopped, as a stopping controller does, and resumes the
        // unfinished runs after the boot's steps, as the real controller
        // does when it starts serving (`serve`).
        const runFibers = yield* RunFibers;
        const reboot: RebootArranger = yield* makeRepeatable(
          Effect.andThen(
            FiberMap.clear(runFibers),
            Effect.andThen(bootSteps, resumeUnfinishedRuns),
          ),
        );
        yield* serve(bundle);
        const base = yield* baseUrl;
        // Reads the audit log through the service that wrote it, like any other
        // reader.
        const log = yield* AuditLog;
        const audit: AuditReader = (kind) => Effect.runPromise(Effect.orDie(log.listByKind(kind)));
        const platformEventWriter = yield* PlatformEvents;
        const platformEvents: PlatformEventReader = (kind) =>
          Effect.runPromise(Effect.orDie(platformEventWriter.listByKind(kind)));
        // Reads the controller's live subscriptions through the service that
        // holds them, so a test checks what the running server has, not what it
        // can infer from the wire.
        const topics = yield* LiveTopics;
        const live: LiveReader = {
          subscriberCount: (topic) => Effect.runPromise(topics.subscriberCount(topic)),
        };
        const repository = yield* runnerRepository;
        // A runner row is not inserted with a cap override, so the override is
        // written the way the API writes one.
        const insertRunner: RunnerArranger = (fields) =>
          Effect.runPromise(
            Effect.orDie(
              Effect.gen(function* () {
                const at = yield* nowIso;
                const runner = yield* repository.insert({
                  name: fields.name,
                  connectivity: fields.connectivity ?? "offline",
                  lifecycle: fields.lifecycle ?? "active",
                  reserved: fields.reserved ?? false,
                  labels: fields.labels ?? [],
                  credentialHash: hashToken(crypto.randomUUID()),
                  at,
                });
                if (fields.maxConcurrentSessions === undefined) return runner;
                const cap = fields.maxConcurrentSessions;
                yield* repository.update(runner.id, { maxConcurrentSessions: cap }, at);
                return { ...runner, maxConcurrentSessions: cap };
              }),
            ),
          );
        const tokens = yield* JoinTokens;
        const joinToken: JoinTokenArranger = () =>
          Effect.runPromise(
            Effect.orDie(
              Effect.flatMap(nowIso, (at) => Effect.map(tokens.create(at), (one) => one.token)),
            ),
          );
        yield* Effect.promise(() =>
          body({
            base,
            audit,
            platformEvents,
            sql,
            live,
            insertRunner,
            joinToken,
            reboot,
            isRunExecuting: (runId) => FiberMap.hasUnsafe(runFibers, runId),
          }),
        );
      }),
    ).pipe(
      Effect.provide(
        buildServices(home, options.evaluationErrorNotifier ?? EvaluationErrorNotifierLayer).pipe(
          // The same listener `hercule serve` builds, including the body size
          // limit. The limit is enforced by the transport, so without it the
          // tests would run a different server from the one that ships.
          Layer.provideMerge(
            BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, ...bodyLimits }),
          ),
        ),
      ),
      Effect.provideService(PasswordCost, TEST_PASSWORD_PARAMS),
      provideTimings(options),
    ),
  ).finally(() => rmSync(home, { recursive: true, force: true }));
};

/**
 * Provides the timings a test overrides to everything the server runs,
 * whether it runs in a request or on a fiber a service started when its layer
 * was built. A timing left unset keeps its default.
 */
const provideTimings =
  (options: ServerOptions) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    let provided = effect;
    const provideIfSet = <V>(key: Context.Reference<V>, value: V | undefined): void => {
      if (value !== undefined) provided = Effect.provideService(provided, key, value);
    };
    provideIfSet(RunnerPingSchedule, options.pings);
    provideIfSet(RunnerFactsDeadline, options.factsDeadline);
    provideIfSet(ProviderProbeDeadline, options.probeDeadline);
    provideIfSet(ProviderProbeInterval, options.probeInterval);
    provideIfSet(ProviderLoginDeadline, options.loginDeadline);
    provideIfSet(SessionInputDeadline, options.inputDeadline);
    provideIfSet(WorkspaceSweepInterval, options.workspaceSweepInterval);
    provideIfSet(EventRoutingInterval, options.eventRoutingInterval);
    provideIfSet(LostRunnerSweepInterval, options.lostRunnerSweepInterval);
    provideIfSet(ExpressionBudget, options.expressionBudget);
    return provided;
  };

/**
 * Sends a request with a JSON body, and optionally a bearer token.
 *
 * Every request closes its connection. Node's `fetch` keeps a connection alive
 * after a request whose body is larger than about 64 KB, and the server's
 * graceful stop then waits about ten seconds for that idle socket. That is
 * long enough for the test to time out while closing its scope rather than
 * in an assertion.
 */
export const send = (
  method: string,
  base: string,
  path: string,
  options: { readonly body?: unknown; readonly token?: string } = {},
): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      connection: "close",
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    },
    ...(options.body === undefined
      ? {}
      : {
          body: typeof options.body === "string" ? options.body : JSON.stringify(options.body),
        }),
  });

/** The body of every error response the envelope writes. */
interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: {
      readonly grant?: string;
      readonly issues?: ReadonlyArray<{ readonly path: ReadonlyArray<string> }>;
    };
  };
}

/** One error, read from the envelope of an error response. */
export interface Refusal {
  readonly code: string;
  readonly message: string;
  /** The grant a `forbidden` error names; absent on every other error. */
  readonly grant?: string;
  /** The path of each issue in a `validation` error, in order. */
  readonly issues: ReadonlyArray<ReadonlyArray<string>>;
  /** The whole body, for assertion messages that need to show it. */
  readonly text: string;
}

/**
 * Reads the error from an error response. The body is read and parsed once
 * here, so a caller can check the code, the grant and the issue paths without
 * cloning a stream that can only be read once.
 */
export const readErrorBody = async (response: Response): Promise<Refusal> => {
  const text = await response.text();
  const body = JSON.parse(text) as ErrorBody;
  return {
    code: body.error.code,
    message: body.error.message,
    ...(body.error.details?.grant === undefined ? {} : { grant: body.error.details.grant }),
    issues: (body.error.details?.issues ?? []).map((issue) => issue.path),
    text,
  };
};

/** Sends a GET with a bearer token. */
export const get = (base: string, path: string, token?: string): Promise<Response> =>
  send("GET", base, path, token === undefined ? {} : { token });

/** Sends a DELETE with a bearer token. */
export const del = (base: string, path: string, token?: string): Promise<Response> =>
  send("DELETE", base, path, token === undefined ? {} : { token });

/** Sends a POST with a JSON body, which most of these tests need. */
export const post = (
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> =>
  send("POST", base, path, { body, ...(token === undefined ? {} : { token }) });

/** Completes first-run setup and returns the bearer token setup returned. */
export const completeSetup = async (base: string): Promise<string> => {
  const response = await send("POST", base, "/api/v1/setup/complete", {
    body: { username: USERNAME, password: PASSWORD, timezone: "Europe/Amsterdam" },
    token: SETUP_TOKEN,
  });
  if (response.status !== 200) throw new Error(`setup.complete answered ${response.status}`);
  return ((await response.json()) as { token: string }).token;
};

/**
 * Live socket helpers: a real WebSocket to the real listener, with the
 * contract's own RPC client, because the socket is tested on the wire. They
 * sit next to `withServer` because every domain checks its pushes through
 * them.
 */
export type LiveClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof live>, RpcClientError>;

/** Returns the socket URL: `/ws` on the same host and port as the API. */
export const buildSocketUrl = (base: string): string => `${base.replace(/^http:/, "ws:")}/ws`;

export const buildLiveConnection = (base: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(BunSocket.layerWebSocket(buildSocketUrl(base))),
    Layer.provide(RpcSerialization.layerJson),
  );

/** Opens one connection while `body` runs, with the JSON serialization a browser uses. */
export const onSocket = (
  base: string,
  body: (client: LiveClient) => Effect.Effect<void, unknown, Scope.Scope>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(live);
        yield* body(client);
      }).pipe(Effect.provide(buildLiveConnection(base))),
    ).pipe(Effect.orDie),
  );

/** Fetches a ticket the way a client does: over HTTP, before connecting. */
export const fetchTicket = async (base: string, token: string): Promise<string> => {
  const response = await post(base, "/api/v1/auth/ws-ticket", {}, token);
  expect(response.status).toBe(200);
  return ((await response.json()) as { ticket: string }).ticket;
};

/**
 * Waits for the window in which record changes are collected to pass. So what
 * a subscription opened afterwards receives is caused by the test's next
 * steps, not by anything the boot or the setup left in flight.
 */
export const waitForLiveToSettle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 2 * COALESCE_WINDOW_MS));

/** Waits up to `ms` for `ready` to return true, and returns whether it did. */
export const waitWithin = async (ms: number, ready: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!ready() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return ready();
};

/**
 * Asserts that the controller holds exactly this many subscriptions to a
 * topic, waiting for the count to settle. Subscriptions open and close
 * asynchronously, so reading the count right after the call would test the
 * timing, not the behaviour.
 */
export const expectHeld = async (
  reader: LiveReader,
  expected: number,
  topic: LiveTopic = "task",
): Promise<void> => {
  let seen = await reader.subscriberCount(topic);
  for (let attempt = 0; attempt < 200 && seen !== expected; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    seen = await reader.subscriberCount(topic);
  }
  expect(seen, topic).toBe(expected);
};

/** The messages one subscription has received so far, collected as they arrive. */
export interface Collected {
  readonly received: ReadonlyArray<LiveMessage>;
  readonly fiber: Fiber.Fiber<void, unknown>;
}

/**
 * Holds a subscription open and keeps every message it receives, in order.
 * The test asserts on the array afterwards, so it checks what the subscriber
 * received rather than when each frame arrived.
 */
export const collectMessages = (
  client: LiveClient,
  payload: { readonly topic: string; readonly cursor?: string },
): Effect.Effect<Collected, never, Scope.Scope> =>
  Effect.gen(function* () {
    const received: Array<LiveMessage> = [];
    const fiber = yield* Effect.forkChild(
      Stream.runForEach(client.subscribe(payload), (message) =>
        Effect.sync(() => {
          received.push(message);
        }),
      ),
    );
    return { received, fiber };
  });
