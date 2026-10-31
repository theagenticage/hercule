/**
 * Tests how `TextGenerationLayer` handles a runner connection that misbehaves
 * in ways a real runner on a real socket cannot be made to, and the timing of
 * the slots and of a call that waits for a runner, which a stub controls more
 * tightly than a socket. The connection is replaced by a stub: `sendRequest`
 * does what the test says, and every runner holds a connection unless the
 * test says otherwise.
 */
import { describe, expect, it } from "vitest";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Ref,
  Scope,
} from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { CatalogModel, TextGenerationOutcome, TextGenerationRequest } from "@hercule/protocol";
import { nowIso, uuidFromString, withTransaction } from "../../db";
import { readEventsOfKind } from "../../events/testing";
import { PluginHost } from "../../plugins";
import {
  buildHarnessDefinition,
  buildPluginStack,
  buildProviderDefinition,
  createPluginFixture,
} from "../../plugins/testing";
import {
  HarnessAccountsLayer,
  modelCatalogRepository,
  providerAccountRepository,
  UnlistedModelsLayer,
} from "../../provider-accounts";
import { LocalRunnerId, RunnerConnections, type Answer, type SendOutcome } from "../../runners";
import { buildProviderAccountOwner, Secrets } from "../../secrets";
import {
  LastTextGenerationFailure,
  LastTextGenerationFailureLayer,
  TextGeneration,
  TextGenerationModels,
  type TextGenerationCall,
  type TextGenerationTarget,
} from "../../text-generation";
import { buildTextGenerationPlugins } from "../../text-generation/testing";
import { TextGenerationDeadline, TextGenerationLayer } from "./generate";
import { TextGenerationTargetChanges, TextGenerationTargetChangesLayer } from "./target-changes";

const FAILURE_KEY = "test-key";

/** The id of the OpenAI account that `arrangeAccount` inserts, which `TARGET` names. */
const ACCOUNT_ID = "0199f0b7-2000-7000-8000-000000000001";

/**
 * Boots the plugins of the text generation fixtures and inserts the OpenAI
 * account `TARGET` names, so a call can build the frame's `HarnessAccount`
 * from a real account row.
 */
const arrangeAccount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.flatMap(PluginHost, (host) => host.boot(buildTextGenerationPlugins()));
  yield* withTransaction(
    sql,
    sql`INSERT INTO provider_accounts (id, provider_id, kind, default_harness_id, created_at, updated_at)
        VALUES (${uuidFromString(ACCOUNT_ID)}, 'openai/openai', 'subscription-per-machine',
                'codex/codex', '2026-10-11T10:00:00.000Z', '2026-10-11T10:00:00.000Z')`,
  );
});

const TARGET: TextGenerationTarget = {
  _tag: "resolved",
  failureKey: FAILURE_KEY,
  providerAccountId: ACCOUNT_ID,
  providerAccountName: "OpenAI",
  harnessId: "codex/codex",
  model: "gpt-6-luna",
  runnerIds: ["runner-1"],
};

const CALL: TextGenerationCall = {
  caller: "core:sessions",
  purpose: "thread.title",
  instructions: "Name the thread.",
  input: "Fix the login bug",
  outputSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
    additionalProperties: false,
  },
  whenNoRunner: "fail",
};

/** The call of a run's step, which waits for a runner rather than fail. */
const WAITING_CALL: TextGenerationCall = { ...CALL, whenNoRunner: "wait" };

/** A target no runner can take a call on. */
const NO_RUNNER: TextGenerationTarget = { ...TARGET, runnerIds: [] };

const PERMITS = 10;

type SendRequest = (
  runnerId: string,
  request: TextGenerationRequest,
) => Effect.Effect<SendOutcome<Answer>>;

/** Builds the runner's answer to `request` with the given outcome. */
const buildAnswer = (
  request: TextGenerationRequest,
  outcome: TextGenerationOutcome,
): SendOutcome<Answer> => ({
  _tag: "sent",
  answer: Option.some({ _tag: "textGenerationReport", requestId: request.requestId, outcome }),
});

