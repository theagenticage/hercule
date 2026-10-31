/**
 * Test helpers that run the controller over a real socket. The repositories
 * are the real ones; nothing is mocked.
 *
 * Everything a request passes through in production is in this stack: the
 * envelope, the pre-setup gate, the derived routes, both credential
 * middlewares and every service. Only the database (a temporary file), the master
 * key (a file in a temporary home) and the port (ephemeral) differ.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServer from "effect/http/HttpServer";
import * as SqlClient from "effect/sql/SqlClient";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import {
  live,
  type LiveMessage,
  type LiveTopic,
  type MutableLiveTopic,
  type Runner,
  type RunnerConnectivity,
  type RunnerLifecycle,
} from "@hercule/contract";
import type { Plugin } from "@hercule/plugin-host";
import { buildHomePaths, BootstrapConfig } from "@hercule/home";
import type { AssistantService } from "../assistants";
import { HerculeHome } from "../config";
import { ConnectionTypesLayer } from "../connections";
import { CredentialsLayer, hashToken } from "../credentials";
import type { DiscussionService } from "../discussions";
import {
  endStrandedInputsAndReportLostWakeUps,
  ConnectionServiceWithReferencesLayer,
  DiscussionInputs,
  EventRoutingInterval,
  IngestExecutorLayer,
  IngestReconcileInterval,
  Live,
  LostRunnerSweepInterval,
  OpenSignalsLayer,
  RunFibers,
  SchedulerInterval,
  AttachmentSweepInterval,
  SkillUpdateCheckInterval,
  SessionInputDeadline,
  TextGenerationDeadline,
  RunServiceReferenceLayer,
  DiscussionInputsReferenceLayer,
  ProviderAccountProbeDeadline,
  ProviderAccountProbeInterval,
  ProviderAccountProbingLayer,
  ProviderAccountSignInDeadline,
  SessionEditObserverLayer,
  SessionObserverLayer,
  revalidateStoredWorkflowsOrLog,
  WorkflowValidityObserversLayer,
  WorkspaceSweepInterval,
} from "../daemon";
import { CurrentActor, type Actor } from "../actor";
import { ExpressionBudget } from "../expressions";
import { nowIso, withTransaction } from "../db";
import { TestDatabase } from "../db/testing";
import {
  AuditLogLayer,
  PlatformEventsLayer,
  type AuditKind,
  type PlatformEventKind,
} from "../events";
import { NotifierLayer } from "../notifications";
import { readEventsOfKind, type LoggedEvent } from "../events/testing";
import { ControllerIdentity, controllerIdentityLayer } from "../identity";
import { COALESCE_WINDOW_MS, LiveTopics } from "../live";
import {
  buildProviderAccountOwner,
  masterKeyLayer,
  Secrets,
  secretsLayer,
  type MasterKeyBackend,
  type SecurityRunner,
} from "../secrets";
import { ModelProfileLookupLayer, ModelProfileMembershipLayer } from "../model-profiles";
import { PermissionProfilesLayer, SessionTokensLayer } from "../permissions";
import {
  findCredentialSecretName,
  PluginConfigsLayer,
  PluginHost,
  PluginHostLayer,
  PluginsLayer,
} from "../plugins";
import { buildHarnessDefinition, buildPluginWithProviderPerHarness } from "../plugins/testing";
import {
  providerAccountRepository,
  HarnessAccountsLayer,
  UnlistedModelsLayer,
  ModelCatalogsLayer,
  ProviderAccountProbesLayer,
  ProviderAccountRunnersLayer,
  ProviderAccountServiceLayer,
  ProviderKeyRequestsLayer,
} from "../provider-accounts";
import { SessionService, SessionServiceLayer } from "../sessions";
import { ConversationMessagesLayer } from "../conversations";
import { ResourceServiceLayer } from "../resources";
import { SettingsLayer } from "../settings";
import { AccountUsageLayer } from "../usage";
import { GithubSkillSources } from "../skills";
import { makeFakeGithub } from "../skills/testing";
import type { TextGeneration } from "../text-generation";
import { RunWorkspaceStepActivityLayer } from "../runs";
import { WorkspaceServiceLayer } from "../workspaces";
import {
  JoinTokens,
  JoinTokensLayer,
  LocalRunnerId,
  RunnerFactsDeadline,
  RunnerPingSchedule,
  RunnerConnectionsLayer,
  runnerRepository,
  type RunnerPings,
} from "../runners";
import { PromotionState, PromotionStateLayer, PromotionTokensLayer } from "../promotion";
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
 * Every service the routes use, on one temporary database file. The plugin host is
 * built here rather than with the operation layers, because the boot and the
 * routes must share one instance: a request must read the status the boot's
 * activation wrote.
 */
