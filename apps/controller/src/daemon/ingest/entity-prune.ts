/**
 * The daily prune of External Entities nothing needs.
 *
 * The rule itself is `ExternalEntityService.prune`: which records go. This
 * module only runs it again every day.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { ExternalEntityService } from "../../external-entities";
import { PromotionState } from "../../promotion";
import { absorbFailures } from "../../absorbing";

/**
 * How often the prune runs. A record is kept for 30 days after its last
 * change, so a day is fine-grained enough, and the sweep reads every
 * entity, which is too much work to repeat often.
 */
const ENTITY_PRUNE_INTERVAL: Duration.Duration = Duration.days(1);

/** The prune interval. Tests override it with a shorter one. */
export const EntityPruneInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/EntityPruneInterval",
  { defaultValue: (): Duration.Duration => ENTITY_PRUNE_INTERVAL },
);

/**
 * Deletes the External Entities and observations nothing needs at once, then
 * again after each `EntityPruneInterval`. Never returns. A pass that fails is
 * logged, and the next one runs.
 *
 * A pass runs only while the controller serves, so a frozen or sealed
 * controller deletes nothing.
 */
export const runEntityPruneLoop: Effect.Effect<
  never,
  never,
  ExternalEntityService | PromotionState
> = Effect.gen(function* () {
  const entities = yield* ExternalEntityService;
  const interval = yield* EntityPruneInterval;
  const promotion = yield* PromotionState;
  while (true) {
    yield* absorbFailures(
      "Pruning External Entities failed",
      promotion.whenServing(entities.prune()),
    );
    yield* Effect.sleep(interval);
  }
});
