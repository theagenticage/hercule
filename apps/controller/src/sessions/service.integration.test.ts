/**
 * Tests for the frames the sessions domain builds: the complete `sessionStart`
 * frames `claimStarts` returns, and the defect `inputFrame` fails with on a
 * step's prompt that has no step key. Also tests `endOnLostRunners`,
 * `setGeneratedTitleAndRole`, and the transcript search `queryPassages`.
 *
 * The tests check the frame's shape on the wire and where each field comes
 * from, not how the domain builds it:
 *
 * - the token, of which the row stores only a hash;
 * - the spec, decoded from the JSON the row stores.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Redacted } from "effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  HarnessNotInstalled,
  SessionSpec,
  SteerRefused,
  type AdapterError,
  type ModelSelection,
  type HarnessAccount,
  type HarnessEvent,
  type SessionInputResult,
  type SessionStart,
} from "@hercule/protocol";
import { createInvalidStateError, createNotFoundError, type Passage } from "@hercule/contract";
import { buildSessionStamp, CurrentActor, type Actor, type SessionActor } from "../actor";
import { buildHomePaths, HerculeHome } from "../config";
import { connectionRepository, ConnectionTypesLayer, GITHUB_CONNECTION_TYPE } from "../connections";
import { hashToken } from "../credentials";
import { IngestExecutorLayer, OpenSignalsLayer } from "../daemon/ingest";
import {
  AfterCommit,
  mintUuid,
  uuidFromString,
  uuidToString,
  withTransaction,
  type Change,
} from "../db";
import { ServingPromotionStateLayer } from "../promotion/testing";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { NotifierLayer } from "../notifications";
import { permissionRequestRepository, SessionTokens, SessionTokensLayer } from "../permissions";
import { PluginConfigsLayer, PluginHost, PluginHostLayer } from "../plugins";
import { buildHarnessDefinition, createPluginFixture } from "../plugins/testing";
import { masterKeyLayer } from "../secrets/masterKey";
import { Secrets, secretsLayer, type SecretOwner } from "../secrets/repository";
import { RunWorkspaceStepActivityLayer } from "../runs";
import { SettingsLayer } from "../settings";
import { subscriptionRepository } from "../subscriptions";
import { githubAccounts, WorkspaceService, WorkspaceServiceLayer } from "../workspaces";
import { inputRepository, type StoredInput } from "./inputs";
import { providerAccountRepository } from "../provider-accounts";
import { AccountUsage, AccountUsageLayer } from "../usage";
import { sessionRepository } from "./repository";
import { SessionEditObserver } from "./edit-observer";
import { SessionObserver } from "./observer";
import {
  SessionService,
  SessionServiceLayer,
  type PassageQueryInput,
  type StartRequest,
} from "./service";

/** Temporary Hercule Homes for the master key, deleted after each test. */
let homes: Array<string> = [];

/**
 * Builds a real plugin host with no plugins. It is needed because a session
 * record lists what its harness does not enforce, and that list is read from
 * the harness definitions the host holds.
 */
const buildHostLayer = (secrets: Layer.Layer<Secrets, unknown, SqlClient.SqlClient>) =>
  PluginHostLayer.pipe(
    Layer.provide([IngestExecutorLayer, OpenSignalsLayer]),
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

/** The session ids the edit observer was told about, in order. */
const observedEdits: Array<string> = [];

/** The reasons `SessionObserver.inputsDropped` was told about, in order. */
const droppedReasons: Array<string> = [];

/**
 * Ignores everything it is told: these tests do not look at what another
 * domain does with it. Only the edit observer notes which sessions it was
 * told edited files.
 */
const ignoreSessions = Layer.mergeAll(
  Layer.succeed(
    SessionObserver,
    SessionObserver.of({
      sessionReported: () => Effect.void,
      sessionExited: () => Effect.void,
      inputsDropped: ({ refusal }) => Effect.sync(() => void droppedReasons.push(refusal)),
    }),
  ),
  Layer.succeed(
    SessionEditObserver,
    SessionEditObserver.of({
      filesEdited: (sessionId) => Effect.sync(() => void observedEdits.push(sessionId)),
      becameUnfinishedAgain: () => Effect.void,
    }),
  ),
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
      AccountUsageLayer,
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

const buildSpec = (providerAccountId: string, model: string): SessionSpec => ({
  providerAccountId,
  workspaceId: null,
  modelSelection: { model, options: {} },
  accessMode: "approval-required",
  timeouts: { inactivityMs: 60_000, absoluteMs: 3_600_000 },
});

/** Inserts one queued session on a runner, the way `create` stores one. */
const insertQueuedSession = (
  runnerId: string,
  options: {
    readonly providerAccountId: string;
    /** The harness the session runs in. Without it, `an-adapter`. */
    readonly harnessId?: string;
    readonly spec: SessionSpec;
    /** Stores this string as the spec, as is, instead of encoding `spec`. */
    readonly storedSpec?: string;
    readonly checkoutBranch?: string;
    readonly githubConnectionId?: string;
    /** An existing profile row, for a test whose session token has to resolve. */
    readonly permissionProfileId?: string;
    /** The Agent the session runs as. Without it the session is a Thread. */
    readonly agentId?: string;
    /** The actor stamp of whoever created the session. Without it, the user. */
    readonly createdBy?: string;
    /**
     * Stores no input with the session, like a row queued before a start
     * carried its first input. `create` always stores the prompt.
     */
    readonly withoutInput?: boolean;
  },
): Effect.Effect<string, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* sessionRepository;
    const inputs = yield* inputRepository;
    const id = mintId();
    yield* withTransaction(
      sql,
      Effect.gen(function* () {
        yield* sessions.insert({
          id,
          title: "a session",
          role: undefined,
          permissionProfileId: options.permissionProfileId ?? mintId(),
          agentId: options.agentId,
          conversationId: undefined,
          step: undefined,
          providerAccountId: options.providerAccountId,
          harnessId: options.harnessId ?? HARNESS_ID,
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
          createdBy: options.createdBy ?? "user",
          at,
        });
        if (options.withoutInput !== true) {
          yield* inputs.insert({
            sessionId: id,
            source: "user",
            actor: "user",
            text: "begin",
            at,
          });
        }
      }),
    );
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
        AccountUsageLayer,
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
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* Secrets;
  const connections = yield* connectionRepository;
  return yield* withTransaction(
    sql,
    Effect.gen(function* () {
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
    }),
  );
});

/** The harness the sessions of these tests run in unless a test names another. */
const HARNESS_ID = "an-adapter";

/** The home, model argument and credential the start frame carries for an account. */
const buildHarnessAccountFor = (providerAccountId: string): HarnessAccount => ({
  providerAccountId,
  harnessHome: `providers/${providerAccountId}`,
  modelArgument: "{model}",
  credentialVariables: ["AN_API_KEY"],
  credential: { variable: "AN_API_KEY", value: "a-key" },
});