const buildServices = (
  home: string,
  githubSkillSources: GithubSkillSources["Service"],
  providerKeyHttpClient: HttpClient.HttpClient,
  masterKeyBackend: MasterKeyBackend = "file",
  securityRunner?: SecurityRunner,
  readLocalRunnerId: () => string | undefined = () => undefined,
) =>
  // The routes' layer includes the controller daemon, which uses the session
  // and workspace services and the plugin host. So this block's output is
  // provided to it rather than merged next to it, just as the real boot
  // provides what `withPlugins` built to the operation layers.
  operationLayers.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        PluginsLayer,
        // Observed by the assistants and runs domains, as in the real boot,
        // so a session's replies and notices reach its conversation, and an
        // agent step whose turn no runner will report fails.
        SessionServiceLayer.pipe(
          Layer.provide(SessionObserverLayer),
          Layer.provide(SessionEditObserverLayer),
          Layer.provide(ConversationMessagesLayer),
        ),
        // As in the real boot: a Connection's delete asks the resources and
        // workflows domains what still names it.
        ConnectionServiceWithReferencesLayer,
        ResourceServiceLayer,
      ).pipe(
        // As in the real boot: sessions take and release workspace leases,
        // the workspace service asks the runs domain whether a workspace
        // step is running, and the observer reaches the run service through
        // the one `RunServiceReference` the operation layers set.
        Layer.provideMerge(WorkspaceServiceLayer),
        Layer.provideMerge(RunWorkspaceStepActivityLayer),
        Layer.provideMerge(RunServiceReferenceLayer),
        Layer.provideMerge(DiscussionInputsReferenceLayer),
        // As in the real boot: a plugin's lifecycle change and a Connection's
        // or an agent's delete validate the stored workflows again.
        Layer.provideMerge(WorkflowValidityObserversLayer),
      ),
    ),
    // One connection map and one set of awaited device logins: the socket
    // route and every service must use the same `RunnerConnections` and
    // `ProviderAccountProbing`. The catalog is provided to the probes, which
    // read harness definitions from it.
    Layer.provideMerge(
      ProviderAccountProbingLayer.pipe(
        // Probing reads the catalogs that the provider's own API lists, which
        // the provider account service does.
        Layer.provideMerge(ProviderAccountServiceLayer),
        Layer.provideMerge(ProviderAccountProbesLayer),
        Layer.provideMerge(ModelCatalogsLayer),
        Layer.provideMerge(ProviderAccountRunnersLayer),
        Layer.provideMerge(Layer.succeed(LocalRunnerId, { read: readLocalRunnerId })),
        Layer.provideMerge(HarnessAccountsLayer),
        Layer.provideMerge(UnlistedModelsLayer),
        Layer.provideMerge(RunnerConnectionsLayer),
        Layer.provideMerge(
          PluginHostLayer.pipe(
            Layer.provide([IngestExecutorLayer, OpenSignalsLayer]),
            Layer.provideMerge(ConnectionTypesLayer),
            Layer.provideMerge(PluginConfigsLayer),
          ),
        ),
      ),
    ),
    Layer.provideMerge(NotifierLayer),
    Layer.provideMerge(AccountUsageLayer),
    Layer.provideMerge(PromotionStateLayer),
    Layer.provideMerge(
      Layer.mergeAll(
        UsersLayer,
        CredentialsLayer,
        SettingsLayer,
        PermissionProfilesLayer,
        AuditLogLayer,
        PlatformEventsLayer,
        // As in the real boot: Provider Accounts declares this port.
        ModelProfileMembershipLayer,
        // Projects declares this port as well, to check that a profile exists.
        ModelProfileLookupLayer,
        controllerIdentityLayer,
        JoinTokensLayer,
        SessionTokensLayer,
        PromotionTokensLayer,
        Layer.succeed(GithubSkillSources, githubSkillSources),
        ProviderKeyRequestsLayer.pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, providerKeyHttpClient)),
        ),
      ),
    ),
    Layer.provideMerge(
      secretsLayer.pipe(
        Layer.provideMerge(
          securityRunner === undefined
            ? masterKeyLayer(masterKeyBackend)
            : masterKeyLayer(masterKeyBackend, securityRunner),
        ),
      ),
    ),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HerculeHome, buildHomePaths(home, join(home, "data")))),
    Layer.provideMerge(
      Layer.succeed(
        BootstrapConfig,
        BootstrapConfig.of({
          dataDir: join(home, "data"),
          bindHost: "127.0.0.1",
          bindPort: 0,
          logLevel: "debug",
        }),
      ),
    ),
  );