const OK: TextGenerationOutcome = { outcome: "ok", value: { title: "Fix it" }, usage: null };

/** Waits until `count()` reaches `expected`, so the calls before it hold their slots. */
const waitForCount = (count: () => number, expected: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (count() < expected) yield* Effect.sleep(Duration.millis(5));
  });

/** What a test changes about the stubs besides `sendRequest`. */
interface Stubs {
  /** The target the setting resolves to, read again on each look for a runner. */
  readonly target?: Ref.Ref<TextGenerationTarget>;
  /** The runners that hold no connection. */
  readonly disconnected?: ReadonlyArray<string>;
}

/**
 * Builds the service with a connection whose `sendRequest` does what the test
 * says, on the database, plugin host, secrets, audit log and promotion state
 * of the caller.
 */
const buildServiceLayer = (
  sendRequest: SendRequest,
  { target = Ref.makeUnsafe<TextGenerationTarget>(TARGET), disconnected = [] }: Stubs,
) =>
  TextGenerationLayer.pipe(
    Layer.provideMerge(HarnessAccountsLayer),
    Layer.provideMerge(UnlistedModelsLayer),
    Layer.provideMerge(
      Layer.mergeAll(
        LastTextGenerationFailureLayer,
        Layer.succeed(TextGenerationModels, { resolve: () => Ref.get(target) }),
        Layer.succeed(RunnerConnections, {
          sendRequest,
          holdsConnection: (id: string) => Effect.succeed(!disconnected.includes(id)),
        } as unknown as RunnerConnections["Service"]),
        Layer.succeed(LocalRunnerId, { read: () => undefined }),
      ),
    ),
    Layer.provideMerge(TextGenerationTargetChangesLayer),
  );

/** Builds the service, as `buildServiceLayer` does, on a database of its own. */
const buildLayer = (sendRequest: SendRequest, stubs: Stubs) =>
  buildServiceLayer(sendRequest, stubs).pipe(Layer.provideMerge(buildPluginStack()));

/** Runs `body` against the layer, with the deadline set to `deadline`. */
const runWithLayer = <A, E>(
  sendRequest: SendRequest,
  body: Effect.Effect<
    A,
    E,
    TextGeneration | LastTextGenerationFailure | TextGenerationTargetChanges | SqlClient.SqlClient
  >,
  deadline: Duration.Duration = Duration.seconds(60),
  stubs: Stubs = {},
) =>
  Effect.runPromise(
    Effect.andThen(arrangeAccount, body).pipe(
      Effect.provide(buildLayer(sendRequest, stubs)),
      Effect.provideService(TextGenerationDeadline, deadline),
      Effect.orDie,
    ),
  );

/** Makes one call and returns how it ended, the audit entries it wrote and the last failure. */
const makeCall = (sendRequest: SendRequest, call: TextGenerationCall = CALL) =>
  runWithLayer(
    sendRequest,
    Effect.gen(function* () {
      const service = yield* TextGeneration;
      const started = Date.now();
      const exit = yield* Effect.exit(service.generate(call));
      const elapsedMs = Date.now() - started;
      const failed = yield* readEventsOfKind("textGeneration.failed");
      const completed = yield* readEventsOfKind("textGeneration.completed");
      const lastFailure = yield* (yield* LastTextGenerationFailure).read(FAILURE_KEY);
      return { exit, elapsedMs, failed, completed, lastFailure };
    }),
  );

describe("a request that cannot be sent", () => {
  it("fails as unavailable, with a message that says the call was never sent", async () => {
    const { exit, failed, lastFailure } = await makeCall(() => Effect.succeed({ _tag: "notSent" }));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("was not sent");
    expect(JSON.stringify(exit)).not.toContain("connection ended");
    expect(failed).toHaveLength(1);
    expect(lastFailure).toMatchObject({ reason: "unavailable" });
  });
});

