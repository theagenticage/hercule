/**
 * Tests how `TextGenerationLayer` handles a runner connection that misbehaves
 * in ways a real runner on a real socket cannot be made to. The connection is
 * replaced by a stub whose `sendRequest` is the only method the layer calls.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit, Layer, Schema } from "effect";
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
  TextGenerationModels,
  type TextGenerationTarget,
} from "../../text-generation";
import { TextGenerationLayer } from "./generate";
import { TextGeneration, type TextGenerationCall } from "./service";

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

const CALL: TextGenerationCall<{ readonly title: string }> = {
  caller: "core:sessions",
  purpose: "thread.title",
  instructions: "Name the thread.",
  input: "Fix the login bug",
  output: Schema.Struct({ title: Schema.String }),
};

/** Builds the layer with a connection whose `sendRequest` does what the test says. */
const buildLayer = (sendRequest: () => Effect.Effect<SendOutcome<Answer>>) =>
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

/** Makes one call and returns how it ended, the audit entries it wrote and the last failure. */
const makeCall = (sendRequest: () => Effect.Effect<SendOutcome<Answer>>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* TextGeneration;
      const started = Date.now();
      const exit = yield* Effect.exit(service.generate(CALL));
      const elapsedMs = Date.now() - started;
      const entries = yield* readEventsOfKind("textGeneration.failed");
      const lastFailure = yield* (yield* LastTextGenerationFailure).read(FAILURE_KEY);
      return { exit, elapsedMs, entries, lastFailure };
    }).pipe(Effect.provide(buildLayer(sendRequest)), Effect.orDie),
  );

describe("a request that cannot be sent", () => {
  it("fails with a message that says the call was never sent", async () => {
    const { exit, entries, lastFailure } = await makeCall(() =>
      Effect.succeed({ _tag: "notSent" }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("was not sent");
    expect(JSON.stringify(exit)).not.toContain("connection ended");
    expect(entries).toHaveLength(1);
    expect(lastFailure).toMatchObject({ reason: "unavailable" });
  });
});

describe("a defect in the fiber that holds the runner's slot", () => {
  it("reaches the caller at once, and is recorded as unavailable once", async () => {
    const { exit, elapsedMs, entries, lastFailure } = await makeCall(() =>
      Effect.die(new Error("the frame could not be encoded")),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    // The caller's deadline is 60 seconds. Waiting for it would be the bug.
    expect(elapsedMs).toBeLessThan(2_000);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.payload).toMatchObject({
      reason: "unavailable",
      message: expect.stringContaining("unexpected error") as unknown,
    });
    expect(lastFailure).toMatchObject({ reason: "unavailable" });
  });
});
