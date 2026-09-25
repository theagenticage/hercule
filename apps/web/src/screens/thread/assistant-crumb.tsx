import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { answeredAssistantQuery } from "../../app/queries";

/**
 * The crumb of an assistant's session: "Assistants", linking to the
 * assistant's conversation, or plain text once the assistant was deleted.
 */
export function AssistantCrumb({
  client,
  assistantId,
}: {
  readonly client: HerculeClient;
  readonly assistantId: string;
}): JSX.Element {
  const assistant = useSuspenseQuery(answeredAssistantQuery(client, assistantId)).data;
  if (assistant === null) return <>Assistants</>;
  return (
    <Link
      to="/assistants/$assistantId"
      params={{ assistantId }}
      className="rounded-control hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
    >
      Assistants
    </Link>
  );
}