describe("the choice of a runner", () => {
  it("skips a runner that holds no connection, so another runner answers", async () => {
    const asked: Array<string> = [];
    const exit = await runWithLayer(
      (runnerId, request) => {
        asked.push(runnerId);
        return Effect.succeed(buildAnswer(request, OK));
      },
      Effect.flatMap(TextGeneration, (service) => Effect.exit(service.generate(CALL))),
      undefined,
      {
        target: Ref.makeUnsafe<TextGenerationTarget>({
          ...TARGET,
          runnerIds: ["runner-1", "runner-2"],
        }),
        disconnected: ["runner-1"],
      },
    );

    expect(exit).toEqual(Exit.succeed({ title: "Fix it" }));
    expect(asked).toEqual(["runner-2"]);
  });
});

describe("the request sent to the runner", () => {
  it("names the harness and carries the account's home and model argument", async () => {
    const requests: Array<TextGenerationRequest> = [];
    await runWithLayer(
      (_, request) => {
        requests.push(request);
        return Effect.succeed(buildAnswer(request, OK));
      },
      Effect.flatMap(TextGeneration, (service) => service.generate(CALL)),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      harnessId: "codex/codex",
      harnessAccount: {
        providerAccountId: ACCOUNT_ID,
        harnessHome: `providers/homes/${ACCOUNT_ID}/codex/codex`,
        modelArgument: "{model}",
      },
      spec: { model: "gpt-6-luna" },
    });
  });

  it("fails as failed, with the reason, when the account was deleted since the setting resolved", async () => {
    const { exit, lastFailure } = await runWithLayer(
      () => Effect.die("no frame is sent"),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(
          sql,
          sql`DELETE FROM provider_accounts WHERE id = ${uuidFromString(ACCOUNT_ID)}`,
        );
        const exit = yield* Effect.exit(
          Effect.flatMap(TextGeneration, (service) => service.generate(CALL)),
        );
        return { exit, lastFailure: yield* (yield* LastTextGenerationFailure).read(FAILURE_KEY) };
      }),
    );

    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { reason: "failed", message: "no such provider account" } }] },
    });
    expect(lastFailure).toMatchObject({ reason: "failed" });
  });
});

describe("a call the runner answers", () => {
  it("fails as failed, not unavailable, when the runner reports that the harness failed", async () => {
    const { exit, failed, lastFailure } = await makeCall((_, request) =>
      Effect.succeed(buildAnswer(request, { outcome: "failed", message: "rate limited" })),
    );

    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { reason: "failed", message: "rate limited" } }] },
    });
    expect(failed[0]!.payload).toMatchObject({ reason: "failed", message: "rate limited" });
    expect(lastFailure).toMatchObject({ reason: "failed" });
  });

  it("fails as invalid-output when the value does not match the JSON Schema", async () => {
    const { exit, failed, completed } = await makeCall((_, request) =>
      Effect.succeed(
        buildAnswer(request, { outcome: "ok", value: { title: "Fix it", extra: 1 }, usage: null }),
      ),
    );

    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { reason: "invalid-output" } }] },
    });
    expect(failed).toHaveLength(1);
    expect(completed).toEqual([]);
  });

  it("records a run's step under the run, with the step id as the purpose", async () => {
    const { exit, completed } = await makeCall(
      (_, request) => Effect.succeed(buildAnswer(request, OK)),
      { ...CALL, caller: "run:run-1", purpose: "screen" },
    );

    expect(exit).toEqual(Exit.succeed({ title: "Fix it" }));
    expect(completed[0]!.payload).toMatchObject({ caller: "run:run-1", purpose: "run-1/screen" });
  });
});

describe("a defect in the fiber that holds the runner's slot", () => {
  it("reaches the caller at once, and is recorded as failed once", async () => {
    const { exit, elapsedMs, failed, lastFailure } = await makeCall(() =>
      Effect.die(new Error("the frame could not be encoded")),
    );

    // The defect becomes the call's typed failure, so a run's step fails
    // with it instead of ending its run with a controller error.
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { reason: "failed" } }] },
    });
    // The caller's deadline is 60 seconds. Waiting for it would be the bug.
    expect(elapsedMs).toBeLessThan(2_000);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({
      reason: "failed",
      message: expect.stringContaining("unexpected error") as unknown,
    });
    expect(lastFailure).toMatchObject({ reason: "failed" });
  });
});

