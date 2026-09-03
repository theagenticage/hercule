/**
 * What `hydra serve` does before it binds: the first-run and boot sequence of
 * spec 15 section 7.
 *
 * On an empty home this auto-initializes with no flags and no prompts - the
 * home layout, `config.toml`, the database and its migrations, the shipped
 * defaults, the master key, the controller identity, and the one-time setup
 * URL. On every later boot it is the same sequence, and everything in it is
 * idempotent, so a restart changes nothing except the setup token.
 *
 * Two steps of spec 15 section 7 are deliberately absent, both because their
 * subject does not exist yet: one provider instance per shipped provider plugin
 * (step 2), and starting the local runner (step 4). Later tickets add them
 * here.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
import { ControllerIdentity, controllerIdentityLayer } from "./identity";
import { PermissionProfilesLayer, type GrantsError } from "./permissions";
import {
  masterKeyLayer,
  secretsLayer,
  type MasterKeyBackend,
  type MasterKeyError,
  type SecretNameError,
} from "./secrets";
import { seed } from "./seed";
import { SettingsLayer, type SettingError } from "./settings";

/** The setup token is 32 random bytes, rendered base64url so it survives a URL. */
const SETUP_TOKEN_BYTES = 32;

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
 * How a token is stored: SHA-256, hex. A setup token is opaque, 256 bits of
 * randomness, so a fast hash is right - there is nothing to guess (spec 13
 * section 4.1). Passwords are the other case and use a slow hash.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The one-time setup URL (spec 15 section 7). A wildcard bind host renders as
 * loopback, because `http://0.0.0.0:4937` is not an address a browser can open;
 * an IPv6 literal is bracketed. `bind.host` is checked when the config is
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
 * re-minting is restarting the unit (spec 15 section 7). The file is mode 0600,
 * the same trust boundary as the master key file, and it exists only while
 * setup is incomplete: `hydra setup-url` reads it, and no unauthenticated
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
      yield* withTransaction(sql`UPDATE setup_state SET token_hash = NULL WHERE singleton = 1`);
      yield* Effect.try({
        try: () => rmSync(paths.setupUrlFile, { force: true }),
        catch: (cause) => new HydraHomeError({ action: "remove", path: paths.setupUrlFile, cause }),
      });
      return undefined;
    }

    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(SETUP_TOKEN_BYTES))).toString(
      "base64url",
    );
    yield* withTransaction(
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

/**
 * Boot the controller: everything up to, and not including, binding.
 *
 * `argv`, `env` and the master-key backend are arguments rather than ambient,
 * so a test drives a temporary home and the file-backed key exactly the way the
 * binary drives the real ones.
 */
export const boot = (options: {
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly masterKeyBackend?: MasterKeyBackend;
}): Effect.Effect<BootOutcome, BootError> => {
  const sequence = Effect.gen(function* () {
    const paths = yield* HydraHome;
    const bootstrap = yield* BootstrapConfig;
    // Whether the file was there before the driver created it decides whether
    // there is anything for a pre-migration copy to preserve (spec 15 section 8).
    const databaseExisted = existsSync(paths.databaseFile);

    const repositories = Layer.mergeAll(
      controllerIdentityLayer.pipe(
        Layer.provide(secretsLayer.pipe(Layer.provide(masterKeyLayer(options.masterKeyBackend)))),
      ),
      SettingsLayer,
      PermissionProfilesLayer,
    );

    const steps = Effect.gen(function* () {
      yield* migrate({ backupsDir: paths.backupsDir, databaseExisted });
      yield* seed;

      const identity = yield* ControllerIdentity;
      const record = yield* identity.ensure;

      const url = yield* ensureSetupUrl(paths, bootstrap);
      return { paths, identityId: record.id, setupUrl: url } satisfies BootOutcome;
    });

    return yield* steps.pipe(
      Effect.provide(repositories.pipe(Layer.provideMerge(openDatabase(paths.databaseFile)))),
      // Nothing above this line has the database file in hand, and a controller
      // that fails at boot has said nothing else yet.
      Effect.catchTag("SqlError", (error) => Effect.fail(databaseError(paths.databaseFile, error))),
    );
  });

  return sequence.pipe(
    Effect.provide(Layer.mergeAll(config.layer(options.argv, options.env), BunFileSystem.layer)),
  );
};
