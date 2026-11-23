import { useEffect, useRef, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import {
  buildOfferSwitchTarget,
  decideReplaceChoice,
  describeReplaceDialog,
  describeReplaceTitle,
  findReplaceCandidates,
  type McpServerSettingsRow,
} from "@hercule/client-core/mcp-servers";
import type { McpServer } from "@hercule/contract";
import { useMcpServerSwitch } from "../../../../../app/mcp-server-switch";
import { mcpServersQuery } from "../../../../../app/queries";
import { ConfirmDialog } from "../../../../../screens/confirm-dialog";
import "../../../../../screens/settings/mcp-servers/url-server-dialogs.css";

/**
 * Renders the Replace dialog (spec 17 §Adding and replacing): the switch of
 * a plugin's server was pressed while servers added by URL sit on the
 * plugin's address, so one of them is moved onto the Connection instead of a
 * second server being made. `row` is the row whose switch was pressed, and
 * `candidates` the servers it found.
 *
 * - With one candidate the dialog asks about it. With several, the user
 *   chooses which one first, and nothing is chosen for them.
 * - Replace writes once, on the chosen server, and switches it on, because
 *   the user pressed On.
 * - The list is read live: a chosen server that was removed or moved
 *   meanwhile is dropped from the choice, and the user chooses again.
 * - A refusal stays in the dialog, in the controller's words, with the server
 *   that won when it names one.
 *
 * `onClose` is called whenever the dialog closes, and the row then unmounts it.
 */
export function ReplaceDialog({
  row,
  candidates,
  onClose,
}: {
  readonly row: McpServerSettingsRow;
  readonly candidates: readonly McpServer[];
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const servers = useSuspenseQuery(mcpServersQuery(client)).data;
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const flip = useMcpServerSwitch(buildOfferSwitchTarget(row));
  const [chosenId, setChosenId] = useState<string | null>(
    candidates.length === 1 ? candidates[0]!.id : null,
  );
  const [started, setStarted] = useState(false);
  const live = findReplaceCandidates(row.offer, servers);
  const choice =
    chosenId === null
      ? null
      : decideReplaceChoice({ offer: row.offer, servers, chosenServerId: chosenId });
  const chosen = choice?.kind === "chosen" ? choice.server : null;
  const lostChoice = choice?.kind === "changed";
  const refusal = flip.replaceRefusal;
  const winner =
    refusal?.winnerServerId == null
      ? undefined
      : servers.find((server) => server.id === refusal.winnerServerId);

  // The Connection's server has a record once the write ran and the list was read again.
  const replaced = servers.some(
    ({ source }) =>
      source.kind === "plugin" &&
      source.contributionId === row.offer.contributionId &&
      source.connectionId === row.connection.id,
  );
  // The dialog ends with the write: once it ran and left no refusal, the server is on the Connection.
  useEffect(() => {
    if (started && replaced && !flip.blocked && flip.replaceRefusal === null) {
      dialogRef.current?.close();
    }
  }, [started, replaced, flip.blocked, flip.replaceRefusal]);

  const described =
    chosen === null
      ? null
      : describeReplaceDialog({
          server: chosen,
          connection: row.connection,
          typeName: row.typeName,
        });
  const several = live.length > 1 || (lostChoice && live.length > 0);
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title={describeReplaceTitle(described)}
      actionLabel={flip.blocked ? "Replacing…" : "Replace"}
      actionClass="accent"
      initialFocus={chosen === null ? undefined : "action"}
      pending={flip.blocked || chosen === null}
      error={refusal?.message ?? null}
      refusal={
        live.length === 0 && !started
          ? "No server added by URL sits on this address any more."
          : null
      }
      onConfirm={() => {
        if (chosen === null) return;
        setStarted(true);
        flip.replace(chosen.id);
      }}
      onClose={onClose}
    >
      {lostChoice && (
        <p>
          The server you chose was removed, or is not added by URL any more.
          {live.length > 0 ? " Choose again." : ""}
        </p>
      )}
      {several && (
        <div className="url-choice" role="radiogroup" aria-label="Server to replace">
          {live.map((server) => (
            <label key={server.id}>
              <input
                type="radio"
                name="replace-server"
                checked={chosen?.id === server.id}
                disabled={flip.blocked}
                onChange={() => {
                  setChosenId(server.id);
                }}
              />
              <b>{server.name}</b>
              <span>{server.source.kind === "url" ? server.source.url : ""}</span>
            </label>
          ))}
        </div>
      )}
      {described !== null && (
        <>
          <p>{described.body}</p>
          <div className="url-replace">
            {described.lines.map((line) => (
              <div key={line.label}>
                <span>{line.label}</span>
                <b>{line.text}</b>
              </div>
            ))}
          </div>
        </>
      )}
      {winner !== undefined && (
        <p>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              dialogRef.current?.close();
              void navigate({ to: "/settings/mcp-servers/$id", params: { id: winner.id } });
            }}
          >
            {`Open ${winner.name}`}
          </button>
        </p>
      )}
    </ConfirmDialog>
  );
}
