import { useState, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { Connection, McpServer } from "@hercule/contract";
import {
  decideReplaceChoice,
  describeReplaceDialog,
  describeReplaceTitle,
  findReplaceCandidates,
  type OfferedServer,
} from "@hercule/client-core/mcp-servers";
import { buildButtonClassName, Button, ChoiceInput } from "@hercule/ui";
import type { McpServerSwitch } from "../../app/mcp-server-switch";
import { mcpServersQuery } from "../../app/queries";
import { ModalDialog } from "../modal-dialog";

/**
 * The Replace dialog: moves a server the user added by URL onto the Connection
 * of the plugin that offers the same server, in one write that also switches
 * it on. Its id, name and every list that names it stay; the sign-in made by
 * hand goes.
 *
 * - `candidates` are the servers added by URL on the offer's address when the
 *   switch was pressed. With several, the user chooses which one to replace,
 *   starting from the first. The choices follow the servers as they are now.
 * - What the user confirmed stays fixed. When the chosen server is deleted or
 *   moved meanwhile, the dialog says so and writes nothing: a server that
 *   appeared since is a new choice, and needs a new press of Replace.
 * - A refusal of the write shows here, with a link to the server that won when
 *   the controller named one.
 *
 * The dialog does not close itself when the write succeeds: the caller closes
 * it once the offer has a record.
 */
export function ReplaceDialog({
  client,
  candidates,
  offer,
  connection,
  typeName,
  switchServer,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly candidates: readonly McpServer[];
  readonly offer: OfferedServer["offer"];
  readonly connection: Connection;
  /** The display name of the Connection's type, such as "Sentry". */
  readonly typeName: string;
  /** The switch of the offer, which writes the Replace and holds its refusal. */
  readonly switchServer: McpServerSwitch;
  readonly onClose: () => void;
}): JSX.Element {
  const servers = useSuspenseQuery(mcpServersQuery(client)).data.items;
  const [chosenId, setChosenId] = useState<string | null>(candidates[0]?.id ?? null);
  const choice =
    chosenId === null ? null : decideReplaceChoice({ offer, servers, chosenServerId: chosenId });
  const chosen = choice?.kind === "chosen" ? choice.server : null;
  // The servers that qualify now, so a deleted one is never offered and a new one is, to be chosen.
  const options = findReplaceCandidates(offer, servers);
  const words =
    chosen === null ? null : describeReplaceDialog({ server: chosen, connection, typeName });
  const { replaceRefusal } = switchServer;
  const winner =
    replaceRefusal?.winnerServerId == null
      ? undefined
      : servers.find((server) => server.id === replaceRefusal.winnerServerId);

  return (
    <ModalDialog title={describeReplaceTitle(words)} onClose={onClose}>
      {choice?.kind === "changed" ? (
        <p className="text-row text-fail" role="alert">
          The server you chose is gone, or is not added by URL on this address any more. Nothing was
          replaced.
          {options.length === 0 ? "" : " Choose again."}
        </p>
      ) : null}
      {words === null ? null : <p className="text-row text-muted">{words.body}</p>}
      {options.length > 1 || choice?.kind === "changed" ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">Server to replace</legend>
          {options.map((server) => (
            <label
              key={server.id}
              className="flex cursor-pointer items-center gap-2.5 rounded-control px-1.5 py-1.5 text-row hover:bg-line-soft"
            >
              <ChoiceInput
                type="radio"
                name="mcp-replace-server"
                checked={chosenId === server.id}
                onChange={() => {
                  setChosenId(server.id);
                }}
              />
              <span className="min-w-0 flex-1">
                <b className="block truncate font-emph text-ink">{server.name}</b>
                <small className="block truncate text-fine text-muted">
                  {server.source.kind === "url" ? server.source.url : ""}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {words === null ? null : (
        <ul className="flex flex-col gap-1 text-row">
          {words.lines.map((line) => (
            <li key={line.label} className="text-muted">
              <b className="font-emph text-ink">{line.label}:</b> {line.text}
            </li>
          ))}
        </ul>
      )}
      {replaceRefusal === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {replaceRefusal.message}
          {replaceRefusal.winnerServerId === null ? null : (
            <>
              {" "}
              <Link
                to="/settings/mcp-servers/$id"
                params={{ id: replaceRefusal.winnerServerId }}
                onClick={onClose}
                className={buildButtonClassName("quiet", "px-1 py-0.5 text-fine")}
              >
                {winner === undefined ? "Open server" : `Open ${winner.name}`}
              </Link>
            </>
          )}
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5 border-t border-line-soft pt-3">
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="form"
          disabled={chosen === null}
          aria-disabled={switchServer.blocked}
          onClick={() => {
            if (chosen !== null && !switchServer.blocked) switchServer.replace(chosen.id);
          }}
        >
          Replace
        </Button>
      </div>
    </ModalDialog>
  );
}
