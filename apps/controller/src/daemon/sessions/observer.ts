/**
 * The sessions domain's `SessionObserver`, as boot provides it to the session
 * service: every domain that watches sessions, told in turn.
 *
 * - The assistants domain writes an assistant's replies and notices into its
 *   conversation.
 * - The runs domain fails an agent step whose prompt no runner saw.
 *
 * The sessions domain cannot import either domain, and the runs domain
 * already imports the sessions domain, so the observers are joined here.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeAssistantSessionObserver } from "../../assistants";
import type { ConversationMessages } from "../../conversations";
import { makeRunSessionObserver, RunService } from "../../runs";
import { combineSessionObservers, SessionObserver } from "../../sessions";

/**
 * The run service, for the runs domain's session observer, set once the run
 * service is built.
 *
 * The observer needs the run service, but the run service cannot be built
 * before the observer: the run service opens step sessions through placement
 * and `Live`, which use the session service, and the session service is
 * built with this observer. So boot builds the observer with this empty
 * reference, and `RunServiceReferenceFill` sets it once the run service is
 * built. Boot builds every layer before it serves any request or hears from
 * any runner, so no session changes before the reference is set.
 */
export class RunServiceReference extends Context.Service<
  RunServiceReference,
  {
    /** Sets the reference. Called once, by `RunServiceReferenceFill`. */
    readonly set: (runs: RunService["Service"]) => void;
    /** Returns the run service. Dies when it is not set yet, which is a bug in boot. */
    readonly get: Effect.Effect<RunService["Service"]>;
  }
>()("hercule/controller/daemon/RunServiceReference") {}

export const RunServiceReferenceLayer: Layer.Layer<RunServiceReference> = Layer.sync(
  RunServiceReference,
)(() => {
  let runs: RunService["Service"] | undefined;
  return {
    set: (built) => {
      runs = built;
    },
    get: Effect.suspend(() =>
      runs === undefined
        ? Effect.die(
            "The runs domain's session observer was called before the run service was built. Boot must build the run service, and RunServiceReferenceFill with it, before any session can change.",
          )
        : Effect.succeed(runs),
    ),
  };
});

/** Sets `RunServiceReference` to the run service, once both are built. */
export const RunServiceReferenceFill: Layer.Layer<never, never, RunServiceReference | RunService> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const reference = yield* RunServiceReference;
      reference.set(yield* RunService);
    }),
  );

export const SessionObserverLayer: Layer.Layer<
  SessionObserver,
  never,
  SqlClient.SqlClient | ConversationMessages | RunServiceReference
> = Layer.effect(SessionObserver)(
  Effect.gen(function* () {
    const reference = yield* RunServiceReference;
    return combineSessionObservers([
      yield* makeAssistantSessionObserver,
      makeRunSessionObserver({
        failStepWithDroppedPrompt: (session, droppedIterations, message) =>
          Effect.flatMap(reference.get, (runs) =>
            runs.failStepWithDroppedPrompt(session, droppedIterations, message),
          ),
      }),
    ]);
  }),
);
