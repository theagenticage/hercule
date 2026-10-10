/**
 * Tests for the frames the sessions domain builds: the complete `sessionStart`
 * frames `starting` returns, and the one-line builders for the frames sent
 * later in a session's life. Also tests `endOnLostRunners`.
 *
 * The tests check the frame's shape on the wire and where each field comes
 * from, not how the domain builds it:
 *
 * - the token, of which the row stores only a hash;
 * - the spec, decoded from the JSON the row stores;
 * - the GitHub account of a connection whose token can be read.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Redacted } from "effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  SessionSpec,
  type ModelSelection,
  type SessionInputResult,
  type SessionStart,
} from "@hercule/protocol";
import { buildHomePaths, HerculeHome } from "../config";
import { connectionRepository, ConnectionTypesLayer, GITHUB_CONNECTION_TYPE } from "../connections";
import { hashToken } from "../credentials";
import { IngestExecutorLayer } from "../daemon/ingest";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../db";
import { ServingPromotionStateLayer } from "../promotion/testing";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { NotifierLayer } from "../notifications";
import { SessionTokens, SessionTokensLayer } from "../permissions";
import { PluginConfigsLayer, PluginHostLayer } from "../plugins";
import { masterKeyLayer } from "../secrets/masterKey";
import { Secrets, secretsLayer, type SecretOwner } from "../secrets/repository";
import { RunWorkspaceStepActivityLayer } from "../runs";
import { SettingsLayer } from "../settings";
import { githubAccounts, WorkspaceService, WorkspaceServiceLayer } from "../workspaces";
import type { GithubAccount } from "../workspaces";
import { inputRepository, type StoredInput } from "./inputs";
import { sessionRepository } from "./repository";
import { SessionObserver } from "./observer";
import { SessionService, SessionServiceLayer, type StartRequest } from "./service";

/** Temporary Hercule Homes for the master key, deleted after each test. */
let homes: Array<string> = [];

/**
 * Builds a real plugin host with no plugins. It is needed because a session
 * record lists what its provider does not enforce, and that list is read from
 * the provider definitions the host holds.
 */
const buildHostLayer = (secrets: Layer.Layer<Secrets, unknown, SqlClient.SqlClient>) =>
  PluginHostLayer.pipe(
    Layer.provide(IngestExecutorLayer),
    Layer.provideMerge(ConnectionTypesLayer),
    Layer.provideMerge(PluginConfigsLayer),
    Layer.provideMerge(secrets),
    Layer.provideMerge(NotifierLayer),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(ServingPromotionStateLayer),
  );

/**
 * Builds a layer that creates a temporary home when the layer is built, not
 * when this module loads. The cleanup after each test deletes the homes, so a
 * home created once at import would be gone by the second test.
 */
const buildHomeLayer = (): Layer.Layer<HerculeHome> =>
  Layer.effect(HerculeHome)(
    Effect.sync(() => {
      const home = mkdtempSync(join(tmpdir(), "hercule-sessions-"));
      homes.push(home);
      return HerculeHome.of(buildHomePaths(home, join(home, "data")));
    }),
  );

const buildRealSecretsLayer = () =>
  secretsLayer.pipe(Layer.provide(masterKeyLayer("file").pipe(Layer.provide(buildHomeLayer()))));

/** Ignores everything it is told: these tests do not look at what another domain does with it. */
const ignoreSessions = Layer.succeed(
  SessionObserver,
  SessionObserver.of({
    sessionReported: () => Effect.void,
    sessionExited: () => Effect.void,
    inputsDropped: () => Effect.void,
  }),
);

/**
 * Builds the workspace service a session takes and releases its leases
 * through, with the runs domain answering whether a workspace step is running,
 * as in the real boot.
 */
const buildWorkspaceLayer = () =>
  WorkspaceServiceLayer.pipe(
    Layer.provideMerge(RunWorkspaceStepActivityLayer),
    Layer.provideMerge(SettingsLayer),
  );

const layer = SessionServiceLayer.pipe(
  Layer.provideMerge(buildWorkspaceLayer()),
  Layer.provideMerge(
    Layer.mergeAll(
      AuditLogLayer,
      SessionTokensLayer,
      ignoreSessions,
      buildHostLayer(buildRealSecretsLayer()),
    ),
  ),
  Layer.provideMerge(TestDatabase),
);

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
  Effect.runPromise(Effect.provide(effect, layer));

const at = "2026-09-07T10:00:00.000Z";

/** Returns a layer whose logger appends each logged message to `logged`, its parts joined by spaces. */
const captureLogs = (logged: Array<string>) =>
  Layer.succeed(
    Logger.CurrentLoggers,
    new Set<Logger.Logger<unknown, unknown>>([
      {
        log: (entry: { readonly message: ReadonlyArray<unknown> }): void => {
          logged.push(entry.message.map(String).join(" "));
        },
      } as unknown as Logger.Logger<unknown, unknown>,
    ]),
  );

/** Returns a new canonical v7 id, the only id format the database accepts. */
const mintId = () => uuidToString(mintUuid());

/** Encodes a spec the way `create` stores it on a queued row. */
const encodeSpec = Schema.encodeUnknownSync(SessionSpec);

const buildSpec = (instanceId: string, model: string): SessionSpec => ({
  instanceId,
  workspaceId: null,
  modelSelection: { model, options: {} },
  accessMode: "approval-required",
  timeouts: { inactivityMs: 60_000, absoluteMs: 3_600_000 },
});

/**
 * Inserts a provider instance row. A start frame's `providerId` and `config`
 * come from this row, which `oldestQueued` joins in.
 */
const insertInstance = (
  providerId: string,
  config: Readonly<Record<string, unknown>>,
): Effect.Effect<string, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = mintUuid();
    yield* sql`
      INSERT INTO provider_instances (id, provider_id, name, config, created_at, updated_at)
      VALUES (${id}, ${providerId}, 'an instance', ${JSON.stringify(config)}, ${at}, ${at})
    `;
    return uuidToString(id);
  });

