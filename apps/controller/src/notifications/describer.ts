/**
 * The port through which the notifications domain gets the describe line of
 * an answer: what taking the answer does, with the current names of what it
 * acts on, such as "Start a run of Bugfix".
 *
 * Writing the line reads the tasks, workflows and sessions an operation names.
 * Those domains depend on the notifications domain, so reading them from here
 * would make the domain graph a cycle. Instead, the notifications domain
 * declares what it needs as this service, and the controller daemon
 * implements it by reading their rows. ADR 0033 owns the rules for breaking a
 * cycle between domains.
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
