/**
 * Tests how `TextGenerationLayer` handles a runner connection that misbehaves
 * in ways a real runner on a real socket cannot be made to, and the timing of
 * the slots, which a stub controls more tightly than a socket. The connection
 * is replaced by a stub whose `sendRequest` is the only method the layer calls.
 */
import { describe, expect, it } from "vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Option } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { TextGenerationOutcome, TextGenerationRequest } from "@hercule/protocol";
import { TestDatabase } from "../../db/testing";
import { AuditLogLayer } from "../../events";
import { readEventsOfKind } from "../../events/testing";
import { PluginHost } from "../../plugins";
import { ServingPromotionStateLayer } from "../../promotion/testing";
import type { StoredInstance } from "../../providers";
import { LocalRunnerId, RunnerConnections, type Answer, type SendOutcome } from "../../runners";
import { Secrets } from "../../secrets";
import {
  LastTextGenerationFailure,
  LastTextGenerationFailureLayer,
  TextGeneration,
  TextGenerationModels,
  type TextGenerationCall,
  type TextGenerationTarget,
} from "../../text-generation";
import { TextGenerationDeadline, TextGenerationLayer } from "./generate";

const FAILURE_KEY = "test-key";

const INSTANCE: StoredInstance = {
  id: "instance-1",
  providerId: "codex",
  name: "Codex",
  config: {},
  createdAt: "2026-10-11T10:00:00.000Z",
  updatedAt: "2026-10-11T10:00:00.000Z",
};

const TARGET: TextGenerationTarget = {
  _tag: "resolved",
  failureKey: FAILURE_KEY,
  instance: INSTANCE,
  model: "codex-mini",
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
};

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

/** Builds the layer with a connection whose `sendRequest` does what the test says. */
const buildLayer = (sendRequest: SendRequest) =>
  TextGenerationLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        LastTextGenerationFailureLayer,
        Layer.succeed(TextGenerationModels, { resolve: () => Effect.succeed(TARGET) }),
        Layer.succeed(RunnerConnections, {
          sendRequest,
        } as unknown as RunnerConnections["Service"]),
        Layer.succeed(Secrets, {
          values: () => Effect.succeed([]),
        } as unknown as Secrets["Service"]),
        Layer.succeed(PluginHost, {
          providers: () => Effect.succeed([]),
        } as unknown as PluginHost["Service"]),
        Layer.succeed(LocalRunnerId, { read: () => undefined }),
      ),
    ),
    Layer.provideMerge(ServingPromotionStateLayer),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(TestDatabase),
  );

/** Runs `body` against the layer, with the deadline set to `deadline`. */
const runWithLayer = <A, E>(
  sendRequest: SendRequest,
  body: Effect.Effect<A, E, TextGeneration | LastTextGenerationFailure | SqlClient.SqlClient>,
  deadline: Duration.Duration = Duration.seconds(60),
) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(buildLayer(sendRequest)),
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

    expect(Exit.isFailure(exit)).toBe(true);
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
});
