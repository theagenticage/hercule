import { useState, type JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { isNotFound, queryKeys, readErrorMessage, type HerculeClient } from "@hercule/client-core";
import { describeServerRemoval, type McpServerView } from "@hercule/client-core/mcp-servers";
import { Button, FormCard } from "@hercule/ui";
import { projectsQuery, settingsQuery } from "../../../../app/queries";
import { InPlaceQuestion } from "../../../../screens/in-place-question";
import { SaveStatus } from "../../../../screens/save-status";
import { CardHeading } from "./-card-heading";

/**
 * The "Remove" card of a server's page. The button opens a question in place
 * that names the projects that name the server and says what the removal
 * does. Confirming deletes the server and goes back to the list. A delete
 * that finds the server already gone goes back to the list too, because the
 * page shows a server that no longer exists. Either way the page's own read is
 * dropped from the cache once the page has been left, so opening its address
 * again never paints the deleted server.
 */
export function Remove({
  client,
  view,
}: {
  readonly client: HerculeClient;
  readonly view: McpServerView;
}): JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  const projects = useSuspenseQuery(projectsQuery(client)).data.items;
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const { server, connection } = view;

  const leave = async (): Promise<void> => {
    await navigate({ to: "/settings/mcp-servers", replace: true });
    queryClient.removeQueries({ queryKey: queryKeys.mcpServer(server.id), exact: true });
  };
  const remove = useMutation({
    mutationFn: () => client.mcpServer.delete({ params: { id: server.id } }),
    onSuccess: async () => {
      // Deleting a server takes it out of every project's list too.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.settings() }),
      ]);
      await leave();
    },
    onError: async (error) => {
      if (!isNotFound(error)) return;
      // Someone else deleted the server first: the list drops it too.
      await queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers() });
      await leave();
    },
  });

  const wording = describeServerRemoval(
    server.id,
    projects,
    settings.user["thread.mcpServerIds"] ?? [],
  );
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
            {wording.naming} {wording.effect}
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
