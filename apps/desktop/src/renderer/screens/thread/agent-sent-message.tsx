import { memo, type JSX } from "react";
import type { Attachment, PromptContextBlock } from "@hercule/contract";
import { hasSameMessageProps, UserMessage } from "../session/messages";
import { useSenderReading } from "./use-sender-reading";

/**
 * Renders a message another session's agent sent into the thread: the
 * user's bubble, with the agent's chip above it and its hue on it. It reads
 * the sender of session `senderSessionId` and hands what it read to
 * `UserMessage`, which draws it.
 *
 * It is `memo`, as `UserMessage` is: the transcript draws again with every
 * row the agent stores, and this message's props stay the same across those
 * rows. `hasSameMessageProps` decides that, as it does for `UserMessage`: the
 * list of images and the context block are built again each time the
 * transcript is grouped, so they count as the same when their ids and text
 * are. The context block is there when the session was spawned with things
 * as context: the spawning agent sent the session's first message.
 */
export const AgentSentMessage = memo(function AgentSentMessage({
  senderSessionId,
  text,
  context,
  attachments,
  at,
  timezone,
  today,
  steered,
  sending,
  skills,
  sessionId,
}: {
  readonly senderSessionId: string;
  readonly text: string;
  readonly context?: PromptContextBlock | undefined;
  readonly attachments: readonly Attachment[];
  readonly at: string;
  readonly timezone: string;
  readonly today: number;
  readonly steered: boolean;
  /** Whether the message is still on its way into the session, as `UserMessage` takes it. */
  readonly sending: boolean;
  /** The skills the runner translated, and the session that has them, as `UserMessage` takes them. */
  readonly skills: readonly string[];
  readonly sessionId: string;
}): JSX.Element {
  const sender = useSenderReading(senderSessionId);
  return (
    <UserMessage
      text={text}
      context={context}
      attachments={attachments}
      at={at}
      timezone={timezone}
      today={today}
      steered={steered}
      sending={sending}
      sender={sender}
      skills={skills}
      sessionId={sessionId}
    />
  );
}, hasSameMessageProps);