/** Prepares the account the way the controller daemon does, with no database read. */
const prepareAccount = (providerAccountId: string): Effect.Effect<HarnessAccount> =>
  Effect.succeed(buildHarnessAccountFor(providerAccountId));

/**
 * Calls `claimStarts` the way the controller daemon does: inside the caller's
 * transaction. The controller has no local runner, no connection has a GitHub
 * account, and every session gets `coordination` as its coordination
 * paragraph, or none when it is left out.
 */
const claimStarting = (
  runnerId: string,
  room: number,
  coordination?: string,
): Effect.Effect<ReadonlyArray<StartRequest>, SqlError, SessionService | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* SessionService;
    return yield* withTransaction(
      sql,
      sessions.claimStarts(runnerId, room, {
        readGithubAccount: () => Effect.succeed(undefined),
        readGitIdentity: () => Effect.succeed(undefined),
        requireAccountRunnable: () => Effect.void,
        prepareHarnessAccount: prepareAccount,
        buildCoordination: () => Effect.succeed(coordination),
        runner: { name: "a runner", negotiatedCapabilities: [] },
        localRunnerId: undefined,
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

/** Reads a session's current status. */
const readStatus = (sessionId: string) =>
  Effect.flatMap(sessionRepository, (rows) =>
    Effect.map(rows.one(sessionId), (row) => Option.getOrThrow(row).status),
  );

/** Returns the frames a claim returned, keyed by session id. */
const mapFramesBySession = (claimed: ReadonlyArray<StartRequest>): Map<string, SessionStart> =>
  new Map(claimed.map((claim) => [claim.sessionId, claim.frame] as const));

describe("SessionService.claimStarts", () => {
  it("returns one complete sessionStart frame per session it moved to starting", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rows = yield* sessionRepository;
        const providerAccountId = mintId();
        const runnerId = mintId();
        const specOnBranch = buildSpec(providerAccountId, "clever");
        const specPlain = buildSpec(providerAccountId, "fast");
        const onBranch = yield* insertQueuedSession(runnerId, {
          providerAccountId,
          spec: specOnBranch,
          checkoutBranch: "feature-x",
        });
        const plain = yield* insertQueuedSession(runnerId, { providerAccountId, spec: specPlain });
        const claimed = yield* claimStarting(runnerId, 2);
        const inputs = yield* inputRepository;
        return {
          claimed,
          providerAccountId,
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
    expect(branch.harnessId).toBe("an-adapter");
    expect(branch.harnessAccount).toEqual(buildHarnessAccountFor(result.providerAccountId));
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

  it("ends a queued session, with the reason, when its account cannot be prepared", async () => {
    // A refusal never passes by itself: retrying it on every pass would only
    // log it again and keep the account from being deleted.
    const refusals = [
      createInvalidStateError("the key could not be decrypted"),
      createNotFoundError("no such provider account"),
    ];
    for (const refusal of refusals) {
      const result = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const sessions = yield* SessionService;
          const runnerId = mintId();
          const refusedAccountId = mintId();
          const fineAccountId = mintId();
          const refused = yield* insertQueuedSession(runnerId, {
            providerAccountId: refusedAccountId,
            spec: buildSpec(refusedAccountId, "clever"),
          });
          // Claimed in the same pass: a refusal ends one session, not the batch.
          const fine = yield* insertQueuedSession(runnerId, {
            providerAccountId: fineAccountId,
            spec: buildSpec(fineAccountId, "clever"),
          });
          const claimed = yield* withTransaction(
            sql,
            sessions.claimStarts(runnerId, 2, {
              readGithubAccount: () => Effect.succeed(undefined),
              readGitIdentity: () => Effect.succeed(undefined),
              requireAccountRunnable: () => Effect.void,
              prepareHarnessAccount: (id) =>
                id === refusedAccountId ? Effect.fail(refusal) : prepareAccount(id),
              buildCoordination: () => Effect.succeed(undefined),
              runner: { name: "a runner", negotiatedCapabilities: [] },
              localRunnerId: undefined,
            }),
          );
          const again = yield* claimStarting(runnerId, 2);
          const exitRows = yield* sql<{ readonly event: string }>`
            SELECT event FROM session_stream WHERE session_id = ${uuidFromString(refused)}
          `;
          const inputRows = yield* sql<{ readonly status: string; readonly reason: string | null }>`
            SELECT status, reason FROM session_inputs WHERE session_id = ${uuidFromString(refused)}
          `;
          return {
            claimed: claimed.map((claim) => claim.sessionId),
            again,
            refused,
            fine,
            refusedStatus: yield* readStatus(refused),
            fineStatus: yield* readStatus(fine),
            exitRows,
            inputRows,
          };
        }),
      );

      expect(result.claimed).toEqual([result.fine]);
      expect(result.fineStatus).toBe("starting");
      expect(result.refusedStatus).toBe("exited");
      expect(result.again).toEqual([]);
      expect(JSON.stringify(result.exitRows)).toContain(refusal.error.message);
      expect(result.inputRows).toEqual([{ status: "cancelled", reason: refusal.error.message }]);
    }
  });

  it("ends a queued session, with the reason, when its account can no longer run on the runner", async () => {
    // Queued under the rule of that moment: a sign-in or a harness may have
    // gone before the runner has room. The check runs once per account and
    // harness, however many sessions are queued.
    const reason = "Anthropic · work is not signed in on that machine";
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* SessionService;
        const runnerId = mintId();
        const lostAccountId = mintId();
        const fineAccountId = mintId();
        const lost = yield* insertQueuedSession(runnerId, {
          providerAccountId: lostAccountId,
          spec: buildSpec(lostAccountId, "clever"),
        });
        const lostToo = yield* insertQueuedSession(runnerId, {
          providerAccountId: lostAccountId,
          spec: buildSpec(lostAccountId, "clever"),
        });
        const fine = yield* insertQueuedSession(runnerId, {
          providerAccountId: fineAccountId,
          spec: buildSpec(fineAccountId, "clever"),
        });
        const asked: Array<string> = [];
        const claimed = yield* withTransaction(
          sql,
          sessions.claimStarts(runnerId, 3, {
            readGithubAccount: () => Effect.succeed(undefined),
            readGitIdentity: () => Effect.succeed(undefined),
            requireAccountRunnable: (id) => {
              asked.push(id);
              return id === lostAccountId
                ? Effect.fail(createInvalidStateError(reason))
                : Effect.void;
            },
            prepareHarnessAccount: prepareAccount,
            buildCoordination: () => Effect.succeed(undefined),
            runner: { name: "a runner", negotiatedCapabilities: [] },
            localRunnerId: undefined,
          }),
        );
        const inputRows = yield* sql<{ readonly status: string; readonly reason: string | null }>`
          SELECT status, reason FROM session_inputs WHERE session_id = ${uuidFromString(lost)}
        `;
        return {
          claimed: claimed.map((claim) => claim.sessionId),
          asked,
          fine,
          lostStatus: yield* readStatus(lost),
          lostTooStatus: yield* readStatus(lostToo),
          inputRows,
        };
      }),
    );

    expect(result.claimed).toEqual([result.fine]);
    expect(result.lostStatus).toBe("exited");
    expect(result.lostTooStatus).toBe("exited");
    expect(result.asked).toHaveLength(2);
    expect(result.inputRows).toEqual([{ status: "cancelled", reason }]);
  });

  it("adds the coordination paragraph to the spec the frame carries", async () => {
    const coordination = "Other agent sessions may work on the same repositories as you.";
    const result = await run(
      Effect.gen(function* () {
        const providerAccountId = mintId();
        const runnerId = mintId();
        const spec = buildSpec(providerAccountId, "clever");
        yield* insertQueuedSession(runnerId, { providerAccountId, spec });
        return { spec, claimed: yield* claimStarting(runnerId, 1, coordination) };
      }),
    );

    expect(result.claimed[0]?.frame.spec).toStrictEqual({ ...result.spec, coordination });
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
          const providerAccountId = mintId();
          const runnerId = mintId();
          const legacy = yield* insertQueuedSession(runnerId, {
            providerAccountId,
            spec: buildSpec(providerAccountId, "clever"),
            withoutInput: true,
          });
          const current = yield* insertQueuedSession(runnerId, {
            providerAccountId,
            spec: buildSpec(providerAccountId, "clever"),
          });
          const claimed = yield* claimStarting(runnerId, 2);
          // Every later dispatch pass reads the row again.
          yield* claimStarting(runnerId, 2);
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
        const providerAccountId = mintId();
        // A runner that is not retired, a ready workspace on it and a known
        // transcript: everything the session needs to read as resumable.
        const arranged = yield* withTransaction(
          sql,
          Effect.gen(function* () {
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
            const spec = JSON.stringify(encodeSpec(buildSpec(providerAccountId, "clever")));
            const sessionId = yield* insertQueuedSession(runnerId, {
              providerAccountId,
              spec: buildSpec(providerAccountId, "clever"),
              withoutInput: true,
            });
            yield* sql`
          UPDATE sessions SET workspace_id = ${uuidFromString(workspaceId)}
          WHERE id = ${uuidFromString(sessionId)}
        `;
            yield* rows.bind(sessionId, runnerId, providerAccountId, "native-1");
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
            return { runnerId, sessionId, lastActiveBeforeExit };
          }),
        );
        const { runnerId, sessionId, lastActiveBeforeExit } = arranged;

        const claimed = yield* claimStarting(runnerId, 1);
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
        const providerAccountId = mintId();
        const runnerId = mintId();
        const first = yield* insertQueuedSession(runnerId, {
          providerAccountId,
          spec: buildSpec(providerAccountId, "clever"),
        });
        const second = yield* insertQueuedSession(runnerId, {
          providerAccountId,
          spec: buildSpec(providerAccountId, "clever"),
        });
        const claimed = yield* claimStarting(runnerId, 2);
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

  it("leaves any number of undecodable rows queued and starts the row behind them, even with room for one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const providerAccountId = mintId();
        const runnerId = mintId();
        // Valid JSON that the current `SessionSpec` schema fails to decode.
        // This is what a queued row looks like after the schema changed
        // under it.
        const poisoned: Array<string> = [];
        for (let i = 0; i < 6; i += 1) {
          poisoned.push(
            yield* insertQueuedSession(runnerId, {
              providerAccountId,
              spec: buildSpec(providerAccountId, "clever"),
              storedSpec: "{}",
            }),
          );
        }
        const good = yield* insertQueuedSession(runnerId, {
          providerAccountId,
          spec: buildSpec(providerAccountId, "clever"),
        });
        const claimed = yield* claimStarting(runnerId, 1);
        return {
          claimed,
          good,
          goodAfter: yield* readStatus(good),
          poisonedAfter: yield* Effect.forEach(poisoned, readStatus),
        };
      }),
    );

    // Six undecodable rows first and room for one: the loop reaches the valid
    // row behind them and gives it the one place.
    expect(result.claimed.map((claim) => claim.sessionId)).toEqual([result.good]);
    expect(result.goodAfter).toBe("starting");
    // The bad rows are not claimed: they stay queued, where a user can see
    // and stop them.
    expect(result.poisonedAfter).toEqual(Array(6).fill("queued"));
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
          const providerAccountId = mintId();
          const runnerId = mintId();
          const connectionId = yield* aGithubConnection;
          const sessionId = yield* insertQueuedSession(runnerId, {
            providerAccountId,
            spec: buildSpec(providerAccountId, "clever"),
            githubConnectionId: connectionId,
          });
          const claim = withTransaction(
            sql,
            sessions.claimStarts(runnerId, 1, {
              readGithubAccount: accounts.readGithubAccount,
              readGitIdentity: accounts.readGitIdentity,
              requireAccountRunnable: () => Effect.void,
              prepareHarnessAccount: prepareAccount,
              buildCoordination: () => Effect.succeed(undefined),
              runner: { name: "a runner", negotiatedCapabilities: [] },
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

describe("SessionService.inputFrame", () => {
  it("fails with a defect on a step prompt whose session no step started", async () => {
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
    return yield* withTransaction(
      sql,
      Effect.gen(function* () {
        const providerAccountId = mintId();
        const sessionId = yield* insertQueuedSession(runnerId, {
          providerAccountId,
          spec: buildSpec(providerAccountId, "clever"),
          permissionProfileId: yield* aProfile,
        });
        const [claim] = yield* claimStarting(runnerId, 1);
        if (status !== "starting") {
          yield* rows.moved(sessionId, status, at);
          yield* inputs.markDelivered(claim!.input.id, claim!.input.sentAt, "opened", at);
        }
        const heardAt = new Date(Date.now() - heardAgoMs).toISOString();
        yield* sql`
      UPDATE sessions SET last_activity_at = ${heardAt} WHERE id = ${uuidFromString(sessionId)}
    `;
        return { sessionId, tokenHash: hashToken(claim!.frame.token) };
      }),
    );
  });

/** Inserts a profile row, which a session's token resolves through. */
const aProfile = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const id = mintId();
  yield* withTransaction(
    sql,
    sql`
      INSERT INTO permission_profiles (id, name, grants, shipped, created_at, updated_at)
      VALUES (${uuidFromString(id)}, ${`profile ${id}`}, '[]', 0, ${at}, ${at})
    `,
  );
  return id;
});

/** Calls `endOnLostRunners` the way the controller daemon does: inside the caller's transaction. */
const runEndOnLostRunners = (connected: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* SessionService;
    yield* withTransaction(sql, sessions.endOnLostRunners(connected));
  });

describe("SessionService.endOnLostRunners", () => {
  it("ends every session on a lost runner once it has not been heard from for its absolute timeout", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tokens = yield* SessionTokens;
        const inputs = yield* inputRepository;
        const runnerId = mintId();
        const busy = yield* insertRunningSession(runnerId, "busy", 2 * HOUR_MS);
        // A controller restart leaves a session `starting` when the runner
        // never answered the start and never connects again.
        const starting = yield* insertRunningSession(runnerId, "starting", 2 * HOUR_MS);
        const idle = yield* insertRunningSession(runnerId, "idle", 2 * HOUR_MS);
        // Resolved while the session runs, so the resolver has it cached. The
        // sweep has to drop that cache too, not only change the row.
        const before = yield* tokens.resolve(busy.tokenHash);
        const waiting = yield* withTransaction(
          yield* SqlClient.SqlClient,
          inputs.insert({
            sessionId: busy.sessionId,
            source: "user",
            actor: "user",
            text: "for later",
            at,
          }),
        );

        yield* runEndOnLostRunners([]);

        const ended = [busy.sessionId, starting.sessionId, idle.sessionId];
        return {
          runnerId,
          ended,
          before,
          after: yield* tokens.resolve(busy.tokenHash),
          statuses: yield* Effect.forEach(ended, readStatus),
          hashes: yield* Effect.forEach(ended, readTokenHash),
          input: Option.getOrThrow(yield* inputs.one(busy.sessionId, waiting.id)),
          audit: yield* readEventsOfKind("session.reconciled"),
        };
      }),
    );

    expect(Option.isSome(result.before)).toBe(true);
    // A busy, a starting and an idle session all end alike.
    expect(result.statuses).toEqual(["exited", "exited", "exited"]);
    expect(result.hashes).toEqual([null, null, null]);
    expect(Option.isNone(result.after)).toBe(true);
    expect(result.input.status).toBe("cancelled");
    expect(result.input.reason).toMatch(/runner was not heard from/);
    expect(result.audit.map((row) => row.payload)).toEqual(
      expect.arrayContaining(
        result.ended.map((sessionId) => ({
          sessionId,
          runnerId: result.runnerId,
          reason: "runner_lost",
        })),
      ),
    );
    expect(result.audit).toHaveLength(3);
  });

  it("withdraws the open Permission Requests of every session it ends, and ends their subscriptions", async () => {
    const result = await run(
      Effect.gen(function* () {
        const requests = yield* permissionRequestRepository;
        const subscriptions = yield* subscriptionRepository;
        const runnerId = mintId();
        // Opens a request for the session and the subscription that waits on its decision.
        const ask = (sessionId: string) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* withTransaction(
              sql,
              Effect.gen(function* () {
                const requestId = yield* requests.insert({
                  sessionId,
                  profileId: mintId(),
                  grant: "task.delete",
                  reason: "a reason",
                  operation: undefined,
                  at,
                });
                const target = { kind: "request", requestId } as const;
                const subscriptionId = yield* subscriptions.insert({
                  holder: { kind: "session", id: sessionId },
                  target,
                  condition: "true",
                  at,
                  actor: `session:${sessionId}`,
                });
                return { requestId, subscriptionId };
              }),
            );
          });
        const first = yield* ask(
          (yield* insertRunningSession(runnerId, "busy", 2 * HOUR_MS)).sessionId,
        );
        const second = yield* ask(
          (yield* insertRunningSession(runnerId, "idle", 2 * HOUR_MS)).sessionId,
        );
        yield* runEndOnLostRunners([]);
        const readRequestStatus = (id: string) =>
          Effect.map(requests.read(id), (found) => Option.getOrThrow(found).status);
        return {
          requests: [
            yield* readRequestStatus(first.requestId),
            yield* readRequestStatus(second.requestId),
          ],
          liveSubscriptions: [
            Option.isSome(yield* subscriptions.readLive(first.subscriptionId)),
            Option.isSome(yield* subscriptions.readLive(second.subscriptionId)),
          ],
        };
      }),
    );

    expect(result).toEqual({
      requests: ["withdrawn", "withdrawn"],
      liveSubscriptions: [false, false],
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
        yield* withTransaction(
          sql,
          sql`UPDATE sessions SET spec = json_remove(spec, '$.timeouts')`,
        );
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
    const sql = yield* SqlClient.SqlClient;
    const inputs = yield* inputRepository;
    const { sessionId } = yield* insertRunningSession(runnerId, "idle", 0);
    return yield* withTransaction(
      sql,
      Effect.gen(function* () {
        const input = yield* inputs.insert({
          sessionId,
          source: "user",
          actor: "user",
          text: "start a turn",
          at,
        });
        return Option.getOrThrow(yield* inputs.claim(input.id, at));
      }),
    );
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
describe("SessionService.resume", () => {
  /**
   * Exits a session that has a waiting input on a runner that is not retired,
   * and returns its ids. Whether its account exists is up to the caller.
   */
  const arrangeExitedSession = (providerAccountId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sessionRepository;
      return yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const runnerId = mintId();
          yield* sql`
            INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                                 credential_hash, created_at, updated_at)
            VALUES (${uuidFromString(runnerId)}, ${runnerId}, 'online', 'active', 0, '[]',
                    'a hash', ${at}, ${at})
          `;
          const sessionId = yield* insertQueuedSession(runnerId, {
            providerAccountId,
            spec: buildSpec(providerAccountId, "clever"),
          });
          yield* rows.bind(sessionId, runnerId, providerAccountId, "native-1");
          yield* rows.moved(sessionId, "exited", at);
          return sessionId;
        }),
      );
    });

  const resumeNow = (sessionId: string, providerAccountId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sessions = yield* SessionService;
      return yield* withTransaction(
        sql,
        sessions.resume(
          sessionId,
          () => Effect.succeed(JSON.stringify(encodeSpec(buildSpec(providerAccountId, "clever")))),
          at,
          false,
        ),
      ).pipe(Effect.exit);
    });

  it("refuses to queue a session whose account was deleted, and leaves it exited", async () => {
    // The caller checked the account before the transaction. An account
    // deleted since then must not leave a queued session that dispatch can
    // never prepare.
    const result = await run(
      Effect.gen(function* () {
        const providerAccountId = mintId();
        const sessionId = yield* arrangeExitedSession(providerAccountId);
        const exit = yield* resumeNow(sessionId, providerAccountId);
        return { exit, status: yield* readStatus(sessionId) };
      }),
    );

    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(JSON.stringify(result.exit)).toContain("The account this thread ran on was deleted.");
    expect(result.status).toBe("exited");
  });

  it("queues a session whose account exists", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const accounts = yield* providerAccountRepository;
        const account = yield* withTransaction(
          sql,
          accounts.insert({
            providerId: "a-provider",
            kind: "a-kind",
            label: null,
            defaultHarnessId: HARNESS_ID,
            at,
          }),
        );
        const sessionId = yield* arrangeExitedSession(account.id);
        const exit = yield* resumeNow(sessionId, account.id);
        return { exit, status: yield* readStatus(sessionId) };
      }),
    );

    expect(Exit.isSuccess(result.exit) && result.exit.value).toBe(true);
    expect(result.status).toBe("queued");
  });
});