describe("the deadline", () => {
  it("starts when the call holds a slot, so the wait for a slot does not count", async () => {
    const DEADLINE_MS = 300;
    const HOLD_MS = 600;
    let sent = 0;
    // The first ten answer after their callers' deadline, so they hold every
    // slot for longer than a deadline. The eleventh is answered at once.
    const sendRequest: SendRequest = (_, request) => {
      sent += 1;
      const answer = Effect.succeed(buildAnswer(request, OK));
      return sent <= PERMITS ? Effect.delay(answer, Duration.millis(HOLD_MS)) : answer;
    };

    const results = await runWithLayer(
      sendRequest,
      Effect.gen(function* () {
        const service = yield* TextGeneration;
        const started = Date.now();
        const first = yield* Effect.forEach(Array.from({ length: PERMITS }), () =>
          Effect.forkChild(
            Effect.match(service.generate(CALL), {
              onFailure: (error) => error.reason,
              onSuccess: () => "ok",
            }),
          ),
        );
        yield* waitForCount(() => sent, PERMITS);
        const eleventh = yield* Effect.exit(service.generate(CALL));
        const waitedMs = Date.now() - started;
        return { first: yield* Fiber.joinAll(first), eleventh, waitedMs };
      }),
      Duration.millis(DEADLINE_MS),
    );

    expect(results.first).toEqual(Array.from({ length: PERMITS }, () => "timeout"));
    expect(results.eleventh).toEqual(Exit.succeed({ title: "Fix it" }));
    expect(results.waitedMs).toBeGreaterThanOrEqual(HOLD_MS);
  });

  it("withdraws a call whose caller is interrupted while it waits for a slot", async () => {
    const release = Effect.runSync(Deferred.make<void>());
    const requests: Array<TextGenerationRequest> = [];
    const sendRequest: SendRequest = (_, request) => {
      requests.push(request);
      return Effect.as(Deferred.await(release), buildAnswer(request, OK));
    };

    const exits = await runWithLayer(
      sendRequest,
      Effect.gen(function* () {
        const service = yield* TextGeneration;
        const first = yield* Effect.forEach(Array.from({ length: PERMITS }), () =>
          Effect.forkChild(Effect.exit(service.generate(CALL))),
        );
        yield* waitForCount(() => requests.length, PERMITS);
        const queued = yield* Effect.forkChild(service.generate(CALL));
        yield* Effect.sleep(Duration.millis(50));
        yield* Fiber.interrupt(queued);
        yield* Deferred.succeed(release, undefined);
        const exits = yield* Fiber.joinAll(first);
        // Give a slot that comes free the time to reach the withdrawn call.
        yield* Effect.sleep(Duration.millis(50));
        return exits;
      }),
    );

    expect(exits.every(Exit.isSuccess)).toBe(true);
    expect(requests).toHaveLength(PERMITS);
  });

  it("records a sent call once the runner answers, when its caller was interrupted", async () => {
    const release = Effect.runSync(Deferred.make<void>());
    let sent = 0;
    const sendRequest: SendRequest = (_, request) => {
      sent += 1;
      return Effect.as(
        Deferred.await(release),
        buildAnswer(request, { ...OK, usage: { inputTokens: 5, outputTokens: 2 } }),
      );
    };

    const completed = await runWithLayer(
      sendRequest,
      Effect.gen(function* () {
        const service = yield* TextGeneration;
        const caller = yield* Effect.forkChild(service.generate(CALL));
        yield* waitForCount(() => sent, 1);
        yield* Fiber.interrupt(caller);
        expect(yield* readEventsOfKind("textGeneration.completed")).toEqual([]);
        yield* Deferred.succeed(release, undefined);
        for (let tries = 0; tries < 100; tries += 1) {
          const entries = yield* readEventsOfKind("textGeneration.completed");
          if (entries.length > 0) return entries;
          yield* Effect.sleep(Duration.millis(5));
        }
        return [];
      }),
    );

    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toMatchObject({ usage: { inputTokens: 5, outputTokens: 2 } });
  });
});

