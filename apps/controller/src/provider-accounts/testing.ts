/**
 * Helpers for tests that run the Provider Account services on a real database
 * and the real plugin host, with no HTTP in between:
 *
 * - three fixture plugins: the provider `acme/acme`, and the harnesses
 *   `alpha/alpha` (which runs both of Acme's account kinds) and `beta/beta`
 *   (which the provider allows for keys but which runs nothing);
 * - `runWithAccounts`, which boots them and runs an effect as the user;
 * - functions that insert the rows other domains own (agents, sessions,
 *   settings), which the delete check reads.
 */
import { Context, Effect, Layer, Option, Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
import type { Plugin, ProviderDefinition } from "@hercule/plugin-host";
import type { ProbeResult } from "@hercule/protocol";
import { mintUuid, nowIso, uuidFromString, withTransaction } from "../db";
import { NotifierLayer } from "../notifications";
import { PluginHost } from "../plugins";
import {
  asUser,
  buildHarnessDefinition,
  buildPluginStack,
  createPluginFixture,
} from "../plugins/testing";
import { RunnerConnections, RunnerConnectionsLayer, runnerRepository } from "../runners";
import { buildProviderAccountOwner, Secrets } from "../secrets";
import { SettingsLayer } from "../settings";
import { AccountUsage, AccountUsageLayer } from "../usage";
import { HarnessAccounts, HarnessAccountsLayer } from "./harness-account";
import { ProviderAccountRunners, ProviderAccountRunnersLayer } from "./account-runners";
import { ProviderKeyCheckLayer } from "./key-check";
import { ProviderUsageEndpointLayer } from "./usage-endpoint";
import { ProviderAccountProbes, ProviderAccountProbesLayer } from "./probes";
import { providerAccountRepository, type StoredProviderAccount } from "./repository";
import { ProviderAccountService, ProviderAccountServiceLayer } from "./service";

export const ACME_PROVIDER_ID = "acme/acme";
export const ALPHA_HARNESS_ID = "alpha/alpha";
export const BETA_HARNESS_ID = "beta/beta";

/** The account kind of Acme that holds a key. */
export const KEY_KIND = "api-key";

/** The account kind of Acme that is signed in on each machine. */
export const MACHINE_KIND = "subscription";

/** The account kind of Acme whose runner makes a token the controller keeps. */
export const TOKEN_KIND = "subscription-token";

const ACME: ProviderDefinition = {
  id: "acme",
  displayName: "Acme",
  kinds: [
    {
      id: KEY_KIND,
      title: "API key",
      description: "A key for Acme.",
      setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
      keyCheck: {
        url: "https://api.acme.test/v1/models",
        headers: { authorization: "Bearer {apiKey}" },
      },
      harnesses: [ALPHA_HARNESS_ID, BETA_HARNESS_ID],
    },
    {
      id: MACHINE_KIND,
      title: "Subscription",
      description: "A plan signed in on each machine.",
      setup: [{ kind: "harness-login", method: "sign-in" }],
      harnesses: [ALPHA_HARNESS_ID],
    },
    {
      id: TOKEN_KIND,
      title: "Subscription token",
      description: "A token that works on every machine.",
      setup: [{ kind: "harness-login", method: "create-token" }],
      harnesses: [ALPHA_HARNESS_ID],
    },
  ],
  defaultHarnessId: ALPHA_HARNESS_ID,
};

/** The plugins the tests boot: Acme, and the two harnesses that may run it. */
export const buildAccountPlugins = (): ReadonlyArray<Plugin> => [
  createPluginFixture({
    id: "acme",
    capabilities: ["providers"],
    definitions: [],
    providers: [ACME],
  }).plugin,
  createPluginFixture({
    id: "alpha",
    definitions: [
      buildHarnessDefinition("alpha", [
        {
          providerId: ACME_PROVIDER_ID,
          kinds: [
            { kind: KEY_KIND, credentialVariable: "ACME_API_KEY" },
            { kind: MACHINE_KIND },
            { kind: TOKEN_KIND, credentialVariable: "ACME_API_KEY" },
          ],
          modelArgument: "acme/{model}",
          models: "own-list",
        },
      ]),
    ],
  }).plugin,
  createPluginFixture({ id: "beta", definitions: [buildHarnessDefinition("beta", [])] }).plugin,
];

/** What the fake provider API does with a request: answer it, fail to connect, or never answer. */
export type FakeProviderAnswer = Response | "unreachable" | "silent";

/** One request the fake provider API received. */
export interface FakeProviderRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The `redirect` mode the request was sent with; `manual` means a redirect is not followed. */
  readonly redirect: string | undefined;
}

