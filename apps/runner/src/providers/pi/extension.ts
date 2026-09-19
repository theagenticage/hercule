/**
 * The extension pi loads for a Hydra session, as the source the adapter writes
 * into the instance's own home at every session start. It is a string constant
 * rather than a file read off disk because the runner ships as a compiled
 * binary with no source tree beside it, and writing it per start keeps the file
 * in step with the build that spawned pi.
 *
 * It reaches for nothing of the runner's: a `-e` file is loaded by pi's own
 * loader, and anything it imported would have to exist on the machine the
 * session runs on - pi's own typebox, which the loader resolves for it, being
 * the exception. Which calls it holds it does not work out for itself either:
 * `requiresApproval` is interpolated here as its own source, so what runs
 * inside pi is the function the adapter reads and the tests cover, not a second
 * reading of it.
 */
import { requiresApproval } from "./policy";

/** Where the adapter writes it, and what pi is pointed at with `-e`. */
export const EXTENSION_FILE = "hydra-extension.ts";

/**
 * How the approval hook learns which mode the session runs under. Spelled once
 * and read from both ends: the adapter puts it in pi's environment, the source
 * below reads it out, and a name that drifted apart would be an approval hook
 * that fell back to asking about everything.
 */
export const ACCESS_MODE_VARIABLE = "HYDRA_ACCESS_MODE";

/**
 * How the tool below learns what this session's turns must answer with, as the
 * schema in JSON. Spelled once and read from both ends, like the mode above: a
 * name that drifted apart would be a session that was asked for a value and
 * given no way to give one.
 */
export const OUTPUT_SCHEMA_VARIABLE = "HYDRA_OUTPUT_SCHEMA";

/**
 * The tool a session under an output schema answers through. The adapter reads
 * the turn's answer off the call to it, so the name is spelled here alone.
 */
export const SUBMIT_RESULT_TOOL = "submit_result";

export const EXTENSION_SOURCE = `import { Type } from "@sinclair/typebox";

/**
 * Hydra's tool approval hook. Written by the Hydra runner at session start; edits here
 * are overwritten the next time a session starts.
 */
const requiresApproval = ${requiresApproval.toString()};

const MODE = process.env.${ACCESS_MODE_VARIABLE} ?? "approval-required";

const DENIED = "The user did not approve this in Hydra.";

const LOST = "Hydra could not ask the user about this: the channel it asks over closed.";

export default function (pi) {
  // A session that was asked for a value answers it through a tool rather than
  // in prose: the schema constrains what the model may say, and the call is
  // where Hydra reads the answer off. Registered before the mode is looked at,
  // because a session on full access is asked for a value just the same.
  if (process.env.${OUTPUT_SCHEMA_VARIABLE}) {
    pi.registerTool({
      name: "${SUBMIT_RESULT_TOOL}",
      label: "Submit result",
      description:
        "Record your answer to the task. Call this exactly once, with the answer as its arguments, and say nothing after it: the call ends your work on this task.",
      // Through unchanged: the runner validates the answer against the very
      // document it handed over, and a schema rewritten here would be a second
      // one.
      parameters: Type.Unsafe(JSON.parse(process.env.${OUTPUT_SCHEMA_VARIABLE})),
      // Preferred rather than required, so a model whose provider cannot
      // constrain its sampling still answers, and the runner still judges it.
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      execute: async () => ({
        content: [{ type: "text", text: "Recorded." }],
        // pi's tool result carries details for its own logs and rendering;
        // this tool has nothing to say beyond having recorded the answer.
        details: {},
        // Without it the agent carries on after answering, and the turn's
        // result waits on a settle that has nothing left to say.
        terminate: true,
      }),
    });
  }
  // Full access is exactly that: with no handler registered nothing is asked,
  // and no tool call ever waits on an answer that was never going to come.
  if (MODE === "full-access") return;
  pi.on("tool_call", async (event, ctx) => {
    if (!requiresApproval(MODE, event.toolName)) return undefined;
    try {
      // The message is the call's own name and id rather than prose: Hydra
      // renders the card from the call itself, and this is how it knows which
      // call this question is about.
      const heldCall = JSON.stringify({ toolCallId: event.toolCallId, toolName: event.toolName });
      const allowed = await ctx.ui.confirm(\`Approve \${event.toolName}?\`, heldCall, {
        // Without it, an aborted turn leaves this dialog waiting for ever, and
        // the session with it.
        signal: ctx.signal,
      });
      return allowed ? undefined : { block: true, reason: DENIED };
    } catch {
      // pi answers an abort or a timeout with a plain "no", so what is left
      // here is the channel itself failing - and a tool that ran because
      // nobody could be asked would have run unapproved.
      return { block: true, reason: LOST };
    }
  });
}
`;