describe("a call that queues for a slot", () => {
  /**
   * Fills every slot with a call that holds it until `release`, queues one
   * more call, then changes the setting to `changed` and frees the slots.
   * Returns how the queued call ended, the requests sent and the failed
   * entries written.
   */
  const changeTargetWhileQueued = (changed: TextGenerationTarget) => {
    const target = Ref.makeUnsafe<TextGenerationTarget>(TARGET);
    const release = Effect.runSync(Deferred.make<void>());
    const requests: Array<TextGenerationRequest> = [];
    return runWithLayer(
      (_, request) => {
        requests.push(request);
        return Effect.as(Deferred.await(release), buildAnswer(request, OK));
      },
      Effect.gen(function* () {
        const service = yield* TextGeneration;
        const first = yield* Effect.forEach(Array.from({ length: PERMITS }), () =>
          Effect.forkChild(Effect.exit(service.generate(CALL))),
        );
        yield* waitForCount(() => requests.length, PERMITS);
        const queued = yield* Effect.forkChild(Effect.exit(service.generate(CALL)));
        yield* Effect.sleep(Duration.millis(50));
        yield* Ref.set(target, changed);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.joinAll(first);
        const exit = yield* Fiber.join(queued);
        return { exit, requests, failed: yield* readEventsOfKind("textGeneration.failed") };
      }),
      undefined,
      { target },
    );
  };

  it("is not sent, and fails as off, when text generation is turned off meanwhile", async () => {
    const result = await changeTargetWhileQueued({ _tag: "off", failureKey: FAILURE_KEY });

    expect(result.exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { reason: "off" } }] },
    });
    expect(result.requests).toHaveLength(PERMITS);
    expect(result.failed).toEqual([]);
  });

  it("is made on the model chosen meanwhile", async () => {
    const result = await changeTargetWhileQueued({ ...TARGET, model: "codex-max" });

    expect(result.exit).toEqual(Exit.succeed({ title: "Fix it" }));
    expect(result.requests.map((request) => request.spec.model)).toEqual([
      ...Array.from({ length: PERMITS }, () => "gpt-6-luna"),
      "codex-max",
    ]);
  });

  it("records nothing for a withdrawn call when the controller stops", async () => {
    let sent = 0;
    const failed = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(
          buildServiceLayer(() => {
            sent += 1;
            return Effect.never;
          }, {}),
          scope,
        );
        yield* Effect.gen(function* () {
          yield* arrangeAccount;
          const service = yield* TextGeneration;
          yield* Effect.forEach(Array.from({ length: PERMITS }), () =>
            Effect.forkChild(Effect.exit(service.generate(CALL))),
          );
          yield* waitForCount(() => sent, PERMITS);
          const queued = yield* Effect.forkChild(service.generate(CALL));
          yield* Effect.sleep(Duration.millis(50));
          yield* Fiber.interrupt(queued);
        }).pipe(Effect.provide(context));
        // Stopping interrupts every slot's holder, the withdrawn call's too.
        yield* Scope.close(scope, Exit.void);
        return yield* readEventsOfKind("textGeneration.failed");
      }).pipe(Effect.provide(buildPluginStack()), Effect.orDie),
    );

    // The ten sent calls end without an answer, and each is recorded once.
    // The withdrawn call was never sent, so it is not recorded.
    expect(failed).toHaveLength(PERMITS);
  });
});

/** Reads how many audit entries the calls wrote, completed and failed together. */
const countAuditEntries = Effect.map(
  Effect.all([
    readEventsOfKind("textGeneration.completed"),
    readEventsOfKind("textGeneration.failed"),
  ]),
  ([completed, failed]) => completed.length + failed.length,
);

