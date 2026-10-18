/**
 * The periodic update check of the Skill Library (spec 11 §2 `skill.check`):
 * at controller start and then every 3 hours, every Skill with a GitHub
 * source whose last check is older than that is checked.
 *
 * The rule itself is `SkillService.checkSkillsNotCheckedSince`: which Skills,
 * and what a check stores. This module only repeats it.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { PromotionState } from "../../promotion";
import { SkillService } from "../../skills";
import { absorbFailures } from "../absorbing";

/** How often the update check runs, and how old a Skill's last check must be for it to run again. */
const SKILL_UPDATE_CHECK_INTERVAL: Duration.Duration = Duration.hours(3);

/** The update check interval. Tests override it with a shorter one. */
export const SkillUpdateCheckInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/SkillUpdateCheckInterval",
  { defaultValue: (): Duration.Duration => SKILL_UPDATE_CHECK_INTERVAL },
);

/**
 * Checks the Skills not checked within the last interval at once, then again
 * after each interval. Never returns. A pass that fails is logged, and the
 * next one runs.
 *
 * Each pass waits for the next interval only once it has ended, so a Skill
 * the last pass checked is due again at the next one. A Skill checked on
 * request in between waits for a later pass.
 *
 * A pass starts only while the controller serves, and never once it is
 * sealed. The pass itself is not counted as running work, because a freeze
 * must not wait for a slow GitHub download. A result written while frozen
 * only records a check, which the next check repeats.
 */
export const runSkillUpdateCheckLoop: Effect.Effect<never, never, SkillService | PromotionState> =
  Effect.gen(function* () {
    const skills = yield* SkillService;
    const interval = yield* SkillUpdateCheckInterval;
    const promotion = yield* PromotionState;
    while (true) {
      yield* promotion.whenServing(Effect.void);
      yield* absorbFailures(
        "The update check of the Skill Library failed",
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          skills.checkSkillsNotCheckedSince(
            new Date(now - Duration.toMillis(interval)).toISOString(),
          ),
        ),
      );
      yield* Effect.sleep(interval);
    }
  });
