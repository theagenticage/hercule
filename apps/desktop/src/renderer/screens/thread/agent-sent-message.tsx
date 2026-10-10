import { memo, type JSX } from "react";
import type { Attachment } from "@hercule/contract";
import { UserMessage } from "../session/messages";
import { useSenderReading } from "./use-sender-reading";

/**
 * Renders a message another session's agent sent into the thread: the
 * user's bubble, with the agent's chip above it and its hue on it. It reads
 * the sender of session `senderSessionId` and hands what it read to
 * `UserMessage`, which draws it.
 *
 * It is `memo`, as `UserMessage` is: the transcript draws again with every
 * row the agent stores, and this message's props stay the same across those
 * rows. The one exception is a message sent with images, whose list of
 * images is a new array each time the transcript is grouped again.
 */
export const AgentSentMessage = memo(function AgentSentMessage({
  senderSessionId,
  text,
  attachments,
  at,
  timezone,
  today,
  steered,
}: {
  readonly senderSessionId: string;
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly at: string;
  readonly timezone: string;
  readonly today: number;
  readonly steered: boolean;
}): JSX.Element {
  const sender = useSenderReading(senderSessionId);
  return (
    <UserMessage
      text={text}
      attachments={attachments}
      at={at}
      timezone={timezone}
      today={today}
      steered={steered}
      sender={sender}
    />
  );
});
