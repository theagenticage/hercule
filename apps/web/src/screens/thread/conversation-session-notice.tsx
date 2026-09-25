import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import { buildButtonClassName } from "@hercule/ui";
import { answeredAssistantQuery } from "../../app/queries";
import { ComposerCard } from "../composer/composer-card";
import { StopButton } from "../composer/controls";
import { readErrorMessage } from "../save-status";

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
 * It uses the composer's card, text line and row of controls, so it has the
 * composer's height and the page does not shift between a thread and an
 * assistant's session.
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
  const queryClient = useQueryClient();
  const assistant = useSuspenseQuery(answeredAssistantQuery(client, assistantId)).data;
  const interrupt = useMutation({
    mutationFn: () => client.session.interrupt({ params: { id: sessionId } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.session(updated.id), updated);
    },
  });

  return (
    <ComposerCard>
      <p className="min-h-6 text-body leading-[1.5] text-muted">
        {assistant === null
          ? "This session answered an assistant that was deleted."
          : `This session answers ${assistant.name}'s chat.`}
      </p>
      <div className="flex min-h-7 items-center justify-end gap-1.5">
        {busy ? (
          <StopButton
            onStop={() => {
              if (!interrupt.isPending) interrupt.mutate();
            }}
          />
        ) : null}
        {assistant === null ? null : (
          <Link
            to="/assistants/$assistantId"
            params={{ assistantId }}
            className={buildButtonClassName("primary", undefined)}
          >
            Open chat
          </Link>
        )}
      </div>
      {interrupt.error === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {readErrorMessage(interrupt.error)}
        </p>
      )}
    </ComposerCard>
  );
}
