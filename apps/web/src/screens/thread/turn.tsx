/**
 * One turn of the transcript: a mono timestamp, the user's message as a
 * right-aligned bubble, the assistant's prose full width as markdown, and the
 * "Worked for" divider where there is something to disclose (spec 14 §The
 * thread surface).
 */
import type { JSX, RefObject } from "react";
import { formatStamp, type ThreadTurn } from "@hydra/client-core";
import { Markdown } from "./markdown";
import { TurnDivider } from "./turn-divider";

export function Turn({
  turn,
  live,
  tailRef,
  timezone,
}: {
  readonly turn: ThreadTurn;
  /** Still running: no `turn.completed` row has arrived for this turn yet. */
  readonly live: boolean;
  /** Where this turn's open item live-streams its token deltas, when it has one. */
  readonly tailRef?: RefObject<HTMLSpanElement | null> | undefined;
  readonly timezone: string;
}): JSX.Element {
  const stamp = formatStamp(new Date(turn.startedAt), timezone);

  return (
    <div className="flex flex-col gap-2">
      {stamp === undefined ? null : (
        <div className="font-mono text-fine text-faint tabular-nums">{stamp}</div>
      )}
      {turn.user === "" ? null : (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-card border border-line-soft bg-surface px-3.5 py-2 text-row whitespace-pre-wrap text-ink">
            {turn.user}
          </div>
        </div>
      )}
      {turn.assistantText === "" && !live ? null : (
        <div className="w-full text-row text-ink">
          <Markdown text={turn.assistantText} />
          {/* The tail is painted as plain text while the agent types, so it
              keeps the whitespace behaviour the settled prose no longer has. */}
          {tailRef === undefined ? null : <span ref={tailRef} className="whitespace-pre-wrap" />}
        </div>
      )}
      {live || turn.items.length > 0 ? (
        <TurnDivider
          live={live}
          duration={turn.duration}
          startedAt={turn.startedAt}
          items={turn.items}
        />
      ) : null}
    </div>
  );
}