describe("SessionService.claimInput", () => {
  it("claims a waiting input in a transaction of its own, and refuses a second claim", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* SessionService;
        const inputs = yield* inputRepository;
        const input = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const { sessionId } = yield* insertRunningSession(mintId(), "idle", 0);
            return yield* inputs.insert({
              sessionId,
              source: "user",
              actor: "user",
              text: "go",
              at,
            });
          }),
        );

        // Called outside any transaction, like the steer path of live delivery.
        const first = yield* sessions.claimInput(input.id);
        const second = yield* sessions.claimInput(input.id);
        return { first: Option.map(first, (claimed) => claimed.id), second };
      }),
    );

    expect(Option.isSome(result.first)).toBe(true);
    expect(Option.isNone(result.second)).toBe(true);
  });
});

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
        yield* withTransaction(yield* SqlClient.SqlClient, rows.moved(row.sessionId, "idle", at));
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

describe("a refusal for an input that a concurrent path already settled", () => {
  /** Builds the runner's refusal of the input `requestId` with `error`. */
  const refusalOf = (requestId: string, error: AdapterError): SessionInputResult => ({
    _tag: "sessionInputResult",
    requestId,
    ok: false,
    error,
  });

  it("tells the observer the input was dropped when the failure cancels the claimed input", async () => {
    droppedReasons.length = 0;
    const input = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const inputs = yield* inputRepository;
        const runnerId = mintId();
        const row = yield* insertIdleSessionWithSentInput(runnerId);
        const answer = refusalOf(row.id, new HarnessNotInstalled({ message: "no harness" }));
        yield* sessions.recordInputAnswer(
          row,
          { _tag: "sent", answer: Option.some(answer) },
          runnerId,
        );
        return Option.getOrThrow(yield* inputs.read(row.id));
      }),
    );

    expect(input).toMatchObject({ status: "cancelled", reason: "no harness" });
    expect(droppedReasons).toEqual(["no harness"]);
  });

  it("tells the observer nothing when ordered ingestion already marked the input delivered", async () => {
    droppedReasons.length = 0;
    const { recorded, input } = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const inputs = yield* inputRepository;
        const runnerId = mintId();
        const row = yield* insertIdleSessionWithSentInput(runnerId);
        yield* sessions.applyInputResult(runnerId, openedAnswer(row.id));
        const answer = refusalOf(row.id, new HarnessNotInstalled({ message: "no harness" }));
        const recorded = yield* sessions.recordInputAnswer(
          row,
          { _tag: "sent", answer: Option.some(answer) },
          runnerId,
        );
        return { recorded, input: Option.getOrThrow(yield* inputs.read(row.id)) };
      }),
    );

    expect(input).toMatchObject({ status: "delivered", delivery: "opened" });
    expect(recorded._tag).toBe("notDelivered");
    expect(droppedReasons).toEqual([]);
  });

  it("does not report a refused steer as queued when the input was already delivered", async () => {
    const { recorded, input } = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const inputs = yield* inputRepository;
        const runnerId = mintId();
        const row = yield* insertIdleSessionWithSentInput(runnerId);
        yield* sessions.applyInputResult(runnerId, openedAnswer(row.id));
        const answer = refusalOf(row.id, new SteerRefused({ message: "no steering now" }));
        const recorded = yield* sessions.recordInputAnswer(
          row,
          { _tag: "sent", answer: Option.some(answer) },
          runnerId,
        );
        return { recorded, input: Option.getOrThrow(yield* inputs.read(row.id)) };
      }),
    );

    expect(input.status).toBe("delivered");
    expect(recorded._tag).toBe("notDelivered");
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

