/**
 * What `hydra serve` does before it binds: the first-run and boot sequence.
 *
 * On an empty home this auto-initializes with no flags and no prompts - the
 * home layout, `config.toml`, the database and its migrations, the shipped
 * defaults, the master key, the controller identity, and the one-time setup
 * URL. On every later boot it is the same sequence, and everything in it is
 * idempotent, so a restart changes nothing except the setup token.
 *
 * Two steps of the sequence are deliberately absent, both because their subject
 * does not exist yet: one provider instance per shipped provider plugin, and
 * starting the local runner. Both belong here once they do.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import type * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import type { HomePaths } from "@hydra/home";
import * as config from "./config";
import { BootstrapConfig, HydraHome, HydraHomeError, type ConfigError } from "./config";
import {
  databaseError,
  migrate,
  openDatabase,
  withTransaction,
  type DatabaseError,
  type SchemaVersionError,
} from "./db";
import { AuditLog, AuditLogLayer } from "./events";
import { ControllerIdentity, controllerIdentityLayer } from "./identity";
import { Credentials, CredentialsLayer, hashToken, mintToken } from "./credentials";
import { Users, UsersLayer } from "./users";
import { PermissionProfilesLayer, type GrantsError, type PermissionProfiles } from "./permissions";
import {
  masterKeyLayer,
  Secrets,
  secretsLayer,
  type MasterKeyBackend,
  type MasterKeyError,
  type SecretNameError,
} from "./secrets";
import { seed } from "./seed";
import { Settings, SettingsLayer, type SettingError } from "./settings";

/** Setup tokens are minted and stored like every other Hydra token. */
export { hashToken };

/** The two bind hosts that mean "every interface"; a URL needs a reachable one instead. */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

/** What a boot leaves behind. `setupUrl` is absent once setup is complete. */
export interface BootOutcome {
  readonly paths: HomePaths;
  readonly identityId: string;
  readonly setupUrl: string | undefined;
}

/** Everything that can stop the controller before it binds. */
export type BootError =
  | ConfigError
  | DatabaseError
  | Migrator.MigrationError
  | SchemaVersionError
  | PlatformError
  | MasterKeyError
  | SecretNameError
  | SettingError
  | GrantsError;

/**
 * The one-time setup URL. A wildcard bind host renders as loopback, because
 * `http://0.0.0.0:4937` is not an address a browser can open; an IPv6 literal
 * is bracketed. `bind.host` is checked when the config is
 * resolved, so by here it is a host and nothing else; a value `URL` will not
 * take is a defect, not a URL nobody can open.
 */
export function setupUrl(bindHost: string, bindPort: number, token: string): string {
  const host = WILDCARD_HOSTS.has(bindHost) ? "127.0.0.1" : bindHost;
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const url = new URL(`http://${authority}:${bindPort}/setup`);
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * Mint a fresh setup token unless setup is already complete, and keep
 * `<home>/setup-url` in step with it.
 *
 * The token is valid until used and every boot invalidates the previous one, so
 * re-minting is restarting the unit. The file is mode 0600, the same trust
 * boundary as the master key file, and it exists only while setup is
 * incomplete: `hydra setup-url` reads it, and no unauthenticated
 * endpoint serves it.
 */
const ensureSetupUrl = (
  paths: HomePaths,
  bootstrap: BootstrapConfig["Service"],
): Effect.Effect<string | undefined, SqlError | HydraHomeError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly completed_at: string | null;
    }>`SELECT completed_at FROM setup_state WHERE singleton = 1`;

    if (rows[0]?.completed_at != null) {
      // No token is outstanding once setup is complete, in the file or in the
      // row: the column holds a hash only while one is.
      yield* withTransaction(
        sql,
        sql`UPDATE setup_state SET token_hash = NULL WHERE singleton = 1`,
      );
      yield* Effect.try({
        try: () => rmSync(paths.setupUrlFile, { force: true }),
        catch: (cause) => new HydraHomeError({ action: "remove", path: paths.setupUrlFile, cause }),
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

    const url = setupUrl(bootstrap.bindHost, bootstrap.bindPort, token);
    yield* Effect.try({
      try: () => {
        // `mode` applies only when the file is created, so the file the previous
        // boot left is removed rather than chmod-ed after a moment at the
        // default mode.
        rmSync(paths.setupUrlFile, { force: true });
        writeFileSync(paths.setupUrlFile, `${url}\n`, { mode: 0o600 });
      },
      catch: (cause) => new HydraHomeError({ action: "write", path: paths.setupUrlFile, cause }),
    });
    return url;
  });

/** Boot the controller: everything up to, and not including, binding. */
export const boot = (options: BootOptions): Effect.Effect<BootOutcome, BootError> =>
  bootWith(options, Effect.succeed);

/** What a boot needs from its caller: the command line, the environment, the key backend. */
export interface BootOptions {
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly masterKeyBackend?: MasterKeyBackend;
}

/**
 * Every service the controller's own code reaches after the boot: the database,
 * the repositories over it, the home and the bootstrap config.
 */
export type ControllerServices =
  | SqlClient.SqlClient
  | ControllerIdentity
  | Secrets
  | AuditLog
  | Settings
  | PermissionProfiles
  | Users
  | Credentials
  | HydraHome
  | BootstrapConfig;

/**
 * Boot the controller and then keep running, with the database open.
 *
 * `hydra serve` binds after this and stays up; `boot` is the same sequence with
 * nothing after it, which is what a test and `hydra setup-url` want. The
 * database closes when `use` finishes, so a clean exit leaves no open handle
 * behind.
 *
 * `argv`, `env` and the master-key backend are arguments rather than ambient,
 * so a test drives a temporary home and the file-backed key exactly the way the
 * binary drives the real ones.
 */
export const bootWith = <A, E>(
  options: BootOptions,
  use: (outcome: BootOutcome) => Effect.Effect<A, E, ControllerServices>,
): Effect.Effect<A, BootError | E> => {
  const sequence = Effect.gen(function* () {
    const paths = yield* HydraHome;
    const bootstrap = yield* BootstrapConfig;
    // Whether the file was there before the driver created it decides whether
    // there is anything for a pre-migration copy to preserve.
    const databaseExisted = existsSync(paths.databaseFile);

    // The secrets repository is merged out rather than only provided inwards:
    // `secret.*` is a public operation, so what runs after the boot needs it.
    const repositories = Layer.mergeAll(
      controllerIdentityLayer,
      SettingsLayer,
      PermissionProfilesLayer,
      UsersLayer,
      CredentialsLayer,
      AuditLogLayer,
    ).pipe(
      Layer.provideMerge(
        secretsLayer.pipe(Layer.provide(masterKeyLayer(options.masterKeyBackend))),
      ),
    );

    const steps = Effect.gen(function* () {
      yield* migrate({ backupsDir: paths.backupsDir, databaseExisted });
      yield* seed;

      const identity = yield* ControllerIdentity;
      const record = yield* identity.ensure;

      const url = yield* ensureSetupUrl(paths, bootstrap);
      return { paths, identityId: record.id, setupUrl: url } satisfies BootOutcome;
    });

    return yield* Effect.flatMap(steps, use).pipe(
      Effect.provide(repositories.pipe(Layer.provideMerge(openDatabase(paths.databaseFile)))),
      // A statement the database refused reads as one line naming the file; a
      // controller that fails at boot has said nothing else yet.
      Effect.catchTag("SqlError", (error) => Effect.fail(databaseError(paths.databaseFile, error))),
    );
  });

  return sequence.pipe(
    Effect.provide(Layer.mergeAll(config.layer(options.argv, options.env), BunFileSystem.layer)),
  );
};
