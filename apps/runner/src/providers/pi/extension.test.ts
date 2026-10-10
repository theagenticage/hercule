/**
 * Tests the extension source that pi actually runs. The extension contains the
 * source of `requiresApproval` instead of calling into the runner, because
 * nothing in the runner exists inside pi. If that source were pasted in wrong,
 * the hook would throw on every tool call, or hold nothing. So these tests
 * take the source back out of the extension, evaluate it, and check that it
 * gives the same results as the original function, without running pi.
 *
 * One thing is not checked here: whether pi's loader resolves the imports at
 * the top of the source. This repository has neither typebox nor pi's own
 * package, so the test drops the imports and passes stand-ins in. Only the
 * live test proves that a real pi loads the file.
 */
import { describe, expect, it } from "vitest";
import type { AccessMode } from "@hercule/protocol";
import {
  ACCESS_MODE_VARIABLE,
  AGENT_FILE_VARIABLE,
  EXTENSION_SOURCE,
  OUTPUT_SCHEMA_VARIABLE,
  SUBAGENT_DIALOG,
  SUBAGENT_TOOL,
  SUBAGENTS_VARIABLE,
  SUBMIT_RESULT_TOOL,
  type SubagentReply,
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

/**
 * pi 0.85.1's built-in tools, `submit_result`, `subagent`, and one tool that
 * is not built in.
 */
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
  SUBAGENT_TOOL,
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
  /**
   * pi calls it with the call id, the arguments, the abort signal, the update
   * callback and the context. `submit_result` reads none of them.
   */
  readonly execute: (...args: ReadonlyArray<unknown>) => unknown;
}

/**
 * A stand-in for typebox's `Type`, with the builders the extension uses.
 * `Type.Unsafe` returns a JSON Schema unchanged, which is why the extension
 * uses it for the output schema. `Type.Object` and `Type.String` build the
 * JSON Schema typebox builds for them. typebox is pi's dependency, not the
 * runner's, so this test drops the extension's import and passes this object
 * in its place.
 */
const TYPE = {
  Unsafe: (schema: unknown) => schema,
  Object: (properties: Record<string, unknown>) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
  }),
  String: (options: Record<string, unknown>) => ({ type: "string", ...options }),
};

/**
 * A stand-in for pi's `createBashToolDefinition`, which builds pi's own bash
 * tool. It returns the options the extension passed, so a test can check them.
 */
const createBashToolDefinition = (cwd: string, options: Record<string, unknown>) => ({
  name: "bash",
  cwd,
  ...options,
});

/** A `pi.on` handler the extension registered: pi calls it with the event and the context. */
type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

/**
 * Loads the extension the way pi loads it, and returns every tool it
 * registered and every event handler, by event name. It evaluates the source
 * and runs the default export against a fake pi that records registrations.
 * The environment is the only input, because the adapter tells the extension
 * about the session through the environment.
 */
const loadExtension = (
  env: Readonly<Record<string, string | undefined>>,
): {
  readonly tools: ReadonlyArray<RegisteredTool>;
  readonly handlers: ReadonlyMap<string, EventHandler>;
} => {
  const body = EXTENSION_SOURCE.split("\n")
    .filter((line) => !line.startsWith("import "))
    .join("\n")
    .replace("export default ", "return ");
  // Evaluating source is the point of this test - pi evaluates the same text.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
  const load = new Function("process", "Type", "createBashToolDefinition", body)(
    { env, cwd: () => "/workspace" },
    TYPE,
    createBashToolDefinition,
  ) as (pi: unknown) => void;
  const tools: Array<RegisteredTool> = [];
  const handlers = new Map<string, EventHandler>();
  load({
    on: (event: string, handler: EventHandler) => {
      handlers.set(event, handler);
    },
    registerTool: (tool: RegisteredTool) => {
      tools.push(tool);
    },
  });
  return { tools, handlers };
};

/** Loads the extension, and returns every tool it registered. */
const loadRegisteredTools = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<RegisteredTool> => loadExtension(env).tools;

/**
 * Returns the tools the extension adds to pi's own. It leaves out the
 * extension's bash, which every agent gets in place of pi's built-in bash.
 */
const listRegisteredTools = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<RegisteredTool> => loadRegisteredTools(env).filter((tool) => tool.name !== "bash");

describe("the bash tool", () => {
  it("replaces pi's own, and opens the agent's file before every command, so whatever the command starts holds it", () => {
    const bash = loadRegisteredTools({}).filter((tool) => tool.name === "bash");

    // The runner finds what an agent's bash calls left running by the
    // processes that hold the file open.
    expect(bash).toEqual([
      {
        name: "bash",
        cwd: "/workspace",
        commandPrefix: `exec 9<"$${AGENT_FILE_VARIABLE}"`,
      },
    ]);
  });
});

