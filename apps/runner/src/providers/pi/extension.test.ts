/**
 * Tests the extension source that pi actually runs. The extension contains the
 * source of `requiresApproval` instead of calling into the runner, because
 * nothing in the runner exists inside pi. If that source were pasted in wrong,
 * the hook would throw on every tool call, or hold nothing. So these tests
 * take the source back out of the extension, evaluate it, and check that it
 * gives the same results as the original function, without running pi.
 *
 * One thing is not checked here: whether pi's loader resolves the typebox
 * import at the top of the source. This repository does not have that package,
 * so the test drops the import and passes `Type` in. Only the live test proves
 * that a real pi loads the file.
 */
import { describe, expect, it } from "vitest";
import type { AccessMode } from "@hercule/protocol";
import {
  ACCESS_MODE_VARIABLE,
  EXTENSION_SOURCE,
  OUTPUT_SCHEMA_VARIABLE,
  SUBMIT_RESULT_TOOL,
} from "./extension";
import { requiresApproval } from "./policy";

/** Every mode a session can reach a runner with, plus one no build knows. */
const MODES: ReadonlyArray<string> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
  "a mode from a newer controller",
];

/** pi 0.85.1's built-in tools, `submit_result`, and one tool that is not built in. */
const TOOLS: ReadonlyArray<string> = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "powershell",
  "write",
  "edit",
  SUBMIT_RESULT_TOOL,
  "mcp__jira__create",
];

/**
 * Evaluates the `requiresApproval` source found in the extension, and returns
 * the resulting function. It uses `new Function` instead of an import, because
 * pi loads the extension as text, and it is the text that must work.
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

describe("the requiresApproval copy inside the extension", () => {
  const fromSource = buildRequiresApprovalFromSource();

  for (const mode of MODES) {
    for (const tool of TOOLS) {
      it(`gives the same result as the adapter for ${tool} under ${mode}`, () => {
        expect(fromSource(mode, tool)).toBe(requiresApproval(mode as AccessMode, tool));
      });
    }
  }
});

describe("where the extension reads the access mode from", () => {
  it("reads the environment variable the adapter sets", () => {
    expect(EXTENSION_SOURCE).toContain(`process.env.${ACCESS_MODE_VARIABLE}`);
  });
});

/** An output schema like the one an Agent gives a session (spec 06 section 7). */
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence"],
  properties: {
    verdict: { type: "string", enum: ["accept", "dismiss"] },
    confidence: { type: "number" },
  },
};

/** The fields of a registered tool that pi reads. */
interface RegisteredTool {
  readonly name: string;
  readonly parameters: unknown;
  readonly execute: (args: unknown, ctx: unknown) => unknown;
}

/**
 * A stand-in for typebox's `Type`. `Type.Unsafe` returns a JSON Schema
 * unchanged, which is why the extension uses it. typebox is pi's dependency,
 * not the runner's, so this test drops the extension's import and passes this
 * object in its place.
 */
const TYPE = { Unsafe: (schema: unknown) => schema };

/**
 * Loads the extension the way pi loads it, and returns the tools it
 * registered. It evaluates the source and runs the default export against a
 * fake pi that records registrations. The environment is the only input,
 * because the adapter tells the extension about the session through the
 * environment.
 */
const listRegisteredTools = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<RegisteredTool> => {
  const body = EXTENSION_SOURCE.split("\n")
    .filter((line) => !line.startsWith("import "))
    .join("\n")
    .replace("export default ", "return ");
  // Evaluating source is the point of this test - pi evaluates the same text.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
  const load = new Function("process", "Type", body)({ env }, TYPE) as (pi: unknown) => void;
  const tools: Array<RegisteredTool> = [];
  load({
    on: () => undefined,
    registerTool: (tool: RegisteredTool) => {
      tools.push(tool);
    },
  });
  return tools;
};

describe("the submit_result tool of a session with an output schema", () => {
  const SCHEMA_ENV = { [OUTPUT_SCHEMA_VARIABLE]: JSON.stringify(OUTPUT_SCHEMA) };

  it("is registered with the schema the adapter passed to the session", () => {
    const tools = listRegisteredTools(SCHEMA_ENV);

    expect(tools.map((tool) => tool.name)).toEqual([SUBMIT_RESULT_TOOL]);
    // The schema passes through unchanged. If the extension rewrote it, the
    // runner would validate the answer against a different document.
    expect(tools[0]!.parameters).toMatchObject(OUTPUT_SCHEMA);
  });

  it("ends the agent's run when it is called", async () => {
    const tools = listRegisteredTools(SCHEMA_ENV);

    // Without this, the agent keeps working after it answers, and the turn's
    // result has to wait until the agent stops on its own.
    expect(await tools[0]!.execute({ verdict: "accept", confidence: 0.9 }, {})).toMatchObject({
      terminate: true,
    });
  });

  it("is not registered for a session without a schema", () => {
    // A Thread answers in prose. A `submit_result` tool on every session
    // would be a tool the model can call with nothing to validate the call.
    expect(listRegisteredTools({})).toEqual([]);
  });
});
