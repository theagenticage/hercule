import { useEffect, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { HerculeClient } from "@hercule/client-core";
import type { McpServerSwitchTarget } from "@hercule/client-core/mcp-servers";
import { buildButtonClassName, Button, ChoiceInput } from "@hercule/ui";
import { useReplaceDialog } from "../../app/mcp-server-switch";
import { ModalDialog } from "../modal-dialog";

/**
 * The Replace dialog: moves a server the user added by URL onto the Connection
 * of the plugin that offers the same server, in one write that also switches
 * it on. Its id, name and every list that names it stay; the sign-in made by
 * hand goes.
 *
 * The switches decide everything the dialog says and shows (see
 * `readReplaceDialog` in client-core): the title, the servers to choose from
 * and which one is chosen, the refusal with the link to the server that won,
 * and whether Replace can be pressed. This component draws that and reports
 * the user's moves. It closes itself once the confirmed server is on the
 * Connection (`done`), and focuses Cancel when it opens, as a dialog that
 * changes something does.
 *
 * `target` is the offer's switch target, whose dialog `openReplace` opened.
 * `onClose` is called whenever the dialog closes, and the row then unmounts it.
 */
export function ReplaceDialog({
  client,
  target,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly target: McpServerSwitchTarget;
  readonly onClose: () => void;
}): JSX.Element | null {
  const { view, pick, confirm, readAgain, close } = useReplaceDialog(client, target);
  const finish = (): void => {
    close();
    onClose();
  };
  const done = view?.done === true;
  useEffect(() => {
    if (!done) return;
    close();
    onClose();
  }, [done, close, onClose]);
  if (view === null) return null;
  const { notice } = view;

  return (
    <ModalDialog title={view.title} onClose={finish}>
      {view.body === null ? null : <p className="text-row text-muted">{view.body}</p>}
      {view.choices === null ? null : (
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">Server to replace</legend>
          {view.choices.map((choice) => (
            <label
              key={choice.serverId}
              className="flex cursor-pointer items-center gap-2.5 rounded-control px-1.5 py-1.5 text-row hover:bg-line-soft"
            >
              <ChoiceInput
                type="radio"
                name="mcp-replace-server"
                checked={view.selectedId === choice.serverId}
                disabled={view.locked}
                onChange={() => {
                  pick(choice.serverId);
                }}
              />
              <span className="min-w-0 flex-1">
                <b className="block truncate font-emph text-ink">{choice.name}</b>
                <small className="block truncate text-fine text-muted">{choice.address}</small>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {view.lines.length === 0 ? null : (
        <ul className="flex flex-col gap-1 text-row">
          {view.lines.map((line) => (
            <li key={line.label} className="text-muted">
              <b className="font-emph text-ink">{line.label}:</b> {line.text}
            </li>
          ))}
        </ul>
      )}
      {notice === null ? null : (
        <p
          className={notice.kind === "working" ? "text-fine text-muted" : "text-fine text-fail"}
          role={notice.kind === "working" ? "status" : "alert"}
        >
          {notice.message}
          {notice.winner === null ? null : (
            <>
              {" "}
              <Link
                to="/settings/mcp-servers/$id"
                params={{ id: notice.winner.serverId }}
                onClick={finish}
                className={buildButtonClassName("quiet", "px-1 py-0.5 text-fine")}
              >
                {notice.winner.label}
              </Link>
            </>
          )}
          {notice.readAgainLabel === null ? null : (
            <>
              {" "}
              <Button type="button" variant="quiet" onClick={readAgain}>
                {notice.readAgainLabel}
              </Button>
            </>
          )}
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5 border-t border-line-soft pt-3">
        <Button type="button" autoFocus onClick={finish}>
          Cancel
        </Button>
        <Button type="button" variant="form" disabled={!view.canReplace} onClick={confirm}>
          Replace
        </Button>
      </div>
    </ModalDialog>
  );
}
