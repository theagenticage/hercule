import { useEffect, useRef, type JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { McpServerSwitchTarget } from "@hercule/client-core/mcp-servers";
import { useReplaceDialog } from "../../../../../app/mcp-server-switch";
import { ConfirmDialog } from "../../../../../screens/confirm-dialog";
import "../../../../../screens/settings/mcp-servers/url-server-dialogs.css";

/**
 * Renders the Replace dialog (spec 17 §Adding and replacing): the switch of
 * a plugin's server was pressed while servers added by URL sit on the
 * plugin's address, so one of them is moved onto the Connection instead of a
 * second server being made. `target` is the offer's switch target, whose
 * dialog `openReplace` opened.
 *
 * The switches decide everything the dialog says and shows (see
 * `readReplaceDialog` in client-core): the title, the servers to choose from
 * and which one is chosen, the refusal with the server that won, and whether
 * Replace can be pressed. This component draws that and reports the user's
 * moves. It closes itself once the confirmed server is on the Connection
 * (`done`). Focus starts on Cancel, as in every dialog that changes something.
 *
 * `onClose` is called whenever the dialog closes, and the row then unmounts it.
 */
export function ReplaceDialog({
  target,
  onClose,
}: {
  readonly target: McpServerSwitchTarget;
  readonly onClose: () => void;
}): JSX.Element | null {
  const { view, pick, confirm, readAgain, close } = useReplaceDialog(target);
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const done = view?.done === true;
  useEffect(() => {
    if (done) dialogRef.current?.close();
  }, [done]);
  if (view === null) return null;
  const { notice } = view;
  const winner = notice?.winner ?? null;
  const readAgainLabel = notice?.readAgainLabel ?? null;

  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title={view.title}
      actionLabel={notice?.kind === "working" ? "Replacing…" : "Replace"}
      actionClass="accent"
      className="url-replace-dialog"
      initialFocus="close"
      pending={!view.canReplace}
      refusal={notice?.kind === "empty" ? notice.message : null}
      onConfirm={confirm}
      onClose={() => {
        close();
        onClose();
      }}
    >
      {view.choices !== null && (
        <div className="options" role="radiogroup" aria-label="Server to replace">
          {view.choices.map((choice) => (
            <label key={choice.serverId} className="option">
              <span className="choice-box">
                <input
                  type="radio"
                  name="replace-server"
                  checked={view.selectedId === choice.serverId}
                  disabled={view.locked}
                  onChange={() => {
                    pick(choice.serverId);
                  }}
                />
              </span>
              <b>{choice.name}</b>
              <small>{choice.address}</small>
            </label>
          ))}
        </div>
      )}
      {view.body !== null && (
        <>
          <p>{view.body}</p>
          <div className="url-replace">
            {view.lines.map((line) => (
              <div key={line.label}>
                <span>{line.label}</span>
                <b>{line.text}</b>
              </div>
            ))}
          </div>
        </>
      )}
      {notice !== null && notice.kind !== "empty" && (
        <p
          className={notice.kind === "working" ? undefined : "fl-err"}
          role={notice.kind === "working" ? "status" : "alert"}
        >
          {notice.message}
        </p>
      )}
      {(winner !== null || readAgainLabel !== null) && (
        <p>
          {winner !== null && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                dialogRef.current?.close();
                void navigate({ to: "/settings/mcp-servers/$id", params: { id: winner.serverId } });
              }}
            >
              {winner.label}
            </button>
          )}
          {readAgainLabel !== null && (
            <button type="button" className="btn btn--sm" onClick={readAgain}>
              {readAgainLabel}
            </button>
          )}
        </p>
      )}
    </ConfirmDialog>
  );
}
