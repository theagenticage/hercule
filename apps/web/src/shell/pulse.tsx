import type { JSX } from "react";
import { DisclosureButton, useTabFlag } from "@hercule/ui";

/**
 * The pulse at the foot of the sidebar: a one-line summary of the fleet's
 * signals that expands to the full block. It starts closed, and stays open
 * across page loads in this tab once opened. Nothing reports into it yet, so
 * both the line and the block explain that instead of showing an empty list.
 */
export function Pulse(): JSX.Element {
  const [open, toggle] = useTabFlag("hercule.pulse.open");

  return (
    <div className="flex flex-col gap-[3px] pb-1">
      <DisclosureButton open={open} onToggle={toggle} className="w-full">
        {/* The dot sits centred in a 12px slot, the width of the mark beside
            "Marks" below, so the two icons and the two labels line up. */}
        <span className="flex w-3 shrink-0 justify-center">
          <span className="size-1.5 rounded-full border-[1.5px] border-faint" />
        </span>
        <span className="min-w-0 flex-1 truncate">Nothing to report yet</span>
      </DisclosureButton>
      {open ? (
        <p className="pr-2.5 pb-0.5 pl-[30px] text-fine text-faint">
          Fleet, assistants and intake report here once a runner joins or a connection brings
          something in.
        </p>
      ) : null}
    </div>
  );
}
