import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { describeSender, type SenderReading } from "@hercule/client-core";
import { assistantsQuery, senderSessionQuery } from "../../app/queries";

/**
 * Returns how to show the agent of session `senderSessionId` as the sender of
 * a message or a queued input, or `"loading"` while the sender is still being
 * read. The desktop app's hook of the same name returns the same values.
 *
 * Every message and row from one sender shares one cached read, which the
 * thread's loader has usually made already, so a thread reads each sender
 * once, however many messages it sent. The read never suspends and never
 * throws: a sender that first appears while the thread streams must not hold
 * up the transcript, and a sender that cannot be read, for any reason, is
 * shown as "another agent" rather than as an error.
 */
export function useSenderReading(senderSessionId: string): SenderReading | "loading" {
  const { client } = useRouteContext({ from: "/_shell" });
  const sender = useQuery(senderSessionQuery(client, senderSessionId));
  const assistants = useQuery(assistantsQuery(client));
  // Until both reads have answered, the name is not known: showing the
  // session's title first and the assistant's name a moment later, or
  // "another agent" before the read lands, would print a name that is wrong.
  if (sender.isPending || assistants.isPending) return "loading";
  return describeSender(senderSessionId, sender.data ?? null, assistants.data?.items ?? []);
}
