/**
 * Decides which tool calls a session's access mode must ask the user about.
 *
 * The approval hook inside pi runs this same function: the extension source is
 * built from `requiresApproval.toString()`. So the tests of this function also
 * cover what pi does. A second copy of the table could drift, and pi would then
 * hold a call Hercule would allow, or worse, run a call Hercule would stop.
 *
 * Because the function runs inside pi as copied source, it keeps its table in
 * its own body and uses nothing from the surrounding module: any outside name
 * would not exist inside pi.
 */
import type { AccessMode } from "@hercule/protocol";

/**
 * Checks whether the approval hook must hold a call to `toolName` and ask the
 * user. Returns false when the call may run without asking.
 */
export const requiresApproval = (mode: AccessMode, toolName: string): boolean => {
  // The runner's own tool for the session's answer. The name is written out
  // here instead of imported from `extension.ts`, because this function is
  // copied into the extension as source and an imported name would not exist
  // inside pi. A test checks that the two spellings match.
  //
  // This call is never asked about. It only records the agent's answer and
  // changes nothing on the machine. Asking about it would park every turn of
  // every unattended session that has an output schema, with nobody there to
  // answer.
  if (toolName === "submit_result") return false;
  // pi's read-only built-in tools: reading the workspace changes nothing.
  const reading = ["read", "grep", "find", "ls"];
  // The tools each mode runs without asking. Full access has no row, because
  // it asks about nothing. A mode this build does not know has no row either,
  // so it asks about everything: letting a call through because the mode was
  // not recognised is the one mistake here that does real harm.
  const unasked: Record<string, ReadonlyArray<string>> = {
    "approval-required": reading,
    "auto-accept-edits": [...reading, "write", "edit"],
    // This row is never used on a runner: pi does not support `auto`, so the
    // controller replaces it with auto-accept-edits before the session starts.
    // The row matches that mode.
    auto: [...reading, "write", "edit"],
  };
  return mode !== "full-access" && !(unasked[mode] ?? []).includes(toolName);
};
