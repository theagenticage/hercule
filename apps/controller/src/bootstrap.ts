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
 * - on a fresh install only, the three default Provider Accounts;
 * - the one-time setup URL.
 *
 * Every later boot runs the same sequence. Every step is idempotent, so a
 * restart changes nothing except the setup token.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type { PlatformError } from "effect/PlatformError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import type { Plugin } from "@hercule/plugin-host";
import { buildControllerOrigin, type HomePaths } from "@hercule/home";
import { makeProcessLogLayer } from "@hercule/process-log";
import * as config from "./config";
import { BootstrapConfig, HerculeHome, HerculeHomeError, type ConfigError } from "./config";
import { ConversationMessagesLayer } from "./conversations";
import {
  createDatabaseError,
  migrate,
  openDatabase,
  withTransaction,
  type DatabaseError,
  type SchemaVersionError,
  type SkippedMigrationError,
} from "./db";
import { ConnectionService, ConnectionTypes, ConnectionTypesLayer } from "./connections";
import {
  endStrandedInputsAndReportLostWakeUps,
  ConnectionServiceWithReferencesLayer,
  IngestExecutorLayer,
  OpenSignalsLayer,
  ProviderAccountProbingLayer,
  revalidateStoredWorkflowsOrLog,
  RunServiceReferenceLayer,
  DiscussionInputsReferenceLayer,
  SessionEditObserverLayer,
  SessionObserverLayer,
  WorkflowValidityObserversLayer,
  type ProviderAccountProbing,
  type RunServiceReference,
  type DiscussionInputsReference,
} from "./daemon";
import { AuditLog, AuditLogLayer, PlatformEvents, PlatformEventsLayer } from "./events";
import { ControllerIdentity, controllerIdentityLayer } from "./identity";
import { Notifier, NotifierLayer } from "./notifications";
import { Credentials, CredentialsLayer, hashToken, mintToken } from "./credentials";
import { Users, UsersLayer } from "./users";
import { sweepSkillArchives } from "./skills";
import {
  PermissionProfilesLayer,
  SessionTokensLayer,
  type GrantsError,
  type PermissionProfiles,
  type SessionTokens,
} from "./permissions";
import {
  MasterKey,
  masterKeyLayer,
  openExistingMasterKey,
  Secrets,
  secretsLayer,
  type MasterKeyBackend,
  type MasterKeyError,
  type SecretNameError,
} from "./secrets";
import {
  PromotionState,
  PromotionStateLayer,
  PromotionTokens,
  PromotionTokensLayer,
} from "./promotion";
import {
  JoinTokensLayer,
  LocalRunnerId,
  RunnerConnections,
  RunnerConnectionsLayer,
  startLocalRunner,
  type JoinTokens,
  type LocalRunner,
  type LocalRunnerFailed,
  type LocalRunnerOptions,
} from "./runners";
import { PluginIntake } from "./intake-settings";
import { ModelProfileLookupLayer, ModelProfileMembershipLayer } from "./model-profiles";
import type { ModelProfileLookup } from "./projects";
import {
  IngestLoops,
  PluginConfigsLayer,
  PluginHost,
  PluginHostLayer,
  Plugins,
  PluginsLayer,
  registry,
} from "./plugins";
import {
  HarnessAccounts,
  HarnessAccountsLayer,
  ModelCatalogs,
  ModelCatalogsLayer,
  ProviderAccountProbes,
  ProviderAccountProbesLayer,
  ProviderAccountRunners,
  ProviderAccountRunnersLayer,
  ProviderAccountService,
  ProviderAccountServiceLayer,
  ProviderKeyRequestsLayer,
  ModelDeclarations,
  ModelDeclarationsLayer,
} from "./provider-accounts";
import { seed } from "./seed";
import { readSetupComplete } from "./setup";
import { SessionService, SessionServiceLayer } from "./sessions";
import { GithubSkillSources, GithubSkillSourcesLayer } from "./skills";
import { AccountUsage, AccountUsageLayer } from "./usage";
import { Settings, SettingsLayer, type SettingError } from "./settings";
import { RunWorkspaceStepActivityLayer } from "./runs";
import type { WorkflowValidity } from "./workflows";
import { WorkspaceService, WorkspaceServiceLayer, type WorkspaceStepActivity } from "./workspaces";
import type { AgentObserver } from "./agents";

