import { Fragment, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, cn } from "@hercule/ui";
import {
  queryKeys,
  showsAccountBesideLabel,
  showsPluginName,
  type ConnectionType,
  type HerculeClient,
  readErrorMessage,
} from "@hercule/client-core";
import type { Connection, ConnectionStatus } from "@hercule/contract";
import { InPlaceQuestion } from "../../../screens/in-place-question";
import { SaveStatus } from "../../../screens/save-status";
import { ConfigureConnection } from "./-configure";
import { ConnectionSetup } from "./-setup";

/**
 * The text colour of each connection status. `connected` is the working state,
 * so it uses the live colour. The user can fix `needs-reauth`, so it uses the
 * attention colour rather than the failure colour.
 */
const STATUS_HUE: Record<ConnectionStatus, string> = {
  connected: "text-live",
  "needs-reauth": "text-attn",
  error: "text-fail",
  disabled: "text-muted",
};

/** The panel open under the row's facts. At most one is open at a time. */
type Panel = "none" | "reconnect" | "configure" | "delete";

/**
 * The row for one connection: its account, its status, and the actions
 * Reconnect, Configure and Delete. The row owns those mutations, because each
 * one changes only this connection and nothing above the row needs to know.
 */
export function ConnectionRow({
  client,
  connection,
  type,
}: {
  readonly client: HerculeClient;
  readonly connection: Connection;
  /** Absent when the plugin that declared the type is no longer in the binary. */
  readonly type: ConnectionType | undefined;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [panel, setPanel] = useState<Panel>("none");

  /**
   * The parts of the secondary line: the plugin that declares the type, the
   * account, and the connection's topic. Each part is left out when it adds
   * nothing:
   *
   * - The plugin tells apart two plugins that declare the same type name, so
   *   it is left out when it is named like the type above.
   * - The account is left out when the name above already shows it, or when
   *   the account has no name.
   * - The topic is left out when the connection has none.
   *
   * The line is built from parts so that each separator is its own element,
   * spaced by the row's gap rather than by spaces in the text.
   */
  const facts = [
    ...(type === undefined || !showsPluginName(type)
      ? []
      : [{ key: "plugin", text: type.pluginName, tone: "text-faint" }]),
    ...(showsAccountBesideLabel(connection)
      ? [{ key: "account", text: connection.displayName, tone: "text-muted" }]
      : []),
    ...(connection.labels[0] === undefined
      ? []
      : [{ key: "topic", text: connection.labels[0], tone: "text-faint" }]),
  ];

  const remove = useMutation({
    mutationFn: () => client.connection.delete({ params: { id: connection.id } }),
    // The list is fetched again rather than patched, because a delete also
    // removes the connection's secrets.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.connections() }),
  });

  const close = (): void => {
    setPanel("none");
  };

  return (
    <li className="flex flex-col gap-1.5 px-2.5 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-row">
        <b className="font-emph text-ink">{type?.displayName ?? connection.type}</b>
        <span className="min-w-0 flex-1 truncate text-muted">{connection.label}</span>
        <span className={cn("text-fine", STATUS_HUE[connection.status])}>{connection.status}</span>
        <div className="flex items-center gap-1.5">
          {/* A working connection has nothing to reconnect. */}
          {connection.status === "connected" || type === undefined ? null : (
            <Button
              onClick={() => {
                setPanel("reconnect");
              }}
            >
              Reconnect
            </Button>
          )}
          <Button
            onClick={() => {
              setPanel("configure");
            }}
          >
            Configure
          </Button>
          <Button
            disabled={panel === "delete" || remove.isPending}
            onClick={() => {
              setPanel("delete");
            }}
          >
            Delete
          </Button>
        </div>
      </div>

      {/* With every part left out there are no facts, and an empty line
          would leave a gap. */}
      {facts.length === 0 ? null : (
        <div className="flex flex-wrap items-baseline gap-x-1.5 pt-px text-fine">
          {facts.map((fact, index) => (
            <Fragment key={fact.key}>
              {index === 0 ? null : <span className="text-faint">·</span>}
              <span className={fact.tone}>{fact.text}</span>
            </Fragment>
          ))}
        </div>
      )}

      {connection.statusDetail === undefined ? null : (
        <p className="text-fine text-muted">{connection.statusDetail}</p>
      )}

      {panel === "reconnect" && type !== undefined ? (
        <ConnectionSetup client={client} type={type} connection={connection} onDone={close} />
      ) : null}

      {panel === "configure" ? (
        <ConfigureConnection client={client} connection={connection} type={type} onDone={close} />
      ) : null}

      {panel === "delete" ? (
        <InPlaceQuestion
          question={`Remove this connection? Hercule forgets its credentials but does not revoke them at ${type?.displayName ?? "the provider"}. Revoke them there if they are no longer needed.`}
          // Every word matters here, so the question wraps rather than being cut short.
          stacked
          declineLabel="Cancel"
          acceptLabel="Confirm"
          onDecline={close}
          onAccept={() => {
            close();
            remove.mutate();
          }}
        />
      ) : null}

      {/* A successful delete removes the row, so only a failure is shown here. */}
      <SaveStatus
        saved={false}
        failure={remove.error === null ? null : readErrorMessage(remove.error)}
      />
    </li>
  );
}
