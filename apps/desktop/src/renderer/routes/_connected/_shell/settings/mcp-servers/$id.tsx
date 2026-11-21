import { Suspense, useEffect, useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  isNotFound,
  listConnectionTypes,
  readErrorMessage,
  RequestError,
} from "@hercule/client-core";
import {
  buildMcpServerViews,
  decideStatusBand,
  readMcpServerOffers,
} from "@hercule/client-core/mcp-servers";
import { rememberSettingsSection } from "../../../../../app/last-settings-section";
import {
  connectionsQuery,
  mcpServerQuery,
  mcpServersQuery,
  pluginsQuery,
  settingsQuery,
} from "../../../../../app/queries";
import { LazyConnectionSetupDialog } from "../../../../../screens/settings/connections/lazy-connection-setup-dialog";
import {
  describeOfferAddress,
  ServerHead,
  ServerSection,
  ToolsSection,
} from "../../../../../screens/settings/mcp-servers/server-page";
import { SettingsHeaderTitle } from "../../../../../screens/settings/settings-frame";
import { ProjectBoxes } from "./-project-boxes";
import { RemoveSection } from "./-remove-section";
import { readServersAgain } from "./-keep-server";
import { useServerSwitch } from "./-switch-server";

/**
 * Returns whether a read of a server's page failed because the address names
 * no server: the controller answers `not_found` for an id nothing holds, and
 * the client refuses text that is no id at all before it sends anything.
 */
const namesNoServer = (error: unknown): boolean =>
  isNotFound(error) || error instanceof RequestError;

/**
 * Settings > MCP servers, the page of one server (spec 17 §Settings, MCP
 * servers): its heading with the plugin and the address, the status band
 * with its one button, the Server section, Tools, Projects and Remove. The
 * header reads "Settings / MCP servers / <name>", with the list linked, and
 * has nothing on the right.
 *
 * The section's layout holds the `mcpServer` topic, which keeps the server
 * current, so the loader reads it only when it is not cached yet; the
 * controller's first push on the topic reads it again. The loader also reads
 * the list of servers and the default list, which the Projects section
 * needs. An id that names no server goes back to the list, and so does a
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
        queryClient.ensureQueryData(settingsQuery(client)),
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
  component: McpServerPage,
});

function McpServerPage(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const { id } = Route.useParams();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const query = useSuspenseQuery(mcpServerQuery(client, id));
  // Once the page has drawn, a failed read keeps the server it read last. A
  // read that finds no server means it was deleted, here or elsewhere. The
  // page leaves, then drops the deleted server's read.
  const deleted = isNotFound(query.error);
  useEffect(() => {
    if (!deleted) return;
    void navigate({ to: "/settings/mcp-servers", replace: true }).then(() => {
      queryClient.removeQueries({ queryKey: mcpServerQuery(client, id).queryKey });
    });
  }, [deleted, navigate, queryClient, client, id]);
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  // One server in, one view out.
  const view = buildMcpServerViews([query.data], connections, plugins)[0]!;
  const offer = readMcpServerOffers(plugins).find(
    (each) => each.contributionId === query.data.source.contributionId,
  );
  const flip = useServerSwitch();
  const check = useMutation({
    mutationFn: () => client.mcpServer.check({ params: { id } }),
    onSettled: async () => {
      await readServersAgain(queryClient, client, id);
    },
  });
  const [reconnecting, setReconnecting] = useState(false);
  const connectionType = listConnectionTypes(plugins).find(
    (type) => type.type === view.connection?.type,
  );
  const band = decideStatusBand(view);
  const startCheck = (): void => {
    if (!check.isPending) check.mutate();
  };
  return (
    <div className="set-record mcp-record">
      <SettingsHeaderTitle
        parent={{ title: "MCP servers", to: "/settings/mcp-servers" }}
        title={view.server.name}
      />
      <ServerHead
        view={view}
        plugins={plugins}
        address={offer === undefined ? null : describeOfferAddress(offer.origin)}
        band={band}
        busy={check.isPending}
        onBandAction={(action) => {
          if (action.kind === "check") startCheck();
          else setReconnecting(true);
        }}
      />
      <ServerSection
        view={view}
        plugins={plugins}
        switchBusy={flip.isPending}
        switchError={flip.error === null ? null : readErrorMessage(flip.error)}
        checkBusy={check.isPending}
        checkError={check.error === null ? null : readErrorMessage(check.error)}
        onFlipSwitch={() => {
          flip.mutate({
            target: { kind: "update", serverId: id },
            on: !view.server.enabled,
          });
        }}
        onCheck={startCheck}
      />
      <ToolsSection view={view} />
      <ProjectBoxes view={view} />
      <RemoveSection view={view} />
      {reconnecting && view.connection !== undefined && connectionType !== undefined && (
        <Suspense fallback={null}>
          <LazyConnectionSetupDialog
            type={connectionType}
            connection={view.connection}
            onClose={() => setReconnecting(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
