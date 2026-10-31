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
import { Effect, Layer, Option } from "effect";
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

const ACME: ProviderDefinition = {
  id: "acme",
  displayName: "Acme",
  kinds: [
    {
      id: KEY_KIND,
      title: "API key",
      description: "A key for Acme.",
      setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
      harnesses: [ALPHA_HARNESS_ID, BETA_HARNESS_ID],
    },
    {
      id: MACHINE_KIND,
      title: "Subscription",
      description: "A plan signed in on each machine.",
      setup: [{ kind: "harness-login" }],
      harnesses: [ALPHA_HARNESS_ID],
    },
  ],
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
          kinds: [{ kind: KEY_KIND, credentialVariable: "ACME_API_KEY" }, { kind: MACHINE_KIND }],
          modelArgument: "acme/{model}",
          models: "own-list",
        },
      ]),
    ],
  }).plugin,
  createPluginFixture({ id: "beta", definitions: [buildHarnessDefinition("beta", [])] }).plugin,
];

const buildStack = () =>
  ProviderAccountServiceLayer.pipe(
    Layer.provideMerge(ProviderAccountProbesLayer),
    Layer.provideMerge(RunnerConnectionsLayer),
    Layer.provideMerge(NotifierLayer),
    Layer.provideMerge(buildPluginStack()),
  );

export type AccountServices =
  | ProviderAccountService
  | ProviderAccountProbes
  | RunnerConnections
  | PluginHost
  | SqlClient.SqlClient
  | Layer.Success<ReturnType<typeof buildPluginStack>>;

/**
 * Runs an effect as the user on a fresh database, after the fixture plugins
 * have been booted.
 */
export const runWithAccounts = <A, E>(body: Effect.Effect<A, E, AccountServices>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(PluginHost, (host) => host.boot(buildAccountPlugins()));
      return yield* body;
    }).pipe(Effect.provide(buildStack()), asUser) as Effect.Effect<A, E, never>,
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

/** Gives an account a legacy home, as the migration does for an account made from an instance. */
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

/** Inserts a runner and returns its id. */
export const addRunner = (name: string): Effect.Effect<string, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runners = yield* runnerRepository;
    const runner = yield* withTransaction(
      sql,
      runners.insert({
        name,
        connectivity: "online",
        lifecycle: "active",
        reserved: false,
        labels: [],
        credentialHash: `hash-${name}`,
        at: yield* nowIso,
      }),
    );
    return runner.id;
  });

/** A probe result that shows a runner signed in, with one model. */
export const SIGNED_IN: ProbeResult = {
  harnessVersion: "1.2.3",
  auth: { status: "ok", identity: "someone@example.com" },
  models: [{ slug: "model-1", name: "Model 1", imageInput: null, options: [] }],
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
