import type { JSX } from "react";
import type { AssistantPresence } from "@hercule/client-core";
import { cn } from "@hercule/ui";

/**
 * The classes of the dot for each presence. The shape says whether a session
 * is loaded: a filled dot while it is (working or idle), a hollow ring while
 * it is not (asleep or unavailable). The hue and the motion tell the two of
 * each pair apart:
 *
 * - working: the live hue, pulsing, because work is happening;
 * - idle: the live hue, still;
 * - asleep: the faint ring an idle thread row carries;
 * - unavailable: a ring in the fail hue, because the next message may not
 *   reach the assistant the way it used to.
 */
const DOT_CLASSES: Readonly<Record<AssistantPresence, string>> = {
  working: "hercule-live-dot bg-live",
  idle: "bg-live",
  asleep: "border-[1.5px] border-faint",
  unavailable: "border-[1.5px] border-fail",
};

/** The 6px dot beside an assistant's name, drawn for its presence. */
export function PresenceDot({ presence }: { readonly presence: AssistantPresence }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-presence={presence}
      className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASSES[presence])}
    />
  );
}
