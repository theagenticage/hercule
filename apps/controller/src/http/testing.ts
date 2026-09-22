/**
 * The controller, over a real socket, for tests. The repositories are the real
 * ones; nothing here is mocked.
 *
 * Everything a request passes through in production is in this stack - the
 * envelope, the pre-setup gate, the derived routes, both credential gates and
 * every service. Only the database (`:memory:`), the master key (a file in a
 * temporary home) and the port (ephemeral) differ.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
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
import { homePaths } from "@hercule/home";
import { HerculeHome } from "../config";
import { ConnectionServiceLayer, ConnectionTypesLayer } from "../connections";
import { CredentialsLayer, hashToken } from "../credentials";
import { EventRoutingInterval, SessionInputDeadline, WorkspaceSweepInterval } from "../daemon";
import { ExpressionBudget } from "../expressions";
import { nowIso } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer, type AuditKind, type AuditRow } from "../events";
import { ControllerIdentity, controllerIdentityLayer } from "../identity";
import { COALESCE_WINDOW_MS, LiveTopics } from "../live";
import { masterKeyLayer, secretsLayer } from "../secrets";
import { PermissionProfilesLayer, SessionTokensLayer } from "../permissions";
import { PluginConfigsLayer, PluginHost, PluginHostLayer, PluginsLayer } from "../plugins";
import {
  ensureProviderInstances,
  ProviderLoginDeadline,
  ProviderProbeDeadline,
  ProviderProbeInterval,
  ProviderProbesLayer,
  ProviderServiceLayer,
} from "../providers";
import { cancelStrandedInputs, SessionServiceLayer } from "../sessions";
import { ResourceServiceLayer } from "../resources";
import { EvaluationErrorNotifier, EvaluationErrorNotifierLayer } from "../subscriptions";
import { SettingsLayer } from "../settings";
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
import { PasswordCost, TEST_PASSWORD_PARAMS, UsersLayer } from "../users";
import { seed } from "../seed";
import { operationLayers } from "./routes";
import { bodyLimits, serve } from "./server";
import type { WebBundle } from "./static";

/** The setup token the harness seeds, and the password `completeSetup` uses. */
export const SETUP_TOKEN = "a-setup-token";
export const PASSWORD = "correct horse battery staple";
export const USERNAME = "rogier";

/**
 * Every service the routes resolve, over one `:memory:` database. The plugin
 * host is built here rather than beside the operation layers because the boot
 * and the routes must share one: the status a request reads is held by the same
 * object the boot's activation pass wrote it into.
 */
const services = (home: string, notifier: Layer.Layer<EvaluationErrorNotifier>) =>
  // The routes' own layer holds the controller daemon, which reaches the
  // session and workspace services and the plugin host, so it is provided this
  // block's output rather than merely merged beside it, the way the real boot's
  // operation layers reach what `withPlugins` built.
  operationLayers.pipe(
    Layer.provide(notifier),
    Layer.provideMerge(
      Layer.mergeAll(
        PluginsLayer,
        ProviderServiceLayer,
        SessionServiceLayer,
        WorkspaceServiceLayer,
        ConnectionServiceLayer,
        ResourceServiceLayer,
      ),
    ),
    // One connection map and one probe driver: the socket route and every
    // service must act through the same `RunnerConnections`. The catalog is
    // below the probe driver, which reads a provider's definition off it.
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
        controllerIdentityLayer,
        JoinTokensLayer,
        SessionTokensLayer,
      ),
    ),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HerculeHome, homePaths(home, join(home, "data")))),
  );

/** An address a fetch can use; the server binds an ephemeral port on loopback. */
export const baseUrl = Effect.map(HttpServer.HttpServer, (server) => {
  const address = server.address;
  if (address._tag !== "TcpAddress") throw new Error("expected a TCP address");
  return `http://127.0.0.1:${address.port}`;
});

/** Reads back what a request wrote to the audit log. */
export type AuditReader = (kind: AuditKind) => Promise<ReadonlyArray<AuditRow>>;

/**
 * Arranges a runner row. No operation enlists a runner - joining does, over the
 * runner protocol - so a test that needs a fleet writes one through the same
 * repository the join will.
 */
export type RunnerArranger = (fields: {
  readonly name: string;
  readonly connectivity?: RunnerConnectivity;
  readonly lifecycle?: RunnerLifecycle;
  readonly reserved?: boolean;
  readonly labels?: ReadonlyArray<string>;
  /** An override; absent leaves the cap derived from what the machine reports. */
  readonly maxConcurrentSessions?: number;
}) => Promise<Runner>;

/**
 * Mints a join token. `runner.createJoinToken` is how a person gets one, but it
 * needs a credential, and the join is reachable before anybody has one - the
 * controller's own first boot mints for its child through this same repository.
 */
export type JoinTokenArranger = () => Promise<string>;

/**
 * Runs the boot's idempotent steps again, which is what a restart does to a
 * database already being served.
 */
export type RebootArranger = () => Promise<void>;

