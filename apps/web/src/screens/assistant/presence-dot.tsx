import type { JSX } from "react";
import type { AssistantPresence } from "@hercule/client-core";
import { cn } from "@hercule/ui";

/**
 * The 6px dot beside an assistant's name: the live hue while the assistant
 * is live, faint while it is idle. The dot is still in both states. "Live"
 * means the assistant has a session loaded and could answer, not that work is
 * happening, and static things have no motion; the working mark in the
 * conversation shows when a turn runs.
 */
export function PresenceDot({ presence }: { readonly presence: AssistantPresence }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-presence={presence}
      className={cn("size-1.5 shrink-0 rounded-full", presence === "live" ? "bg-live" : "bg-faint")}
    />
  );
}
