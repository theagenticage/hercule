import { describe, expect, it } from "vitest";
import { splitGatewayToolName } from "./gateway-tool-name";

// The cases of a normal name and of a tool name holding `__` are covered
// through the Claude Code and Codex item tests. These are the names the
// gateway never builds.
describe("splitGatewayToolName", () => {
  it.each(["__search_issues", "sentry__"])(
    "returns undefined for %j, which has an empty server part or tool part",
    (name) => {
      expect(splitGatewayToolName(name)).toBeUndefined();
    },
  );
});
