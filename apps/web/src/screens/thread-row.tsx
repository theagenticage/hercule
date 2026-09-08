import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { ThreadRow } from "@hydra/client-core";
import { DoneMark, WorkingMark, cn } from "@hydra/ui";

/**
 * One thread row: the sidebar and All sessions both render `threadRows`'
 * output this way, differing only in what they pass as the second line (a
 * model slug in the sidebar's meta mode, a provider display name on All
 * sessions) and whether a row can be the open thread.
 */
export function ThreadRowView({
  mark,
  title,
  age,
  secondLine = null,
  sessionId,
  selected = false,
}: {
  readonly mark: ThreadRow["mark"];
  readonly title: string;
  readonly age: string;
  readonly secondLine?: string | null;
  readonly sessionId: string;
  readonly selected?: boolean;
}): JSX.Element {
  return (
    <Link
      to="/threads/$sessionId"
      params={{ sessionId }}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "flex flex-col gap-px rounded-control px-2.5 py-[7px] text-row",
        "hover:bg-line-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
        selected && "bg-line-soft",
      )}
    >
      <span className="flex items-center gap-2">
        <span className="flex w-3 shrink-0 justify-center">
          {mark === "working" ? (
            <WorkingMark />
          ) : mark === "exited" ? (
            <DoneMark />
          ) : (
            <span className="size-1.5 rounded-full border-[1.5px] border-faint" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-ink">{title}</span>
        <span className="shrink-0 font-mono text-fine text-faint tabular-nums">{age}</span>
      </span>
      {secondLine === null ? null : (
        <span className="truncate pl-5 font-mono text-fine text-faint">{secondLine}</span>
      )}
    </Link>
  );
}