/** The qualified id of the harness the test controller adds, and of its provider. */
export const TEST_HARNESS_ID = "test/test";

/**
 * Returns the plugins a test controller boots: the test's own, plus a plugin
 * with one provider and one harness when none of the test's plugins offers a
 * provider. Setup creates the default assistant, which needs a Provider
 * Account, so a controller with no provider cannot finish setup. The plugin is
 * built per call, so it holds nothing from a controller that has finished.
 */
const buildPluginRegistry = (plugins: ReadonlyArray<Plugin>): ReadonlyArray<Plugin> =>
  plugins.some((plugin) => plugin.manifest.capabilities.includes("providers"))
    ? plugins
    : [...plugins, buildPluginWithProviderPerHarness("test", [buildHarnessDefinition("test")])];

/**
 * Gives a test controller one account, so setup can create the default
 * assistant. The account is of the first registered provider's first account
 * kind that has a registered harness to run in, and that harness is its
 * default. A kind that holds a key or token gets one stored, so the account
 * can run. Does nothing when the controller already has an account.
 */
const addTestProviderAccount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const accounts = yield* providerAccountRepository;
  const secrets = yield* Secrets;
  const host = yield* PluginHost;
  if (yield* accounts.hasAny()) return;
  const harnesses = yield* host.harnesses();
  for (const provider of yield* host.providers()) {
    for (const kind of provider.kinds) {
      const harnessId = kind.harnesses.find((id) => harnesses.some((one) => one.id === id));
      if (harnessId === undefined) continue;
      yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const account = yield* accounts.insert({
            providerId: provider.id,
            kind: kind.id,
            label: null,
            defaultHarnessId: harnessId,
            at: yield* nowIso,
          });
          const credentialName = findCredentialSecretName(kind);
          if (credentialName !== undefined) {
            yield* secrets.set(
              buildProviderAccountOwner(account.id),
              credentialName,
              Redacted.make("test-credential"),
            );
          }
        }),
      );
      return;
    }
  }
}).pipe(Effect.catchTag("SecretNameError", Effect.die));

/**
 * The provider every key check reads when the test gives none: it accepts any
 * key, and no test reaches a real provider by accident.
 */
const acceptingProviderKeyClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}"))),
);

/**
 * The GitHub a test controller reads when the test gives none: every read
 * fails, so no test reaches the real GitHub by accident.
 */
