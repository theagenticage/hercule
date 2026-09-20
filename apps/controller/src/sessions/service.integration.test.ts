/**
 * The frames the sessions domain builds itself: the `sessionStart` frames
 * `starting` hands back complete, and the one-expression builders for the
 * frames that follow a session's life.
 *
 * What is asserted is the wire shape and which row each field of it came from
 * - the token the row holds only a hash of, the spec decoded from the document
 * the row stores, the account a readable connection lends - never how the
 * domain goes about building them.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Redacted } from "effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { SessionSpec, type ModelSelection, type SessionStart } from "@hercule/protocol";
import { homePaths, HerculeHome } from "../config";
import { connectionRepository, ConnectionTypesLayer, GITHUB_CONNECTION_TYPE } from "../connections";
import { hashToken } from "../credentials";
import { mintUuid, uuidToString, withTransaction } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { SessionTokensLayer } from "../permissions";
import { PluginConfigsLayer, PluginHostLayer } from "../plugins";
import { masterKeyLayer } from "../secrets/masterKey";
import { Secrets, secretsLayer, type SecretOwner } from "../secrets/repository";
import { gitCredentials } from "../workspaces";
import type { GitCredential } from "../workspaces";
import { type StoredInput } from "./inputs";
import { sessionRepository } from "./repository";
import { SessionService, SessionServiceLayer, type Starting } from "./service";

/** Throwaway master-key homes, removed once this file's tests are done. */
let homes: Array<string> = [];

/**
 * A real plugin host with nothing registered in it, because the record a
 * session reads back says what its provider will not enforce, and that is read
 * from the catalog the host holds.
 */
const hostLayer = (secrets: Layer.Layer<Secrets, unknown, SqlClient.SqlClient>) =>
  PluginHostLayer.pipe(
    Layer.provideMerge(ConnectionTypesLayer),
    Layer.provideMerge(PluginConfigsLayer),
    Layer.provideMerge(secrets),
    Layer.provideMerge(AuditLogLayer),
  );

/**
 * Made when the layer is built rather than when this module is read: the
 * sweep after each test removes what the last one made, so a home minted once
 * at import would be gone by the second case.
 */
const aScratchHome = (): Layer.Layer<HerculeHome> =>
  Layer.effect(HerculeHome)(
    Effect.sync(() => {
      const home = mkdtempSync(join(tmpdir(), "hercule-sessions-"));
      homes.push(home);
      return HerculeHome.of(homePaths(home, join(home, "data")));
    }),
  );

const realSecrets = () =>
  secretsLayer.pipe(Layer.provide(masterKeyLayer("file").pipe(Layer.provide(aScratchHome()))));

const layer = SessionServiceLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(AuditLogLayer, SessionTokensLayer, hostLayer(realSecrets()))),
  Layer.provideMerge(TestDatabase),
);

const run = <A, E>(effect: Effect.Effect<A, E, SessionService | SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, layer));

const at = "2026-09-07T10:00:00.000Z";

/** A canonical v7 id, which is the only shape the store takes. */
const anId = () => uuidToString(mintUuid());

/** The exact spec document a queued row stores, as `create` stores it. */
const encodeSpec = Schema.encodeUnknownSync(SessionSpec);

const aSpec = (instanceId: string, model: string): SessionSpec => ({
  instanceId,
  workspaceId: null,
  modelSelection: { model, options: {} },
  accessMode: "approval-required",
  timeouts: { inactivityMs: 60_000, absoluteMs: 3_600_000 },
});

/**
 * A provider instance row, which is where a start's `providerId` and `config`
 * come from: `oldestQueued` joins them in.
 */