describe("files a runner reports as edited by commands", () => {
  const files = [{ resourceId: mintId(), path: "src/router.ts" }];

  beforeEach(() => {
    observedEdits.length = 0;
  });

  it("reach the edit observer when the runner holds the session", async () => {
    const runnerId = mintId();
    const sessionId = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const row = yield* insertRunningSession(runnerId, "busy", 0);
        yield* sessions.applyFilesEdited(runnerId, {
          _tag: "filesEdited",
          sessionId: row.sessionId,
          editedFiles: files,
        });
        return row.sessionId;
      }),
    );

    expect(observedEdits).toEqual([sessionId]);
  });

  it("are ignored when another runner holds the session", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const row = yield* insertRunningSession(mintId(), "busy", 0);
        yield* sessions.applyFilesEdited(mintId(), {
          _tag: "filesEdited",
          sessionId: row.sessionId,
          editedFiles: files,
        });
      }),
    );

    expect(observedEdits).toEqual([]);
  });

  it("are ignored for a session the controller does not know", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.applyFilesEdited(mintId(), {
          _tag: "filesEdited",
          sessionId: mintId(),
          editedFiles: files,
        });
      }),
    );

    expect(observedEdits).toEqual([]);
  });
});

/** Builds a plugin with a provider whose one account kind reports its usage through sessions. */
const buildMeteredPlugin = () =>
  createPluginFixture({
    id: "metered",
    capabilities: ["harnesses", "providers"],
    definitions: [
      buildHarnessDefinition("metered", [
        {
          providerId: "metered/metered",
          kinds: [{ kind: "subscription" }],
          modelArgument: "{model}",
          models: "all",
        },
      ]),
    ],
    providers: [
      {
        id: "metered",
        displayName: "Metered",
        kinds: [
          {
            id: "subscription",
            title: "Subscription",
            description: "A plan signed in on each machine.",
            setup: [{ kind: "harness-login", method: "sign-in" }],
            usage: { readBy: "sessions" },
            harnesses: ["metered/metered"],
          },
        ],
        defaultHarnessId: "metered/metered",
      },
    ],
  }).plugin;

