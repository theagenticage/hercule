import type { JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { describeAge, showsAccountBesideLabel, type HerculeClient } from "@hercule/client-core";
import type { PluginDetail } from "@hercule/contract";
import {
  buildServerSwitchTarget,
  decideServerPageSwitch,
  describeConnectionRowProblem,
  isCheckDisabled,
  type McpServerView,
} from "@hercule/client-core/mcp-servers";
import { Button, FormCard, Row, Switch, useMinuteClock } from "@hercule/ui";
import { useMcpServerSwitch } from "../../../../app/mcp-server-switch";
import { mcpServerQuery, mcpServersQuery } from "../../../../app/queries";
import { ProviderMark } from "../../../../screens/provider-mark";

/**
 * The "Server" card of a server's page: the switch that offers it to threads,
 * its read-only name, the Connection it is reached with, and when it was last
 * checked. The card owns the switch's write, which changes only this server.
 *
 * The switch shows the server's record in the list of servers, the value a
 * press is decided on. While the page's own read of the server shows another
 * value, because it is still being read again or the read failed, the switch
 * is unavailable and says why, so it is never pressed on an old value.
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
  const now = useMinuteClock();
  const { server, connection } = view;

  // The same target as the server's row in the list, so the two share one guard.
  const switchServer = useMcpServerSwitch(client, buildServerSwitchTarget(server));
  const catalogued = useSuspenseQuery(mcpServersQuery(client)).data.items.find(
    ({ id }) => id === server.id,
  );
  const pageRead = useQuery(mcpServerQuery(client, server.id));
  const pageSwitch = decideServerPageSwitch({
    page: server,
    catalogued,
    pageReadFailed: pageRead.isError,
    reload: "Reload the page",
  });
  const switchWaits = switchServer.blocked || pageSwitch.waitReason !== null;
  const switchProblem = switchServer.problem ?? pageSwitch.waitReason;

  const cannotCheck = checkPending || isCheckDisabled(view);
  const connectionProblem = describeConnectionRowProblem(view);

  return (
    <FormCard label="Server">
      <Row label="Offered to threads" htmlFor="mcp-server-offered">
        <div className="flex flex-col gap-1">
          <Switch
            id="mcp-server-offered"
            aria-disabled={switchWaits}
            checked={pageSwitch.on}
            onCheckedChange={switchServer.press}
          />
          <p className="text-fine text-faint">
            Off keeps the name, the sign-in and the projects that name it.
          </p>
          {switchProblem === null ? null : (
            <p className="text-fine text-fail" role="alert">
              {switchProblem}
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
            {connectionProblem !== null ? (
              <span className="ml-auto text-fine text-fail">{connectionProblem}</span>
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
