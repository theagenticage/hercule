/**
 * The approval hook pi actually runs. The extension carries `requiresApproval`
 * as interpolated source rather than a call into the runner - nothing it reaches
 * for exists on the machine pi runs on - and source that was interpolated wrong
 * is a hook that throws on every tool call, or one that holds nothing. So the source is
 * lifted back out of the extension, evaluated on its own, and asked the same
 * questions as the function it was written from: the two agreeing is the whole
 * property, and it is checked without pi.
 */
import { describe, expect, it } from "vitest";
import type { AccessMode } from "@hydra/protocol";
import { ACCESS_MODE_VARIABLE, EXTENSION_SOURCE } from "./extension";
import { requiresApproval } from "./policy";

/** Every mode a session can reach a runner under, plus one from no build. */
const MODES: ReadonlyArray<string> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
  "a mode from a newer controller",
];

/** pi 0.85.1's built-ins, plus a name from no built-in at all. */
const TOOLS: ReadonlyArray<string> = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "powershell",
  "write",
  "edit",
  "mcp__jira__create",
];

/**
 * The approval hook's own copy of the function, off the source the extension
 * carries. `new Function` rather than an import: what pi loads is text, and text
 * is what has to be shown to work.
 */
const buildRequiresApprovalFromSource = (): ((mode: string, toolName: string) => boolean) => {
  const source = EXTENSION_SOURCE.split("const requiresApproval = ")[1]?.split(
    ";\n\nconst MODE",
  )[0];
  expect(source).toBeDefined();
  // Evaluating source is the point of this test - pi evaluates the same text -
  // and the text comes from this build's own constant, not from anywhere else.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
  return new Function(`return (${source!});`)() as (mode: string, toolName: string) => boolean;
};

describe("the deciding function the extension carries", () => {
  const fromSource = buildRequiresApprovalFromSource();

  for (const mode of MODES) {
    for (const tool of TOOLS) {
      it(`decides ${tool} under ${mode} the way the adapter does`, () => {
        expect(fromSource(mode, tool)).toBe(requiresApproval(mode as AccessMode, tool));
      });
    }
  }
});

describe("what the extension reads its mode out of", () => {
  it("reads the variable the adapter sets, spelled once", () => {
    expect(EXTENSION_SOURCE).toContain(`process.env.${ACCESS_MODE_VARIABLE}`);
  });
});
