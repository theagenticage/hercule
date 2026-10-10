import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { describeSender, type SenderReading } from "@hercule/client-core";
import { assistantsQuery, senderSessionQuery } from "../../app/queries";

/**
 * Returns how to show the agent of session `senderSessionId` as the sender of
 * a message or a queued input, or null while the sender is still being read.
 *
 * Every message and row from one sender shares one cached read, which the
 * thread's loader has usually made already. The read never suspends and
 * never throws: a sender that first appears while the thread streams must
 * not hold up the transcript, and a sender that cannot be read, for any
 * reason, is shown as "Another agent" rather than as an error. The
 * assistants are shell data, cached before any thread opens.
 */
export function useSenderReading(senderSessionId: string): SenderReading | null {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const sender = useQuery(senderSessionQuery(client, senderSessionId));
  const assistants = useQuery(assistantsQuery(client));
  // Until both reads have answered, the name is not known: showing the
  // session's title first and the assistant's name a moment later, or
  // "Another agent" before the read lands, would print a name that is wrong.
  if (sender.isPending || assistants.isPending) return null;
  return describeSender(senderSessionId, sender.data ?? undefined, assistants.data ?? []);
}
