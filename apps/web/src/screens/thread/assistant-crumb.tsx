import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { answeredAssistantQuery } from "../../app/queries";

/**
 * Renders the crumb of an assistant's session: "Assistants / <name>", where
 * the name links to the assistant's conversation. Once the assistant was
 * deleted, the crumb is the plain text "Assistants", because there is no
 * name to show and no conversation to open.
 *
 * "Assistants" itself is plain text, as on the conversation screen: there is
 * no list of assistants to go back to yet.
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
    <>
      Assistants <span aria-hidden="true">/</span>{" "}
      <Link
        to="/assistants/$assistantId"
        params={{ assistantId }}
        className="rounded-control hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
      >
        {assistant.name}
      </Link>
    </>
  );
}
