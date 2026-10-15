import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  decideStartFresh,
  formatStamp,
  readErrorMessage,
  resolveDisplayTimezone,
  type HerculeClient,
} from "@hercule/client-core";
import type { Conversation, Reminder } from "@hercule/contract";
import { Button, FormCard, Group, LaneLabel, Row } from "@hercule/ui";
import {
  conversationsQuery,
  currentConversationSessionQuery,
  remindersQuery,
  settingsQuery,
} from "../../../app/queries";
import { SaveStatus } from "../../../screens/save-status";

/**
 * Renders what belongs to each conversation of one assistant: the button
 * that starts it fresh, and its pending reminders.
 *
 * The conversations load after the assistant's form, so this section shows
 * its own loading and error states instead of holding up the screen. Each
 * conversation reads its own session and reminders where it draws them.
 */
export function AssistantConversations({
  client,
  assistantId,
}: {
  readonly client: HerculeClient;
  readonly assistantId: string;
}): JSX.Element {
  const conversations = useQuery(conversationsQuery(client, assistantId));

  if (conversations.data === undefined) {
    return conversations.error === null ? (
      <p className="text-row text-muted">Loading…</p>
    ) : (
      <p className="text-fine text-fail" role="alert">
        {readErrorMessage(conversations.error)}
      </p>
    );
  }
  return (
    <section className="flex flex-col gap-7">
      {conversations.data.items.map((conversation) => (
        <ConversationCard key={conversation.id} client={client} conversation={conversation} />
      ))}
    </section>
  );
}

/**
 * Renders one conversation's card: Start fresh with the reason it is
 * unavailable, when it is, and the conversation's pending reminders.
 *
 * - Start fresh asks the controller to end the conversation's session and
 *   continue in a fresh one. It asks for no confirmation, because nothing is
 *   lost: the assistant keeps its memory and its reminders. A refusal shows
 *   the controller's message beside the button.
 * - Each reminder shows when it fires, in the user's time zone, and its
 *   text, with a Cancel button.
 */
function ConversationCard({
  client,
  conversation,
}: {
  readonly client: HerculeClient;
  readonly conversation: Conversation;
}): JSX.Element {
  const queryClient = useQueryClient();
  const session = useQuery(currentConversationSessionQuery(client, conversation.id));
  const reminders = useQuery(remindersQuery(client, conversation.id));
  const timezone = resolveDisplayTimezone(
    useSuspenseQuery(settingsQuery(client)).data.user.timezone,
  );

  const rotate = useMutation({
    mutationKey: ["settings", "conversation", "rotate", conversation.id],
    mutationFn: () => client.conversation.rotate({ params: { id: conversation.id } }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: currentConversationSessionQuery(client, conversation.id).queryKey,
      }),
  });
  const cancel = useMutation({
    mutationKey: ["settings", "reminder", "cancel", conversation.id],
    mutationFn: (reminder: Reminder) => client.reminder.cancel({ params: { id: reminder.id } }),
    // A reminder that is already gone, fired or cancelled elsewhere, is
    // refused; the refetch then drops it from the list as well.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: remindersQuery(client, conversation.id).queryKey }),
  });

  // The decision waits for the session read, so Start fresh is not offered,
  // then withdrawn, on a conversation that has no session.
  const startFresh = session.isSuccess ? decideStartFresh(session.data) : null;
  const pending = reminders.data?.items ?? [];

  return (
    <FormCard label={`Conversation (${conversation.channel})`}>
      <Row label="Session">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Button
            variant="form"
            disabled={startFresh === null || !startFresh.available || rotate.isPending}
            onClick={() => {
              rotate.mutate();
            }}
          >
            {rotate.isPending ? "Starting fresh…" : "Start fresh"}
          </Button>
          {startFresh?.available === false && (
            <span className="text-fine text-faint">{startFresh.reason}</span>
          )}
          <SaveStatus
            saved={false}
            failure={rotate.error === null ? null : readErrorMessage(rotate.error)}
          />
        </div>
      </Row>
      <p className="text-fine text-faint">
        Ends the current session and carries on in a fresh one. Memory and reminders stay.
      </p>

      <div className="pt-2">
        <LaneLabel>Reminders</LaneLabel>
        <Group>
          {reminders.data === undefined ? (
            reminders.error === null ? (
              <p className="px-2.5 py-2 text-row text-muted">Loading…</p>
            ) : (
              <p className="px-2.5 py-2 text-fine text-fail" role="alert">
                {readErrorMessage(reminders.error)}
              </p>
            )
          ) : pending.length === 0 ? (
            <p className="px-2.5 py-2 text-row text-muted">No reminders set.</p>
          ) : (
            <ul className="flex flex-col">
              {pending.map((reminder) => (
                <li
                  key={reminder.id}
                  className="flex items-baseline gap-3 px-2.5 py-1.5 text-row text-ink"
                >
                  <span className="shrink-0 font-mono text-fine tabular-nums text-muted">
                    {formatStamp(new Date(reminder.at), timezone) ?? reminder.at}
                  </span>
                  <span className="min-w-0 flex-1 break-words">{reminder.text}</span>
                  <Button
                    disabled={cancel.isPending && cancel.variables.id === reminder.id}
                    aria-label={`Cancel reminder: ${reminder.text}`}
                    onClick={() => {
                      cancel.mutate(reminder);
                    }}
                  >
                    Cancel
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Group>
        <SaveStatus
          saved={false}
          failure={cancel.error === null ? null : readErrorMessage(cancel.error)}
        />
      </div>
    </FormCard>
  );
}
