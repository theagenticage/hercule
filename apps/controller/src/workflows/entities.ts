import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { SqlError } from "effect/sql/SqlError";

/**
 * What the workflows domain needs to know about an External Entity: its
 * qualified kind, because a run's entity input accepts only the External Ref
 * of an entity of the kinds it lists.
 *
 * The external entities domain depends on the workflows domain, because it
 * offers each workflow with an entity input as Hand to an agent. So the
 * workflows domain cannot import it back, and declares what it needs as this
 * port instead, like `WorkflowSignals`. The controller daemon provides it
 * (`WorkflowEntitiesLayer`).
 */
export class WorkflowEntities extends Context.Service<
  WorkflowEntities,
  {
    /**
     * Returns the qualified kind, such as `github/pull-request`, of the
     * External Entity with this External Ref, or none when no entity has it.
     */
    readonly readKind: (ref: string) => Effect.Effect<Option.Option<string>, SqlError>;
  }
>()("hercule/controller/workflows/WorkflowEntities") {}
