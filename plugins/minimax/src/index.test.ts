/**
 * Tests the one fact about the minimax plugin that the shipped catalog cannot
 * show: which parser function is registered for which account kind. The rest
 * of the definition is pinned by `apps/controller/src/plugins/registry.test.ts`.
 */
import { expect, it } from "vitest";
import { Effect } from "effect";
import { minimax } from "./index";
import { parsePlanUsageBody } from "./usage";

it("registers the usage parser for the plan key kind only", () => {
  const registered: Array<unknown> = [];
  Effect.runSync(
    Effect.orDie(
      minimax.register({
        providers: {
          register: (_definition, options) =>
            Effect.sync(() => {
              registered.push(options?.parseUsageBody);
            }),
        },
      }),
    ),
  );

  expect(registered).toEqual([{ "plan-key": parsePlanUsageBody }]);
});
