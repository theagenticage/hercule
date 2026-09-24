/**
 * One turn of the transcript (spec 14 §The thread surface). It shows:
 *
 * - a mono timestamp;
 * - the user's message as a right-aligned bubble;
 * - the assistant's prose at full width;
 * - the "Worked for" divider, when the turn is live or has tool items.
 *
 * Both messages are rendered as markdown.
 */
import type { JSX, RefObject } from "react";
import { formatStamp, type ThreadTurn } from "@hercule/client-core";
import { Markdown } from "./markdown";
import { TurnDivider } from "./turn-divider";

export function Turn({
  turn,
  live,
  tailRef,
  timezone,
}: {
  readonly turn: ThreadTurn;
  /** Whether the turn is running: the last turn of a busy session, with no `turn.completed` yet. */
  readonly live: boolean;
  /** The element the live tail streams text into; set only on the live turn. */
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
          <div className="max-w-[80%] rounded-card border border-line-soft bg-surface px-3.5 py-2 text-row text-ink">
            <Markdown text={turn.user} breaks />
          </div>
        </div>
      )}
      {turn.assistantText === "" && !live ? null : (
        <div className="w-full text-row text-ink">
          <Markdown text={turn.assistantText} />
          {/* The tail is plain text while the agent writes, so its whitespace
              is kept as sent; the finished prose is rendered as markdown. */}
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