const anInstance = (
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

/** One queued session on a runner, stored the way `create` stores one. */
const aQueuedSession = (
  runnerId: string,
  options: {
    readonly instanceId: string;
    readonly spec: SessionSpec;
    /** Stores this document verbatim instead of encoding `spec`. */
    readonly storedSpec?: string;
    readonly checkoutBranch?: string;
    readonly githubConnectionId?: string;
  },
): Effect.Effect<string, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    const id = anId();
    yield* sessions.insert({
      id,
      title: "a session",
      permissionProfileId: anId(),
      agentId: undefined,
      instanceId: options.instanceId,
      runnerId,
      workspaceId: null,
      projectId: undefined,
      checkoutBranch: options.checkoutBranch,
      githubConnectionId: options.githubConnectionId,
      requestedAccessMode: "approval-required",
      accessMode: "approval-required",
      // The document is stored verbatim: a start frame's spec is decoded
      // from exactly this.
      spec: options.storedSpec ?? JSON.stringify(encodeSpec(options.spec)),
      modelSelection: options.spec.modelSelection,
      parentSessionId: undefined,
      at,
    });
    return id;
  });

/** The pair `starting` returns for one claimed session. */
type Claim = Starting;

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

/**
 * The reader's own dependency, gated: a `Secrets.get` that announces itself
 * and then holds, so an interruption arriving there must travel through the
 * credential reader's error handling rather than around it. The rest of the
 * stack is the real one, over the same database, with a master key of its own
 * in a home the test throws away.
 */
const gatedCredentialStack = (entered: Deferred.Deferred<void>, hold: Deferred.Deferred<void>) => {
  const gatedSecrets = Layer.effect(
    Secrets,
    Effect.map(Effect.provide(Secrets, realSecrets()), (inner) => ({
      ...inner,
      get: (owner: SecretOwner, name: string) =>
        Effect.andThen(
          Deferred.succeed(entered, undefined),
          Effect.andThen(Deferred.await(hold), inner.get(owner, name)),
        ),
    })),
  );
  return SessionServiceLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(AuditLogLayer, SessionTokensLayer, gatedSecrets, hostLayer(gatedSecrets)),
    ),
    Layer.provideMerge(TestDatabase),
  );
};

/** A real GitHub connection with a really encrypted token: the reader only
 * reaches for a secret on one. */
