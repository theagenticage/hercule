/**
 * Tests the one fact about the opencode plugin that the shipped catalog cannot
 * show: which parser function is registered for which account kind. The rest
 * of the definition is pinned by `apps/controller/src/plugins/registry.test.ts`.
 */
import { expect, it } from "vitest";
import { Effect } from "effect";
import { opencode } from "./index";
import { parseGoUsageBody } from "./usage";

it("registers the usage parser for the Go key kind only", () => {
  const registered: Array<unknown> = [];
  Effect.runSync(
    Effect.orDie(
      opencode.register({
        providers: {
          register: (_definition, options) =>
            Effect.sync(() => {
              registered.push(options?.parseUsageBody);
            }),
        },
      }),
    ),
  );

  expect(registered).toEqual([{ "go-key": parseGoUsageBody }]);
});