/** Inserts one queued session on a runner, the way `create` stores one. */
const insertQueuedSession = (
  runnerId: string,
  options: {
    readonly instanceId: string;
    readonly spec: SessionSpec;
    /** Stores this string as the spec, as is, instead of encoding `spec`. */
    readonly storedSpec?: string;
    readonly checkoutBranch?: string;
    readonly githubConnectionId?: string;
    /** An existing profile row, for a test whose session token has to resolve. */
    readonly permissionProfileId?: string;
    /** The Agent the session runs as. Without it the session is a Thread. */
    readonly agentId?: string;
    /**
     * Stores no input with the session, like a row queued before a start
     * carried its first input. `create` always stores the prompt.
     */
    readonly withoutInput?: boolean;
    /**
     * The agent step that started the session. Its input is then the
     * prompt of the step's first iteration.
     */
    readonly step?: { readonly runId: string; readonly stepId: string };
  },
): Effect.Effect<string, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    const inputs = yield* inputRepository;
    const id = mintId();
    yield* sessions.insert({
      id,
      title: "a session",
      permissionProfileId: options.permissionProfileId ?? mintId(),
      agentId: options.agentId,
      conversationId: undefined,
      step: options.step,
      instanceId: options.instanceId,
      runnerId,
      workspaceId: null,
      projectId: undefined,
      checkoutBranch: options.checkoutBranch,
      githubConnectionId: options.githubConnectionId,
      requestedAccessMode: "approval-required",
      accessMode: "approval-required",
      // The spec is stored as is: a start frame's spec is decoded from exactly
      // this string.
      spec: options.storedSpec ?? JSON.stringify(encodeSpec(options.spec)),
      modelSelection: options.spec.modelSelection,
      parentSessionId: undefined,
      at,
    });
    if (options.withoutInput !== true) {
      yield* inputs.insert({
        sessionId: id,
        source: "user",
        actor: "user",
        text: "begin",
        at,
        ...(options.step === undefined ? {} : { stepIteration: 1 }),
      });
    }
    return id;
  });

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

/**
 * Builds the service layer with a gated `Secrets.values`: it signals `entered`
 * and then waits on `hold`. So an interruption that arrives there has to pass
 * through the credential reader's error handling. The rest of the stack is
 * real, over the same database, with its own master key in a temporary home.
 */
const buildGatedCredentialStack = (
  entered: Deferred.Deferred<void>,
  hold: Deferred.Deferred<void>,
) => {
  const gatedSecrets = Layer.effect(
    Secrets,
    Effect.map(Effect.provide(Secrets, buildRealSecretsLayer()), (inner) => ({
      ...inner,
      values: (owner: SecretOwner) =>
        Effect.andThen(
          Deferred.succeed(entered, undefined),
          Effect.andThen(Deferred.await(hold), inner.values(owner)),
        ),
    })),
  );
  return SessionServiceLayer.pipe(
    Layer.provideMerge(buildWorkspaceLayer()),
    Layer.provideMerge(
      Layer.mergeAll(
        AuditLogLayer,
        SessionTokensLayer,
        ignoreSessions,
        gatedSecrets,
        buildHostLayer(gatedSecrets),
      ),
    ),
    Layer.provideMerge(TestDatabase),
  );
};

/**
 * Inserts a real GitHub connection with an encrypted token. The credential
 * reader reads a secret only for such a connection.
 */
const aGithubConnection = Effect.gen(function* () {
  const secrets = yield* Secrets;
  const connections = yield* connectionRepository;
  const connection = yield* connections.insert({
    pluginId: "github",
    type: GITHUB_CONNECTION_TYPE,
    label: "work",
    displayName: "octocat",
    accountId: "583231",
    labels: [],
    config: {},
    at,
  });
  yield* secrets.set(
    { kind: "connection", id: connection.id },
    "pat",
    Redacted.make("ghp_a-real-looking-token"),
  );
  return connection.id;
});

/** Returns no credentials, for the instance these sessions run on. */
const NO_SECRETS = (): Effect.Effect<Record<string, string>> => Effect.succeed({});

/** The identity the connection's account in these tests commits as. */
const ALICE = { name: "alice", email: "alice@users.noreply.github.com" };

/**
 * Calls `claimStarts` the way the controller daemon does: inside the caller's
 * transaction. Without `options.localRunnerId` the controller has no local
 * runner.
 */
const claimStarting = (
  runnerId: string,
  room: number,
  readGithubAccount: (connectionId: string) => Effect.Effect<GithubAccount | undefined>,
  options: { readonly localRunnerId?: string } = {},
): Effect.Effect<ReadonlyArray<StartRequest>, SqlError, SessionService | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* SessionService;
    return yield* withTransaction(
      sql,
      sessions.claimStarts(runnerId, room, {
        readGithubAccount,
        readSecrets: NO_SECRETS,
        localRunnerId: options.localRunnerId,
      }),
    );
  });

/** Reads a session's token hash directly from the row. */
const readTokenHash = (sessionId: string) =>
  Effect.map(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql<{ readonly token_hash: string | null }>`
          SELECT token_hash FROM sessions WHERE id = unhex(${sessionId.replaceAll("-", "")})
        `,
    ),
    (rows) => rows[0]!.token_hash,
  );

/** Returns the frames a claim returned, keyed by session id. */
const mapFramesBySession = (claimed: ReadonlyArray<StartRequest>): Map<string, SessionStart> =>
  new Map(claimed.map((claim) => [claim.sessionId, claim.frame] as const));

