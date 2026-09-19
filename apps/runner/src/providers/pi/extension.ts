/**
 * The extension pi loads for a Hydra session, as the source the adapter writes
 * into the instance's own home at every session start. It is a string constant
 * rather than a file read off disk because the runner ships as a compiled
 * binary with no source tree beside it, and writing it per start keeps the file
 * in step with the build that spawned pi.
 *
 * It imports nothing: a `-e` file is loaded by pi's own loader, and anything it
 * reached for would have to exist on the machine the session runs on. Which
 * calls it holds it does not work out for itself either: `requiresApproval` is
 * interpolated here as its own source, so what runs inside pi is the function
 * the adapter reads and the tests cover, not a second reading of it.
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

export const EXTENSION_SOURCE = `/**
 * Hydra's tool approval hook. Written by the Hydra runner at session start; edits here
 * are overwritten the next time a session starts.
 */
const requiresApproval = ${requiresApproval.toString()};

const MODE = process.env.${ACCESS_MODE_VARIABLE} ?? "approval-required";

const DENIED = "The user did not approve this in Hydra.";

const LOST = "Hydra could not ask the user about this: the channel it asks over closed.";

export default function (pi) {
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
