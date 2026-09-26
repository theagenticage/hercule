/**
 * The first-run and boot sequence: what `hercule serve` does before it starts
 * listening.
 *
 * On an empty home it initializes everything with no flags and no prompts:
 *
 * - the home layout and `config.toml`;
 * - the database and its migrations;
 * - the shipped defaults and the master key;
 * - the controller identity;
 * - one provider instance per shipped provider plugin;
 * - the one-time setup URL.
 *
 * Every later boot runs the same sequence. Every step is idempotent, so a
 * restart changes nothing except the setup token.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import type * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import type { Plugin } from "@hercule/plugin-host";
import type { HomePaths } from "@hercule/home";
import * as config from "./config";
import { BootstrapConfig, HerculeHome, HerculeHomeError, type ConfigError } from "./config";
import { AssistantSessionObserverLayer } from "./assistants";
import { ConversationMessagesLayer } from "./conversations";
import {
  createDatabaseError,
  migrate,
  openDatabase,
  withTransaction,
  type DatabaseError,
  type SchemaVersionError,
} from "./db";
import {
  ConnectionService,
  ConnectionServiceLayer,
  ConnectionTypes,
  ConnectionTypesLayer,
} from "./connections";
import { cancelStrandedInputsAndReportLostWakeUps } from "./daemon";
import { AuditLog, AuditLogLayer } from "./events";
import { ControllerIdentity, controllerIdentityLayer } from "./identity";
import { Credentials, CredentialsLayer, hashToken, mintToken } from "./credentials";
import { Users, UsersLayer } from "./users";
import {
  PermissionProfilesLayer,
  SessionTokensLayer,
  type GrantsError,
  type PermissionProfiles,
  type SessionTokens,
} from "./permissions";
import {
  masterKeyLayer,
  Secrets,
  secretsLayer,
  type MasterKeyBackend,
  type MasterKeyError,
  type SecretNameError,
} from "./secrets";
import {
  JoinTokensLayer,
  RunnerConnections,
  RunnerConnectionsLayer,
  startLocalRunner,
  type JoinTokens,
  type LocalRunner,
  type LocalRunnerFailed,
  type LocalRunnerOptions,
} from "./runners";
import {
  PluginConfigsLayer,
  PluginHost,
  PluginHostLayer,
  Plugins,
  PluginsLayer,
  registry,
} from "./plugins";
import {
  ensureProviderInstances,
  ProviderProbes,
  ProviderProbesLayer,
  ProviderService,
  ProviderServiceLayer,
} from "./providers";
import { seed } from "./seed";
import { SessionService, SessionServiceLayer } from "./sessions";
import { Settings, SettingsLayer, type SettingError } from "./settings";
import { WorkspaceService, WorkspaceServiceLayer } from "./workspaces";

/** Setup tokens are created and stored like every other Hercule token. */
export { hashToken };

/** The two bind hosts that mean "every interface". A URL needs a reachable address instead. */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

/** The result of a boot. `setupUrl` is `undefined` once setup is complete. */
export interface BootOutcome {
  readonly paths: HomePaths;
  readonly identityId: string;
  readonly setupUrl: string | undefined;
  /** The local runner this boot spawned, if it was asked to spawn one. */
  readonly localRunner: LocalRunner | undefined;
}

/** Every error that can stop the controller before it starts listening. */
export type BootError =
  | ConfigError
  | DatabaseError
  | Migrator.MigrationError
  | SchemaVersionError
  | PlatformError
  | MasterKeyError
  | SecretNameError
  | SettingError
  | GrantsError
  | LocalRunnerFailed;

/**
 * Returns the origin a process on this machine uses to reach the controller. A
 * wildcard bind host becomes loopback, because nothing can open
 * `http://0.0.0.0:4937`; an IPv6 literal is put in brackets. `bind.host` is
 * validated when the config is resolved, so here it is only a host; a value
 * `URL` cannot parse would be a bug, not a URL nobody can open.
 */