describe("SessionService.claimStarts", () => {
  it("returns one complete sessionStart frame per session it moved to starting", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rows = yield* sessionRepository;
        const instanceId = yield* insertInstance("an-adapter", {
          token: "t",
          baseUrl: "https://api",
        });
        const runnerId = mintId();
        const specOnBranch = buildSpec(instanceId, "clever");
        const specPlain = buildSpec(instanceId, "fast");
        const onBranch = yield* insertQueuedSession(runnerId, {
          instanceId,
          spec: specOnBranch,
          checkoutBranch: "feature-x",
        });
        const plain = yield* insertQueuedSession(runnerId, { instanceId, spec: specPlain });
        const claimed = yield* claimStarting(runnerId, 2, () => Effect.succeed(undefined));
        const inputs = yield* inputRepository;
        return {
          claimed,
          onBranch,
          plain,
          specOnBranch,
          specPlain,
          onBranchAfter: yield* Effect.map(rows.one(onBranch), Option.getOrUndefined),
          plainAfter: yield* Effect.map(rows.one(plain), Option.getOrUndefined),
          onBranchInput: yield* Effect.map(
            inputs.read(claimed.find((claim) => claim.sessionId === onBranch)!.input.id),
            Option.getOrUndefined,
          ),
        };
      }),
    );

    expect(result.claimed).toHaveLength(2);
    const frames = mapFramesBySession(result.claimed);
    expect([...frames.keys()].sort()).toEqual([result.onBranch, result.plain].sort());

    const branch = frames.get(result.onBranch)!;
    expect(branch._tag).toBe("sessionStart");
    expect(branch.providerId).toBe("an-adapter");
    expect(branch.config).toEqual({ token: "t", baseUrl: "https://api" });
    // Decoded from the spec the row stores, not built again from other fields.
    expect(branch.spec).toStrictEqual(result.specOnBranch);
    expect(branch.checkoutBranch).toBe("feature-x");
    expect(typeof branch.token).toBe("string");
    expect(branch.token.length).toBeGreaterThan(0);

    const plain = frames.get(result.plain)!;
    expect(plain.spec).toStrictEqual(result.specPlain);
    // When the row has no branch, the frame has no `checkoutBranch` key at all.
    expect("checkoutBranch" in plain).toBe(false);

    // Both claimed rows moved to `starting`.
    expect(result.onBranchAfter?.status).toBe("starting");
    expect(result.plainAfter?.status).toBe("starting");

    // The frame carries the session's waiting input, claimed in the same
    // transaction, with the model selection the session runs on.
    const input = result.onBranchInput;
    expect(input).toMatchObject({ status: "queued", text: "begin" });
    expect(input!.sentAt).not.toBeNull();
    expect(branch.requestId).toBe(input!.id);
    expect(branch.input).toStrictEqual({
      text: "begin",
      modelSelection: result.specOnBranch.modelSelection,
    });
    expect(result.claimed.find((claim) => claim.sessionId === result.onBranch)?.input).toEqual(
      input,
    );
  });

  it("puts the step key on the input the start of an agent step's session carries", async () => {
    // The runner reports the result of the turn the prompt starts only when
    // the prompt carries its step's key, whether a start or a sessionInput
    // carries it.
    const runId = mintId();
    const result = await run(
      Effect.gen(function* () {
        const instanceId = yield* insertInstance("an-adapter", {});
        const runnerId = mintId();
        const spec = buildSpec(instanceId, "fast");
        yield* insertQueuedSession(runnerId, {
          instanceId,
          spec,
          step: { runId, stepId: "implement" },
        });
        const [claimed] = yield* claimStarting(runnerId, 1, () => Effect.succeed(undefined));
        return { frame: claimed!.frame, input: claimed!.input, spec };
      }),
    );

    expect(result.input.stepIteration).toBe(1);
    expect(result.frame.input).toStrictEqual({
      text: "begin",
      modelSelection: result.spec.modelSelection,
      step: { runId, stepId: "implement", iteration: 1 },
    });
  });

  it("skips a queued session that never ran and has no waiting input, leaves it queued, and warns once", async () => {
    // A row queued before a start carried its first input. A start without
    // an input would open no turn, so the session is left for a person to
    // see, not started empty.
    const logged: Array<string> = [];
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const rows = yield* sessionRepository;
          const instanceId = yield* insertInstance("an-adapter", {});
          const runnerId = mintId();
          const legacy = yield* insertQueuedSession(runnerId, {
            instanceId,
            spec: buildSpec(instanceId, "clever"),
            withoutInput: true,
          });
          const current = yield* insertQueuedSession(runnerId, {
            instanceId,
            spec: buildSpec(instanceId, "clever"),
          });
          const claimed = yield* claimStarting(runnerId, 2, () => Effect.succeed(undefined));
          // Every later dispatch pass reads the row again.
          yield* claimStarting(runnerId, 2, () => Effect.succeed(undefined));
          return {
            claimed: claimed.map((claim) => claim.sessionId),
            current,
            legacy,
            legacyAfter: yield* Effect.map(rows.one(legacy), Option.getOrUndefined),
          };
        }),
        layer.pipe(Layer.provideMerge(captureLogs(logged))),
      ),
    );

    expect(result.claimed).toEqual([result.current]);
    expect(result.legacyAfter?.status).toBe("queued");
    const warnings = logged.filter((line) => line.includes("never ran"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(result.legacy);
  });

  it("moves a resumed session with no waiting input back to the exit it was resumed from", async () => {
    // A resume queues a session for the input that woke it. If that input
    // is gone by the time dispatch reads the row, the resumed process would
    // have nothing to do, so the session goes back to being exited.
    const exitedAt = "2026-09-07T09:00:00.000Z";
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sessionRepository;
        const workspaces = yield* WorkspaceService;
        const instanceId = yield* insertInstance("an-adapter", {});
        // A runner that is not retired, a ready workspace on it and a known
        // transcript: everything the session needs to read as resumable.
        const runnerId = mintId();
        yield* sql`
          INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                               credential_hash, created_at, updated_at)
          VALUES (${uuidFromString(runnerId)}, ${runnerId}, 'online', 'active', 0, '[]',
                  'a hash', ${at}, ${at})
        `;
        const workspaceId = mintId();
        yield* sql`
          INSERT INTO workspaces (id, runner_id, kind, status, created_at)
          VALUES (${uuidFromString(workspaceId)}, ${uuidFromString(runnerId)}, 'ephemeral',
                  'ready', ${at})
        `;
        const spec = JSON.stringify(encodeSpec(buildSpec(instanceId, "clever")));
        const sessionId = yield* insertQueuedSession(runnerId, {
          instanceId,
          spec: buildSpec(instanceId, "clever"),
          withoutInput: true,
        });
        yield* sql`
          UPDATE sessions SET workspace_id = ${uuidFromString(workspaceId)}
          WHERE id = ${uuidFromString(sessionId)}
        `;
        yield* rows.bind(sessionId, runnerId, instanceId, "native-1");
        const holder = { kind: "session", id: sessionId } as const;
        yield* workspaces.acquire(holder, workspaceId, exitedAt);
        const { lastActivityAt: lastActiveBeforeExit } = Option.getOrThrow(
          yield* rows.one(sessionId),
        );
        yield* rows.moved(sessionId, "exited", exitedAt);
        yield* workspaces.release(holder, "idle", exitedAt);
        // What a resume writes: the row back on the queue, the lease taken
        // again, and the crash-loop guard armed.
        yield* rows.resume(sessionId, spec);
        yield* workspaces.acquire(holder, workspaceId, at);
        yield* rows.setCrashGuardArmed(sessionId, true);

        const claimed = yield* claimStarting(runnerId, 1, () => Effect.succeed(undefined));
        const stream = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM session_stream WHERE session_id = ${uuidFromString(sessionId)}
        `;
        const leases = yield* sql<{
          readonly released_at: string | null;
          readonly retention: string | null;
          readonly kept_until: string | null;
        }>`
          SELECT released_at, retention, kept_until FROM workspace_leases
          WHERE holder_id = ${uuidFromString(sessionId)}
        `;
        return {
          claimed,
          after: Option.getOrThrow(yield* rows.one(sessionId)),
          lastActiveBeforeExit,
          streamRows: stream[0]!.count,
          leases,
        };
      }),
    );

    expect(result.claimed).toEqual([]);
    expect(result.after).toMatchObject({
      status: "exited",
      exitedAt,
      resumable: true,
      // The resume armed the guard, and it goes back to disarmed. Neither the
      // exit nor the resume touched the last activity.
      crashGuardArmed: false,
      lastActivityAt: result.lastActiveBeforeExit,
    });
    expect(result.lastActiveBeforeExit).not.toBe(exitedAt);
    // Nothing exited again, so no exit was written to the stream.
    expect(result.streamRows).toBe(0);
    // The session can still be resumed, so the workspace is kept for the
    // idle window of thirty days, counted from the original exit.
    expect(result.leases).toEqual([
      {
        released_at: exitedAt,
        retention: "idle",
        kept_until: new Date(Date.parse(exitedAt) + 30 * 24 * 3_600_000).toISOString(),
      },
    ]);
  });

  it("creates a new token and stores only its hash on the row", async () => {
    const result = await run(
      Effect.gen(function* () {
        const instanceId = yield* insertInstance("an-adapter", {});
        const runnerId = mintId();
        const first = yield* insertQueuedSession(runnerId, {
          instanceId,
          spec: buildSpec(instanceId, "clever"),
        });
        const second = yield* insertQueuedSession(runnerId, {
          instanceId,
          spec: buildSpec(instanceId, "clever"),
        });
        const claimed = yield* claimStarting(runnerId, 2, () => Effect.succeed(undefined));
        return {
          claimed,
          first,
          second,
          firstHash: yield* readTokenHash(first),
          secondHash: yield* readTokenHash(second),
        };
      }),
    );

    expect(result.claimed).toHaveLength(2);
    const frames = mapFramesBySession(result.claimed);
    const firstFrame = frames.get(result.first)!;
    const secondFrame = frames.get(result.second)!;
    // The row stores the hash of the token the frame carries, never the token.
    expect(hashToken(firstFrame.token)).toBe(result.firstHash);
    expect(firstFrame.token).not.toBe(result.firstHash);
    expect(hashToken(secondFrame.token)).toBe(result.secondHash);
    // Created per start: two sessions in one claim never share a token.
    expect(firstFrame.token).not.toBe(secondFrame.token);
  });

  it("includes the connection's GitHub account, and reads it only for rows with a connection", async () => {
    const connectionId = mintId();
    const result = await run(
      Effect.gen(function* () {
        const instanceId = yield* insertInstance("an-adapter", {});
        const runnerId = mintId();
        const connected = yield* insertQueuedSession(runnerId, {
          instanceId,
          spec: buildSpec(instanceId, "clever"),
          githubConnectionId: connectionId,
        });
        const bare = yield* insertQueuedSession(runnerId, {
          instanceId,
          spec: buildSpec(instanceId, "clever"),
        });
        const asked: Array<string> = [];
        const claimed = yield* claimStarting(runnerId, 2, (id) =>
          Effect.sync(() => {
            asked.push(id);
            return { token: "ghpat-alice", gitIdentity: ALICE };
          }),
        );
        return { asked, claimed, connected, bare };
      }),
    );

    // The account was read only for the row with a connection.
    expect(result.asked).toEqual([connectionId]);

    const frames = mapFramesBySession(result.claimed);
    const account = frames.get(result.connected)!;
    expect(account.ghToken).toBe("ghpat-alice");
    expect(account.gitIdentity).toStrictEqual(ALICE);

    const none = frames.get(result.bare)!;
    expect("ghToken" in none).toBe(false);
    expect("gitIdentity" in none).toBe(false);
  });

  it("omits ghToken and gitIdentity where the connection has no account", async () => {
    const connectionId = mintId();
    const result = await run(
      Effect.gen(function* () {
        const instanceId = yield* insertInstance("an-adapter", {});
        const runnerId = mintId();
        const sessionId = yield* insertQueuedSession(runnerId, {
          instanceId,
          spec: buildSpec(instanceId, "clever"),
          githubConnectionId: connectionId,
        });
        const asked: Array<string> = [];
        const claimed = yield* claimStarting(runnerId, 1, (id) =>
          Effect.sync(() => {
            asked.push(id);
            return undefined;
          }),
        );
        return { asked, claimed, sessionId };
      }),
    );

    // The account was read, and there was none.
    expect(result.asked).toEqual([connectionId]);
    expect(result.claimed).toHaveLength(1);
    expect(result.claimed[0]!.frame).toMatchObject({ sessionId: result.sessionId });
    expect("ghToken" in result.claimed[0]!.frame).toBe(false);
    expect("gitIdentity" in result.claimed[0]!.frame).toBe(false);
  });

  it("sets the `userMaterial` flag only for a Thread on the local runner", async () => {
    const result = await run(
      Effect.gen(function* () {
        const instanceId = yield* insertInstance("an-adapter", {});
        const spec = buildSpec(instanceId, "clever");
        const localRunnerId = mintId();
        const otherRunnerId = mintId();
        const localThread = yield* insertQueuedSession(localRunnerId, { instanceId, spec });
        const localAgentSession = yield* insertQueuedSession(localRunnerId, {
          instanceId,
          spec,
          agentId: mintId(),
        });
        const otherThread = yield* insertQueuedSession(otherRunnerId, { instanceId, spec });
        const noAccount = () => Effect.succeed(undefined);
        return {
          local: mapFramesBySession(
            yield* claimStarting(localRunnerId, 2, noAccount, { localRunnerId }),
          ),
          other: mapFramesBySession(
            yield* claimStarting(otherRunnerId, 1, noAccount, { localRunnerId }),
          ),
          localThread,
          localAgentSession,
          otherThread,
        };
      }),
    );

    expect(result.local.get(result.localThread)!.userMaterial).toBe(true);
    // An Agent's session never gets the flag, and neither does a Thread on
    // another runner. Both frames leave the key out rather than setting it to
    // false.
    expect("userMaterial" in result.local.get(result.localAgentSession)!).toBe(false);
    expect("userMaterial" in result.other.get(result.otherThread)!).toBe(false);
  });

  it("leaves a row whose stored spec will not decode queued, and starts the rest of the batch", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rows = yield* sessionRepository;
        const instanceId = yield* insertInstance("an-adapter", {});
        const runnerId = mintId();
        // Valid JSON that the current `SessionSpec` schema fails to decode.
        // This is what a queued row looks like after the schema changed
        // under it.
        const poisoned = yield* insertQueuedSession(runnerId, {
          instanceId,
          spec: buildSpec(instanceId, "clever"),
          storedSpec: "{}",
        });
        const good = yield* insertQueuedSession(runnerId, {
          instanceId,
          spec: buildSpec(instanceId, "clever"),
        });
        const claimed = yield* claimStarting(runnerId, 2, () => Effect.succeed(undefined));
        return {
          claimed,
          poisoned,
          good,
          poisonedAfter: yield* Effect.map(rows.one(poisoned), Option.getOrUndefined),
          goodAfter: yield* Effect.map(rows.one(good), Option.getOrUndefined),
        };
      }),
    );

    // The bad row is not claimed: it stays queued, where a user can see and stop it.
    expect(result.claimed.map((claim) => claim.sessionId)).toEqual([result.good]);
    expect(result.poisonedAfter?.status).toBe("queued");
    // And it does not block the rows behind it.
    expect(result.goodAfter?.status).toBe("starting");
  });

  it("starts the row behind an undecodable first row when there is room for only one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rows = yield* sessionRepository;
        const instanceId = yield* insertInstance("an-adapter", {});
        const runnerId = mintId();
        const poisoned = yield* insertQueuedSession(runnerId, {
          instanceId,
          spec: buildSpec(instanceId, "clever"),
          storedSpec: "{}",
        });
        const good = yield* insertQueuedSession(runnerId, {
          instanceId,
          spec: buildSpec(instanceId, "clever"),
        });
        const claimed = yield* claimStarting(runnerId, 1, () => Effect.succeed(undefined));
        return {
          claimed,
          poisoned,
          good,
          poisonedAfter: yield* Effect.map(rows.one(poisoned), Option.getOrUndefined),
        };
      }),
    );

    // Room for one, and the oldest row cannot use it, so the next row does.
    expect(result.claimed.map((claim) => claim.sessionId)).toEqual([result.good]);
    expect(result.poisonedAfter?.status).toBe("queued");
  });

  it("skips any number of undecodable rows to fill the room", async () => {
    const result = await run(
      Effect.gen(function* () {
        const instanceId = yield* insertInstance("an-adapter", {});
        const runnerId = mintId();
        for (let i = 0; i < 6; i += 1) {
          yield* insertQueuedSession(runnerId, {
            instanceId,
            spec: buildSpec(instanceId, "clever"),
            storedSpec: "{}",
          });
        }
        const good = yield* insertQueuedSession(runnerId, {
          instanceId,
          spec: buildSpec(instanceId, "clever"),
        });
        const claimed = yield* claimStarting(runnerId, 2, () => Effect.succeed(undefined));
        return { claimed, good };
      }),
    );

    // Six undecodable rows first, room for two, and one valid row after
    // them: the loop reaches the valid row and claims it.
    expect(result.claimed.map((claim) => claim.sessionId)).toEqual([result.good]);
  });

  it("passes an interruption on instead of logging it as an unreadable connection", async () => {
    const entered = Effect.runSync(Deferred.make<void>());
    const hold = Effect.runSync(Deferred.make<void>());
    const logged: Array<string> = [];
    const stack = buildGatedCredentialStack(entered, hold).pipe(
      Layer.provideMerge(captureLogs(logged)),
    );
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const accounts = yield* githubAccounts;
          const connectionId = yield* aGithubConnection;
          const reader = yield* Effect.forkChild(accounts.readGithubAccount(connectionId));
          yield* Deferred.await(entered);
          // The interruption arrives through the dependency itself, as a
          // catchable cause. The reader's error handling must not treat it as
          // an unreadable connection.
          yield* Deferred.interrupt(hold);
          const exit = yield* Fiber.await(reader);
          return Exit.isFailure(exit);
        }),
        stack,
      ),
    );

    // The interruption came back out of the reader and was not logged. A
    // handler that treated it as an unreadable connection would have
    // returned no account and logged that.
    expect(result).toBe(true);
    expect(logged.filter((line) => line.includes("could not be read"))).toEqual([]);
  });

  it("rolls the claim back when interrupted inside the credential reader", async () => {
    const entered = Effect.runSync(Deferred.make<void>());
    const hold = Effect.runSync(Deferred.make<void>());
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sessionRepository;
          const sessions = yield* SessionService;
          const accounts = yield* githubAccounts;
          const instanceId = yield* insertInstance("an-adapter", {});
          const runnerId = mintId();
          const connectionId = yield* aGithubConnection;
          const sessionId = yield* insertQueuedSession(runnerId, {
            instanceId,
            spec: buildSpec(instanceId, "clever"),
            githubConnectionId: connectionId,
          });
          const claim = withTransaction(
            sql,
            sessions.claimStarts(runnerId, 1, {
              readGithubAccount: accounts.readGithubAccount,
              readSecrets: NO_SECRETS,
              localRunnerId: undefined,
            }),
          );
          const fiber = yield* Effect.forkChild(claim);
          yield* Deferred.await(entered);
          // Like a shutdown: the dispatch fiber, waiting inside the credential
          // reader's dependency, is interrupted without waiting for it to
          // finish.
          yield* Fiber.interrupt(fiber);
          return {
            after: yield* Effect.map(rows.one(sessionId), Option.getOrUndefined),
            hash: yield* readTokenHash(sessionId),
          };
        }),
        buildGatedCredentialStack(entered, hold),
      ),
    );

    // The claim rolled back with the interruption: the row is still queued,
    // and no token hash was stored. Whatever the reader's error handling does
    // with an interruption, the transaction never commits an interrupted
    // claim.
    expect(result.after?.status).toBe("queued");
    expect(result.hash).toBeNull();
  });
});

describe("the frame builders on SessionService", () => {
  it("stopping returns exactly the sessionStop frame", async () => {
    const sessionId = mintId();
    const frame = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return sessions.stopping(sessionId);
      }),
    );
    expect(frame).toStrictEqual({ _tag: "sessionStop", sessionId });
  });

  it("inputFrame returns exactly the sessionInput frame for the stored row", async () => {
    const row: StoredInput = {
      id: mintId(),
      sessionId: mintId(),
      source: "user",
      actor: "user:0199e0e7-0000-7000-8000-000000000000",
      text: "pick the failing test",
      attachments: [],
      status: "queued",
      delivery: null,
      createdAt: at,
      deliveredAt: null,
      sentAt: null,
      reason: null,
      stepIteration: null,
    };
    const modelSelection: ModelSelection = { model: "fast", options: { verbose: true } };
    const frame = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return sessions.inputFrame(
          { id: row.sessionId, runId: null, stepId: null, modelSelection },
          row,
        );
      }),
    );

    expect(frame).toStrictEqual({
      _tag: "sessionInput",
      requestId: row.id,
      sessionId: row.sessionId,
      input: { text: row.text, modelSelection: modelSelection },
    });
  });

  it("inputFrame puts the step key on the prompt of an agent step", async () => {
    const row: StoredInput = {
      id: mintId(),
      sessionId: mintId(),
      source: "user",
      actor: "run:0199e0e7-0000-7000-8000-000000000001",
      text: "implement the change",
      attachments: [],
      status: "queued",
      delivery: null,
      createdAt: at,
      deliveredAt: null,
      sentAt: null,
      reason: null,
      stepIteration: 2,
    };
    const runId = mintId();
    const modelSelection: ModelSelection = { model: "fast", options: {} };
    const frame = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return sessions.inputFrame(
          { id: row.sessionId, runId, stepId: "implement", modelSelection },
          row,
        );
      }),
    );

    expect(frame.input).toStrictEqual({
      text: row.text,
      modelSelection,
      step: { runId, stepId: "implement", iteration: 2 },
    });
  });

  it("inputFrame fails with a defect on a step prompt whose session no step started", async () => {
    const row: StoredInput = {
      id: mintId(),
      sessionId: mintId(),
      source: "user",
      actor: "run:0199e0e7-0000-7000-8000-000000000001",
      text: "implement the change",
      attachments: [],
      status: "queued",
      delivery: null,
      createdAt: at,
      deliveredAt: null,
      sentAt: null,
      reason: null,
      stepIteration: 2,
    };
    const modelSelection: ModelSelection = { model: "fast", options: {} };

    // Sending the prompt without its step key would run a turn whose result
    // no runner reports, so the run would wait for it for ever.
    await expect(
      run(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          return sessions.inputFrame(
            { id: row.sessionId, runId: null, stepId: null, modelSelection },
            row,
          );
        }),
      ),
    ).rejects.toThrow("holds the prompt of an agent step, but no step started it");
  });

  it("interrupting returns exactly the sessionInterrupt frame", async () => {
    const sessionId = mintId();
    const frame = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return sessions.interrupting(sessionId, undefined);
      }),
    );
    expect(frame).toStrictEqual({ _tag: "sessionInterrupt", sessionId });
  });

  it("respondingToApprovalRequest returns exactly the sessionRespondToApprovalRequest frame with the three fields", async () => {
    const sessionId = mintId();
    const requestId = mintId();
    const frame = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return sessions.respondingToApprovalRequest(sessionId, requestId, "allow_always");
      }),
    );
    expect(frame).toStrictEqual({
      _tag: "sessionRespondToApprovalRequest",
      sessionId,
      requestId,
      decision: "allow_always",
    });
  });

  it("respondingToQuestion returns exactly the sessionRespondToQuestion frame with the three fields", async () => {
    const sessionId = mintId();
    const requestId = mintId();
    const frame = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return sessions.respondingToQuestion(sessionId, requestId, { Storage: "SQLite" });
      }),
    );
    expect(frame).toStrictEqual({
      _tag: "sessionRespondToQuestion",
      sessionId,
      requestId,
      answers: { Storage: "SQLite" },
    });
  });
});

const HOUR_MS = 3_600_000;

/**
 * Inserts a session started on this runner with a new token, last heard from
 * `heardAgoMs` ago. Its absolute timeout is one hour (`buildSpec`). A session
 * past `starting` has had the input its start carried delivered, so no input
 * of it is on the wire.
 */
const insertRunningSession = (
  runnerId: string,
  status: "starting" | "idle" | "busy",
  heardAgoMs: number,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sessionRepository;
    const inputs = yield* inputRepository;
    const instanceId = yield* insertInstance("an-adapter", {});
    const sessionId = yield* insertQueuedSession(runnerId, {
      instanceId,
      spec: buildSpec(instanceId, "clever"),
      permissionProfileId: yield* aProfile,
    });
    const [claim] = yield* claimStarting(runnerId, 1, () => Effect.succeed(undefined));
    if (status !== "starting") {
      yield* rows.moved(sessionId, status, at);
      yield* inputs.markDelivered(claim!.input.id, claim!.input.sentAt, "opened", at);
    }
    const heardAt = new Date(Date.now() - heardAgoMs).toISOString();
    yield* sql`
      UPDATE sessions SET last_activity_at = ${heardAt} WHERE id = ${uuidFromString(sessionId)}
    `;
    return { sessionId, tokenHash: hashToken(claim!.frame.token) };
  });

/** Inserts a profile row, which a session's token resolves through. */
const aProfile = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const id = mintId();
  yield* sql`
    INSERT INTO permission_profiles (id, name, grants, shipped, created_at, updated_at)
    VALUES (${uuidFromString(id)}, ${`profile ${id}`}, '[]', 0, ${at}, ${at})
  `;
  return id;
});

/** Reads a session's current status. */
const readStatus = (sessionId: string) =>
  Effect.flatMap(sessionRepository, (rows) =>
    Effect.map(rows.one(sessionId), (row) => Option.getOrThrow(row).status),
  );

/** Calls `endOnLostRunners` the way the controller daemon does: inside the caller's transaction. */
const runEndOnLostRunners = (connected: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* SessionService;
    yield* withTransaction(sql, sessions.endOnLostRunners(connected));
  });

describe("SessionService.endOnLostRunners", () => {
  it("ends a session on a lost runner once it has not been heard from for its absolute timeout", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tokens = yield* SessionTokens;
        const inputs = yield* inputRepository;
        const runnerId = mintId();
        const busy = yield* insertRunningSession(runnerId, "busy", 2 * HOUR_MS);
        // Resolved while the session runs, so the resolver has it cached. The
        // sweep has to drop that cache too, not only change the row.
        const before = yield* tokens.resolve(busy.tokenHash);
        const waiting = yield* inputs.insert({
          sessionId: busy.sessionId,
          source: "user",
          actor: "user",
          text: "for later",
          at,
        });

        yield* runEndOnLostRunners([]);

        return {
          runnerId,
          sessionId: busy.sessionId,
          before,
          after: yield* tokens.resolve(busy.tokenHash),
          status: yield* readStatus(busy.sessionId),
          hash: yield* readTokenHash(busy.sessionId),
          input: Option.getOrThrow(yield* inputs.one(busy.sessionId, waiting.id)),
          audit: yield* readEventsOfKind("session.reconciled"),
        };
      }),
    );

    expect(Option.isSome(result.before)).toBe(true);
    expect(result.status).toBe("exited");
    expect(result.hash).toBeNull();
    expect(Option.isNone(result.after)).toBe(true);
    expect(result.input.status).toBe("cancelled");
    expect(result.input.reason).toMatch(/runner was not heard from/);
    expect(result.audit.map((row) => row.payload)).toEqual([
      { sessionId: result.sessionId, runnerId: result.runnerId, reason: "runner_lost" },
    ]);
  });

  it("ends a starting session and an idle one alike", async () => {
    // A controller restart leaves a session `starting` when the runner never
    // answered the start and never connects again.
    const result = await run(
      Effect.gen(function* () {
        const runnerId = mintId();
        const starting = yield* insertRunningSession(runnerId, "starting", 2 * HOUR_MS);
        const idle = yield* insertRunningSession(runnerId, "idle", 2 * HOUR_MS);
        yield* runEndOnLostRunners([]);
        return {
          starting: yield* readStatus(starting.sessionId),
          startingHash: yield* readTokenHash(starting.sessionId),
          idle: yield* readStatus(idle.sessionId),
          idleHash: yield* readTokenHash(idle.sessionId),
        };
      }),
    );

    expect(result).toEqual({
      starting: "exited",
      startingHash: null,
      idle: "exited",
      idleHash: null,
    });
  });

  it("leaves running a session within its timeout, and one on a connected runner", async () => {
    // Within the timeout, the session may still run on a runner that is only
    // unreachable. A connected runner reports its own exits.
    const result = await run(
      Effect.gen(function* () {
        const tokens = yield* SessionTokens;
        const recent = yield* insertRunningSession(mintId(), "busy", HOUR_MS / 2);
        const connectedRunner = mintId();
        const connected = yield* insertRunningSession(connectedRunner, "busy", 2 * HOUR_MS);
        yield* runEndOnLostRunners([connectedRunner]);
        return {
          recent: yield* readStatus(recent.sessionId),
          recentToken: Option.isSome(yield* tokens.resolve(recent.tokenHash)),
          connected: yield* readStatus(connected.sessionId),
          connectedToken: Option.isSome(yield* tokens.resolve(connected.tokenHash)),
        };
      }),
    );

    expect(result).toEqual({
      recent: "busy",
      recentToken: true,
      connected: "busy",
      connectedToken: true,
    });
  });

  it("uses the eight-hour default for a session whose stored spec has no timeouts", async () => {
    // A spec stored before the spec had timeouts.
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const withinDefault = yield* insertRunningSession(mintId(), "busy", 2 * HOUR_MS);
        const pastDefault = yield* insertRunningSession(mintId(), "busy", 9 * HOUR_MS);
        yield* sql`UPDATE sessions SET spec = json_remove(spec, '$.timeouts')`;
        yield* runEndOnLostRunners([]);
        return {
          withinDefault: yield* readStatus(withinDefault.sessionId),
          pastDefault: yield* readStatus(pastDefault.sessionId),
        };
      }),
    );

    expect(result).toEqual({ withinDefault: "busy", pastDefault: "exited" });
  });
});

/**
 * Inserts an idle session on a runner with one input already claimed, the way
 * a send claims it just before the frame goes out. Returns the claimed row.
 */
const insertIdleSessionWithSentInput = (runnerId: string) =>
  Effect.gen(function* () {
    const inputs = yield* inputRepository;
    const { sessionId } = yield* insertRunningSession(runnerId, "idle", 0);
    const input = yield* inputs.insert({
      sessionId,
      source: "user",
      actor: "user",
      text: "start a turn",
      at,
    });
    return Option.getOrThrow(yield* inputs.claim(input.id, at));
  });

/** Builds the runner's answer that the input `requestId` opened a turn. */
const openedAnswer = (requestId: string): SessionInputResult => ({
  _tag: "sessionInputResult",
  requestId,
  ok: true,
  delivery: "opened",
});

/**
 * The runner's answer that an input opened a turn reaches the controller
 * twice: the send waiting for it records it (`recordInputAnswer`), and the session's
 * ordered traffic applies it (`applyInputResult`). Either can run first.
 */
describe("an answer that an input opened a turn", () => {
  it("moves the session to busy as soon as the waiting send records it", async () => {
    // Otherwise the session reads idle with no input on the wire until
    // `applyInputResult` runs, and a delivery pass in between sends a second
    // input into the turn that just opened.
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const inputs = yield* inputRepository;
        const runnerId = mintId();
        const row = yield* insertIdleSessionWithSentInput(runnerId);

        yield* sessions.recordInputAnswer(
          row,
          { _tag: "sent", answer: Option.some(openedAnswer(row.id)) },
          runnerId,
        );

        return {
          status: yield* readStatus(row.sessionId),
          onTheWire: yield* inputs.holdsInputOnTheWire(row.sessionId),
        };
      }),
    );

    expect(result).toEqual({ status: "busy", onTheWire: false });
  });

  it("leaves the session idle when the waiting send records it after the turn already ended", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const rows = yield* sessionRepository;
        const inputs = yield* inputRepository;
        const runnerId = mintId();
        const row = yield* insertIdleSessionWithSentInput(runnerId);

        yield* sessions.applyInputResult(runnerId, {
          _tag: "sessionInputResult",
          requestId: row.id,
          ok: true,
          delivery: "opened",
        });
        const applied = {
          status: yield* readStatus(row.sessionId),
          input: Option.getOrThrow(yield* inputs.read(row.id)),
        };
        // The turn the input opened ends before the waiting send runs.
        yield* rows.moved(row.sessionId, "idle", at);
        yield* sessions.recordInputAnswer(
          row,
          { _tag: "sent", answer: Option.some(openedAnswer(row.id)) },
          runnerId,
        );

        return { applied, status: yield* readStatus(row.sessionId) };
      }),
    );

    expect(result.applied.status).toBe("busy");
    expect(result.applied.input).toMatchObject({ status: "delivered", delivery: "opened" });
    expect(result.status).toBe("idle");
  });
});

describe("an answer from a runner that does not hold the session", () => {
  it("records nothing, and logs that it was dropped", async () => {
    // Only the runner that holds a session can deliver its inputs. An answer
    // from any other runner must not mark the input delivered or open a turn.
    const logged: Array<string> = [];
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const inputs = yield* inputRepository;
          const row = yield* insertIdleSessionWithSentInput(mintId());

          yield* sessions.applyInputResult(mintId(), openedAnswer(row.id));

          return {
            sentAt: row.sentAt,
            status: yield* readStatus(row.sessionId),
            input: Option.getOrThrow(yield* inputs.read(row.id)),
          };
        }),
        layer.pipe(Layer.provideMerge(captureLogs(logged))),
      ),
    );

    expect(result.status).toBe("idle");
    expect(result.input).toMatchObject({ status: "queued", sentAt: result.sentAt });
    expect(logged.filter((line) => line.includes("does not hold"))).toHaveLength(1);
  });
});

/** Reads the status of every approval notification in the database. */
const readApprovalNotificationStatuses = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{ readonly status: string }>`SELECT status FROM notifications WHERE kind = 'core.approval'`,
);

describe("a report applied after its session ended", () => {
  it("stores no open request and raises no approval notification", async () => {
    // The report is folded outside any transaction. A retired runner ends the
    // session before the report's transaction opens.
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* SessionService;
        const rows = yield* sessionRepository;
        const runnerId = mintId();
        const { sessionId } = yield* insertRunningSession(runnerId, "busy", 0);
        const event = {
          _tag: "request.opened" as const,
          eventId: crypto.randomUUID(),
          sessionId,
          at,
          request: {
            requestId: "req-1",
            itemId: "i1",
            kind: "command_approval" as const,
            decisions: ["allow", "deny"] as const,
            detail: { command: "ls -la" },
          },
        };

        const folded = yield* sessions.foldReport(runnerId, 1, event);
        yield* withTransaction(sql, sessions.endOnRunner(runnerId));
        yield* withTransaction(sql, sessions.applyReport(runnerId, event, folded!));

        return {
          session: Option.getOrThrow(yield* rows.one(sessionId)),
          notifications: yield* readApprovalNotificationStatuses,
        };
      }),
    );

    expect(result.session.status).toBe("exited");
    expect(result.session.openRequests).toEqual([]);
    expect(result.notifications).toEqual([]);
  });
});
