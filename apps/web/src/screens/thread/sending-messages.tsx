/**
 * The messages on their way into a session, drawn under its last turn until
 * their inputs read `delivered` (spec 14 §The thread surface).
 */
import type { JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { readInputSender, splitQueuedInputs, type HerculeClient } from "@hercule/client-core";
import type { Input } from "@hercule/contract";
import { inputsQuery, sessionQuery } from "../../app/queries";
import { MessageBubble } from "../bubble";
import { useAttachmentImages } from "../use-attachment-images";
import { AgentSentMessage } from "./agent-sent-message";

/**
 * Draws each message on its way into the session `sessionId`, oldest first:
 * one the runner was handed, or the one the session's start will carry
 * (`splitQueuedInputs`). Each is a right-aligned bubble with "sending…"
 * under it, so a message the user expects to go straight in never shows as
 * queued. A message another session's agent sent names its sender on that
 * line, as in the transcript (`AgentSentMessage`). Draws nothing when no
 * message is on its way.
 */
export function SendingMessages({
  client,
  sessionId,
}: {
  readonly client: HerculeClient;
  readonly sessionId: string;
}): JSX.Element | null {
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const inputs = useQuery(inputsQuery(client, sessionId)).data?.items ?? [];
  const { sending } = splitQueuedInputs(session, inputs);
  if (sending.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {sending.map((input) => (
        <SendingMessage key={input.id} input={input} />
      ))}
    </div>
  );
}

/** Draws one message on its way into the session, with "sending…" under its bubble. */
function SendingMessage({ input }: { readonly input: Input }): JSX.Element | null {
  const { images, observe } = useAttachmentImages(input.attachments);
  if (input.text === "" && images.length === 0) return null;
  const senderSessionId = readInputSender(input);
  const bubble = (
    <MessageBubble
      text={input.text}
      images={images}
      imagesRef={observe}
      embeddedHtml={senderSessionId !== undefined}
    />
  );
  if (senderSessionId !== undefined) {
    return (
      <AgentSentMessage senderSessionId={senderSessionId} note="sending…">
        {bubble}
      </AgentSentMessage>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      {bubble}
      <p className="text-meta text-faint">sending…</p>
    </div>
  );
}
