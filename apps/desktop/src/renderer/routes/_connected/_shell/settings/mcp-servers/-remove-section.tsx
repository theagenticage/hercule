import { useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { formatNameList, isNotFound, readErrorMessage } from "@hercule/client-core";
import type { McpServerView } from "@hercule/client-core/mcp-servers";
import {
  mcpServerQuery,
  mcpServersQuery,
  projectsQuery,
  settingsQuery,
} from "../../../../../app/queries";
import { ConfirmDialog } from "../../../../../screens/confirm-dialog";

/**
 * Renders the Remove section of the page of the server `view`, its last
 * section (spec 17 §Settings, MCP servers). "Remove server…" asks for a
 * confirmation that names the projects that name the server, and says what
 * removing does. A refusal by the controller stays in the dialog.
 *
 * Once the controller has deleted the server, the page goes to the list. The
 * server's own read is then dropped, so a server that has this id can never
 * show the deleted one first. The same happens when the controller answers
 * `not_found`, because another client deleted the server first: the page
 * leaves rather than keep a server that is gone. The projects and the default
 * list, which the controller has rewritten without the server, are read again.
 */
export function RemoveSection({ view }: { readonly view: McpServerView }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  const { server, connection } = view;
  const written = view.account === undefined ? server.name : `${server.name} ${view.account}`;
  const leaveDeletedServer = async (): Promise<void> => {
    dialogRef.current?.close();
    // The page leaves before its read is dropped: the page reads the
    // server, and would otherwise read it again and fail.
    await navigate({ to: "/settings/mcp-servers" });
    queryClient.removeQueries({ queryKey: mcpServerQuery(client, server.id).queryKey });
  };
  const remove = useMutation({
    mutationFn: () => client.mcpServer.delete({ params: { id: server.id } }),
    onSuccess: leaveDeletedServer,
    onError: async (error) => {
      if (isNotFound(error)) await leaveDeletedServer();
    },
    // The refusal may mean the server is already gone, so the list is out of date.
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: mcpServersQuery(client).queryKey, exact: true }),
        queryClient.invalidateQueries({ queryKey: projectsQuery(client).queryKey, exact: true }),
        queryClient.invalidateQueries({ queryKey: settingsQuery(client).queryKey, exact: true }),
      ]);
    },
  });
  return (
    <section className="set-sec">
      <h2>{`Remove ${server.name}`}</h2>
      <p>
        {connection === undefined
          ? "Deletes the server. Projects that name it stop naming it."
          : `Deletes the server. Projects that name it stop naming it. The Connection ${view.typeName} · ${connection.label} stays.`}
      </p>
      <button
        type="button"
        className="btn btn--danger"
        onClick={() => {
          remove.reset();
          setConfirming(true);
        }}
      >
        Remove server…
      </button>
      {confirming && (
        <ConfirmDialog
          dialogRef={dialogRef}
          title={`Remove ${written}?`}
          actionLabel={remove.isPending ? "Removing…" : "Remove"}
          actionClass="danger"
          initialFocus="close"
          pending={remove.isPending}
          error={
            remove.error === null ? null : `Could not remove: ${readErrorMessage(remove.error)}`
          }
          onConfirm={() => {
            remove.mutate();
          }}
          onClose={() => setConfirming(false)}
        >
          <NamingProjects view={view} />
        </ConfirmDialog>
      )}
    </section>
  );
}

/**
 * Renders what removing the server of `view` does: which lists name it, and
 * that every project's list and every thread's list drops it. The lists are
 * read when the dialog opens, which is when the user decides.
 */
function NamingProjects({ view }: { readonly view: McpServerView }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const names = [
    ...projects
      .filter((project) => project.mcpServerIds.includes(view.server.id))
      .map((project) => project.name),
    ...((settings.user["thread.mcpServerIds"] ?? []).includes(view.server.id)
      ? ["threads without a project"]
      : []),
  ];
  return (
    <p>
      {names.length === 0
        ? "No project names it. "
        : `${formatNameList(names, "and")} ${names.length === 1 ? "names" : "name"} it. `}
      Every project's list and every thread's list drops it, and a running thread loses its tools at
      once.
    </p>
  );
}
