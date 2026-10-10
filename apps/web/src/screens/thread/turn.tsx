/**
 * One turn of the transcript. It shows:
 *
 * - a centred time separator, when the screen passes one;
 * - each message sent into the turn, with its images, as its own
 *   right-aligned bubble in transcript order, unless `hidesUserMessage`
 *   leaves them out. A message steered into the running turn is marked
 *   "steered", and a message another session's agent sent names its sender
 *   under the bubble;
 * - one line per subagent the turn started;
 * - the assistant's prose at full width;
 * - the divider that shows how long the agent worked, or how the turn ended,
 *   when `showsTurnDivider` returns true.
 *
 * The messages and the agent's prose are rendered as markdown. Spec 14 §The
 * thread surface owns the turn's layout.
 */
import type { JSX, ReactNode, RefObject } from "react";
import { showsTurnDivider, type ThreadTurn, type ThreadUserMessage } from "@hercule/client-core";
import { SenderName, writeSenderName } from "../actor-link";
import { MessageBubble } from "../bubble";
import { useAttachmentImages } from "../use-attachment-images";
import { TimeSeparator } from "../time-separator";
import { Markdown } from "../markdown";
import { TurnDivider } from "./turn-divider";
import { useSenderReading } from "./use-sender-reading";

export function Turn({
  turn,
  spawnLines,
  live,
  tailRef,
  stamp,
  hidesUserMessage = false,
}: {
  readonly turn: ThreadTurn;
  /** The lines of the subagents the turn started, drawn under the turn's messages. */
  readonly spawnLines: ReactNode;
  /** Whether the turn is running: the last turn of a busy session, with no `turn.completed` yet. */
  readonly live: boolean;
  /** The element the live tail streams text into; set only on the live turn. */
  readonly tailRef?: RefObject<HTMLSpanElement | null> | undefined;
  /** The time separator to show above the turn; none when undefined. */
  readonly stamp: string | undefined;
  /**
   * Whether to leave out the turn's messages. A subagent's page sets it on
   * the first turn, whose input is the brief the page's brief card already
   * shows.
   */
  readonly hidesUserMessage?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {stamp === undefined ? null : <TimeSeparator stamp={stamp} />}
      {hidesUserMessage
        ? null
        : turn.userMessages.map((message) => (
            <UserMessage key={message.itemId} message={message} />
          ))}
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

/**
 * Draws one message sent into a turn, on the right. The owner's message that
 * opened its turn is the bare bubble. Any other message has one line under
 * its bubble: "steered" for a message steered into the running turn, and
 * "Sent by" and its sender for a message another session's agent sent, both
 * on the line when both hold. A message with neither text nor images draws
 * nothing.
 */
function UserMessage({ message }: { readonly message: ThreadUserMessage }): JSX.Element | null {
  const { images, observe } = useAttachmentImages(message.attachments);
  if (message.text === "" && images.length === 0) return null;
  const bubble = <MessageBubble text={message.text} images={images} imagesRef={observe} />;
  if (message.senderSessionId !== undefined) {
    return (
      <AgentMessage senderSessionId={message.senderSessionId} steered={message.steered}>
        {bubble}
      </AgentMessage>
    );
  }
  if (!message.steered) return <div className="flex justify-end">{bubble}</div>;
  return (
    <div className="flex flex-col items-end gap-1">
      {bubble}
      <p className="text-meta text-faint">steered</p>
    </div>
  );
}

/**
 * Draws a message another session's agent sent, with a line under it that
 * reads "Sent by" and the sender's name as a link to the sender, then
 * "· steered" when the message was steered. The message's accessible name
 * names the sender too, so a screen reader never takes it for the owner's.
 *
 * While the sender is still being read, which happens only for a sender that
 * first appears while the thread streams, the sender is left out of the line
 * rather than filled with a name that may be wrong.
 */
function AgentMessage({
  senderSessionId,
  steered,
  children,
}: {
  readonly senderSessionId: string;
  readonly steered: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  const sender = useSenderReading(senderSessionId);
  return (
    <div
      role="group"
      aria-label={sender === undefined ? undefined : `Message from ${writeSenderName(sender)}`}
      className="flex flex-col items-end gap-1"
    >
      {children}
      {sender === undefined && !steered ? null : (
        <p className="text-meta text-faint">
          {sender === undefined ? null : (
            <>
              Sent by <SenderName sender={sender} plainClassName="text-muted" />
            </>
          )}
          {sender !== undefined && steered ? " · " : null}
          {steered ? "steered" : null}
        </p>
      )}
    </div>
  );
}
