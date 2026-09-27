import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { AssistantPresence } from "@hercule/client-core";
import { cn } from "@hercule/ui";
import { PresenceDot } from "./presence-dot";

/**
 * One row of the sidebar's Assistants group: the presence dot, the
 * assistant's name, and the channel it is reached on. The row links to the
 * assistant's conversation. It has the thread row's size and marker column, so the
 * names line up with the thread titles above them.
 *
 * An assistant with no session yet has no presence, so its marker column
 * stays empty rather than showing a dot that would claim a state.
 */
export function AssistantRow({
  assistantId,
  name,
  presence,
  selected,
}: {
  readonly assistantId: string;
  readonly name: string;
  readonly presence: AssistantPresence | null;
  /** Whether the open screen is this assistant's conversation or one of its sessions. */
  readonly selected: boolean;
}): JSX.Element {
  return (
    <Link
      to="/assistants/$assistantId"
      params={{ assistantId }}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-control px-2.5 py-[7px] text-row",
        "hover:bg-line-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
        selected && "bg-line-soft",
      )}
    >
      <span className="flex w-3 shrink-0 justify-center">
        {presence === null ? null : <PresenceDot presence={presence} />}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink">{name}</span>{" "}
      {/* The web is the only channel so far. */}
      <span className="shrink-0 font-mono text-fine text-faint">web</span>
    </Link>
  );
}
