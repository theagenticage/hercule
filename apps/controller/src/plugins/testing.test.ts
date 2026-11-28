/**
 * Tests the folder `buildPluginStack` creates: it exists while the stack is
 * in use and is gone once the stack's scope closes, however the scope ends.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Context, Effect } from "effect";
import * as Layer from "effect/Layer";
import { HerculeHome } from "../config";
import { buildPluginStack } from "./testing";

/** Builds a stack, reads its folder, and runs `use` while the stack is open. */
const withStackFolder = <A, E>(use: (folder: string) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    let folder = "";
    const exit = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(buildPluginStack());
          folder = Context.get(context, HerculeHome).home;
          expect(existsSync(folder)).toBe(true);
          return yield* use(folder);
        }),
      ),
    );
    return { folder, exit };
  });

describe("buildPluginStack", () => {
  it("deletes its folder when the scope closes", async () => {
    const { folder, exit } = await Effect.runPromise(withStackFolder(() => Effect.void));
    expect(exit._tag).toBe("Success");
    expect(existsSync(folder)).toBe(false);
  });

  it("deletes its folder when the code that uses the stack fails", async () => {
    const { folder, exit } = await Effect.runPromise(
      withStackFolder(() => Effect.fail("the test failed")),
    );
    expect(exit._tag).toBe("Failure");
    expect(existsSync(folder)).toBe(false);
  });

  it("gives each build of the same stack its own folder", async () => {
    const stack = buildPluginStack();
    const homes = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = Context.get(yield* Layer.build(stack), HerculeHome).home;
          const second = Context.get(yield* Layer.build(stack), HerculeHome).home;
          return [first, second];
        }),
      ),
    );
    expect(homes[0]).not.toBe(homes[1]);
  });
});
