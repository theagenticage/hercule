import { describe, expect, it } from "vitest";
import { refusalReason } from "./plugin-refusal";

describe("refusalReason", () => {
  it("says which host API the plugin wanted and which one it found", () => {
    const reason = refusalReason({ kind: "hostApi", expected: 1, actual: 2 });
    expect(reason).toContain("2");
    expect(reason).toContain("1");
  });

  it("names the capability the controller does not implement", () => {
    expect(refusalReason({ kind: "unimplementedCapability", capability: "channels" })).toContain(
      "channels",
    );
  });

  it("carries the schema complaint through, which is the only detail there is", () => {
    expect(
      refusalReason({ kind: "unsupportedConfigSchema", message: "property `home` is an object" }),
    ).toContain("property `home` is an object");
  });
});