/**
 * The services are inferred rather than listed, so a step added to the boot
 * cannot leave a stale list behind.
 */
const repeatable = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<() => Promise<A>, never, R> =>
  Effect.map(
    Effect.context<R>(),
    (services) => () => Effect.runPromiseWith(services)(Effect.orDie(effect)),
  );

/** Reads back what the controller is holding for the clients on its live socket. */
export interface LiveReader {
  readonly subscriberCount: (topic: LiveTopic) => Promise<number>;
}

/** What a test is handed: the running controller, and the ways to read it back. */
export interface ServerHarness {
  /** An address a fetch can use. */
  readonly base: string;
  readonly audit: AuditReader;
  readonly sql: SqlClient.SqlClient;
  readonly live: LiveReader;
  readonly insertRunner: RunnerArranger;
  readonly joinToken: JoinTokenArranger;
  readonly reboot: RebootArranger;
}

/** What a test may vary about the controller it is handed. */
export interface ServerOptions {
  readonly bundle?: WebBundle;
  /**
   * How often the controller pings a runner it holds a socket with, and how
   * long it lets one stay silent. The shipped values are counted in tens of
   * seconds, which no test can wait for, and a real Bun listener cannot be
   * driven by a `TestClock` - so a test about liveness hands over its own.
   */
  readonly pings?: RunnerPings;
  /**
   * How long the controller waits for a runner to answer a request for its
   * facts. The shipped ten seconds is longer than a test can wait.
   */
  readonly factsDeadline?: Duration.Duration;
  /** The shipped fifteen seconds and hour are both longer than a test can wait. */
  readonly probeDeadline?: Duration.Duration;
  readonly probeInterval?: Duration.Duration;
  readonly loginDeadline?: Duration.Duration;
  /** How long a delivered input waits for the machine to say what it did with it. */
  readonly inputDeadline?: Duration.Duration;
  /** The shipped ten minutes is longer than a test that watches it can wait. */
  readonly workspaceSweepInterval?: Duration.Duration;
  /** The shipped second is longer than a test that waits out several ticks can wait. */
  readonly eventRoutingInterval?: Duration.Duration;
  /**
   * How long one evaluation of a condition may run before the wrapper reports
   * it. A test that wants every evaluation reported hands over a budget no
   * evaluation can stay under: the evaluator offers no other lever.
   */
  readonly expressionBudget?: Duration.Duration;
  /**
   * Where the report of a condition that cannot be evaluated goes. The
   * shipped one goes nowhere, which nothing can read.
   */
  readonly evaluationErrorNotifier?: Layer.Layer<EvaluationErrorNotifier>;
  /** The shipped registry is compiled in, so a test hands over its own. */
  readonly plugins?: ReadonlyArray<Plugin>;
}

/**
 * Runs the real controller application over a real socket for the length of
 * `body`, in a temporary home that is removed afterwards.
 *
 * With no `bundle` the controller serves the API alone, which is what a
 * checkout that was never built does. With no `pings` the shipped intervals
 * apply.
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
        // The boot's steps in the boot's order, so a request sees what a real
        // controller has. Held as one effect because reboot runs them again.
        const bootSteps = Effect.gen(function* () {
          yield* cancelStrandedInputs;
          yield* Effect.flatMap(ControllerIdentity, (identity) => identity.ensure);
          yield* seed;
          yield* Effect.flatMap(PluginHost, (host) => host.boot(options.plugins ?? []));
          yield* ensureProviderInstances;
        });
        yield* bootSteps;
        const reboot: RebootArranger = yield* repeatable(bootSteps);
        let listening = serve(bundle);
        const named = <A>(key: Context.Reference<A>, value: A | undefined): void => {
          if (value !== undefined) listening = Effect.provideService(listening, key, value);
        };
        named(RunnerPingSchedule, options.pings);
        named(RunnerFactsDeadline, options.factsDeadline);
        named(ProviderProbeDeadline, options.probeDeadline);
        named(ProviderProbeInterval, options.probeInterval);
        named(ProviderLoginDeadline, options.loginDeadline);
        named(SessionInputDeadline, options.inputDeadline);
        named(WorkspaceSweepInterval, options.workspaceSweepInterval);
        named(EventRoutingInterval, options.eventRoutingInterval);
        named(ExpressionBudget, options.expressionBudget);
        yield* listening;
        const base = yield* baseUrl;
        // The log this database holds, read the way anything else reads it: a
        // request's audit row is asserted through the service that wrote it.
        const log = yield* AuditLog;
        const audit: AuditReader = (kind) => Effect.runPromise(Effect.orDie(log.listByKind(kind)));
        // The live subscriptions this controller is holding, read through the
        // service that holds them: a test asserts what the running server has,
        // not what it can infer from the wire.
        const topics = yield* LiveTopics;
        const live: LiveReader = {
          subscriberCount: (topic) => Effect.runPromise(topics.subscriberCount(topic)),
        };
        const repository = yield* runnerRepository;
        // The cap is not something a row is inserted with, so an arranged
        // override is written the way the API writes one.
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
          body({ base, audit, sql, live, insertRunner, joinToken, reboot }),
        );
      }),
    ).pipe(
      Effect.provide(
        services(home, options.evaluationErrorNotifier ?? EvaluationErrorNotifierLayer).pipe(
          // The same listener `hercule serve` builds, body cap included: the cap
          // is the transport's, so a harness without it would test a different
          // server from the one that ships.
          Layer.provideMerge(
            BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, ...bodyLimits }),
          ),
        ),
      ),
      Effect.provideService(PasswordCost, TEST_PASSWORD_PARAMS),
    ),
  ).finally(() => rmSync(home, { recursive: true, force: true }));
};

/**
 * A request with a JSON body, and optionally a bearer token.
 *
 * Every request closes its connection. Node's `fetch` keeps a connection alive
 * after a request whose body ran past about 64 KB, and the server's graceful
 * stop then waits some ten seconds for that idle socket, which is long enough
 * to time a test out in the scope close rather than in the assertion.
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

/** The body every refusal the envelope writes has. */
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

