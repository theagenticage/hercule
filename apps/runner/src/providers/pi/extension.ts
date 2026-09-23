/**
 * The source of the extension pi loads for a Hercule session. The adapter
 * writes it into the instance's home at every session start. It is a string
 * constant, not a file read from disk, because the runner ships as a compiled
 * binary with no source tree beside it. Writing it at every start keeps the
 * file in step with the runner build that starts pi.
 *
 * The extension imports nothing from the runner. pi loads a `-e` file itself,
 * so anything the file imported would have to exist on the machine the session
 * runs on. The one exception is pi's own typebox, which pi's loader resolves
 * for the file. The extension does not have its own copy of the approval rules
 * either: the source of `requiresApproval` is pasted in, so the function that
 * runs inside pi is the same function the adapter uses and the tests cover.
 */
import { requiresApproval } from "./policy";

/** The file name the adapter writes the extension to, and passes to pi with `-e`. */
export const EXTENSION_FILE = "hercule-extension.ts";

/**
 * The environment variable that tells the approval hook the session's access
 * mode. The adapter sets it and the extension source below reads it, both
 * through this one constant. If the two spellings drifted apart, the hook would
 * fall back to asking about everything.
 */
export const ACCESS_MODE_VARIABLE = "HERCULE_ACCESS_MODE";

/**
 * The environment variable that carries the session's output schema, as JSON,
 * to the `submit_result` tool below. Like the access mode variable, both sides
 * use this one constant. If the two spellings drifted apart, the session would
 * be asked for an answer and have no tool to give it with.
 */
export const OUTPUT_SCHEMA_VARIABLE = "HERCULE_OUTPUT_SCHEMA";

/**
 * The name of the tool a session with an output schema calls to give its
 * answer. The adapter reads the turn's answer from the call to this tool, so
 * the name is defined here and nowhere else.
 */
export const SUBMIT_RESULT_TOOL = "submit_result";

export const EXTENSION_SOURCE = `import { Type } from "@sinclair/typebox";

/**
 * Hercule's tool approval hook. Written by the Hercule runner at session start; edits here
 * are overwritten the next time a session starts.
 */
const requiresApproval = ${requiresApproval.toString()};

const MODE = process.env.${ACCESS_MODE_VARIABLE} ?? "approval-required";

const DENIED = "The user did not approve this in Hercule.";

const LOST = "Hercule could not ask the user for approval because its connection to pi was closed.";

export default function (pi) {
  // A session with an output schema gives its answer by calling a tool, not in
  // prose. The schema constrains what the model can send, and the runner reads
  // the answer from the call. The tool is registered before the mode check,
  // because a full-access session gives its answer the same way.
  if (process.env.${OUTPUT_SCHEMA_VARIABLE}) {
    pi.registerTool({
      name: "${SUBMIT_RESULT_TOOL}",
      label: "Submit result",
      description:
        "Record your answer to the task. Call this exactly once, with the answer as its arguments, and say nothing after it: the call ends your work on this task.",
      // The schema is passed through unchanged, because the runner validates
      // the answer against the schema it sent. A schema changed here could
      // accept answers the runner then rejects.
      parameters: Type.Unsafe(JSON.parse(process.env.${OUTPUT_SCHEMA_VARIABLE})),
      // Preferred, not required: a model whose provider cannot constrain its
      // output can still answer, and the runner still validates the answer.
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      execute: async () => ({
        content: [{ type: "text", text: "Recorded." }],
        // pi uses a tool result's details for its own logs and display. This
        // tool has nothing to add beyond recording the answer.
        details: {},
        // Without this, the agent keeps working after it answers, and the
        // turn's result has to wait until the agent stops on its own.
        terminate: true,
      }),
    });
  }
  // Full access asks about nothing, so no handler is registered and no tool
  // call can wait for an answer that will never come.
  if (MODE === "full-access") return;
  pi.on("tool_call", async (event, ctx) => {
    if (!requiresApproval(MODE, event.toolName)) return undefined;
    try {
      // The message is the call's id and tool name as JSON, not prose. Hercule
      // builds the approval card from the tool call itself, and uses this id to
      // find that call.
      const heldCall = JSON.stringify({ toolCallId: event.toolCallId, toolName: event.toolName });
      const allowed = await ctx.ui.confirm(\`Approve \${event.toolName}?\`, heldCall, {
        // Without the signal, an aborted turn leaves this dialog waiting
        // forever, and the session stuck with it.
        signal: ctx.signal,
      });
      return allowed ? undefined : { block: true, reason: DENIED };
    } catch {
      // pi returns false for an abort or a timeout, so an error here means the
      // connection to Hercule failed. Block the call: running it would run a
      // tool nobody approved.
      return { block: true, reason: LOST };
    }
  });
}
`;