export function buildControllerOrigin(bindHost: string, bindPort: number): string {
  const host = WILDCARD_HOSTS.has(bindHost) ? "127.0.0.1" : bindHost;
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${authority}:${bindPort}`;
}

/** Returns the one-time setup URL, at an address a browser on this machine can open. */
export function buildSetupUrl(bindHost: string, bindPort: number, token: string): string {
  const url = new URL("/setup", buildControllerOrigin(bindHost, bindPort));
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * Creates a new setup token unless setup is already complete, and keeps
 * `<home>/setup-url` in step with it. Returns the setup URL, or `undefined`
 * once setup is complete. Fails with `HerculeHomeError` when the file cannot be
 * written or removed.
 *
 * The token is valid until used, and every boot invalidates the previous one,
 * so restarting the service is how to get a new token. The file has mode 0600,
 * the same protection as the master key file, and exists only while setup is
 * incomplete: `hercule setup-url` reads it, and no unauthenticated endpoint
 * serves it.
 */
const ensureSetupUrl = (
  paths: HomePaths,
  bootstrap: BootstrapConfig["Service"],
): Effect.Effect<string | undefined, SqlError | HerculeHomeError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly completed_at: string | null;
    }>`SELECT completed_at FROM setup_state WHERE singleton = 1`;

    if (rows[0]?.completed_at != null) {
      // Once setup is complete no token is outstanding, so clear both the file
      // and the row: the column holds a hash only while a token is outstanding.
      yield* withTransaction(
        sql,
        sql`UPDATE setup_state SET token_hash = NULL WHERE singleton = 1`,
      );
      yield* Effect.try({
        try: () => rmSync(paths.setupUrlFile, { force: true }),
        catch: (cause) =>
          new HerculeHomeError({ action: "remove", path: paths.setupUrlFile, cause }),
      });
      return undefined;
    }

    const token = mintToken();
    yield* withTransaction(
      sql,
      sql`
        INSERT INTO setup_state (singleton, token_hash, completed_at)
        VALUES (1, ${hashToken(token)}, NULL)
        ON CONFLICT (singleton) DO UPDATE SET token_hash = excluded.token_hash
      `,
    );

    const url = buildSetupUrl(bootstrap.bindHost, bootstrap.bindPort, token);
    yield* Effect.try({
      try: () => {
        // `mode` applies only when the file is created, so the previous boot's
        // file is removed first. Changing its mode afterwards would leave it
        // briefly readable with the default mode.
        rmSync(paths.setupUrlFile, { force: true });
        writeFileSync(paths.setupUrlFile, `${url}\n`, { mode: 0o600 });
      },
      catch: (cause) => new HerculeHomeError({ action: "write", path: paths.setupUrlFile, cause }),
    });
    return url;
  });

/** Boots the controller: every step up to, but not including, listening. */
export const boot = (options: BootOptions): Effect.Effect<BootOutcome, BootError> =>
  bootWith(options, Effect.succeed);

/** The inputs of a boot: the command line, the environment and the master key backend. */
export interface BootOptions {
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly masterKeyBackend?: MasterKeyBackend;
  /**
   * How to run the local runner beside this controller, for a boot that goes
   * on to serve. A boot with nothing after it, such as `hercule setup-url` or a
   * repository test, spawns no runner: there is no reason to start a second
   * Hercule process just to read one value.
   */
  readonly localRunner?: LocalRunnerOptions;
  /**
   * The plugins to load. Defaults to the registry compiled into this binary.
   * Only a test that runs the plugin host with its own plugins overrides it.
   */
  readonly plugins?: ReadonlyArray<Plugin>;
}

/**
 * Every service the controller's own code uses after the boot: the database,
 * the repositories on it, the home and the bootstrap config.
 */
export type ControllerServices =
  | SqlClient.SqlClient
  | ControllerIdentity
  | Secrets
  | AuditLog
  | Settings
  | PermissionProfiles
  | SessionTokens
  | Users
  | Credentials
  | JoinTokens
  | Plugins
  | PluginHost
  | ConnectionTypes
  | RunnerConnections
  | ProviderProbes
  | ProviderService
  | SessionService
  | WorkspaceService
  | ConnectionService
  | HerculeHome
  | BootstrapConfig;

/**
 * Boots the controller, then runs `use` with the database still open, and
 * returns what `use` returns.
 *
 * `hercule serve` starts listening inside `use` and stays up; `boot` is the same
 * sequence with nothing after it, which is what a test and `hercule setup-url`
 * need. The database closes when `use` finishes, so a clean exit leaves no open
 * handle behind.
 *
 * `argv`, `env` and the master-key backend are arguments rather than read from
 * the process, so a test can use a temporary home and the file-backed key
 * exactly the way the binary uses the real ones.
 */
export const bootWith = <A, E>(
  options: BootOptions,
  use: (outcome: BootOutcome) => Effect.Effect<A, E, ControllerServices>,
): Effect.Effect<A, BootError | E> => {
  const sequence = Effect.gen(function* () {
    const paths = yield* HerculeHome;
    const bootstrap = yield* BootstrapConfig;
    // If the file did not exist before the driver created it, there is nothing
    // for a pre-migration copy to preserve.
    const databaseExisted = existsSync(paths.databaseFile);

    // The secrets repository is merged into the output rather than only
    // provided to the layers above it: `secret.*` are public operations, so
    // the code that runs after the boot needs it too.
    const repositories = Layer.mergeAll(
      controllerIdentityLayer,
      SettingsLayer,
      PermissionProfilesLayer,
      SessionTokensLayer,
      UsersLayer,
      CredentialsLayer,
      AuditLogLayer,
      JoinTokensLayer,
    ).pipe(
      Layer.provideMerge(
        secretsLayer.pipe(Layer.provide(masterKeyLayer(options.masterKeyBackend))),
      ),
    );

    /**
     * The plugin host on top of those repositories: it reads secrets and
     * appends to the audit log, so it is built on them rather than merged
     * beside them. It is also the catalog every layer above reads a provider's
     * definition from, which is why the fleet is built on it.
     */
    const catalog = PluginHostLayer.pipe(
      Layer.provideMerge(ConnectionTypesLayer),
      Layer.provideMerge(PluginConfigsLayer),
      Layer.provideMerge(repositories),
    );

    /**
     * One connection map and one probe driver per process: the socket route,
     * the controller daemon and the sweep after a hello all use the same
     * `RunnerConnections`.
     */
    const withFleet = ProviderProbesLayer.pipe(
      Layer.provideMerge(RunnerConnectionsLayer),
      Layer.provideMerge(catalog),
    );

    /**
     * The session service tells the assistants domain, through the sessions
     * domain's `SessionObserver` port, about every report and every exit, and
     * about inputs it drops, so an assistant's replies and notices reach its
     * conversation. The sessions domain cannot import the assistants domain,
     * so the two are joined here.
     */
    const sessionService = SessionServiceLayer.pipe(
      Layer.provide(AssistantSessionObserverLayer),
      Layer.provide(ConversationMessagesLayer),
    );

    /** The services built on the catalog and the fleet. */
    const withPlugins = Layer.mergeAll(
      PluginsLayer,
      ProviderServiceLayer,
      sessionService,
      WorkspaceServiceLayer,
      ConnectionServiceLayer,
    ).pipe(Layer.provideMerge(withFleet));

    const steps = Effect.gen(function* () {
      yield* migrate({ backupsDir: paths.backupsDir, databaseExisted });
      // There is no way to ask whether the harness received an input that was
      // in flight before this boot. So the input is cancelled rather than
      // resent, which could deliver it twice, and the subscription records
      // which wake-up was lost. This runs after the migrations and before
      // anything is placed on a runner.
      yield* cancelStrandedInputsAndReportLostWakeUps;
      yield* seed;

      const identity = yield* ControllerIdentity;
      const record = yield* identity.ensure;

      // After the migrations and the identity, because a plugin that activates
      // may read its own state and secrets. Before the runner, because a
      // session's provider is looked up in the catalog.
      yield* Effect.flatMap(PluginHost, (host) => host.boot(options.plugins ?? registry));
      // After the catalog, because a provider instance is created only for a
      // provider this build registered.
      yield* ensureProviderInstances;

      const url = yield* ensureSetupUrl(paths, bootstrap);

      // Last, because the local runner joins over loopback as soon as it is up,
      // and it cannot join until the identity and the schema exist.
      const localRunner =
        options.localRunner === undefined
          ? undefined
          : yield* startLocalRunner(
              options.localRunner,
              buildControllerOrigin(bootstrap.bindHost, bootstrap.bindPort),
              paths.home,
            );

      return { paths, identityId: record.id, setupUrl: url, localRunner } satisfies BootOutcome;
    });

    return yield* Effect.scoped(Effect.flatMap(steps, use)).pipe(
      Effect.provide(withPlugins.pipe(Layer.provideMerge(openDatabase(paths.databaseFile)))),
      // A failed statement becomes one line that includes the file name,
      // because a controller that fails at boot has printed nothing else yet.
      Effect.catchTag("SqlError", (error) =>
        Effect.fail(createDatabaseError(paths.databaseFile, error)),
      ),
    );
  });

  return sequence.pipe(
    Effect.provide(Layer.mergeAll(config.layer(options.argv, options.env), BunFileSystem.layer)),
  );
};
