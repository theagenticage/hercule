import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Hello, PROTOCOL_VERSION } from "./index";

const decode = Schema.decodeUnknownEffect(Hello);

describe("Hello", () => {
  it.effect("decodes a well-formed frame", () =>
    Effect.gen(function* () {
      const hello = yield* decode({ protocolVersion: PROTOCOL_VERSION, runnerId: "r_1" });
      assert.deepStrictEqual(hello, { protocolVersion: PROTOCOL_VERSION, runnerId: "r_1" });
    }),
  );

  it.effect("rejects a frame without a runner id", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(decode({ protocolVersion: PROTOCOL_VERSION }));
      assert.strictEqual(result._tag, "Failure");
    }),
  );
});