describe("the approval hook's dialog", () => {
  /**
   * Runs the `tool_call` handler on one call, under approval-required, with a
   * context whose dialog allows. Returns the message of the dialog it opened.
   */
  const readDialogMessage = async (
    toolName: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown> => {
    const handler = loadExtension({}).handlers.get("tool_call")!;
    const messages: Array<string> = [];
    const ctx = {
      signal: new AbortController().signal,
      ui: {
        confirm: (_title: string, message: string) => {
          messages.push(message);
          return Promise.resolve(true);
        },
      },
    };
    await handler({ type: "tool_call", toolCallId: "call_1", toolName, input }, ctx);
    expect(messages).toHaveLength(1);
    return JSON.parse(messages[0]!);
  };

  it("carries the command of a shell call, as pi validated it", async () => {
    expect(await readDialogMessage("bash", { command: "rm -rf build", timeout: 5 })).toEqual({
      toolCallId: "call_1",
      toolName: "bash",
      command: "rm -rf build",
    });
  });

  it("carries the path of a file change, and leaves the content out", async () => {
    // A write's content can be megabytes, and the message is one RPC frame.
    expect(await readDialogMessage("write", { path: "42", content: "x".repeat(1000) })).toEqual({
      toolCallId: "call_1",
      toolName: "write",
      path: "42",
    });
  });

  it("leaves out a command or path that is not a string", async () => {
    expect(await readDialogMessage("mcp__jira__create", { path: 42, command: ["ls"] })).toEqual({
      toolCallId: "call_1",
      toolName: "mcp__jira__create",
    });
  });
});

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

describe("the subagent tool", () => {
  const SUBAGENTS_ENV = { [SUBAGENTS_VARIABLE]: "1" };

  it("is registered for an agent that may start subagents, asking for a task and a prompt", () => {
    const tools = listRegisteredTools(SUBAGENTS_ENV);

    expect(tools.map((tool) => tool.name)).toEqual([SUBAGENT_TOOL]);
    // The runner reads both fields from the call, so both must be required.
    expect(tools[0]!.parameters).toMatchObject({
      required: ["description", "prompt"],
      properties: { description: { type: "string" }, prompt: { type: "string" } },
    });
  });

  it("is registered under full access too", () => {
    // A full-access agent registers no approval hook, but it delegates the
    // same way as any other agent.
    const tools = listRegisteredTools({ ...SUBAGENTS_ENV, [ACCESS_MODE_VARIABLE]: "full-access" });

    expect(tools.map((tool) => tool.name)).toEqual([SUBAGENT_TOOL]);
  });

  it("is registered beside submit_result for an agent with an output schema", () => {
    const tools = listRegisteredTools({
      ...SUBAGENTS_ENV,
      [OUTPUT_SCHEMA_VARIABLE]: JSON.stringify(OUTPUT_SCHEMA),
    });

    expect(tools.map((tool) => tool.name)).toEqual([SUBMIT_RESULT_TOOL, SUBAGENT_TOOL]);
  });

  it("is not registered at the deepest level, where the variable is left out", () => {
    // An agent there is not offered the tool, and the runner refuses a
    // subagent request from that level anyway.
    expect(listRegisteredTools({})).toEqual([]);
    expect(listRegisteredTools({ [SUBAGENTS_VARIABLE]: "0" })).toEqual([]);
  });

  const CALL_ID = "call_subagent_1";

  /** One `ctx.ui.input` call the tool made: the dialog's title, its placeholder, and its options. */
  interface DialogCall {
    readonly title: string;
    readonly placeholder: string;
    readonly options: unknown;
  }

  /**
   * Runs the tool's execute the way pi does, with a context whose dialog
   * returns `answer`. Returns the result, or the error the tool threw, and
   * every dialog call it made.
   */
  const callSubagentTool = async (
    answer: string | undefined,
  ): Promise<{
    readonly outcome: { readonly result: unknown } | { readonly error: unknown };
    readonly dialogs: ReadonlyArray<DialogCall>;
    readonly signal: AbortSignal;
  }> => {
    const tool = listRegisteredTools(SUBAGENTS_ENV)[0]!;
    const signal = new AbortController().signal;
    const dialogs: Array<DialogCall> = [];
    const ctx = {
      ui: {
        input: (title: string, placeholder: string, options: unknown) => {
          dialogs.push({ title, placeholder, options });
          return Promise.resolve(answer);
        },
      },
    };
    const params = { description: "Count the tests", prompt: "Count the test files in src." };
    try {
      const result = await tool.execute(CALL_ID, params, signal, () => undefined, ctx);
      return { outcome: { result }, dialogs, signal };
    } catch (error) {
      return { outcome: { error }, dialogs, signal };
    }
  };

  it("asks the runner for a subagent through the dialog, with the call's request as JSON", async () => {
    const reply: SubagentReply = { text: "There are 12." };
    const { dialogs, signal } = await callSubagentTool(JSON.stringify(reply));

    expect(dialogs).toHaveLength(1);
    // The runner recognises the dialog by its title, and reads the request
    // from its placeholder.
    expect(dialogs[0]!.title).toBe(SUBAGENT_DIALOG);
    expect(JSON.parse(dialogs[0]!.placeholder)).toEqual({
      toolCallId: CALL_ID,
      description: "Count the tests",
      prompt: "Count the test files in src.",
    });
    // Without the signal, an aborted turn leaves the call waiting forever.
    expect(dialogs[0]!.options).toEqual({ signal });
  });

  it("returns the subagent's final message as the call's result", async () => {
    const reply: SubagentReply = { text: "There are 12." };
    const { outcome } = await callSubagentTool(JSON.stringify(reply));

    expect(outcome).toEqual({
      result: { content: [{ type: "text", text: "There are 12." }], details: {} },
    });
  });

  it("fails the call with the runner's error, so the agent sees what went wrong", async () => {
    const reply: SubagentReply = { error: "The subagent's pi process exited." };
    const { outcome } = await callSubagentTool(JSON.stringify(reply));

    expect("error" in outcome && outcome.error).toBeInstanceOf(Error);
    expect("error" in outcome && (outcome.error as Error).message).toBe(
      "The subagent's pi process exited.",
    );
  });

  it("fails the call when the dialog gets no answer", async () => {
    // pi gives no answer when the turn was aborted or the dialog cancelled.
    const { outcome } = await callSubagentTool(undefined);

    expect("error" in outcome && outcome.error).toBeInstanceOf(Error);
  });
});