const aGithubConnection = Effect.gen(function* () {
  const secrets = yield* Secrets;
  const connections = yield* connectionRepository;
  const connection = yield* connections.insert({
    pluginId: "github",
    type: GITHUB_CONNECTION_TYPE,
    label: "work",
    displayName: "octocat",
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

/** An instance with no credential stored: what these sessions run on. */
const NO_SECRETS = (): Effect.Effect<Record<string, string>> => Effect.succeed({});

/** `starting` as the daemon calls it: inside the caller's transaction. */
const claiming = (
  runnerId: string,
  room: number,
  accountOf: (connectionId: string) => Effect.Effect<GitCredential | undefined>,
): Effect.Effect<ReadonlyArray<Claim>, SqlError, SessionService | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* SessionService;
    return yield* withTransaction(
      sql,
      sessions.starting(runnerId, room, { accountOf, secretsOf: NO_SECRETS }),
    );
  });

/** The token hash a session row holds, read straight off the row. */
const hashOf = (sessionId: string) =>
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

/** The frames a claim returned, keyed by the session each starts. */
const framesOf = (claimed: ReadonlyArray<Claim>): Map<string, SessionStart> =>
  new Map(claimed.map((claim) => [claim.sessionId, claim.frame] as const));

describe("SessionService.starting", () => {
  it("returns one complete sessionStart per session it claimed to starting", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rows = yield* sessionRepository;
        const instanceId = yield* anInstance("an-adapter", { token: "t", baseUrl: "https://api" });
        const runnerId = anId();
        const specOnBranch = aSpec(instanceId, "clever");
        const specPlain = aSpec(instanceId, "fast");
        const onBranch = yield* aQueuedSession(runnerId, {
          instanceId,
          spec: specOnBranch,
          checkoutBranch: "feature-x",
        });
        const plain = yield* aQueuedSession(runnerId, { instanceId, spec: specPlain });
        const claimed = yield* claiming(runnerId, 2, () => Effect.succeed(undefined));
        return {
          claimed,
          onBranch,
          plain,
          specOnBranch,
          specPlain,
          onBranchAfter: yield* Effect.map(rows.one(onBranch), Option.getOrUndefined),
          plainAfter: yield* Effect.map(rows.one(plain), Option.getOrUndefined),
        };
      }),
    );

    expect(result.claimed).toHaveLength(2);
    const frames = framesOf(result.claimed);
    expect([...frames.keys()].sort()).toEqual([result.onBranch, result.plain].sort());

    const branch = frames.get(result.onBranch)!;
    expect(branch._tag).toBe("sessionStart");
    expect(branch.providerId).toBe("an-adapter");
    expect(branch.config).toEqual({ token: "t", baseUrl: "https://api" });
    // Decoded from the document the row stores, not a re-encode of a summary.
    expect(branch.spec).toStrictEqual(result.specOnBranch);
    expect(branch.checkoutBranch).toBe("feature-x");
    expect(typeof branch.token).toBe("string");
    expect(branch.token.length).toBeGreaterThan(0);

    const plain = frames.get(result.plain)!;
    expect(plain.spec).toStrictEqual(result.specPlain);
    // Where the row holds no branch, the key is not on the frame at all.
    expect("checkoutBranch" in plain).toBe(false);

    // One pair per session it claimed: both rows moved to `starting`.
    expect(result.onBranchAfter?.status).toBe("starting");
    expect(result.plainAfter?.status).toBe("starting");
  });

  it("mints the token fresh and leaves the row holding nothing but its hash", async () => {
    const result = await run(
      Effect.gen(function* () {
        const instanceId = yield* anInstance("an-adapter", {});
        const runnerId = anId();
        const first = yield* aQueuedSession(runnerId, {
          instanceId,
          spec: aSpec(instanceId, "clever"),
        });
        const second = yield* aQueuedSession(runnerId, {
          instanceId,
          spec: aSpec(instanceId, "clever"),
        });
        const claimed = yield* claiming(runnerId, 2, () => Effect.succeed(undefined));
        return {
          claimed,
          first,
          second,
          firstHash: yield* hashOf(first),
          secondHash: yield* hashOf(second),
        };
      }),
    );

    expect(result.claimed).toHaveLength(2);
    const frames = framesOf(result.claimed);
    const firstFrame = frames.get(result.first)!;
    const secondFrame = frames.get(result.second)!;
    // The row stores the hash of the token the frame carries, never the token.
    expect(hashToken(firstFrame.token)).toBe(result.firstHash);
    expect(firstFrame.token).not.toBe(result.firstHash);
    expect(hashToken(secondFrame.token)).toBe(result.secondHash);
    // Minted per start: two sessions in one claim never share a credential.
    expect(firstFrame.token).not.toBe(secondFrame.token);
  });

  it("carries a readable connection's account, and asks only the connected rows", async () => {
    const connectionId = anId();
    const result = await run(
      Effect.gen(function* () {
        const instanceId = yield* anInstance("an-adapter", {});
        const runnerId = anId();
        const connected = yield* aQueuedSession(runnerId, {
          instanceId,
          spec: aSpec(instanceId, "clever"),
          githubConnectionId: connectionId,
        });
        const bare = yield* aQueuedSession(runnerId, {
          instanceId,
          spec: aSpec(instanceId, "clever"),
        });
        const asked: Array<string> = [];
        const claimed = yield* claiming(runnerId, 2, (id) =>
          Effect.sync(() => {
            asked.push(id);
            return { token: "ghpat-alice", login: "alice" };
          }),
        );
        return { asked, claimed, connected, bare };
      }),
    );

    // Only the row with a non-null connection was asked about.
    expect(result.asked).toEqual([connectionId]);

    const frames = framesOf(result.claimed);
    const account = frames.get(result.connected)!;
    expect(account.ghToken).toBe("ghpat-alice");
    // Who the account commits as: its login, and GitHub's noreply address.
    expect(account.gitIdentity).toStrictEqual({
      name: "alice",
      email: "alice@users.noreply.github.com",
    });

    const none = frames.get(result.bare)!;
    expect("ghToken" in none).toBe(false);
    expect("gitIdentity" in none).toBe(false);
  });

  it("omits ghToken and gitIdentity where accountOf finds no account", async () => {
    const connectionId = anId();
    const result = await run(
      Effect.gen(function* () {
        const instanceId = yield* anInstance("an-adapter", {});
        const runnerId = anId();
        const sessionId = yield* aQueuedSession(runnerId, {
          instanceId,
          spec: aSpec(instanceId, "clever"),
          githubConnectionId: connectionId,
        });
        const asked: Array<string> = [];
        const claimed = yield* claiming(runnerId, 1, (id) =>
          Effect.sync(() => {
            asked.push(id);
            return undefined;
          }),
        );
        return { asked, claimed, sessionId };
      }),
    );

    // It asked, and the answer was that there is no account.
    expect(result.asked).toEqual([connectionId]);
    expect(result.claimed).toHaveLength(1);
    expect(result.claimed[0]!.frame).toMatchObject({ sessionId: result.sessionId });
    expect("ghToken" in result.claimed[0]!.frame).toBe(false);
    expect("gitIdentity" in result.claimed[0]!.frame).toBe(false);
  });

  it("leaves a row whose stored spec will not decode queued, and starts the rest of the batch", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rows = yield* sessionRepository;
        const instanceId = yield* anInstance("an-adapter", {});
        const runnerId = anId();
        // A document this build's codec refuses - valid JSON the row was
        // allowed to store, and no `SessionSpec` of today will read: what a
        // codec changing underneath a queued row leaves behind.
        const poisoned = yield* aQueuedSession(runnerId, {
          instanceId,
          spec: aSpec(instanceId, "clever"),
          storedSpec: "{}",
        });
        const good = yield* aQueuedSession(runnerId, {
          instanceId,
          spec: aSpec(instanceId, "clever"),
        });
        const claimed = yield* claiming(runnerId, 2, () => Effect.succeed(undefined));
        return {
          claimed,
          poisoned,
          good,
          poisonedAfter: yield* Effect.map(rows.one(poisoned), Option.getOrUndefined),
          goodAfter: yield* Effect.map(rows.one(good), Option.getOrUndefined),
        };
      }),
    );

    // The bad row is not claimed: it stays queued, visible and stoppable.
    expect(result.claimed.map((claim) => claim.sessionId)).toEqual([result.good]);
    expect(result.poisonedAfter?.status).toBe("queued");
    // And it blocks nothing behind it.
    expect(result.goodAfter?.status).toBe("starting");
  });

  it("still starts the row behind a poison head when there is room for only one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rows = yield* sessionRepository;
        const instanceId = yield* anInstance("an-adapter", {});
        const runnerId = anId();
        const poisoned = yield* aQueuedSession(runnerId, {
          instanceId,
          spec: aSpec(instanceId, "clever"),
          storedSpec: "{}",
        });
        const good = yield* aQueuedSession(runnerId, {
          instanceId,
          spec: aSpec(instanceId, "clever"),
        });
        const claimed = yield* claiming(runnerId, 1, () => Effect.succeed(undefined));
        return {
          claimed,
          poisoned,
          good,
          poisonedAfter: yield* Effect.map(rows.one(poisoned), Option.getOrUndefined),
        };
      }),
    );

    // Room for one, and the oldest row cannot fill it: the look past it does.
    expect(result.claimed.map((claim) => claim.sessionId)).toEqual([result.good]);
    expect(result.poisonedAfter?.status).toBe("queued");
  });

  it("walks past any number of poison rows to fill the room", async () => {
    const result = await run(
      Effect.gen(function* () {
        const instanceId = yield* anInstance("an-adapter", {});
        const runnerId = anId();
        for (let i = 0; i < 6; i += 1) {
          yield* aQueuedSession(runnerId, {
            instanceId,
            spec: aSpec(instanceId, "clever"),
            storedSpec: "{}",
          });
        }
        const good = yield* aQueuedSession(runnerId, {
          instanceId,
          spec: aSpec(instanceId, "clever"),
        });
        const claimed = yield* claiming(runnerId, 2, () => Effect.succeed(undefined));
        return { claimed, good };
      }),
    );

    // Six unreadable rows ahead, room for two, one healthy row behind them
    // all: the walk reaches it and the room is filled with what it found.
    expect(result.claimed.map((claim) => claim.sessionId)).toEqual([result.good]);
  });

  it("passes an interruption on rather than logging it away as an unreadable connection", async () => {
    const entered = Effect.runSync(Deferred.make<void>());
    const hold = Effect.runSync(Deferred.make<void>());
    const logged: Array<string> = [];
    const stack = gatedCredentialStack(entered, hold).pipe(
      Layer.provideMerge(
        Layer.succeed(
          Logger.CurrentLoggers,
          new Set<Logger.Logger<unknown, unknown>>([
            {
              log: (entry: { readonly message: ReadonlyArray<string> }): void => {
                logged.push(entry.message.join(" "));
              },
            } as unknown as Logger.Logger<unknown, unknown>,
          ]),
        ),
      ),
    );
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const credentials = yield* gitCredentials;
          const connectionId = yield* aGithubConnection;
          const reader = yield* Effect.forkChild(credentials.githubAccountOf(connectionId));
          yield* Deferred.await(entered);
          // An interrupt cause arrives through the dependency itself: the
          // catchable shape, and the one the reader's error handling must not
          // read as an unreadable connection.
          yield* Deferred.interrupt(hold);
          const exit = yield* Fiber.await(reader);
          return Exit.isFailure(exit);
        }),
        stack,
      ),
    );

    // The interruption came back out of the reader, and was never logged
    // away: a handler that read it as an unreadable connection would have
    // completed the read with no account and written exactly that to the log.
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
          const credentials = yield* gitCredentials;
          const instanceId = yield* anInstance("an-adapter", {});
          const runnerId = anId();
          const connectionId = yield* aGithubConnection;
          const sessionId = yield* aQueuedSession(runnerId, {
            instanceId,
            spec: aSpec(instanceId, "clever"),
            githubConnectionId: connectionId,
          });
          const claim = withTransaction(
            sql,
            sessions.starting(runnerId, 1, {
              accountOf: credentials.githubAccountOf,
              secretsOf: NO_SECRETS,
            }),
          );
          const fiber = yield* Effect.forkChild(claim);
          yield* Deferred.await(entered);
          // The shutdown shape: the dispatch child, suspended inside the
          // credential reader's dependency, is told to stop and waits for
          // nothing.
          yield* Fiber.interrupt(fiber);
          return {
            after: yield* Effect.map(rows.one(sessionId), Option.getOrUndefined),
            hash: yield* hashOf(sessionId),
          };
        }),
        gatedCredentialStack(entered, hold),
      ),
    );

    // The claim rolled back with the interruption: the row never left the
    // queue, and the token's hash never landed. Whatever the reader's error
    // handling does with an interruption, the transaction never commits a
    // claim the interruption reached into.
    expect(result.after?.status).toBe("queued");
    expect(result.hash).toBeNull();
  });
});

