/**
 * The approval hook pi actually runs. The extension carries `requiresApproval`
 * as interpolated source rather than a call into the runner - nothing it reaches
 * for exists on the machine pi runs on - and source that was interpolated wrong
 * is a hook that throws on every tool call, or one that holds nothing. So the source is
 * lifted back out of the extension, evaluated on its own, and asked the same
 * questions as the function it was written from: the two agreeing is the whole
 * property, and it is checked without pi.
 *
 * One thing is not checked here: whether pi's own loader resolves the typebox
 * import the source opens with. This repository does not have that package, so
 * the test drops the import and hands `Type` in. Only the live test proves that
 * a real pi loads the file.
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
  SUBMIT_RESULT_TOOL,
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

/** The schema a session under an Agent answers under (spec 06 section 7). */
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence"],
  properties: {
    verdict: { type: "string", enum: ["accept", "dismiss"] },
    confidence: { type: "number" },
  },
};

/** One tool the extension registered, as far as pi reads a definition. */
interface RegisteredTool {
  readonly name: string;
  readonly parameters: unknown;
  readonly execute: (args: unknown, ctx: unknown) => unknown;
}

/**
 * `Type.Unsafe` does nothing to a JSON Schema, which is why the extension
 * calls it. typebox is pi's own dependency and not the runner's, so this test
 * drops the extension's import and passes in what the import named.
 */
const TYPE = { Unsafe: (schema: unknown) => schema };

/**
 * Loads the extension the way pi loads it. The test evaluates the source and
 * runs its default export against a pi that records what was registered. The
 * environment is the whole input, because the adapter tells the extension
 * about the session through the environment.
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

describe("the tool a session under an output schema answers through", () => {
  const SCHEMA_ENV = { [OUTPUT_SCHEMA_VARIABLE]: JSON.stringify(OUTPUT_SCHEMA) };

  it("registers it under the schema the adapter handed the session", () => {
    const tools = listRegisteredTools(SCHEMA_ENV);

    expect(tools.map((tool) => tool.name)).toEqual([SUBMIT_RESULT_TOOL]);
    // The schema passes through unchanged. If the extension rewrote it, the
    // runner would validate the answer against a different document.
    expect(tools[0]!.parameters).toMatchObject(OUTPUT_SCHEMA);
  });

  it("ends the agent's run on the call that answered", async () => {
    const tools = listRegisteredTools(SCHEMA_ENV);

    // Without this the agent carries on after it answers, and the turn's
    // result waits for a settle that has nothing left to say.
    expect(await tools[0]!.execute({ verdict: "accept", confidence: 0.9 }, {})).toMatchObject({
      terminate: true,
    });
  });

  it("registers no tool for a session that was given no schema", () => {
    // A Thread answers prose. A `submit_result` on every session would be a
    // tool the model can call, and nothing would validate the call.
    expect(listRegisteredTools({})).toEqual([]);
  });
});