/**
 * A fake provider API for the key check: an `HttpClient` that answers each
 * request as `answer` says (a 200 with an empty JSON body by default) and
 * records the requests it received.
 */
export const buildFakeProviderApi = (
  answer: (request: FakeProviderRequest) => FakeProviderAnswer = () => new Response("{}"),
) => {
  const requests: Array<FakeProviderRequest> = [];
  const client = HttpClient.make((request, _url, _signal, fiber) => {
    const received: FakeProviderRequest = {
      url: request.url,
      headers: { ...request.headers },
      redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
    };
    requests.push(received);
    const outcome = answer(received);
    if (outcome === "silent") return Effect.never;
    if (outcome === "unreachable") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: "connection refused" }),
        }),
      );
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, outcome));
  });
  return { client, requests };
};

const buildStack = (providerApi: HttpClient.HttpClient) =>
  ProviderAccountServiceLayer.pipe(
    Layer.provideMerge(ProviderKeyCheckLayer),
    Layer.provideMerge(ProviderUsageEndpointLayer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, providerApi)),
    Layer.provideMerge(ProviderAccountProbesLayer),
    Layer.provideMerge(ProviderAccountRunnersLayer),
    Layer.provideMerge(HarnessAccountsLayer),
    Layer.provideMerge(SettingsLayer),
    Layer.provideMerge(AccountUsageLayer),
    Layer.provideMerge(RunnerConnectionsLayer),
    Layer.provideMerge(NotifierLayer),
    Layer.provideMerge(buildPluginStack()),
  );

export type AccountServices =
  | ProviderAccountService
  | AccountUsage
  | ProviderAccountProbes
  | ProviderAccountRunners
  | HarnessAccounts
  | RunnerConnections
  | PluginHost
  | SqlClient.SqlClient
  | Layer.Success<ReturnType<typeof buildPluginStack>>;

/**
 * Runs an effect as the user on a fresh database, after the fixture plugins
 * have been booted. Key checks and usage reads go to `providerApi`, which
 * accepts every key unless the test gives its own. A test that needs other
 * providers passes `plugins` in place of the fixture plugins.
 */
export const runWithAccounts = <A, E>(
  body: Effect.Effect<A, E, AccountServices>,
  providerApi: HttpClient.HttpClient = buildFakeProviderApi().client,
  plugins: ReadonlyArray<Plugin> = buildAccountPlugins(),
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(PluginHost, (host) => host.boot(plugins));
      return yield* body;
    }).pipe(Effect.provide(buildStack(providerApi)), asUser) as Effect.Effect<A, E, never>,
  );

/** Inserts an account of Acme and returns its row. */
export const addAccount = (
  account: {
    readonly kind?: string;
    readonly label?: string | null;
    readonly defaultHarnessId?: string;
    readonly providerId?: string;
  } = {},
): Effect.Effect<StoredProviderAccount, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const accounts = yield* providerAccountRepository;
    return yield* withTransaction(
      sql,
      accounts.insert({
        providerId: account.providerId ?? ACME_PROVIDER_ID,
        kind: account.kind ?? KEY_KIND,
        label: account.label ?? null,
        defaultHarnessId: account.defaultHarnessId ?? ALPHA_HARNESS_ID,
        at: yield* nowIso,
      }),
    );
  });

/**
 * Stores the account's credential under the Secret name its kind uses:
 * `apiKey` for a key kind, `token` for a token kind. Needs `Secrets`, which
 * `runWithAccounts` provides.
 */
export const storeCredential = (
  accountId: string,
  name: "apiKey" | "token",
  value = "a-secret",
): Effect.Effect<void, unknown, SqlClient.SqlClient | Secrets> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secrets = yield* Secrets;
    yield* withTransaction(
      sql,
      secrets.set(buildProviderAccountOwner(accountId), name, Redacted.make(value)),
    );
  });

/** Sets the time at which the account's token expires. */
export const setTokenExpiry = (
  accountId: string,
  expiresAt: string,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const accounts = yield* providerAccountRepository;
    yield* withTransaction(
      sql,
      accounts.setCredentialExpiry(accountId, expiresAt, "2026-10-31T00:00:00.000Z"),
    );
  });

/** Gives an account a legacy home, as the upgrade does for an account it made from the previous version's data. */
export const giveLegacyHome = (
  accountId: string,
  folder: string,
  harnessId: string,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    withTransaction(
      sql,
      sql`
        UPDATE provider_accounts
        SET legacy_home_folder = ${folder}, legacy_home_harness_id = ${harnessId}
        WHERE id = ${uuidFromString(accountId)}
      `,
    ),
  );

