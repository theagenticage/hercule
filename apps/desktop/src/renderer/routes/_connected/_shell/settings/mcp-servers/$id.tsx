import { useCallback, type JSX } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { isNotFound, RequestError } from "@hercule/client-core";
import { rememberSettingsSection } from "../../../../../app/last-settings-section";
import {
  mcpServerQuery,
  mcpServersQuery,
  readOnOpen,
  settingsQuery,
} from "../../../../../app/queries";
import { McpServerPage } from "./-server-page";

/**
 * Returns whether a read of a server's page failed because the address names
 * no server: the controller answers `not_found` for an id nothing holds, and
 * the client refuses text that is no id at all before it sends anything.
 */
const namesNoServer = (error: unknown): boolean =>
  isNotFound(error) || error instanceof RequestError;

/**
 * Settings > MCP servers, the page of one server (spec 17 §Settings, MCP
 * servers): its heading with the source (the plugin, or "Added by URL") and the address, the status band
 * with its one button, the Server section, Tools, Projects and Remove. The
 * header reads "Settings / MCP servers / <name>", with the list linked, and
 * has nothing on the right.
 *
 * The section's layout holds the `mcpServer` topic, which keeps the server
 * current, so the loader reads it only when it is not cached yet; the
 * controller's first push on the topic reads it again. The loader also reads
 * the list of servers, and the default list each time the page opens, which
 * the Projects section needs. An id that names no server goes back to the list, and so does a
 * page whose server is deleted while it is open. The section remembers its
 * list, never one server's page.
 */
export const Route = createFileRoute("/_connected/_shell/settings/mcp-servers/$id")({
  staticData: { title: "MCP servers" },
  loader: async ({ context: { controller, queryClient }, params: { id } }) => {
    const { client } = controller;
    try {
      await Promise.all([
        queryClient.ensureQueryData(mcpServerQuery(client, id)),
        queryClient.ensureQueryData(mcpServersQuery(client)),
        // The Projects section shows the default list, which no push keeps current.
        readOnOpen(queryClient, settingsQuery(client)),
      ]);
    } catch (error) {
      if (!namesNoServer(error)) throw error;
      // oxlint-disable-next-line typescript/only-throw-error -- the router's way to redirect
      throw redirect({ to: "/settings/mcp-servers", replace: true });
    }
  },
  onEnter: () => {
    rememberSettingsSection("/settings/mcp-servers");
  },
  component: McpServerRoute,
});

function McpServerRoute(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const { id } = Route.useParams();
  const navigate = Route.useNavigate();
  const leave = useCallback(
    () => navigate({ to: "/settings/mcp-servers", replace: true }),
    [navigate],
  );
  return <McpServerPage client={client} id={id} onLeave={leave} />;
}
