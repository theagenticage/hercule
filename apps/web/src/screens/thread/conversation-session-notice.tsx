import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { type HerculeClient, readErrorMessage } from "@hercule/client-core";
import { buildButtonClassName } from "@hercule/ui";
import { answeredAssistantQuery } from "../../app/queries";
import { StopButton } from "../stop-button";
import { useStopAgent } from "../use-stop-agent";

/**
 * The card an assistant's session shows where a thread has its composer. The
 * user talks to an assistant in its conversation, so the card names the
 * assistant and links back to the conversation instead of offering a second
 * place to type. While the session is busy, the card also offers the
 * composer's Stop control, so a runaway turn can be stopped from here.
 *
 * The assistant may have been deleted since the session ran. The card then
 * says so and has no link, because there is no conversation to open.
 *
 * The card is one row: the text on the left, the controls on the right. It
 * has the composer card's surface, so a permission dock tucks under it the
 * same way, but not the composer's height, because it holds no textarea.
 */
export function ConversationSessionNotice({
  client,
  sessionId,
  assistantId,
  busy,
}: {
  readonly client: HerculeClient;
  readonly sessionId: string;
  readonly assistantId: string;
  readonly busy: boolean;
}): JSX.Element {
  const assistant = useSuspenseQuery(answeredAssistantQuery(client, assistantId)).data;
  const stopAgent = useStopAgent(client, sessionId);

  return (
    <div className="relative z-[1] flex flex-col gap-1 rounded-[14px] border border-line bg-raised py-2 pr-2.5 pl-3.5 shadow-lift">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-body text-muted">
          {assistant === null
            ? "This session replied in a conversation with an assistant that was deleted."
            : `This session replies in your conversation with ${assistant.name}.`}
        </p>
        {/* A fixed height, so the row, and the text centred in it, stays put
            when Stop appears or goes. */}
        <div className="flex h-7 shrink-0 items-center gap-1.5">
          {busy ? (
            <StopButton
              onStop={() => {
                stopAgent.stop();
              }}
            />
          ) : null}
          {assistant === null ? null : (
            <Link
              to="/assistants/$assistantId"
              params={{ assistantId }}
              className={buildButtonClassName("primary", undefined)}
            >
              Open conversation
            </Link>
          )}
        </div>
      </div>
      {stopAgent.error === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {readErrorMessage(stopAgent.error)}
        </p>
      )}
    </div>
  );
}
