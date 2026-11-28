import { useEffect, useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { isNotFound, readErrorMessage, type HerculeClient } from "@hercule/client-core";
import {
  buildMcpServerViews,
  buildServerSwitchTarget,
  decideServerPageSwitch,
  decideStatusBand,
  describeServerPageFields,
  describeSignInRow,
  type SignInEntry,
} from "@hercule/client-core/mcp-servers";
import { useMcpServerSwitch } from "../../../../../app/mcp-server-switch";
import {
  connectionsQuery,
  mcpServerQuery,
  mcpServersQuery,
  pluginsQuery,
} from "../../../../../app/queries";
import {
  ServerHead,
  ServerSection,
  ToolsSection,
} from "../../../../../screens/settings/mcp-servers/server-page";
import { SettingsHeaderTitle } from "../../../../../screens/settings/settings-frame";
import { ProjectBoxes } from "./-project-boxes";
import { RemoveSection } from "./-remove-section";
import { ServerDialogs } from "./-server-dialogs";

/**
 * Renders the page of the server `id`: its heading with the source and the
 * address, the status band with its one button, the Server section, Tools,
 * Projects and Remove, and the sign-in and Connection dialogs the band opens.
 *
 * Once the page has drawn, a failed read keeps the server it read last. A read
 * that finds no server means it was deleted, here or elsewhere: the page calls
 * `onLeave`, which goes back to the list, then drops the deleted server's read.
 */
export function McpServerPage({
  client,
  id,
  onLeave,
}: {
  readonly client: HerculeClient;
  readonly id: string;
  readonly onLeave: () => Promise<void>;
}): JSX.Element {
  const queryClient = useQueryClient();
  const query = useSuspenseQuery(mcpServerQuery(client, id));
  // Once the page has drawn, a failed read keeps the server it read last. A
  // read that finds no server means it was deleted, here or elsewhere. The
  // page leaves, then drops the deleted server's read.
  const deleted = isNotFound(query.error);
  useEffect(() => {
    if (!deleted) return;
    void onLeave().then(() => {
      queryClient.removeQueries({ queryKey: mcpServerQuery(client, id).queryKey });
    });
  }, [deleted, onLeave, queryClient, client, id]);
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  // One server in, one view out.
  const view = buildMcpServerViews([query.data], connections, plugins)[0]!;
  // A server added by URL shows its whole address, a plugin's server the address its plugin offers.
  const fields = describeServerPageFields(view, plugins);
  const flip = useMcpServerSwitch(buildServerSwitchTarget(query.data), query.data.id);
  // The switch shows the server's record in the list of servers, the value a
  // press is decided on. While this page's own read shows another value, it
  // waits, so a press never lands on an old value.
  const catalogued = useSuspenseQuery(mcpServersQuery(client)).data.find((each) => each.id === id);
  const pageSwitch = decideServerPageSwitch({
    page: query.data,
    catalogued,
    pageReadFailed: query.isError,
    reload: "Reopen the page",
  });
  const check = useMutation({
    mutationFn: () => client.mcpServer.check({ params: { id } }),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: mcpServersQuery(client).queryKey, exact: true }),
        queryClient.invalidateQueries({
          queryKey: mcpServerQuery(client, id).queryKey,
          exact: true,
        }),
      ]);
    },
  });
  const [reconnecting, setReconnecting] = useState(false);
  // The token dialog is the page's one sign-in for a server added by URL. It is opened by the band's
  // button, "Replace token…" or "Sign in again…", and keeps the button that did, as its entry.
  const [signingIn, setSigningIn] = useState<SignInEntry | null>(null);
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
        fields={fields}
        band={band}
        busy={check.isPending}
        onBandAction={(action) => {
          if (action.kind === "check") startCheck();
          else if (action.kind === "sign-in") setSigningIn("sign-in");
          else setReconnecting(true);
        }}
      />
      <ServerSection
        view={view}
        plugins={plugins}
        switchOn={pageSwitch.on}
        switchBusy={flip.blocked || pageSwitch.waitReason !== null}
        switchError={flip.problem ?? pageSwitch.waitReason}
        checkBusy={check.isPending}
        checkError={check.error === null ? null : readErrorMessage(check.error)}
        onFlipSwitch={() => {
          flip.press(!pageSwitch.on);
        }}
        onCheck={startCheck}
        onOpenSignIn={() => setSigningIn(describeSignInRow(view)?.action?.kind ?? "sign-in")}
      />
      <ToolsSection view={view} />
      <ProjectBoxes view={view} />
      <RemoveSection view={view} />
      <ServerDialogs
        view={view}
        plugins={plugins}
        signingIn={signingIn}
        onCloseSignIn={() => setSigningIn(null)}
        reconnecting={reconnecting}
        onCloseReconnect={() => setReconnecting(false)}
      />
    </div>
  );
}
