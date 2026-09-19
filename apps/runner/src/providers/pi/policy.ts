/**
 * Which tool calls a session's access mode stops to ask about. Two parties
 * need the answer - the gate pi runs, which decides whether to hold the call,
 * and the adapter, which decides what the question it then gets asked is
 * called - so the decision is this one function, and the gate is written from
 * its own source. Two copies of the table would be a mode where the gate holds
 * a call the card cannot name, or worse, lets one through the other would have
 * stopped.
 *
 * That is why it carries its tables inside its body and closes over nothing:
 * what the gate runs is this function's text, and a name it reached for from
 * around it would not be there when it runs inside pi.
 */
import type { AccessMode, OpenRequest } from "@hydra/protocol";

/**
 * What the question a held call becomes is called on the session's stream,
 * named from the protocol's own list so a kind that is renamed there does not
 * quietly become a second vocabulary here.
 */
export type ParkKind = Extract<
  OpenRequest["kind"],
  "command_approval" | "file_change_approval" | "tool_approval"
>;

/** What the gate does with one call: hold it and ask, or let it run. */
type Verdict = { readonly park: false } | { readonly park: true; readonly kind: ParkKind };

export const decide = (mode: AccessMode, toolName: string): Verdict => {
  // pi's own read-only built-ins: a look at the workspace changes nothing.
  const reading = ["read", "grep", "find", "ls"];
  // What each mode runs without asking. Full access is not a row here: it is
  // the mode that asks about nothing at all. Neither is a mode this build has
  // not heard of, and a mode with no row asks about everything - a call let
  // through because the gate did not recognise the mode is the one failure
  // here that costs something.
  const unasked: Record<string, ReadonlyArray<string>> = {
    "approval-required": reading,
    "auto-accept-edits": [...reading, "write", "edit"],
    // Never reaches a runner: the controller lands a provider that does not
    // support it on auto-accept-edits first, and it asks the same questions.
    auto: [...reading, "write", "edit"],
  };
  // What a held call is asked as, by what it does; anything else is a tool.
  // pi's two shells take the same arguments and are the same question to the
  // user, whichever machine the session runs on.
  const kinds: Record<string, ParkKind> = {
    bash: "command_approval",
    powershell: "command_approval",
    write: "file_change_approval",
    edit: "file_change_approval",
  };
  if (mode === "full-access" || (unasked[mode] ?? []).includes(toolName)) return { park: false };
  return { park: true, kind: kinds[toolName] ?? "tool_approval" };
};
