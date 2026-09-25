/**
 * Test helpers for the expressions domain.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { ExpressionBudget } from "./index";

/**
 * Returns the effect with no wall-clock budget on the evaluations it runs, so
 * none of them can fail for running too long.
 *
 * A test about what an expression answers needs this. The shipped budget is
 * measured in wall-clock time, and a busy machine can pause the test between
 * the two clock reads for longer than the budget, which fails the evaluation
 * for a reason the test is not about. The tests of the budget itself set their
 * own budget instead.
 */
export const provideUnlimitedBudget = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.provideService(effect, ExpressionBudget, Duration.infinity);
