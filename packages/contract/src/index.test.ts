import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { API_VERSION, Health } from "./index";

const decode = Schema.decodeUnknownEffect(Health);

describe("Health", () => {
  it.effect("decodes a well-formed payload", () =>
    Effect.gen(function* () {
      const health = yield* decode({ status: "ok", apiVersion: API_VERSION });
      assert.deepStrictEqual(health, { status: "ok", apiVersion: API_VERSION });
    }),
  );

  it.effect("rejects an unknown status", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(decode({ status: "down", apiVersion: API_VERSION }));
      assert.strictEqual(result._tag, "Failure");
    }),
  );
});