const unreachableGithub = makeFakeGithub();
unreachableGithub.failReads("a test controller reads no GitHub");

/** Returns an address `fetch` can use; the server binds an ephemeral port on loopback. */
export const baseUrl = Effect.map(HttpServer.HttpServer, (server) => {
  const address = server.address;
  if (address._tag === "UnixPathAddress") throw new Error("expected a TCP address");
  return `http://127.0.0.1:${address.port}`;
});

/** Reads back the audit entries of one kind a request wrote, oldest first. */
export type AuditReader = <Kind extends AuditKind>(
  kind: Kind,
) => Promise<ReadonlyArray<LoggedEvent<Kind>>>;

/** Reads back the platform events of one kind the controller emitted, oldest first. */
export type PlatformEventReader = <Kind extends PlatformEventKind>(
  kind: Kind,
) => Promise<ReadonlyArray<LoggedEvent<Kind>>>;

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

/**
 * Runs an effect as the user against the running controller's live session
 * operations, its Discussion Inputs, its Discussion and session services, its
 * plugin host, its promotion gate, its text generation and its database, and
 * returns the effect's `Exit`. Tests use it for a method that no route calls,
 * such as `DiscussionInputs.tellSession`, and to build a second
 * `DiscussionInputs` around a test double.
 */
export type LiveSessionsRunner = <A, E>(
  effect: Effect.Effect<A, E, LiveSessionsServices>,
) => Promise<Exit.Exit<A, E>>;

/** What `LiveSessionsRunner` provides. */
export type LiveSessionsServices =
  | AssistantService
  | Live
  | DiscussionInputs
  | DiscussionService
  | SessionService
  | PluginHost
  | PromotionState
  | TextGeneration
  | SqlClient.SqlClient;

/** The user that `LiveSessionsRunner` runs an effect as. */
const TEST_USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/** Reads the subscriptions the controller holds for clients on its live socket. */
export interface LiveReader {
  readonly subscriberCount: (topic: LiveTopic) => Promise<number>;
}

