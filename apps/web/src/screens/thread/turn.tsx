/**
 * One turn of the transcript. It shows:
 *
 * - a centred time separator, when the screen passes one;
 * - the user's message and images as a right-aligned bubble, unless
 *   `hidesUserMessage` leaves it out;
 * - one line per subagent the turn started;
 * - the assistant's prose at full width;
 * - the divider that shows how long the agent worked, or how the turn ended,
 *   when `showsTurnDivider` returns true.
 *
 * Both messages are rendered as markdown. Spec 14 §The thread surface owns
 * the turn's layout.
 */
import type { JSX, ReactNode, RefObject } from "react";
import { showsTurnDivider, type ThreadTurn } from "@hercule/client-core";
import { OwnerBubble } from "../bubble";
import { useAttachmentImages } from "../use-attachment-images";
import { TimeSeparator } from "../time-separator";
import { Markdown } from "../markdown";
import { TurnDivider } from "./turn-divider";

export function Turn({
  turn,
  spawnLines,
  live,
  tailRef,
  stamp,
  hidesUserMessage = false,
}: {
  readonly turn: ThreadTurn;
  /** The lines of the subagents the turn started, drawn under the user's message. */
  readonly spawnLines: ReactNode;
  /** Whether the turn is running: the last turn of a busy session, with no `turn.completed` yet. */
  readonly live: boolean;
  /** The element the live tail streams text into; set only on the live turn. */
  readonly tailRef?: RefObject<HTMLSpanElement | null> | undefined;
  /** The time separator to show above the turn; none when undefined. */
  readonly stamp: string | undefined;
  /**
   * Whether to leave out the user's message. A subagent's page sets it on
   * the first turn, whose input is the brief the page's brief card already
   * shows.
   */
  readonly hidesUserMessage?: boolean;
}): JSX.Element {
  const { images, observe } = useAttachmentImages(turn.userAttachments);
  const hasUserMessage = turn.user !== "" || images.length > 0;
  return (
    <div className="flex flex-col gap-2">
      {stamp === undefined ? null : <TimeSeparator stamp={stamp} />}
      {!hasUserMessage || hidesUserMessage ? null : (
        <div className="flex justify-end">
          <OwnerBubble text={turn.user} images={images} imagesRef={observe} />
        </div>
      )}
      {spawnLines}
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
