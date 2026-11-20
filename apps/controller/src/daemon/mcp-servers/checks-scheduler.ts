/**
 * The loop that asks for the checks MCP Servers are due: the daily list of
 * every enabled server, the retries of a server that could not be reached,
 * and the first check of a server that has none planned (spec 21 sections 5.3
 * and 5.4).
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { absorbFailures } from "../../absorbing";
import { McpServerChecks } from "../../mcp-servers";
import { PromotionState } from "../../promotion";

/** The time between looks at which checks are due. Tests override it with a shorter one. */
export const McpServerCheckInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/McpServerCheckInterval",
  { defaultValue: (): Duration.Duration => Duration.minutes(1) },
);

/**
 * Runs the scheduler: one look at once, then one every `McpServerCheckInterval`
 * after the previous look ended. Never returns. A look only requests checks,
 * which run on their own fibers, so a slow server delays nothing. It waits
 * while the controller is frozen or sealed.
 */
export const runMcpServerChecksScheduler: Effect.Effect<
  never,
  never,
  McpServerChecks | PromotionState
> = Effect.gen(function* () {
  const checks = yield* McpServerChecks;
  const promotion = yield* PromotionState;
  const interval = yield* McpServerCheckInterval;
  while (true) {
    yield* absorbFailures(
      "Requesting the MCP server checks that are due failed",
      promotion.whenServing(checks.requestDue),
    );
    yield* Effect.sleep(interval);
  }
});
