/**
 * Tests who may hand a thing off and take a handoff back. Both operations are
 * the user's own act, so a session that holds every grant is refused before
 * anything is read or written. The services the handoff calls are left empty:
 * the test passes only if none of them is reached.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { CurrentActor, type Actor } from "../actor";
import { buildPluginStack } from "../plugins/testing";
import { RunService } from "../runs";
import { SignalClaims, SignalService } from "../signals";
import { TaskService } from "../tasks";
import { ExternalEntityHandoffs, ExternalEntityHandoffsLayer } from "./handoffs";

const A_SESSION = {
  _tag: "session",
  sessionId: "0199e0e7-0002-7000-8000-000000000000",
  grants: ["run.start", "run.write", "run.cancel", "task.update", "task.create"],
} as unknown as Actor;

/** Services the handoff calls only after the actor check. A call would die, so reaching one fails the test. */
const untouchedServices = Layer.mergeAll(
  Layer.succeed(TaskService)({} as never),
  Layer.succeed(RunService)({} as never),
  Layer.succeed(SignalService)({} as never),
  Layer.succeed(SignalClaims)({} as never),
);

const layer = ExternalEntityHandoffsLayer.pipe(
  Layer.provide(untouchedServices),
  Layer.provideMerge(buildPluginStack()),
);

/** Runs a call as the session and returns the error it failed with. */
const failAsSession = (
  call: (handoffs: ExternalEntityHandoffs["Service"]) => Effect.Effect<unknown, unknown>,
): Promise<unknown> =>
  Effect.runPromise(
    Effect.flatMap(ExternalEntityHandoffs, call).pipe(
      Effect.flip,
      Effect.provideService(CurrentActor, A_SESSION),
      Effect.provide(layer),
    ),
  );

describe("a session that holds every grant", () => {
  it.each([
    [
      "hands a thing off",
      (handoffs: ExternalEntityHandoffs["Service"]) =>
        handoffs.handOff("0199e0e7-9999-7000-8000-000000000000", {
          workflowId: "0199e0e7-9999-7000-8000-000000000001",
        }),
    ],
    [
      "takes a handoff back",
      (handoffs: ExternalEntityHandoffs["Service"]) =>
        handoffs.undoHandOff("0199e0e7-9999-7000-8000-000000000002"),
    ],
  ])("is refused when it %s", async (_name, use) => {
    const error = await failAsSession(use);

    expect(error).toMatchObject({ error: { code: "forbidden" } });
  });
});