/** What a test receives: the running controller, and helpers to inspect it. */
export interface ServerHarness {
  /** The temporary Home whose master key belongs to this test database. */
  readonly home: string;
  /** An address a fetch can use. */
  readonly base: string;
  readonly audit: AuditReader;
  readonly platformEvents: PlatformEventReader;
  readonly sql: SqlClient.SqlClient;
  readonly live: LiveReader;
  readonly insertRunner: RunnerArranger;
  readonly joinToken: JoinTokenArranger;
  readonly reboot: RebootArranger;
  readonly runWithLiveSessions: LiveSessionsRunner;
  /**
   * The controller's secrets repository. A test uses it to arrange a secret
   * the public API refuses to write, such as a connection's credentials.
   */
  readonly secrets: Secrets["Service"];
  /**
   * The controller's promotion gate. A test reads its state to know that work
   * waits at the gate while the controller is frozen or sealed.
   */
  readonly promotion: PromotionState["Service"];
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
  /** The default hour is longer than a test can wait. */
  readonly attachmentSweepInterval?: Duration.Duration;
  /** The default three hours is longer than a test can wait. */
  readonly skillUpdateCheckInterval?: Duration.Duration;
  /**
   * The GitHub the Skill Library's update check reads. Without it, every read
   * fails, so no test reaches the real GitHub.
   */
  readonly githubSkillSources?: GithubSkillSources["Service"];
  /**
   * The HTTP client a key check goes through. Without it, every key is
   * accepted, so no test reaches a real provider.
   */
  readonly providerKeyHttpClient?: HttpClient.HttpClient;
  /** The default second is too long for a test that waits several ticks. */
  readonly eventRoutingInterval?: Duration.Duration;
  /** The default minute is longer than a test can wait. */
  readonly lostRunnerSweepInterval?: Duration.Duration;
  /** How often the scheduler looks for cron triggers that are due. The default is a second. */
  readonly schedulerInterval?: Duration.Duration;
  /** How often the Ingest Reconciler opens and closes ingest handles. The default is two seconds. */
  readonly ingestReconcileInterval?: Duration.Duration;
  /** How long a text generation may wait for a slot and an answer. The default is over a minute. */
  readonly textGenerationDeadline?: Duration.Duration;
  /**
   * How long one evaluation of a condition may run before it is reported as
   * over budget. A test that wants every evaluation reported sets a budget no
   * evaluation can stay under, because the evaluator has no other option for
   * this.
   *
   * Unset, there is no budget at all, unlike the shipped 50 ms. The budget is
   * measured in wall-clock time, and a busy machine can pause the controller
   * between the two clock reads for longer than that. The evaluation then
   * counts as no match, and a test waiting for the match fails for a reason
   * it is not about.
   */
  readonly expressionBudget?: Duration.Duration;
  /**
   * The plugin registry. The real one is compiled in, so a test passes its
   * own. A harness plugin is added when none of these offers harnesses.
   */
  readonly plugins?: ReadonlyArray<Plugin>;
  /**
   * Returns the id the local runner reported, or `undefined` while it has
   * reported none. The harness starts no local runner, so without this the
   * controller has none. The controller calls it each time it needs the id,
   * so a test can name a runner that joins after the server is up.
   */
  readonly readLocalRunnerId?: () => string | undefined;
  /**
   * Where this controller keeps its Master Key. Defaults to the file store,
   * so a test never touches the developer's keychain. A promotion test that
   * covers macOS-to-Linux puts `"keychain"` here and a fake `security` runner.
   */
  readonly masterKeyBackend?: MasterKeyBackend;
  /** The `security` CLI the keychain store runs. Required with `"keychain"`. */
  readonly securityRunner?: SecurityRunner;
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
        yield* withTransaction(
          sql,
          sql`INSERT INTO setup_state (singleton, token_hash, completed_at)
              VALUES (1, ${hashToken(SETUP_TOKEN)}, NULL)`,
        );
        // The boot's steps, in the boot's order, so a request sees what a real
        // controller would have. Kept as one effect because `reboot` runs them
        // again.
        const bootSteps = Effect.gen(function* () {
          yield* endStrandedInputsAndReportLostWakeUps;
          yield* Effect.flatMap(ControllerIdentity, (identity) => identity.ensure);
          yield* seed;
          yield* Effect.flatMap(PluginHost, (host) =>
            host.boot(buildPluginRegistry(options.plugins ?? [])),
          );
          yield* revalidateStoredWorkflowsOrLog;
          yield* addTestProviderAccount;
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
        const audit: AuditReader = (kind) =>
          Effect.runPromise(
            Effect.orDie(Effect.provideService(readEventsOfKind(kind), SqlClient.SqlClient, sql)),
          );
        const platformEvents: PlatformEventReader = (kind) =>
          Effect.runPromise(
            Effect.orDie(Effect.provideService(readEventsOfKind(kind), SqlClient.SqlClient, sql)),
          );
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
                return yield* withTransaction(
                  sql,
                  Effect.gen(function* () {
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
                );
              }),
            ),
          );
        const liveSessions = yield* Effect.context<LiveSessionsServices>();
        const runWithLiveSessions: LiveSessionsRunner = (effect) =>
          Effect.runPromiseExit(
            Effect.provideService(
              Effect.provideContext(effect, liveSessions),
              CurrentActor,
              TEST_USER,
            ),
          );
        const secrets = yield* Secrets;
        const promotion = yield* PromotionState;
        const tokens = yield* JoinTokens;
        const joinToken: JoinTokenArranger = () =>
          Effect.runPromise(
            Effect.orDie(
              Effect.flatMap(nowIso, (at) =>
                Effect.map(withTransaction(sql, tokens.create(at)), (one) => one.token),
              ),
            ),
          );
        yield* Effect.promise(() =>
          body({
            home,
            base,
            audit,
            platformEvents,
            sql,
            live,
            insertRunner,
            joinToken,
            reboot,
            runWithLiveSessions,
            secrets,
            promotion,
            isRunExecuting: (runId) => FiberMap.hasUnsafe(runFibers, runId),
          }),
        );
      }),
    ).pipe(
      Effect.provide(
        buildServices(
          home,
          options.githubSkillSources ?? unreachableGithub.service,
          options.providerKeyHttpClient ?? acceptingProviderKeyClient,
          options.masterKeyBackend,
          options.securityRunner,
          options.readLocalRunnerId,
        ).pipe(
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
    provideIfSet(ProviderAccountProbeDeadline, options.probeDeadline);
    provideIfSet(ProviderAccountProbeInterval, options.probeInterval);
    provideIfSet(ProviderAccountSignInDeadline, options.loginDeadline);
    provideIfSet(SessionInputDeadline, options.inputDeadline);
    provideIfSet(WorkspaceSweepInterval, options.workspaceSweepInterval);
    provideIfSet(AttachmentSweepInterval, options.attachmentSweepInterval);
    provideIfSet(SkillUpdateCheckInterval, options.skillUpdateCheckInterval);
    provideIfSet(EventRoutingInterval, options.eventRoutingInterval);
    provideIfSet(LostRunnerSweepInterval, options.lostRunnerSweepInterval);
    provideIfSet(SchedulerInterval, options.schedulerInterval);
    provideIfSet(IngestReconcileInterval, options.ingestReconcileInterval);
    provideIfSet(TextGenerationDeadline, options.textGenerationDeadline);
    provideIfSet(ExpressionBudget, options.expressionBudget ?? Duration.infinity);
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
  if (response.status !== 200)
    throw new Error(`setup.complete answered ${response.status}: ${await response.text()}`);
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

/**
 * Builds the client side of a live connection. `pingTimeout` is how long the
 * client waits for a pong before it drops the connection as silent. It defaults
 * to the RPC client's own five seconds.
 */
export const buildLiveConnection = (base: string, pingTimeout?: Duration.Input) =>
  RpcClient.layerProtocolSocket({ pingTimeout }).pipe(
    Layer.provide(BunSocket.layerWebSocket(buildSocketUrl(base))),
    Layer.provide(RpcSerialization.layerJson),
  );

/**
 * Opens one connection while `body` runs, with the JSON serialization a browser
 * uses. `pingTimeout` is passed on to {@link buildLiveConnection}.
 */
export const onSocket = (
  base: string,
  body: (client: LiveClient) => Effect.Effect<void, unknown, Scope.Scope>,
  pingTimeout?: Duration.Input,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(live);
        yield* body(client);
      }).pipe(Effect.provide(buildLiveConnection(base, pingTimeout))),
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
): Effect.Effect<Collected, never, Scope.Scope> => collectStream(client.subscribe(payload));

/**
 * Holds a subscription to a mutable topic open and keeps every push after
 * the first one, in order. The controller opens every mutable subscription
 * with a push that says every record may have changed. That push is the
 * same whatever the test does, so it is left out here, and a test about it
 * uses `collectMessages`.
 */
export const collectPushes = (
  client: LiveClient,
  topic: MutableLiveTopic,
): Effect.Effect<Collected, never, Scope.Scope> =>
  collectStream(Stream.drop(client.subscribe({ topic }), 1));

/** Runs a subscription's stream in the background and keeps every message it receives, in order. */
const collectStream = <E>(
  stream: Stream.Stream<LiveMessage, E>,
): Effect.Effect<Collected, never, Scope.Scope> =>
  Effect.gen(function* () {
    const received: Array<LiveMessage> = [];
    const fiber = yield* Effect.forkChild(
      Stream.runForEach(stream, (message) =>
        Effect.sync(() => {
          received.push(message);
        }),
      ),
    );
    return { received, fiber };
  });
