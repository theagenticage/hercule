/**
 * The driver of the MCP Server checks: it starts the loop that runs the checks
 * MCP Servers are due, which are the daily list of every enabled server, the
 * retries of a server that could not be reached, and the first check of a
 * server that has none planned (spec 21 sections 5.3 and 5.4).
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { McpServerChecks } from "../../mcp-servers";

/**
 * The longest the loop waits between two looks for due checks, when nothing
 * wakes it. Tests override it with a shorter one.
 */
export const McpServerCheckInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/McpServerCheckInterval",
  { defaultValue: (): Duration.Duration => Duration.minutes(1) },
);

/**
 * Runs the checks loop with `McpServerCheckInterval` as its backstop. Never
 * returns. It waits while the controller is frozen or sealed, and a slow
 * server delays no other server.
 */
export const runMcpServerChecksScheduler: Effect.Effect<never, never, McpServerChecks> = Effect.gen(
  function* () {
    const checks = yield* McpServerChecks;
    return yield* checks.run(yield* McpServerCheckInterval);
  },
);