describe("the start of a session's process", () => {
  it("is stored when dispatch claims the session", async () => {
    const stored = await run(
      Effect.gen(function* () {
        const rows = yield* sessionRepository;
        const { sessionId } = yield* insertRunningSession(mintId(), "starting", 0);
        return yield* rows.one(sessionId);
      }),
    );

    expect(Option.getOrThrow(stored).processStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("usage a runner reports for a session", () => {
  const readings = [
    {
      kind: "window" as const,
      window: "five-hour" as const,
      usedPercent: 42,
      resetsAt: null,
      hit: false,
      takenAt: at,
    },
  ];

  /**
   * Boots a provider whose one kind reports usage through sessions, inserts a
   * running session on an account of it, held by `runnerId`, and returns the
   * ids of the session and the account.
   */
  const arrangeMeteredSession = (runnerId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const host = yield* PluginHost;
      const accounts = yield* providerAccountRepository;
      yield* host.boot([buildMeteredPlugin()]);
      const account = yield* withTransaction(
        sql,
        accounts.insert({
          providerId: "metered/metered",
          kind: "subscription",
          label: null,
          defaultHarnessId: "metered/metered",
          at,
        }),
      );
      const { sessionId } = yield* insertRunningSession(runnerId, "busy", 0);
      yield* withTransaction(
        sql,
        sql`
          UPDATE sessions SET provider_account_id = ${uuidFromString(account.id)}
          WHERE id = ${uuidFromString(sessionId)}
        `,
      );
      return { sessionId, accountId: account.id };
    });

  const report = (sessionId: string) => ({
    _tag: "accountUsageReported" as const,
    sessionId,
    readings,
  });

  it("is stored for the session's account when the runner holds the session", async () => {
    const runnerId = mintId();
    const stored = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const usage = yield* AccountUsage;
        const { sessionId, accountId } = yield* arrangeMeteredSession(runnerId);
        yield* sessions.applyAccountUsageReported(runnerId, report(sessionId));
        return yield* usage.read(accountId);
      }),
    );

    expect(stored).toMatchObject([{ window: "five-hour", usedPercent: 42, source: "session" }]);
  });

  it("is dropped when the session's process started before the account's credential was replaced", async () => {
    const runnerId = mintId();
    const stored = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const usage = yield* AccountUsage;
        const { sessionId, accountId } = yield* arrangeMeteredSession(runnerId);
        yield* usage.clear(accountId);
        yield* sessions.applyAccountUsageReported(runnerId, report(sessionId));
        return yield* usage.read(accountId);
      }),
    );

    expect(stored).toEqual([]);
  });

  it("is stored when the session's process started after the account's credential was replaced", async () => {
    const runnerId = mintId();
    const stored = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* SessionService;
        const usage = yield* AccountUsage;
        const { sessionId, accountId } = yield* arrangeMeteredSession(runnerId);
        yield* usage.clear(accountId);
        // The session was resumed after the replacement: dispatch stamped a later process start.
        const resumedAt = new Date(Date.now() + 60_000).toISOString();
        yield* withTransaction(
          sql,
          sql`
            UPDATE sessions SET process_started_at = ${resumedAt}
            WHERE id = ${uuidFromString(sessionId)}
          `,
        );
        yield* sessions.applyAccountUsageReported(runnerId, report(sessionId));
        return yield* usage.read(accountId);
      }),
    );

    expect(stored).toMatchObject([{ window: "five-hour", usedPercent: 42, source: "session" }]);
  });

  it("is dropped when the session has exited", async () => {
    const runnerId = mintId();
    const stored = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* SessionService;
        const rows = yield* sessionRepository;
        const usage = yield* AccountUsage;
        const { sessionId, accountId } = yield* arrangeMeteredSession(runnerId);
        yield* withTransaction(sql, rows.moved(sessionId, "exited", at));
        yield* sessions.applyAccountUsageReported(runnerId, report(sessionId));
        return yield* usage.read(accountId);
      }),
    );

    expect(stored).toEqual([]);
  });

  it("is dropped, and logged, when another runner holds the session", async () => {
    const logged: Array<string> = [];
    const stored = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const usage = yield* AccountUsage;
          const { sessionId, accountId } = yield* arrangeMeteredSession(mintId());
          yield* sessions.applyAccountUsageReported(mintId(), report(sessionId));
          return yield* usage.read(accountId);
        }),
        layer.pipe(Layer.provideMerge(captureLogs(logged))),
      ),
    );

    expect(stored).toEqual([]);
    expect(logged.filter((line) => line.includes("Dropped a runner's usage report"))).toHaveLength(
      1,
    );
  });

  it("is dropped for a session the controller does not know", async () => {
    const logged: Array<string> = [];
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          yield* sessions.applyAccountUsageReported(mintId(), report(mintId()));
        }),
        layer.pipe(Layer.provideMerge(captureLogs(logged))),
      ),
    );

    expect(logged.filter((line) => line.includes("Dropped a runner's usage report"))).toHaveLength(
      1,
    );
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

