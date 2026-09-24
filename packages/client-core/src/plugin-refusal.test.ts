import { describe, expect, it } from "vitest";
import { describeRefusalReason } from "./plugin-refusal";

describe("describeRefusalReason", () => {
  it("names the host API the plugin was built against and the one the controller supports", () => {
    const reason = describeRefusalReason({ kind: "hostApi", expected: 1, actual: 2 });
    expect(reason).toContain("2");
    expect(reason).toContain("1");
  });

  it("names the capability the controller does not implement", () => {
    expect(
      describeRefusalReason({ kind: "unimplementedCapability", capability: "channels" }),
    ).toContain("channels");
  });

  it("includes the schema error message, which is the only detail there is", () => {
    expect(
      describeRefusalReason({
        kind: "unsupportedConfigSchema",
        message: "property `home` is an object",
      }),
    ).toContain("property `home` is an object");
  });
});
