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
  // The servers the dialog listed when the user pressed Replace. The write moves the chosen
  // server onto the Connection, so the live list no longer holds it afterwards.
  const [confirmedList, setConfirmedList] = useState<readonly McpServer[] | null>(null);
  const progress = flip.replaceProgress;
  const choosing = progress.kind === "choosing";
  const live = findReplaceCandidates(row.offer, servers);
  const shown = choosing ? live : (confirmedList ?? live);
  // Once the user confirmed, the dialog keeps the confirmed server selected, whatever the list does.
  const selectedId =
    progress.kind === "choosing" || progress.serverId === null ? chosenId : progress.serverId;
  const choice =
    selectedId === null
      ? null
      : choosing
        ? decideReplaceChoice({ offer: row.offer, servers, chosenServerId: selectedId })
        : { kind: "chosen" as const, server: shown.find((server) => server.id === selectedId) };
  const chosen = choice?.kind === "chosen" ? (choice.server ?? null) : null;
  const lostChoice = choice?.kind === "changed";
  const refusal = progress.kind === "refused" ? progress.message : null;
  const winner =
    progress.kind === "refused" && progress.winnerServerId !== null
      ? servers.find((server) => server.id === progress.winnerServerId)
      : undefined;

  // The dialog ends when the confirmed server's own record is on the Connection.
  useEffect(() => {
    if (progress.kind === "replaced") dialogRef.current?.close();
  }, [progress.kind]);

  const described =
    chosen === null
      ? null
      : describeReplaceDialog({
          server: chosen,
          connection: row.connection,
          typeName: row.typeName,
        });
  const several = shown.length > 1 || (lostChoice && live.length > 0);
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title={describeReplaceTitle(described)}
      actionLabel={flip.blocked ? "Replacing…" : "Replace"}
      actionClass="accent"
      initialFocus={chosen === null ? undefined : "action"}
      pending={flip.blocked || chosen === null}
      error={refusal}
      refusal={
        live.length === 0 && choosing
          ? "No server added by URL sits on this address any more."
          : null
      }
      onConfirm={() => {
        if (chosen === null) return;
        setConfirmedList(live);
        flip.replace(chosen.id);
      }}
      onClose={() => {
        flip.clearReplace();
        onClose();
      }}
    >
      {lostChoice && (
        <p>
          The server you chose was removed, or is not added by URL any more.
          {live.length > 0 ? " Choose again." : ""}
        </p>
      )}
      {several && (
        <div className="url-choice" role="radiogroup" aria-label="Server to replace">
          {shown.map((server) => (
            <label key={server.id}>
              <input
                type="radio"
                name="replace-server"
                checked={chosen?.id === server.id}
                disabled={flip.blocked || !choosing}
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