/** Setup tokens are created and stored like every other Hercule token. */
export { hashToken };

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
  | SkippedMigrationError
  | PlatformError
  | MasterKeyError
  | SecretNameError
  | SettingError
  | GrantsError
  | LocalRunnerFailed;

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
    if (yield* readSetupComplete) {
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
  | AccountUsage
  | ControllerIdentity
  | Secrets
  | MasterKey
  | AuditLog
  | PlatformEvents
  | Notifier
  | Settings
  | PermissionProfiles
  | SessionTokens
  | Users
  | Credentials
  | JoinTokens
  | Plugins
  | PluginHost
  | PluginIntake
  | IngestLoops
  | ConnectionTypes
  | RunnerConnections
  | HarnessAccounts
  | ModelDeclarations
  | ModelCatalogs
  | ModelProfileLookup
  | ProviderAccountProbes
  | ProviderAccountRunners
  | ProviderAccountProbing
  | ProviderAccountService
  | SessionService
  | WorkspaceService
  | WorkspaceStepActivity
  | RunServiceReference
  | DiscussionInputsReference
  | ConnectionService
  | AgentObserver
  | WorkflowValidity
  | LocalRunnerId
  | HerculeHome
  | BootstrapConfig
  | PromotionTokens
  | PromotionState
  | GithubSkillSources;

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
 *
 * Everything the boot and `use` log goes to `<home>/logs/controller.log`, at
 * the configured `log.level`, and nowhere else unless stderr is a terminal.
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
    // Filled by the set-up below, which opens an existing Master Key before the
    // migrations, and read by the Master Key layer so the key is read once.
    const openedMasterKey = yield* Ref.make<CryptoKey | undefined>(undefined);
    // The local runner starts after the layers are built, and the layers that
    // sweep the fleet read its id on every sweep. The boot sets the Ref once
    // the runner is up; until then `LocalRunnerId` reads no id. The sweeps run
    // from the server `use` starts, which is after the Ref is set, so the
    // first arrival already finds the runner. Its id can still be unknown for
    // a moment on the very first start, while the child is joining; the
    // choice then falls to the first runner that can serve, which is the local
    // runner itself when it is the only one connected.
    const startedLocalRunner = yield* Ref.make<LocalRunner | undefined>(undefined);
    const localRunnerIdLayer = Layer.succeed(LocalRunnerId, {
      read: () => Ref.getUnsafe(startedLocalRunner)?.runnerId(),
    });

    // The secrets repository is merged into the output rather than only
    // provided to the layers above it: `secret.*` are public operations, so
    // the code that runs after the boot needs it too. The notifier sits on
    // the audit log, and beside the repositories rather than above the plugin
    // host, because the plugin host and the fleet raise notifications of
    // their own. GitHub, which the Skill Library's update check reads
    // through the `fetch` client, is provided here rather than with the
    // operations, so a test controller can read a fake GitHub instead.
    const repositories = NotifierLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          controllerIdentityLayer,
          SettingsLayer,
          PermissionProfilesLayer,
          SessionTokensLayer,
          UsersLayer,
          CredentialsLayer,
          AuditLogLayer,
          PlatformEventsLayer,
          // Provider Accounts declares this port and cannot import the Model
          // Profiles that implement it.
          ModelProfileMembershipLayer,
          // Projects declares this port as well, to check that a profile exists.
          ModelProfileLookupLayer,
          JoinTokensLayer,
          PromotionTokensLayer,
          GithubSkillSourcesLayer.pipe(Layer.provide(FetchHttpClient.layer)),
          ProviderKeyRequestsLayer.pipe(Layer.provide(FetchHttpClient.layer)),
          AccountUsageLayer,
          PromotionStateLayer.pipe(
            Layer.provide(Layer.mergeAll(controllerIdentityLayer, AuditLogLayer)),
          ),
        ).pipe(
          Layer.provideMerge(
            secretsLayer.pipe(
              Layer.provideMerge(
                masterKeyLayer(options.masterKeyBackend, undefined, openedMasterKey),
              ),
            ),
          ),
        ),
      ),
    );

    /**
     * The plugin host on top of those repositories: it reads secrets and
     * appends to the audit log, so it is built on them rather than merged
     * beside them. It is also the catalog every layer above reads a harness's
     * definition from, which is why the fleet is built on it. Each
     * Connection's ingest runs on a fiber of the controller daemon's Ingest
     * Executor, which is built below the host so that it is released after
     * the host has closed every ingest at shutdown.
     */
    const catalog = PluginHostLayer.pipe(
      Layer.provide([IngestExecutorLayer, OpenSignalsLayer]),
      Layer.provideMerge(ConnectionTypesLayer),
      Layer.provideMerge(PluginConfigsLayer),
      Layer.provideMerge(repositories),
    );

    /**
     * One connection map and one set of awaited device logins per process:
     * the socket route, the controller daemon and the sweep after a hello all
     * use the same `RunnerConnections`, and the sign-in operations and the
     * inbound driver use the same `ProviderAccountProbing`.
     */
    const withFleet = ProviderAccountProbingLayer.pipe(
      // Probing reads the catalogs that the provider's own API lists, which
      // the provider account service does.
      Layer.provideMerge(ProviderAccountServiceLayer),
      Layer.provideMerge(ProviderAccountProbesLayer),
      Layer.provideMerge(ModelCatalogsLayer),
      Layer.provideMerge(ProviderAccountRunnersLayer),
      Layer.provideMerge(localRunnerIdLayer),
      Layer.provideMerge(HarnessAccountsLayer),
      Layer.provideMerge(ModelDeclarationsLayer),
      Layer.provideMerge(RunnerConnectionsLayer),
      Layer.provideMerge(catalog),
    );

    /**
     * The session service tells the assistants and runs domains, through the
     * sessions domain's `SessionObserver` port, about every report and every
     * exit, and about inputs it drops: an assistant's replies and notices
     * reach its conversation, and an agent step whose turn no runner will
     * report fails. The sessions domain cannot import either domain, so they
     * are joined here.
     */
    const sessionService = SessionServiceLayer.pipe(
      Layer.provide(SessionObserverLayer),
      Layer.provide(SessionEditObserverLayer),
      Layer.provide(ConversationMessagesLayer),
    );

    /**
     * The services built on the catalog and the fleet. The session service
     * releases and takes workspace leases, so the workspace service is
     * provided to it. The workspace service asks the runs domain, through
     * the `WorkspaceStepActivity` port, whether a workspace step is running
     * before it hands out a git credential. The workspaces domain cannot
     * import the runs domain, so the two are joined here. The connection
     * service asks the resources and workflows domains, through the
     * `ConnectionReferences` port, what still names a Connection before it
     * deletes one, and is joined to them here for the same reason. The
     * session service's observer reaches the run service through
     * `RunServiceReference`, which the operation layers set once they have
     * built the run service, so the one reference is merged here for both.
     * The session service's edit observer reaches `DiscussionInputs` the same
     * way, through `DiscussionInputsReference`.
     *
     * The plugin and connection services report the changes that can make a
     * stored workflow invalid through their observer ports, which the
     * workflows domain's `WorkflowValidity` implements. The workflows domain
     * depends on both domains, so they are joined here too. The observers are
     * merged, so the agent service, built with the operations, finds its own
     * observer, and the boot finds `WorkflowValidity`.
     */
    const withPlugins = Layer.mergeAll(
      PluginsLayer,
      sessionService,
      ConnectionServiceWithReferencesLayer,
    ).pipe(
      Layer.provideMerge(WorkspaceServiceLayer),
      Layer.provideMerge(RunWorkspaceStepActivityLayer),
      Layer.provideMerge(RunServiceReferenceLayer),
      Layer.provideMerge(DiscussionInputsReferenceLayer),
      Layer.provideMerge(WorkflowValidityObserversLayer),
      Layer.provideMerge(withFleet),
    );

    const steps = Effect.gen(function* () {
      // Right after the migrations, which `openDatabase` ran and which create
      // the seal's table, and before anything that a sealed controller must not
      // do.
      const flags = yield* config.ServeFlags;
      const promotion = yield* PromotionState;
      yield* promotion.restore(flags);

      const identity = yield* ControllerIdentity;
      const record = yield* identity.ensure;

      // A sealed controller has moved: its data and its work now live on the
      // new machine, and it only answers with the new address. So it skips
      // every step that starts or prepares work. A plugin activated here
      // would wait forever on the promotion gate, or act on data that moved.
      // The identity, the setup URL and the local runner still start, because
      // the local runner has to connect to receive the new address.
      if ((yield* promotion.phase)._tag !== "Sealed") {
        // There is no way to ask whether the harness received an input that
        // was in flight before this boot. So the input is never sent again,
        // which could deliver it twice: an agent step's prompt is marked
        // sent, any other input is cancelled, and the subscription records
        // which wake-up was lost. This runs after the migrations and before
        // anything is placed on a runner.
        yield* endStrandedInputsAndReportLostWakeUps;
        // Before the controller serves requests, so no import or delete
        // writes to the Skill Library's files while the sweep removes the
        // ones an interrupted write or a crash left behind. Leftover files
        // only take disk space, so a `skills/` folder that cannot be listed
        // is logged and the boot goes on.
        yield* Effect.catchTag(sweepSkillArchives, "SkillFileError", (error) =>
          Effect.logWarning(
            "Could not list the Skill Library folder, so no leftover file was removed; the next boot tries again",
            error,
          ),
        );
        yield* seed;

        // After the migrations and the identity, because a plugin that
        // activates may read its own state and secrets. Before the runner,
        // because a session's harness is looked up in the catalog.
        yield* Effect.flatMap(PluginHost, (host) => host.boot(options.plugins ?? registry));
        // After the plugins start, because a stored workflow is judged
        // against the actions, event kinds and Connection types of the active
        // plugins. A plugin may have changed while the controller was stopped.
        // A failure is logged and the boot goes on.
        yield* revalidateStoredWorkflowsOrLog;
      }

      const url = yield* ensureSetupUrl(paths, bootstrap);

      // Last, because the local runner joins over loopback as soon as it is up,
      // and it cannot join until the identity and the schema exist.
      const localRunner =
        options.localRunner === undefined
          ? undefined
          : yield* startLocalRunner(options.localRunner, {
              controllerUrl: buildControllerOrigin(bootstrap.bindHost, bootstrap.bindPort),
              home: paths.home,
              logLevel: bootstrap.logLevel,
            });

      yield* Ref.set(startedLocalRunner, localRunner);
      return { paths, identityId: record.id, setupUrl: url, localRunner } satisfies BootOutcome;
    });

    return yield* Effect.scoped(Effect.flatMap(steps, use)).pipe(
      Effect.provide(
        withPlugins.pipe(
          Layer.provideMerge(
            // The migrations run while the database opens, on the writer alone:
            // see `openDatabase`.
            openDatabase(
              paths,
              // An existing Master Key is opened first, because a migration
              // encrypts secrets again under it (spec 04, boot order). A key
              // that cannot be opened stops the boot before the database
              // changes. A machine with no key yet gets one after the
              // migrations, in `masterKeyLayer`.
              Effect.gen(function* () {
                const masterKey = yield* openExistingMasterKey(options.masterKeyBackend);
                yield* Ref.set(openedMasterKey, masterKey);
                return yield* migrate({
                  backupsDir: paths.backupsDir,
                  databaseExisted,
                  ...(masterKey === undefined ? {} : { masterKey }),
                });
              }),
            ),
          ),
        ),
      ),
      // A failed statement becomes one line that includes the file name,
      // because a controller that fails at boot has printed nothing else yet.
      Effect.catchTag("SqlError", (error) =>
        Effect.fail(createDatabaseError(paths.databaseFile, error)),
      ),
    );
  });

  // The process log is installed as soon as the config names the home and the
  // level, so the migrations and every later boot step log into
  // `<home>/logs/controller.log` too. A failure after that point is logged
  // there as well as printed, because a service unit keeps only the log; a
  // failure before it, such as a `config.toml` that does not parse, reaches
  // only stderr.
  const sequenceWithProcessLog = Effect.gen(function* () {
    const paths = yield* HerculeHome;
    const bootstrap = yield* BootstrapConfig;
    return yield* Effect.provide(
      sequence.pipe(
        Effect.tapCause((cause) => Effect.logError("The controller stopped on a failure", cause)),
      ),
      makeProcessLogLayer({ home: paths.home, role: "controller", level: bootstrap.logLevel }),
    );
  });

  return sequenceWithProcessLog.pipe(
    Effect.provide(Layer.mergeAll(config.layer(options.argv, options.env), BunFileSystem.layer)),
  );
};