describe("a report that starts a tool call", () => {
  it("counts the call and announces the session at the slow pace", async () => {
    const published: Array<Change> = [];
    const listener = Layer.succeed(AfterCommit, {
      publish: (changes: ReadonlyArray<Change>) =>
        Effect.sync(() => {
          published.push(...changes);
        }),
    });
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* SessionService;
        const rows = yield* sessionRepository;
        const runnerId = mintId();
        const { sessionId } = yield* insertRunningSession(runnerId, "busy", 0);
        const event = {
          _tag: "item.started" as const,
          eventId: crypto.randomUUID(),
          sessionId,
          at,
          turnId: "t1",
          itemId: "i1",
          kind: "command_execution" as const,
          detail: {},
        };

        const folded = yield* sessions.foldReport(runnerId, 1, event);
        yield* withTransaction(sql, sessions.applyReport(runnerId, event, folded!)).pipe(
          Effect.provide(listener),
        );

        return { sessionId, session: Option.getOrThrow(yield* rows.one(sessionId)) };
      }),
    );

    expect(result.session.toolCalls).toBe(1);
    expect(published).toContainEqual(
      expect.objectContaining({
        _tag: "record",
        topic: "session",
        id: result.sessionId,
        countsOnly: true,
      }),
    );
  });
});

