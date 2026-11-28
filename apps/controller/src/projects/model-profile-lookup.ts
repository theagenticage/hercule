import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

/**
 * What the projects domain needs from Model Profiles: to learn whether a
 * profile exists, so a project never names one that does not.
 *
 * Model Profiles depend on projects (deleting a profile clears it from the
 * projects that name it), so this domain cannot import them. It declares what
 * it needs as this service, and the model-profiles domain provides it over
 * the profile table, without using the Model Profile service. It runs in the
 * caller's transaction.
 */
export class ModelProfileLookup extends Context.Service<
  ModelProfileLookup,
  {
    /** Returns whether a Model Profile with this id exists. */
    readonly exists: (modelProfileId: string) => Effect.Effect<boolean, SqlError>;
  }
>()("hercule/controller/projects/ModelProfileLookup") {}