/** The binary name every fixture harness declares (`buildHarnessDefinition`). */
const FIXTURE_BINARY_NAME = "harness";

/**
 * Inserts an online runner with facts and returns its id. By default the
 * facts show an adapter for both fixture harnesses and their binary on the
 * machine; `adapters`, `binaryPresent` and `saidHello` change that.
 */
export const addRunner = (
  name: string,
  {
    adapters = [ALPHA_HARNESS_ID, BETA_HARNESS_ID],
    binaryPresent = true,
    saidHello = true,
  }: {
    readonly adapters?: ReadonlyArray<string>;
    readonly binaryPresent?: boolean;
    /** False leaves the runner without facts, like one that has not said hello yet. */
    readonly saidHello?: boolean;
  } = {},
): Effect.Effect<string, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runners = yield* runnerRepository;
    const at = yield* nowIso;
    return yield* withTransaction(
      sql,
      Effect.gen(function* () {
        const runner = yield* runners.insert({
          name,
          connectivity: "online",
          lifecycle: "active",
          reserved: false,
          labels: [],
          credentialHash: `hash-${name}`,
          at,
        });
        if (!saidHello) return runner.id;
        yield* runners.recordFacts(
          runner.id,
          {
            os: "linux",
            arch: "x64",
            totalMemoryBytes: 8 * 1024 ** 3,
            docker: false,
            toolchains: [],
            harnesses: [{ name: FIXTURE_BINARY_NAME, present: binaryPresent }],
            adapters,
            identityPort: 4937,
          },
          at,
        );
        return runner.id;
      }),
    );
  });

/** A probe result that shows a runner signed in, with one model. */
export const SIGNED_IN: ProbeResult = {
  harnessVersion: "1.2.3",
  auth: { status: "ok", identity: "someone@example.com" },
  models: [{ slug: "model-1", name: "Model 1", imageInput: null, options: [] }],
  usage: null,
};

/** Stores a snapshot for an account in a harness on a runner. */
export const addSnapshot = (
  accountId: string,
  harnessId: string,
  runnerId: string,
  result: ProbeResult = SIGNED_IN,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const accounts = yield* providerAccountRepository;
    yield* withTransaction(
      sql,
      accounts.recordSnapshot(accountId, harnessId, runnerId, result, yield* nowIso),
    );
  });

const AT = "2026-10-31T00:00:00.000Z";

/** Inserts an agent, or with `kind: "assistant"` an assistant's agent row, on an account. */
export const addAgent = (
  accountId: string,
  name: string,
  kind: "agent" | "assistant" = "agent",
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const none = mintUuid();
    return withTransaction(
      sql,
      sql`INSERT INTO agents (id, kind, name, system_prompt, provider_account_id,
                              permission_profile_id, access_mode, disallowed_tools,
                              created_at, updated_at)
          VALUES (${mintUuid()}, ${kind}, ${name}, '', ${uuidFromString(accountId)}, ${none},
                  'auto', '[]', ${AT}, ${AT})`,
    );
  });

/** Inserts a session on an account with the given status. */
export const addSession = (
  accountId: string,
  status: "queued" | "starting" | "idle" | "busy" | "exited",
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const none = mintUuid();
    return withTransaction(
      sql,
      sql`INSERT INTO sessions (id, permission_profile_id, provider_account_id, harness_id,
                                runner_id, requested_access_mode, access_mode, spec, title, status,
                                created_at, last_activity_at)
          VALUES (${mintUuid()}, ${none}, ${uuidFromString(accountId)}, ${ALPHA_HARNESS_ID},
                  ${none}, 'auto', 'auto', '{}', 'a session', ${status}, ${AT}, ${AT})`,
    );
  });

/** Writes the controller setting `textGeneration.model` as the JSON text it is stored as. */
export const setTextGenerationModel = (
  value: unknown,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    withTransaction(
      sql,
      sql`INSERT INTO settings (scope, key, value, updated_at)
          VALUES ('controller', 'textGeneration.model', ${JSON.stringify(value)}, ${AT})`,
    ),
  );

/** Inserts a user and gives them a thread default account (or none, with `Option.none()`). */
export const addUserWithThreadDefault = (
  username: string,
  accountId: Option.Option<string>,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`INSERT INTO users (id, username, password_hash, created_at, updated_at)
                   VALUES (${id}, ${username}, 'x', ${AT}, ${AT})`;
        if (Option.isSome(accountId)) {
          yield* sql`INSERT INTO user_settings (user_id, key, value, updated_at)
                     VALUES (${id}, 'thread.providerAccountId', ${JSON.stringify(accountId.value)}, ${AT})`;
        }
      }),
    ),
  );