/** One refusal, read out of the envelope the API writes it in. */
export interface Refusal {
  readonly code: string;
  readonly message: string;
  /** The grant a `forbidden` names; absent on every other refusal. */
  readonly grant?: string;
  /** The path of each issue a `validation` lists, in the order it listed them. */
  readonly issues: ReadonlyArray<ReadonlyArray<string>>;
  /** The whole body, for an assertion message that has to show what was said. */
  readonly text: string;
}

/**
 * What a response refused, and what it said. The body is read once and parsed
 * here, so a caller may ask about the code, the grant and the issue paths
 * without juggling clones of a stream that can only be read once.
 */
export const readRefusal = async (response: Response): Promise<Refusal> => {
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

/** A GET with a bearer token. */
export const get = (base: string, path: string, token?: string): Promise<Response> =>
  send("GET", base, path, token === undefined ? {} : { token });

/** A DELETE with a bearer token. */
export const del = (base: string, path: string, token?: string): Promise<Response> =>
  send("DELETE", base, path, token === undefined ? {} : { token });

/** A POST with a JSON body, the shape most of these tests need. */
export const post = (
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> =>
  send("POST", base, path, { body, ...(token === undefined ? {} : { token }) });

/** Finishes first run and answers with the bearer token setup handed back. */
export const completeSetup = async (base: string): Promise<string> => {
  const response = await send("POST", base, "/api/v1/setup/complete", {
    body: { username: USERNAME, password: PASSWORD, timezone: "Europe/Amsterdam" },
    token: SETUP_TOKEN,
  });
  if (response.status !== 200) throw new Error(`setup.complete answered ${response.status}`);
  return ((await response.json()) as { token: string }).token;
};

/**
 * A real WebSocket against the real listener with the contract group's own RPC
 * client, because the whole point of the socket is the wire. It lives beside
 * `withServer` because every domain observes its pushes through this.
 */
export type LiveClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof live>, RpcClientError>;

/** The socket sits at `/ws` on the same authority the API is served from. */
export const socketUrl = (base: string): string => `${base.replace(/^http:/, "ws:")}/ws`;

export const liveConnection = (base: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(BunSocket.layerWebSocket(socketUrl(base))),
    Layer.provide(RpcSerialization.layerJson),
  );

/** Opens one connection for the length of `body`, over the JSON framing a browser uses. */
export const onSocket = (
  base: string,
  body: (client: LiveClient) => Effect.Effect<void, unknown, Scope.Scope>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(live);
        yield* body(client);
      }).pipe(Effect.provide(liveConnection(base))),
    ).pipe(Effect.orDie),
  );

/** A ticket, fetched the way a client fetches one: over HTTP, before dialling. */
export const ticketFor = async (base: string, token: string): Promise<string> => {
  const response = await post(base, "/api/v1/auth/ws-ticket", {}, token);
  expect(response.status).toBe(200);
  return ((await response.json()) as { ticket: string }).ticket;
};

/**
 * Waits out the window record changes are collected in, so what a subscription
 * opened after this sees is caused by what the test does next and not by
 * whatever the boot or the setup left in flight.
 */
export const settleLive = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 2 * COALESCE_WINDOW_MS));

/** Waits up to `ms` for something to become true, and answers whether it did. */
export const within = async (ms: number, ready: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!ready() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return ready();
};

/**
 * Asserts the controller holds exactly this many subscriptions to a topic,
 * giving it time to get there. A subscription is taken out and torn down
 * asynchronously, so a count read in the same turn as the call would be
 * measuring the race rather than the behaviour.
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

/** What one subscription has pushed so far, collected as it arrives. */
export interface Collected {
  readonly received: ReadonlyArray<LiveMessage>;
  readonly fiber: Fiber.Fiber<void, unknown>;
}

/**
 * Holds a subscription open and keeps everything it pushes, in order. The
 * assertions are made against the array afterwards, so a test says what the
 * subscriber ended up seeing rather than when each frame landed.
 */
export const collecting = (
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
