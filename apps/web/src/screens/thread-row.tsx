import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { ThreadRow } from "@hercule/client-core";
import { DoneMark, WorkingMark, cn } from "@hercule/ui";

/**
 * One thread row. The sidebar and All sessions both render the rows of
 * `buildThreadRows` with it. They differ only in:
 *
 * - the second line: a model slug in the sidebar's meta mode, a provider
 *   display name on All sessions, the run that started a step session;
 * - whether a row can be marked as the open thread.
 *
 * A row whose end is a word, "queued" or "offline", shows that word in place
 * of its age, and the hollow circle in place of its mark: the session is not
 * working, whatever its status says, because it is waiting for a session slot
 * or for its runner.
 */
export function ThreadRowView({
  mark,
  title,
  end,
  age,
  secondLine = null,
  sessionId,
  selected = false,
}: {
  readonly mark: ThreadRow["mark"];
  readonly title: string;
  readonly end: ThreadRow["end"];
  /** How long ago the session was last active, such as "3m". */
  readonly age: string;
  readonly secondLine?: string | null;
  readonly sessionId: string;
  readonly selected?: boolean;
}): JSX.Element {
  const word = end.kind === "word" ? end.word : undefined;
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
          {word === undefined && mark === "working" ? (
            <WorkingMark />
          ) : word === undefined && mark === "exited" ? (
            <DoneMark />
          ) : (
            <span className="size-1.5 rounded-full border-[1.5px] border-faint" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-ink">{title}</span>
        {word === undefined ? (
          <span className="shrink-0 font-mono text-fine text-faint tabular-nums">{age}</span>
        ) : (
          <span className="shrink-0 text-fine text-faint">{word}</span>
        )}
      </span>
      {secondLine === null ? null : (
        <span className="truncate pl-5 font-mono text-fine text-faint">{secondLine}</span>
      )}
    </Link>
  );
}
