import { useState, type JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  formatNameList,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import type { Project } from "@hercule/contract";
import type { McpServerView } from "@hercule/client-core/mcp-servers";
import { Button, FormCard } from "@hercule/ui";
import { InPlaceQuestion } from "../../../../screens/in-place-question";
import { SaveStatus } from "../../../../screens/save-status";
import { CardHeading } from "./-card-heading";

/**
 * The "Remove" card of a server's page. The button opens a question in place
 * that names the projects that name the server and says what the removal
 * does. Confirming deletes the server and goes back to the list.
 */
export function Remove({
  client,
  view,
  projects,
}: {
  readonly client: HerculeClient;
  readonly view: McpServerView;
  /** Every project, of which the question names those whose list names the server. */
  readonly projects: readonly Project[];
}): JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  const { server, connection } = view;

  const remove = useMutation({
    mutationFn: () => client.mcpServer.delete({ params: { id: server.id } }),
    onSuccess: async () => {
      // Deleting a server takes it out of every project's list too.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.settings() }),
      ]);
      await navigate({ to: "/settings/mcp-servers", replace: true });
    },
  });

  const naming = projects.filter((project) => project.mcpServerIds.includes(server.id));
  const who = view.account === undefined ? server.name : `${server.name} ${view.account}`;

  return (
    <FormCard label={<CardHeading title="Remove" />}>
      <p className="text-fine text-faint">
        {connection === undefined
          ? "Deletes the server. Projects that name it stop naming it."
          : `Deletes the server. Projects that name it stop naming it. The Connection ${view.typeName} · ${connection.label} stays.`}
      </p>
      {asking ? (
        <InPlaceQuestion
          stacked
          question={`Remove ${who}?`}
          declineLabel="Cancel"
          acceptLabel="Remove"
          disabled={remove.isPending}
          onDecline={() => {
            setAsking(false);
          }}
          onAccept={() => {
            remove.mutate();
          }}
        >
          <p className="text-fine text-muted">
            {naming.length === 0
              ? "No project names it."
              : `${formatNameList(
                  naming.map((project) => project.name),
                  "and",
                )} name${naming.length === 1 ? "s" : ""} it.`}{" "}
            Every project's list and every thread's list drops it, and a running thread loses its
            tools at once.
          </p>
        </InPlaceQuestion>
      ) : (
        <div>
          <Button
            onClick={() => {
              setAsking(true);
            }}
          >
            Remove server…
          </Button>
        </div>
      )}
      <SaveStatus
        saved={false}
        failure={remove.error === null ? null : readErrorMessage(remove.error)}
      />
    </FormCard>
  );
}