describe("a call that waits for a runner", () => {
  it("waits while no runner can take it, and is made once a change lets one", async () => {
    const target = Ref.makeUnsafe<TextGenerationTarget>(NO_RUNNER);
    const asked: Array<string> = [];
    const result = await runWithLayer(
      (runnerId, request) => {
        asked.push(runnerId);
        return Effect.succeed(buildAnswer(request, OK));
      },
      Effect.gen(function* () {
        const service = yield* TextGeneration;
        const changes = yield* TextGenerationTargetChanges;
        const caller = yield* Effect.forkChild(Effect.exit(service.generate(WAITING_CALL)));
        yield* Effect.sleep(Duration.millis(50));
        const entriesWhileWaiting = yield* countAuditEntries;
        yield* Ref.set(target, TARGET);
        yield* changes.announce();
        const exit = yield* Fiber.join(caller);
        const completed = yield* readEventsOfKind("textGeneration.completed");
        return { entriesWhileWaiting, exit, completed };
      }),
      undefined,
      { target },
    );

    expect(result.entriesWhileWaiting).toBe(0);
    expect(result.exit).toEqual(Exit.succeed({ title: "Fix it" }));
    expect(asked).toEqual(["runner-1"]);
    expect(result.completed).toHaveLength(1);
  });

  it("fails as off, and records nothing, when text generation is turned off while it waits", async () => {
    const target = Ref.makeUnsafe<TextGenerationTarget>(NO_RUNNER);
    const result = await runWithLayer(
      () => Effect.die("no runner is asked"),
      Effect.gen(function* () {
        const service = yield* TextGeneration;
        const changes = yield* TextGenerationTargetChanges;
        const caller = yield* Effect.forkChild(Effect.exit(service.generate(WAITING_CALL)));
        yield* Effect.sleep(Duration.millis(50));
        yield* Ref.set(target, { _tag: "off", failureKey: FAILURE_KEY });
        yield* changes.announce();
        const exit = yield* Fiber.join(caller);
        return { exit, entries: yield* countAuditEntries };
      }),
      undefined,
      { target },
    );

    expect(result.exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { reason: "off" } }] },
    });
    expect(result.entries).toBe(0);
  });

  it("looks again at once when the runner it was sent to went away", async () => {
    let sent = 0;
    const exit = await runWithLayer(
      (_, request) => {
        sent += 1;
        return Effect.succeed(sent === 1 ? { _tag: "notSent" } : buildAnswer(request, OK));
      },
      Effect.flatMap(TextGeneration, (service) => Effect.exit(service.generate(WAITING_CALL))),
    );

    expect(exit).toEqual(Exit.succeed({ title: "Fix it" }));
    expect(sent).toBe(2);
  });

  it("looks again at once only once, then waits for a change", async () => {
    let sent = 0;
    const sentBeforeInterrupt = await runWithLayer(
      () => {
        sent += 1;
        return Effect.succeed({ _tag: "notSent" } as const);
      },
      Effect.gen(function* () {
        const service = yield* TextGeneration;
        const caller = yield* Effect.forkChild(service.generate(WAITING_CALL));
        yield* Effect.sleep(Duration.millis(100));
        const count = sent;
        yield* Fiber.interrupt(caller);
        return count;
      }),
    );

    expect(sentBeforeInterrupt).toBe(2);
  });
});

describe("a caller interrupted as the runner answers", () => {
  it("leaves exactly one audit entry for the call, whichever happens first", async () => {
    const ROUNDS = 20;
    let release = Effect.runSync(Deferred.make<void>());
    let sent = 0;
    const sendRequest: SendRequest = (_, request) => {
      sent += 1;
      return Effect.as(Deferred.await(release), buildAnswer(request, OK));
    };

    const entries = await runWithLayer(
      sendRequest,
      Effect.gen(function* () {
        const service = yield* TextGeneration;
        for (let round = 1; round <= ROUNDS; round += 1) {
          release = yield* Deferred.make<void>();
          const caller = yield* Effect.forkChild(service.generate(CALL));
          yield* waitForCount(() => sent, round);
          yield* Effect.all([Deferred.succeed(release, undefined), Fiber.interrupt(caller)], {
            concurrency: "unbounded",
          });
          // The abandoned call's record is written once its holder ends.
          for (let tries = 0; tries < 100 && (yield* countAuditEntries) < round; tries += 1) {
            yield* Effect.sleep(Duration.millis(5));
          }
        }
        // Give a second, wrong entry the time to be written.
        yield* Effect.sleep(Duration.millis(50));
        return yield* countAuditEntries;
      }),
    );

    expect(entries).toBe(ROUNDS);
  });
});