describe("the frame builders on SessionService", () => {
  it("stopping returns exactly the sessionStop frame", async () => {
    const sessionId = anId();
    const frame = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return sessions.stopping(sessionId);
      }),
    );
    expect(frame).toStrictEqual({ _tag: "sessionStop", sessionId });
  });

  it("inputFrame returns exactly the sessionInput frame off the stored row", async () => {
    const row: StoredInput = {
      id: anId(),
      sessionId: anId(),
      source: "user",
      actor: "user:0199e0e7-0000-7000-8000-000000000000",
      text: "pick the failing test",
      status: "queued",
      delivery: null,
      createdAt: at,
      deliveredAt: null,
      sentAt: null,
      reason: null,
    };
    const modelSelection: ModelSelection = { model: "fast", options: { verbose: true } };
    const frame = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return sessions.inputFrame(row, modelSelection);
      }),
    );

    expect(frame).toStrictEqual({
      _tag: "sessionInput",
      requestId: row.id,
      sessionId: row.sessionId,
      input: { text: row.text, modelSelection: modelSelection },
    });
  });

  it("interrupting returns exactly the sessionInterrupt frame", async () => {
    const sessionId = anId();
    const frame = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return sessions.interrupting(sessionId);
      }),
    );
    expect(frame).toStrictEqual({ _tag: "sessionInterrupt", sessionId });
  });

  it("responding returns exactly the sessionRespond frame with the three fields", async () => {
    const sessionId = anId();
    const requestId = anId();
    const frame = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return sessions.responding(sessionId, requestId, "allow_always");
      }),
    );
    expect(frame).toStrictEqual({
      _tag: "sessionRespond",
      sessionId,
      requestId,
      decision: "allow_always",
    });
  });
});
