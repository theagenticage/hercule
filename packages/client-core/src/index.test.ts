import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { parseHealth } from "./index";

describe("parseHealth", () => {
  it.effect("returns a plain object", () =>
    Effect.gen(function* () {
      const health = yield* Effect.promise(() => parseHealth({ status: "ok", apiVersion: 1 }));
      assert.deepStrictEqual(health, { status: "ok", apiVersion: 1 });
    }),
  );

  it.effect("rejects a malformed payload", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(Effect.tryPromise(() => parseHealth({ status: "ok" })));
      assert.strictEqual(result._tag, "Failure");
    }),
  );
});
