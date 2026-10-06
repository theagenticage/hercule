/**
 * One turn of the transcript. It shows:
 *
 * - a centred time separator, when the screen passes one;
 * - the user's message as a right-aligned bubble;
 * - one line per subagent the turn started;
 * - the assistant's prose at full width;
 * - the divider that shows how long the agent worked, or how the turn ended,
 *   when `showsTurnDivider` returns true.
 *
 * Both messages are rendered as markdown. Spec 14 §The thread surface owns
 * the turn's layout.
 */
import type { JSX, RefObject } from "react";
import { showsTurnDivider, type ThreadTurn } from "@hercule/client-core";
import type { Session, Subagent } from "@hercule/contract";
import { OwnerBubble } from "../bubble";
import { SpawnLines } from "../subagents/spawn-lines";
import { TimeSeparator } from "../time-separator";
import { Markdown } from "../markdown";
import { TurnDivider } from "./turn-divider";

export function Turn({
  session,
  subagents,
  turn,
  live,
  tailRef,
  stamp,
}: {
  /** The session the turn belongs to, whether the turn is its own agent's or a subagent's. */
  readonly session: Session;
  /** Every subagent of the session, oldest first. */
  readonly subagents: readonly Subagent[];
  readonly turn: ThreadTurn;
  /** Whether the turn is running: the last turn of a busy session, with no `turn.completed` yet. */
  readonly live: boolean;
  /** The element the live tail streams text into; set only on the live turn. */
  readonly tailRef?: RefObject<HTMLSpanElement | null> | undefined;
  /** The time separator to show above the turn; none when undefined. */
  readonly stamp: string | undefined;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {stamp === undefined ? null : <TimeSeparator stamp={stamp} />}
      {turn.user === "" ? null : (
        <div className="flex justify-end">
          <OwnerBubble text={turn.user} />
        </div>
      )}
      <SpawnLines session={session} subagents={subagents} turn={turn} />
      {turn.assistantText === "" && !live ? null : (
        // Until the first word streams into the tail, the prose is hidden, so
        // the flex gap above it does not count. The divider under the turn
        // then sits at the same height while the turn runs and after it ends.
        <div className="w-full text-row text-ink has-[>span:only-child:empty]:hidden">
          <Markdown text={turn.assistantText} />
          {/* The tail is plain text while the agent writes, so its whitespace
              is kept as sent; the finished prose is rendered as markdown. */}
          {tailRef === undefined ? null : <span ref={tailRef} className="whitespace-pre-wrap" />}
        </div>
      )}
      {showsTurnDivider(turn, live) ? <TurnDivider turn={turn} live={live} /> : null}
    </div>
  );
}
