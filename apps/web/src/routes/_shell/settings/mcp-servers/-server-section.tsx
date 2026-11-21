import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  describeAge,
  queryKeys,
  readErrorMessage,
  showsAccountBesideLabel,
  type HerculeClient,
} from "@hercule/client-core";
import type { PluginDetail } from "@hercule/contract";
import type { McpServerView } from "@hercule/client-core/mcp-servers";
import { Button, FormCard, Row, Switch, useMinuteClock } from "@hercule/ui";
import { ProviderMark } from "../../../../screens/provider-mark";

/**
 * The "Server" card of a server's page: the switch that offers it to threads,
 * its read-only name, the Connection it is reached with, and when it was last
 * checked. The card owns the switch's write, which changes only this server.
 *
 * Check now is the page's, because the status band asks for the same check,
 * so `onCheck` and `checkPending` come from the page. It is unavailable while
 * the server is checking or off.
 */
export function ServerSection({
  client,
  view,
  plugins,
  onCheck,
  checkPending,
}: {
  readonly client: HerculeClient;
  readonly view: McpServerView;
  readonly plugins: readonly PluginDetail[];
  readonly onCheck: () => void;
  readonly checkPending: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  const now = useMinuteClock();
  const { server, connection } = view;

  const offer = useMutation({
    mutationFn: (enabled: boolean) =>
      client.mcpServer.update({ params: { id: server.id }, payload: { enabled } }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mcpServer(server.id) }),
      ]),
  });

  const cannotCheck =
    checkPending || view.displayStatus === "checking" || view.displayStatus === "off";

  return (
    <FormCard label="Server">
      <Row label="Offered to threads" htmlFor="mcp-server-offered">
        <div className="flex flex-col gap-1">
          <Switch
            id="mcp-server-offered"
            aria-disabled={offer.isPending}
            checked={server.enabled}
            onCheckedChange={(enabled) => {
              offer.mutate(enabled);
            }}
          />
          <p className="text-fine text-faint">
            Off keeps the name, the sign-in and the projects that name it.
          </p>
          {offer.error === null ? null : (
            <p className="text-fine text-fail" role="alert">
              {readErrorMessage(offer.error)}
            </p>
          )}
        </div>
      </Row>

      <Row label="Name">
        <div className="flex flex-col gap-1">
          <code className="font-mono text-row text-ink">{server.name}</code>
          <p className="text-fine text-faint">
            Agents see its tools as{" "}
            <code className="font-mono">{`mcp__tools__${server.name}__<tool>`}</code>.
          </p>
        </div>
      </Row>

      <Row label="Connection">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <ProviderMark pluginId={view.pluginId} plugins={plugins} />
            <span className="min-w-0 truncate text-ink">
              {connection === undefined ? "Not found" : `${view.typeName} · ${connection.label}`}
            </span>
            {connection !== undefined && showsAccountBesideLabel(connection) ? (
              <span className="min-w-0 truncate text-fine text-muted">
                {connection.displayName}
              </span>
            ) : null}
            {/* While the server needs sign-in the band holds the page's one
                button, so this row says only what is wrong. */}
            {view.displayStatus === "needs-sign-in" ? (
              <span className="ml-auto text-fine text-fail">
                {server.statusDetail ?? "needs sign-in"}
              </span>
            ) : (
              <Link
                to="/connections"
                className="ml-auto text-fine text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
              >
                Open
              </Link>
            )}
          </div>
          <p className="text-fine text-faint">
            The sign-in it acts through. No token leaves the controller.
          </p>
        </div>
      </Row>

      <Row label="Last checked">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-ink">
              {server.checkedAt === null ? "Not checked yet" : describeAge(server.checkedAt, now)}
            </span>
            <Button
              variant="form"
              className="ml-auto"
              aria-disabled={cannotCheck}
              onClick={onCheck}
            >
              Check now
            </Button>
          </div>
          <p className="text-fine text-faint">
            Hercule lists the tools again once a day, and when the Connection or the sign-in
            changes.
          </p>
        </div>
      </Row>
    </FormCard>
  );
}
