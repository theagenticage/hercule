/**
 * Tests the folder `buildPluginStack` creates: it exists, with the master key
 * inside, while the stack is in use, and it is gone once the stack's scope
 * closes, however the code that used the stack ended.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Context, Effect, Exit } from "effect";
import * as Layer from "effect/Layer";
import { HerculeHome } from "../config";
import { buildPluginStack } from "./testing";

/**
 * Builds the stack, checks that its folder holds the master key, and runs
 * `use`. Returns the folder and how `use` ended. Fails the test if the stack
 * itself cannot be built.
 */
const runWithStack = (
  stack: ReturnType<typeof buildPluginStack>,
  use: Effect.Effect<void, string>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      let folder: string | undefined;
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            folder = Context.get(yield* Layer.build(stack), HerculeHome).home;
            expect(existsSync(join(folder, "master.key"))).toBe(true);
            yield* use;
          }),
        ),
      );
      return { folder, exit };
    }),
  );

describe("buildPluginStack", () => {
  it("deletes the folder of each build when its scope closes, however the use of the stack ended", async () => {
    // One stack value, built in two independent runs: a stack that kept one
    // folder for every build would fail the second run, or leave it behind.
    const stack = buildPluginStack();

    const finished = await runWithStack(stack, Effect.void);
    const failed = await runWithStack(stack, Effect.fail("the test failed"));

    expect(Exit.isSuccess(finished.exit)).toBe(true);
    expect(Exit.isFailure(failed.exit) && String(failed.exit.cause)).toContain("the test failed");
    expect(finished.folder).not.toBe(failed.folder);
    for (const { folder } of [finished, failed]) {
      expect(folder).toBeDefined();
      expect(existsSync(folder!)).toBe(false);
    }
  });
});
