/**
 * Which tool calls a session's access mode stops to ask about. The approval
 * hook pi runs is not a second reading of this: the extension is written from
 * this function's own source, so what holds a call inside pi is the function
 * these tests cover. Two copies of the table would be a mode where the approval
 * hook holds a call Hydra would have let run, or worse, lets one through that
 * Hydra would have stopped.
 *
 * That is why it carries its table inside its body and closes over nothing: a
 * name it reached for from around it would not be there when it runs inside pi.
 */
import type { AccessMode } from "@hydra/protocol";

/** Whether the approval hook holds this call and asks about it, or lets it run. */
export const requiresApproval = (mode: AccessMode, toolName: string): boolean => {
  // The runner's own tool for the session's answer. The name is spelled out
  // here and not imported from `extension.ts`: this function is interpolated
  // into the extension as its own source, so a name it read from around it
  // would not exist when the function runs inside pi. A test holds the two
  // spellings together.
  //
  // The call is never asked about. It records a verdict the agent has already
  // reached and touches nothing on the machine. An approval card for it would
  // park every turn of every unattended session under a schema, on a question
  // nobody is there to answer.
  if (toolName === "submit_result") return false;
  // pi's own read-only built-ins: a look at the workspace changes nothing.
  const reading = ["read", "grep", "find", "ls"];
  // What each mode runs without asking. Full access is not a row here: it is
  // the mode that asks about nothing at all. Neither is a mode this build has
  // not heard of, and a mode with no row asks about everything - a call let
  // through because the approval hook did not recognise the mode is the one failure
  // here that costs something.
  const unasked: Record<string, ReadonlyArray<string>> = {
    "approval-required": reading,
    "auto-accept-edits": [...reading, "write", "edit"],
    // Never reaches a runner: the controller lands a provider that does not
    // support it on auto-accept-edits first, and it asks the same questions.
    auto: [...reading, "write", "edit"],
  };
  return mode !== "full-access" && !(unasked[mode] ?? []).includes(toolName);
};