describe("SessionService.setGeneratedTitleAndRole", () => {
  /**
   * Inserts a session titled `title`, with `existingRole` as the role spawn
   * gave it (none by default), and applies `generated` as the generated answer.
   */
  const generate = (
    title: string,
    generated: {
      readonly title: string;
      readonly needsRefinement?: boolean;
      readonly role?: string;
    },
    existingRole: string | null = null,
  ) => {
    const published: Array<Change> = [];
    const listener = Layer.succeed(AfterCommit, {
      publish: (changes: ReadonlyArray<Change>) =>
        Effect.sync(() => {
          published.push(...changes);
        }),
    });
    return run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* SessionService;
        const rows = yield* sessionRepository;
        const { sessionId } = yield* insertRunningSession(mintId(), "busy", 0);
        yield* withTransaction(
          sql,
          sql`UPDATE sessions SET title = ${title}, role = ${existingRole}
              WHERE id = ${uuidFromString(sessionId)}`,
        );

        yield* sessions
          .setGeneratedTitleAndRole(sessionId, {
            title: generated.title,
            needsRefinement: generated.needsRefinement ?? false,
            role: generated.role ?? "",
          })
          .pipe(Effect.provide(listener));

        const [stored] = yield* sql<{ readonly needs_refinement: number | null }>`
          SELECT needs_refinement FROM sessions WHERE id = ${uuidFromString(sessionId)}`;
        const session = Option.getOrThrow(yield* rows.one(sessionId));
        return {
          sessionId,
          title: session.title,
          role: session.role,
          needsRefinement: stored!.needs_refinement,
          published,
        };
      }),
    );
  };

  it.each([
    [true, 1],
    [false, 0],
  ])(
    "replaces the title, stores the refinement flag %s as %s and announces the session",
    async (needsRefinement, stored) => {
      const result = await generate("fix the thing pls", {
        title: "Fix the login redirect",
        needsRefinement,
      });

      expect(result.title).toBe("Fix the login redirect");
      expect(result.needsRefinement).toBe(stored);
      expect(result.published).toContainEqual(
        expect.objectContaining({ _tag: "record", topic: "session", id: result.sessionId }),
      );
    },
  );

  it("cleans the generated title like any other title", async () => {
    const result = await generate("a", { title: `  Fix\nthe   build ${"x".repeat(200)}` });

    expect(result.title).toHaveLength(80);
    expect(result.title.startsWith("Fix the build xxx")).toBe(true);
  });

  it("cuts the title by characters, so an emoji at the cut stays whole", async () => {
    const result = await generate("a", { title: `${"x".repeat(79)}\u{1F680}\u{1F680} tail` });

    expect(result.title).toBe(`${"x".repeat(79)}\u{1F680}`);
  });

  it("removes control and format characters", async () => {
    const result = await generate("a", {
      title: "Fix\u0000 the\u200B login \u202Ebug\u0007 \uFEFF now",
    });

    expect(result.title).toBe("Fix the login bug now");
  });

  it("keeps the zero-width joiner and non-joiner, which scripts and emoji sequences need", async () => {
    // Persian "mi-khahad" is spelled with a zero-width non-joiner, and the
    // family emoji is three people joined by zero-width joiners.
    const persian = "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u062F";
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";

    // A zero-width space between the two parts must still be stripped.
    const result = await generate("a", { title: `${persian} \u200B${family}` });

    expect(result.title).toBe(`${persian} ${family}`);
  });

  it("keeps the title it has when the generated title and role are both empty", async () => {
    const result = await generate("the first line", { title: " \n ", needsRefinement: true });

    expect(result.title).toBe("the first line");
    expect(result.role).toBeNull();
    expect(result.needsRefinement).toBeNull();
    expect(result.published).toEqual([]);
  });

  it("stores a generated role, cleaned, on a session that has none", async () => {
    const result = await generate("a", { title: "Fix it", role: "  API\n docs \u200B" });

    expect(result.role).toBe("API docs");
    expect(result.published).toContainEqual(
      expect.objectContaining({ _tag: "record", topic: "session", id: result.sessionId }),
    );
  });

  it("keeps the role the session already has", async () => {
    const result = await generate("a", { title: "Fix it", role: "migration" }, "review");

    expect(result.role).toBe("review");
    expect(result.title).toBe("Fix it");
  });

  it.each([
    ["is empty after cleaning", " \n\u200B "],
    ["is over 24 characters", "x".repeat(25)],
  ])(
    "drops a generated role that %s, and never cuts it, but keeps the title and flag",
    async (_why, role) => {
      const result = await generate("a", { title: "Fix it", needsRefinement: true, role });

      expect(result.role).toBeNull();
      expect(result.title).toBe("Fix it");
      expect(result.needsRefinement).toBe(1);
    },
  );

  it("stores a valid role when the title is empty after cleaning, leaving the title and flag alone", async () => {
    const result = await generate("the first line", {
      title: " \n ",
      needsRefinement: true,
      role: "review",
    });

    expect(result.role).toBe("review");
    expect(result.title).toBe("the first line");
    expect(result.needsRefinement).toBeNull();
    expect(result.published).toContainEqual(
      expect.objectContaining({ _tag: "record", topic: "session", id: result.sessionId }),
    );
  });
});

