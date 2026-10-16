import type { JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  decideStartFresh,
  describeConversationChannel,
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
 * Renders what belongs to each conversation of one assistant: the card with
 * the button that starts it fresh, and its pending reminders. The screen's
 * loader reads the first assistant's conversations ahead; another assistant's
 * are read when it is selected, and the screen shows its loading state around
 * this section until they arrive.
 */
export function AssistantConversations({
  client,
  assistantId,
}: {
  readonly client: HerculeClient;
  readonly assistantId: string;
}): JSX.Element {
  const conversations = useSuspenseQuery(conversationsQuery(client, assistantId)).data;
  return (
    <>
      {conversations.items.map((conversation) => (
        <ConversationSection key={conversation.id} client={client} conversation={conversation} />
      ))}
    </>
  );
}

/**
 * Renders one conversation: a card with Start fresh and the reason it is
 * unavailable, when it is, and under it the conversation's pending reminders.
 *
 * - Start fresh asks the controller to end the conversation's session and
 *   continue in a fresh one. It asks for no confirmation, because nothing is
 *   lost: the assistant keeps its memory and its reminders. A refusal shows
 *   the controller's message beside the button.
 * - Each reminder shows when it fires, in the user's time zone, and its
 *   text, with a Cancel button.
 */
function ConversationSection({
  client,
  conversation,
}: {
  readonly client: HerculeClient;
  readonly conversation: Conversation;
}): JSX.Element {
  const queryClient = useQueryClient();
  const session = useSuspenseQuery(currentConversationSessionQuery(client, conversation.id)).data;
  const pending = useSuspenseQuery(remindersQuery(client, conversation.id)).data.items;
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

  const startFresh = decideStartFresh(session);

  return (
    <>
      <FormCard
        label={describeConversationChannel(conversation.channel)}
        fine="Start fresh ends the current session and carries on in a fresh one. Memory and reminders stay."
      >
        <Row label="Session">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Button
              variant="form"
              disabled={!startFresh.available || rotate.isPending}
              onClick={() => {
                rotate.mutate();
              }}
            >
              {rotate.isPending ? "Starting fresh…" : "Start fresh"}
            </Button>
            {!startFresh.available && (
              <span className="text-fine text-faint">{startFresh.reason}</span>
            )}
            <SaveStatus
              saved={false}
              failure={rotate.error === null ? null : readErrorMessage(rotate.error)}
            />
          </div>
        </Row>
      </FormCard>

      <div>
        <LaneLabel>Reminders</LaneLabel>
        <Group>
          {pending.length === 0 ? (
            <p className="px-2.5 py-2 text-row text-muted">No reminders set.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line-soft">
              {pending.map((reminder) => (
                <li
                  key={reminder.id}
                  className="flex items-baseline gap-3 px-2.5 py-1.5 text-row text-ink"
                >
                  <span className="w-28 shrink-0 font-mono text-fine tabular-nums text-muted">
                    {formatStamp(new Date(reminder.at), timezone) ?? reminder.at}
                  </span>
                  <span className="min-w-0 flex-1 break-words">{reminder.text}</span>
                  <Button
                    className="-mr-2"
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
    </>
  );
}
