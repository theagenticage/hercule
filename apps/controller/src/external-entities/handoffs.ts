/**
 * The handoff of an External Entity to a workflow: the execution of
 * `externalEntity.handOff` and `externalEntity.undoHandOff`. It starts a run
 * of the workflow on the thing's Task and ends the open signals the workflow
 * answers, and it takes a handoff back as far as is safe.
 *
 * It is a service of its own, in the shape of `SignalHandoffs`, because it
 * calls the run service and the workflow service, which the entity service
 * does not.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {
  EntityHandOffInput,
  EntityHandOffResult,
  Forbidden,
  HandOffUndo,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "@hercule/contract";
import type { SqlError } from "effect/sql/SqlError";

interface Handoffs {
  /**
   * Hands the entity to a workflow and returns the run it started and the
   * Task that run works on.
   */
  readonly handOff: (
    entityId: string,
    input: EntityHandOffInput,
  ) => Effect.Effect<
    EntityHandOffResult,
    Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SqlError
  >;

  /**
   * Takes back the handoff that started `runId`, as far as is safe, and
   * returns what was taken back.
   */
  readonly undoHandOff: (
    runId: string,
  ) => Effect.Effect<HandOffUndo, Unauthenticated | Forbidden | NotFound | SqlError>;
}

// TODO(#1034): replace both bodies with the real handoff and undo.
const make = Effect.sync((): Handoffs => ({
  handOff: () => Effect.die(new Error("not implemented: #1034")),
  undoHandOff: () => Effect.die(new Error("not implemented: #1034")),
}));

/** The entity handoff service. */
export class ExternalEntityHandoffs extends Context.Service<
  ExternalEntityHandoffs,
  Effect.Success<typeof make>
>()("hercule/controller/external-entities/ExternalEntityHandoffs") {}

export const ExternalEntityHandoffsLayer: Layer.Layer<ExternalEntityHandoffs> =
  Layer.effect(ExternalEntityHandoffs)(make);