describe("SessionService.queryPassages", () => {
  const agentA = "0190b000-0000-7000-8000-00000000000a";
  const agentB = "0190b000-0000-7000-8000-00000000000b";
  /** When each message was written, oldest first. */
  const t = [1, 2, 3, 4, 5, 6].map((minute) => `2026-10-11T10:0${minute}:00.000Z`);

  const USER: Actor = {
    _tag: "user",
    userId: "user",
    credential: { kind: "login", id: "credential", tokenHash: "hash" },
  };

  /** Returns a session actor that holds `session.read`, for the session given. */
  const buildSessionActor = (sessionId: string, agentId: string | null): SessionActor => ({
    _tag: "session",
    sessionId,
    profileId: "profile",
    grants: ["session.read"],
    profileGrants: ["session.read"],
    assistantId: null,
    agentId,
  });

  /**
   * Writes four sessions and their stream:
   *
   * - `agentRun`, of Agent A, created by the user: a user message, the same
   *   message completed, an assistant reply and some reasoning;
   * - `child`, of Agent A, created by `thread`: a reply from its subagent;
   * - `thread`, a Thread created by the user: a user message;
   * - `other`, of Agent B: an assistant reply.
   *
   * Every message mentions the rocket, so a search for it finds one passage
   * per message.
   */
  const seed = Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    const providerAccountId = mintId();
    const spec = buildSpec(providerAccountId, "clever");
    const runnerId = mintId();
    const thread = yield* insertQueuedSession(runnerId, { providerAccountId, spec });
    const agentRun = yield* insertQueuedSession(runnerId, {
      providerAccountId,
      spec,
      agentId: agentA,
    });
    const child = yield* insertQueuedSession(runnerId, {
      providerAccountId,
      spec,
      agentId: agentA,
      createdBy: buildSessionStamp(thread),
    });
    const other = yield* insertQueuedSession(runnerId, {
      providerAccountId,
      spec,
      agentId: agentB,
    });
    const base = { eventId: "e", sessionId: "native", at: t[0]! };
    const userMessage = (text: string) =>
      ({
        ...base,
        turnId: "turn-1",
        itemId: "item-1",
        kind: "user_message",
        detail: { text },
      }) as const;
    const reply = (
      text: string,
      streamKind: "assistant_text" | "reasoning_text" = "assistant_text",
    ) =>
      ({
        _tag: "content.delta",
        ...base,
        turnId: "turn-1",
        itemId: "item-2",
        streamKind,
        delta: text,
      }) as const;
    const rows: ReadonlyArray<readonly [string, string, HarnessEvent]> = [
      [agentRun, t[0]!, { _tag: "item.started", ...userMessage("launch the rocket today") }],
      [
        agentRun,
        t[0]!,
        { _tag: "item.completed", ...userMessage("launch the rocket today"), status: "completed" },
      ],
      [agentRun, t[1]!, reply("the rocket launched")],
      [agentRun, t[2]!, reply("the rocket reasoning", "reasoning_text")],
      [child, t[3]!, { ...reply("the rocket is fuelled"), subagentId: "helper" }],
      [thread, t[4]!, { _tag: "item.started", ...userMessage("where is the rocket") }],
      [other, t[5]!, reply("another rocket")],
    ];
    yield* withTransaction(
      yield* SqlClient.SqlClient,
      Effect.forEach(
        rows.entries(),
        ([index, [sessionId, rowAt, event]]) =>
          sessions.append(sessionId, { seq: index + 1, at: rowAt, event }),
        { discard: true },
      ),
    );
    return { thread, agentRun, child, other };
  });

  type Seeded = Effect.Success<typeof seed>;

  /** Seeds the stream, then runs `test` with the seeded ids. */
  const runSeeded = <A, E>(
    test: (seeded: Seeded) => Effect.Effect<A, E, Layer.Success<typeof layer>>,
  ) => run(Effect.flatMap(seed, test));

  /** Runs `transcript.query` as `actor`, failing the test on any error. */
  const queryAs = (actor: Actor, input: PassageQueryInput) =>
    Effect.flatMap(SessionService, (service) =>
      Effect.provideService(service.queryPassages(input), CurrentActor, actor),
    );

  /** Returns where each passage is from: its session and when it was written. */
  const locate = (items: ReadonlyArray<Passage>) => items.map((item) => [item.sessionId, item.at]);

  it("finds every message once, newest first, with an excerpt of the text that matched", async () => {
    const { seeded, page } = await runSeeded((seeded) =>
      Effect.map(queryAs(USER, { text: "rocket" }), (page) => ({ seeded, page })),
    );

    // The completed user message repeats its start, and reasoning is not a
    // message, so neither is a passage.
    expect(locate(page.items)).toEqual([
      [seeded.other, t[5]],
      [seeded.thread, t[4]],
      [seeded.child, t[3]],
      [seeded.agentRun, t[1]],
      [seeded.agentRun, t[0]],
    ]);
    expect(page.items[4]).toEqual({
      sessionId: seeded.agentRun,
      turnId: "turn-1",
      at: t[0],
      excerpt: "launch the rocket today",
    });
    expect(page.nextCursor).toBeUndefined();
    // Only the passage the subagent wrote carries a subagent id.
    expect(page.items.map((item) => item.subagentId)).toEqual([
      undefined,
      undefined,
      "helper",
      undefined,
      undefined,
    ]);
    expect(page.items.filter((item) => "subagentId" in item)).toHaveLength(1);
  });

  it("pages through every passage once, in either direction", async () => {
    const { first, second, third, oldestFirst } = await runSeeded(() =>
      Effect.gen(function* () {
        const first = yield* queryAs(USER, { text: "rocket", limit: 2 });
        const second = yield* queryAs(USER, {
          text: "rocket",
          limit: 2,
          cursor: first.nextCursor!,
        });
        const third = yield* queryAs(USER, {
          text: "rocket",
          limit: 2,
          cursor: second.nextCursor!,
        });
        const oldestFirst = yield* queryAs(USER, {
          text: "rocket",
          sort: [{ field: "at", direction: "asc" }],
        });
        return { first, second, third, oldestFirst };
      }),
    );

    const all = [...first.items, ...second.items, ...third.items];
    expect(all.map((item) => item.at)).toEqual([t[5], t[4], t[3], t[1], t[0]]);
    expect(third.nextCursor).toBeUndefined();
    expect(oldestFirst.items.map((item) => item.at)).toEqual([t[0], t[1], t[3], t[4], t[5]]);
  });

  it("narrows by session, by Agent, and by when the message was written", async () => {
    const result = await runSeeded((seeded) =>
      Effect.gen(function* () {
        return {
          seeded,
          bySession: yield* queryAs(USER, { text: "rocket", sessionId: seeded.agentRun }),
          byAgent: yield* queryAs(USER, { text: "rocket", agentId: agentA }),
          since: yield* queryAs(USER, { text: "rocket", since: t[3]! }),
          until: yield* queryAs(USER, { text: "rocket", until: t[3]! }),
          narrowed: yield* queryAs(USER, { text: "launched rocket", agentId: agentA }),
        };
      }),
    );

    const { seeded } = result;
    expect(locate(result.bySession.items)).toEqual([
      [seeded.agentRun, t[1]],
      [seeded.agentRun, t[0]],
    ]);
    expect(locate(result.byAgent.items)).toEqual([
      [seeded.child, t[3]],
      [seeded.agentRun, t[1]],
      [seeded.agentRun, t[0]],
    ]);
    // `since` keeps the instant itself, and `until` stops before it.
    expect(result.since.items.map((item) => item.at)).toEqual([t[5], t[4], t[3]]);
    expect(result.until.items.map((item) => item.at)).toEqual([t[1], t[0]]);
    // Every word must match.
    expect(locate(result.narrowed.items)).toEqual([[seeded.agentRun, t[1]]]);
  });

  it("resolves `me` from the calling session: its Agent, and the sessions it created", async () => {
    const result = await runSeeded((seeded) =>
      Effect.gen(function* () {
        return {
          seeded,
          ownAgent: yield* queryAs(buildSessionActor(seeded.child, agentA), {
            text: "rocket",
            agentId: "me",
          }),
          created: yield* queryAs(buildSessionActor(seeded.thread, null), {
            text: "rocket",
            actor: "me",
          }),
        };
      }),
    );

    const { seeded } = result;
    expect(locate(result.ownAgent.items)).toEqual([
      [seeded.child, t[3]],
      [seeded.agentRun, t[1]],
      [seeded.agentRun, t[0]],
    ]);
    expect(locate(result.created.items)).toEqual([[seeded.child, t[3]]]);
  });

  it("returns an empty page for text with no word in it", async () => {
    const page = await runSeeded(() => queryAs(USER, { text: "?!" }));

    expect(page).toEqual({ items: [] });
  });
});
