import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { Hello, PROTOCOL_VERSION } from "./index";

describe("Hello", () => {
  it("decodes a well-formed frame", () => {
    const decode = Schema.decodeUnknownSync(Hello);
    expect(decode({ protocolVersion: PROTOCOL_VERSION, runnerId: "r_1" })).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      runnerId: "r_1",
    });
  });

  it("rejects a frame without a runner id", () => {
    const decode = Schema.decodeUnknownSync(Hello);
    expect(() => decode({ protocolVersion: PROTOCOL_VERSION })).toThrow();
  });
});
