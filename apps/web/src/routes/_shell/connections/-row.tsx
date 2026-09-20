import { Fragment, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, cn } from "@hercule/ui";
import { queryKeys, type ConnectionType, type HydraClient } from "@hercule/client-core";
import type { Connection, ConnectionStatus } from "@hercule/contract";
import { SaveStatus, messageOf } from "../../../screens/save-status";
import { ConfigureConnection } from "./-configure";
import { ConnectionSetup } from "./-setup";

/**
 * `connected` is the working state and wears the live hue; `needs-reauth` is
 * the user's to fix, so it is the attention hue rather than a failure.
 */
const STATUS_HUE: Record<ConnectionStatus, string> = {
  connected: "text-live",
  "needs-reauth": "text-attn",
  error: "text-fail",
  disabled: "text-muted",
};

/** What the row is showing under its facts: at most one thing at a time. */
type Panel = "none" | "reconnect" | "configure" | "delete";

/**
 * One connection: which account it is, where it stands, and the three things
 * that can be done to it. The row owns those writes, because each is about this
 * connection and nothing above it needs to know one happened.
 */
export function ConnectionRow({
  client,
  connection,
  type,
}: {
  readonly client: HydraClient;
  readonly connection: Connection;
  /** Absent when the plugin that declared the type is no longer in the binary. */
  readonly type: ConnectionType | undefined;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [panel, setPanel] = useState<Panel>("none");

  /**
   * The quiet line, part by part: the plugin that declares the type, the
   * account, and the topic it files into. The plugin leads, because two plugins
   * may declare one type name and the name above says nothing about which this
   * is. Assembled rather than written out so the separators are one element
   * each, spaced by the row's own gap and never by a space inside the text.
   */
  const facts = [
    ...(type === undefined ? [] : [{ key: "plugin", text: type.pluginName, tone: "text-faint" }]),
    { key: "account", text: connection.displayName, tone: "text-muted" },
    ...(connection.labels[0] === undefined
      ? []
      : [{ key: "topic", text: connection.labels[0], tone: "text-faint" }]),
  ];

  const remove = useMutation({
    mutationFn: () => client.connection.delete({ params: { id: connection.id } }),
    // The row is gone from the listing, which is read again rather than
    // patched: a delete takes the connection's secrets with it.
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

      <div className="flex flex-wrap items-baseline gap-x-1.5 pt-px text-fine">
        {facts.map((fact, index) => (
          <Fragment key={fact.key}>
            {index === 0 ? null : <span className="text-faint">·</span>}
            <span className={fact.tone}>{fact.text}</span>
          </Fragment>
        ))}
      </div>

      {connection.statusDetail === undefined ? null : (
        <p className="text-fine text-muted">{connection.statusDetail}</p>
      )}

      {panel === "reconnect" && type !== undefined ? (
        <ConnectionSetup client={client} type={type} connection={connection} onDone={close} />
      ) : null}

      {panel === "configure" ? (
        <ConfigureConnection client={client} connection={connection} type={type} onDone={close} />
      ) : null}

      {/* Asked in place rather than behind a browser dialog, like every other
          question this app puts to the reader. */}
      {panel === "delete" ? (
        <div className="flex flex-wrap items-center gap-1.5 text-row text-muted">
          <span>Remove this connection? Its stored credentials go with it.</span>
          <Button
            variant="primary"
            onClick={() => {
              close();
              remove.mutate();
            }}
          >
            Confirm
          </Button>
          <Button onClick={close}>Cancel</Button>
        </div>
      ) : null}

      {/* A delete that worked takes the row with it, so only a refusal has
          anywhere to land. */}
      <SaveStatus saved={false} failure={remove.error === null ? null : messageOf(remove.error)} />
    </li>
  );
}
