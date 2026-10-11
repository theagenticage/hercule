import { assert, describe, it } from "vitest";
import { parsePluginId } from "./plugin-id";

describe("parsePluginId", () => {
  it("returns the plugin before the slash of a signal kind or an action", () => {
    assert.strictEqual(parsePluginId("github/review-requested"), "github");
    assert.strictEqual(parsePluginId("github/pr.create"), "github");
  });

  it("returns null for a core signal kind and a built-in action", () => {
    assert.isNull(parsePluginId("proposal"));
    assert.isNull(parsePluginId("task.create"));
  });
});
