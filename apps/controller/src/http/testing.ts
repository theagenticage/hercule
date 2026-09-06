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
  type RunnerState,
} from "@hydra/contract";
import type { Plugin } from "@hydra/plugin-host";
import { homePaths } from "@hydra/home";
import { HydraHome } from "../config";
import { CredentialsLayer, hashToken } from "../credentials";
import { nowIso } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer, type AuditKind, type AuditRow } from "../events";
import { ControllerIdentity, controllerIdentityLayer } from "../identity";
import { COALESCE_WINDOW_MS, LiveTopics } from "../live";
import { masterKeyLayer, secretsLayer } from "../secrets";
import { PermissionProfilesLayer } from "../permissions";
import { PluginHost, PluginHostLayer, PluginsLayer } from "../plugins";
import { SettingsLayer } from "../settings";
import {
  JoinTokens,
  JoinTokensLayer,
  RunnerPingSchedule,
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
 * Every service the routes resolve, over one `:memory:` database.
 *
 * The plugin host is built here rather than listed with the operation layers,
 * because the boot and the routes must share one: the status a request reads is
 * held by the same object the boot's activation pass wrote it into.
 */
const services = (home: string) =>
  Layer.mergeAll(operationLayers, PluginsLayer.pipe(Layer.provideMerge(PluginHostLayer))).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        UsersLayer,
        CredentialsLayer,
        SettingsLayer,
        PermissionProfilesLayer,
        AuditLogLayer,
        controllerIdentityLayer,
        JoinTokensLayer,
        PermissionProfilesLayer,
      ),
    ),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HydraHome, homePaths(home, join(home, "data")))),
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
  readonly state?: RunnerState;
  readonly labels?: ReadonlyArray<string>;
  readonly maxConcurrentSessions?: number;
}) => Promise<Runner>;

/**
 * Mints a join token. `runner.createJoinToken` is how a person gets one, but it
 * needs a credential, and the join is reachable before anybody has one - the
 * controller's own first boot mints for its child through this same repository.
 */
export type JoinTokenArranger = () => Promise<string>;

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
   * The plugin registry this controller boots. The shipped registry is a file
   * in the binary, so a test that needs plugins hands over its own.
   */
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
  const home = mkdtempSync(join(tmpdir(), "hydra-http-"));
  writeFileSync(join(home, "setup-url"), `http://127.0.0.1:4937/setup?token=${SETUP_TOKEN}\n`);

  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO setup_state (singleton, token_hash, completed_at)
                   VALUES (1, ${hashToken(SETUP_TOKEN)}, NULL)`;
        // The boot creates the identity and seeds the shipped defaults before
        // anything binds, so the harness does both the same way: a request sees
        // the three shipped profiles and the controller settings a real
        // controller has.
        yield* Effect.flatMap(ControllerIdentity, (identity) => identity.ensure);
        yield* seed;
        // After the schema and the seed, as the real boot runs it: a plugin
        // that activates may read its own state and secrets.
        yield* Effect.flatMap(PluginHost, (host) => host.boot(options.plugins ?? []));
        yield* options.pings === undefined
          ? serve(bundle)
          : Effect.provideService(serve(bundle), RunnerPingSchedule, options.pings);
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
        const insertRunner: RunnerArranger = (fields) =>
          Effect.runPromise(
            Effect.orDie(
              Effect.flatMap(nowIso, (at) =>
                repository.insert({
                  name: fields.name,
                  state: fields.state ?? "offline",
                  labels: fields.labels ?? [],
                  maxConcurrentSessions: fields.maxConcurrentSessions ?? 1,
                  credentialHash: hashToken(crypto.randomUUID()),
                  at,
                }),
              ),
            ),
          );
        const tokens = yield* JoinTokens;
        const joinToken: JoinTokenArranger = () =>
          Effect.runPromise(
            Effect.orDie(
              Effect.flatMap(nowIso, (at) => Effect.map(tokens.create(at), (one) => one.token)),
            ),
          );
        yield* Effect.promise(() => body({ base, audit, sql, live, insertRunner, joinToken }));
      }),
    ).pipe(
      Effect.provide(
        services(home).pipe(
          // The same listener `hydra serve` builds, body cap included: the cap
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
 * The live socket, for a test that drives one.
 *
 * A real WebSocket against the real listener with the contract group's own RPC
 * client, because the whole point of the socket is the wire. They live beside
 * `withServer` rather than in one test file: the socket is how every domain's
 * pushes are observed, and a second copy of this drifts from the first.
 */
export type LiveClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof live>, RpcClientError>;

/** The socket sits at `/ws` on the same authority the API is served from. */
export const socketUrl = (base: string): string => `${base.replace(/^http:/, "ws:")}/ws`;

/** One connection's worth of client transport, for a test that opens its own. */
export const liveConnection = (base: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(BunSocket.layerWebSocket(socketUrl(base))),
    Layer.provide(RpcSerialization.layerJson),
  );

/**
 * Opens one connection for the length of `body` and closes it afterwards. The
 * client is the contract group's own, over JSON framing, which is what a
 * browser client will be.
 */
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
