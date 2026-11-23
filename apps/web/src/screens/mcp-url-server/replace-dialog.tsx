import { useEffect, useState, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { Connection, McpServer } from "@hercule/contract";
import {
  buildOfferSwitchTarget,
  decideReplaceChoice,
  decideReplaceLock,
  describeReplaceDialog,
  describeReplaceTitle,
  findReplaceCandidates,
  type OfferedServer,
} from "@hercule/client-core/mcp-servers";
import { buildButtonClassName, Button, ChoiceInput } from "@hercule/ui";
import { useReplaceProgress, type McpServerSwitch } from "../../app/mcp-server-switch";
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
 * - What the user confirmed stays fixed, selection and the server's name and
 *   address included, until the write and the read of the list after it are
 *   done, also when the server leaves the list meanwhile. A refusal that
 *   settled releases the selection: the reason stays, a choice that no longer
 *   qualifies is cleared, and the user chooses again, with the servers listed
 *   even when one is left. Nothing is chosen for the user then, so Replace stays
 *   off until they pick. When the chosen server
 *   is deleted or moved while the user is still choosing, the dialog says so
 *   and writes nothing: a server that appeared since is a new choice, and
 *   needs a new press of Replace.
 * - The dialog closes only when the confirmed server itself is on the offer's
 *   Connection (`replaced`). A server that another client put on the Connection
 *   meanwhile is a winner, not our success: the dialog stays with the refusal
 *   and a link to it. The same holds for a refusal of the write, with the
 *   server the controller named.
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
  const [pickedId, setPickedId] = useState<string | null>(candidates[0]?.id ?? null);
  // True once a refusal cleared the choice: the servers stay listed, also when only one is left.
  const [chooseAgain, setChooseAgain] = useState(false);
  // The servers the dialog listed when the user pressed Replace. The write can move the chosen
  // server off the list before the dialog settles, and the dialog still names it.
  const [confirmedOptions, setConfirmedOptions] = useState<readonly McpServer[] | null>(null);
  const progress = useReplaceProgress(client, buildOfferSwitchTarget({ offer, connection }));
  // The server the user confirmed stays selected until the write and the read after it are
  // done, also when a refusal (a winner) is already shown while the write is still held.
  const lockedId = decideReplaceLock(progress, switchServer.blocked);
  const confirmed = lockedId !== null;
  // The servers that qualify now, so a deleted one is never offered and a new one is, to be chosen.
  const live = findReplaceCandidates(offer, servers);
  const options = confirmed ? (confirmedOptions ?? live) : live;
  // A refusal that settled releases the selection. A choice that no longer qualifies is cleared.
  const choiceIsStale =
    pickedId !== null &&
    progress.kind === "refused" &&
    progress.serverId !== null &&
    !confirmed &&
    !live.some((server) => server.id === pickedId);
  if (choiceIsStale) {
    setPickedId(null);
    setChooseAgain(true);
  }
  const chosenId = lockedId ?? (choiceIsStale ? null : pickedId);
  const choice =
    chosenId === null
      ? null
      : confirmed
        ? {
            kind: "chosen" as const,
            server:
              options.find((server) => server.id === chosenId) ??
              candidates.find((server) => server.id === chosenId),
          }
        : decideReplaceChoice({ offer, servers, chosenServerId: chosenId });
  const replaced = progress.kind === "replaced";
  useEffect(() => {
    if (replaced) onClose();
  }, [replaced, onClose]);
  const chosen = choice?.kind === "chosen" ? (choice.server ?? null) : null;
  const words =
    chosen === null ? null : describeReplaceDialog({ server: chosen, connection, typeName });
  const refusal = progress.kind === "refused" ? progress : null;
  const winner =
    refusal?.winnerServerId == null
      ? undefined
      : servers.find((server) => server.id === refusal.winnerServerId);

  return (
    <ModalDialog title={describeReplaceTitle(words)} onClose={onClose}>
      {choice?.kind === "changed" && !confirmed ? (
        <p className="text-row text-fail" role="alert">
          The server you chose is gone, or is not added by URL on this address any more. Nothing was
          replaced.
          {options.length === 0 ? "" : " Choose again."}
        </p>
      ) : null}
      {words === null ? null : <p className="text-row text-muted">{words.body}</p>}
      {options.length > 1 ||
      (chooseAgain && options.length > 0) ||
      (choice?.kind === "changed" && !confirmed) ? (
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
                disabled={confirmed}
                onChange={() => {
                  setPickedId(server.id);
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
      {refusal === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {refusal.message}
          {refusal.winnerServerId === null ? null : (
            <>
              {" "}
              <Link
                to="/settings/mcp-servers/$id"
                params={{ id: refusal.winnerServerId }}
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
            if (chosen === null || switchServer.blocked) return;
            setConfirmedOptions(options);
            switchServer.replace(chosen.id);
          }}
        >
          Replace
        </Button>
      </div>
    </ModalDialog>
  );
}