describe("the catalog models the harness does not list, on the request", () => {
  const WIDE = "wide/wide";
  const NARROW = "narrow/narrow";
  const API_ONLY: CatalogModel = {
    slug: "api-only",
    name: "API only",
    imageInput: null,
    options: [],
    contextWindow: 200_000,
    reasoning: true,
  };

  /**
   * A provider that reads its catalog from its API, a harness that can run
   * any of its models and one that runs only what it lists.
   */
  const buildApiPlugins = () => [
    createPluginFixture({
      id: "wide",
      definitions: [
        buildHarnessDefinition("wide", [
          {
            providerId: "apiprov/apiprov",
            kinds: [{ kind: "api-key", modelArgument: "{model}", credentialVariable: "API_KEY" }],
            models: "all",
          },
        ]),
      ],
    }).plugin,
    createPluginFixture({
      id: "narrow",
      definitions: [
        buildHarnessDefinition("narrow", [
          {
            providerId: "apiprov/apiprov",
            kinds: [{ kind: "api-key", modelArgument: "{model}", credentialVariable: "API_KEY" }],
            models: "own-list",
          },
        ]),
      ],
    }).plugin,
    createPluginFixture({
      id: "apiprov",
      capabilities: ["providers"],
      definitions: [],
      providers: [
        {
          ...buildProviderDefinition("apiprov", [WIDE, NARROW]),
          catalogSource: {
            kind: "provider-api",
            url: "https://api.example.com/v1/models",
            headers: { authorization: "Bearer {apiKey}" },
          },
        },
      ],
      providerOptions: { parseCatalogBody: () => [] },
    }).plugin,
  ];

  /** Makes a call in `harnessId` on an account whose catalog holds `API_ONLY`, and returns the request sent. */
  const sendInHarness = async (harnessId: string): Promise<TextGenerationRequest> => {
    const requests: Array<TextGenerationRequest> = [];
    // Set once the account exists, because the repository mints its id.
    const target = Ref.makeUnsafe<TextGenerationTarget>({
      ...TARGET,
      harnessId,
      model: "api-only",
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const accounts = yield* providerAccountRepository;
        const catalogs = yield* modelCatalogRepository;
        yield* Effect.flatMap(PluginHost, (host) => host.boot(buildApiPlugins()));
        const account = yield* withTransaction(
          sql,
          accounts.insert({
            providerId: "apiprov/apiprov",
            kind: "api-key",
            label: null,
            defaultHarnessId: WIDE,
            at: yield* nowIso,
          }),
        );
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const secrets = yield* Secrets;
            yield* secrets.set(
              buildProviderAccountOwner(account.id),
              "apiKey",
              Redacted.make("a-fixture-key"),
            );
            yield* catalogs.recordSuccess(
              account.id,
              [API_ONLY],
              yield* nowIso,
              "2026-10-31T10:00:00.000Z",
            );
          }),
        );
        yield* Ref.update(target, (one) => ({ ...one, providerAccountId: account.id }));
        const service = yield* TextGeneration;
        yield* service.generate(CALL);
      }).pipe(
        Effect.provide(
          buildLayer(
            (_, request) => {
              requests.push(request);
              return Effect.succeed(buildAnswer(request, OK));
            },
            { target },
          ),
        ),
        Effect.provideService(TextGenerationDeadline, Duration.seconds(60)),
        Effect.orDie,
      ),
    );
    return requests[0]!;
  };

  it("carries them when the harness can run any model of the provider", async () => {
    const request = await sendInHarness(WIDE);

    expect(request.unlistedModels).toEqual([
      {
        slug: "api-only",
        name: "API only",
        imageInput: null,
        contextWindow: 200_000,
        reasoning: true,
      },
    ]);
  });

  it("leaves them off when the harness runs only the models it lists", async () => {
    const request = await sendInHarness(NARROW);

    expect("unlistedModels" in request).toBe(false);
  });
});
