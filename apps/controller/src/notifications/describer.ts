/**
 * The port through which the notifications domain gets the describe line of
 * an answer: what taking the answer does, with the current names of what it
 * acts on, such as "Start a run of Bugfix".
 *
 * Writing the line reads the tasks, workflows and sessions an operation names,
 * and those domains depend on this one, so this domain cannot read them
 * itself without making the domain graph a cycle. So the domain declares what
 * it needs as this service, and the controller daemon provides it from their
 * rows. This is the second step of the cycle ladder in ADR 0033: invert the
 * control.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { BindableOperation, DescribeLine } from "@hercule/contract";

export class BoundOperationDescriber extends Context.Service<
  BoundOperationDescriber,
  {
    /**
     * Returns the describe lines of the operations of one notification's
     * answers, in the same order, with the current names of the entities
     * their inputs name. An entity that no longer exists is named by its id.
     * The answers of one decision usually name the same task or session, so
     * each entity is read once for the whole list. Reads only; it never
     * fails for a missing entity.
     */
    readonly describe: (
      operations: ReadonlyArray<BindableOperation>,
    ) => Effect.Effect<ReadonlyArray<DescribeLine>, SqlError>;
  }
>()("hercule/controller/notifications/BoundOperationDescriber") {}
