import { useEffect, useRef, useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  formatStamp,
  joinCommand,
  queryKeys,
  readErrorMessage,
  resolveBrowserTimezone,
  toIdTail,
  type HerculeClient,
} from "@hercule/client-core";
import { joinTokensQuery } from "../../app/queries";
import { CheckIcon } from "../../icons/check";
import { CopyIcon } from "../../icons/copy";
import { GlassDialog } from "../glass-dialog";
import { useCopyResult } from "../use-copy-result";
import "./add-machine-dialog.css";

/**
 * Renders the Add a machine dialog of the Fleet screen: the command that
 * joins a machine to this fleet, and the join tokens that are still unused,
 * each with Revoke.
 *
 * - A token is minted as the dialog opens, and the command carries it. The
 *   controller shows a token's secret once, so the list of open tokens cannot
 *   show it again: only this dialog's own command holds one.
 * - The "Personal machine" checkbox adds `--reserved` to the command, so the
 *   machine only runs work sent to it by name (spec 03, section 5.5).
 * - A token is used once and lasts an hour. The dialog says when the command
 *   stops working from the token's own expiry, not from a number of its own.
 * - Creating or revoking a token reads the open tokens again. Revoking the
 *   token the command carries takes the command away: it would not work.
 *
 * `origin` is the address of the controller the app is connected to, such as
 * `http://127.0.0.1:4937`. The new machine joins that address, so the command
 * must carry it and not the address of the page.
 *
 * `onClose` is called whenever the dialog closes. The caller then unmounts it.
 */
export function AddMachineDialog({
  client,
  origin,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly origin: string;
  readonly onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();
  const [timezone] = useState(() => resolveBrowserTimezone());
  const [reserved, setReserved] = useState(false);
  const { result: copyResult, copy } = useCopyResult();

  const openTokens = useQuery(joinTokensQuery(client)).data ?? [];
  const readTokensAgain = () => queryClient.invalidateQueries({ queryKey: queryKeys.joinTokens() });
  const create = useMutation({
    mutationFn: () => client.runner.createJoinToken(),
    onSuccess: readTokensAgain,
  });
  const [revokedId, setRevokedId] = useState<string | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => client.runner.revokeJoinToken({ params: { id } }),
    onSuccess: (_, id) => {
      setRevokedId(id);
      return readTokensAgain();
    },
  });

  // React in development runs every effect twice when a component mounts,
  // and would mint two tokens. A ref keeps its value across that second run,
  // so the second run sees the first one's mark and does nothing.
  const mintedOnOpen = useRef(false);
  const { mutate: createToken } = create;
  useEffect(() => {
    if (mintedOnOpen.current) return;
    mintedOnOpen.current = true;
    createToken();
  }, [createToken]);

  const minted = create.data;
  const commandRevoked = minted !== undefined && minted.id === revokedId;
  const command =
    minted === undefined || commandRevoked
      ? undefined
      : joinCommand({ origin, token: minted.token, reserved });
  const copyLabel =
    copyResult === "copied" ? "Copied" : copyResult === "failed" ? "Copy failed" : "Copy";
  const error = create.isError
    ? `Could not make a join token: ${readErrorMessage(create.error)}`
    : revoke.isError
      ? `Could not revoke the token: ${readErrorMessage(revoke.error)}`
      : null;

  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="fleet-add"
      label="Add a machine"
      onClose={onClose}
    >
      <div className="pop-h">
        <b>Add a machine</b>
      </div>
      <div className="fleet-add-body">
        <p>
          On the new machine, open a terminal and run this. It joins the machine to this fleet.
          Hercule must already be installed there.
        </p>
        <label className="fleet-add-reserved">
          <span className="choice-box">
            <input
              type="checkbox"
              checked={reserved}
              onChange={(event) => {
                setReserved(event.target.checked);
              }}
            />
            <CheckIcon size={12} />
          </span>
          Personal machine - only runs work you send to it
        </label>
        <div className="fleet-add-command">
          <code>{command ?? (commandRevoked ? "No command" : "Making a join token…")}</code>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label={copyLabel}
            title={copyLabel}
            disabled={command === undefined}
            onClick={() => {
              if (command !== undefined) copy(command);
            }}
          >
            {copyResult === "copied" ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          </button>
        </div>
        {minted !== undefined &&
          (commandRevoked ? (
            <p className="fleet-add-wait">
              This command's token was revoked. Close and open the dialog again for a new one.
            </p>
          ) : (
            <p className="fleet-add-wait">
              <span className="spin" /> Waiting for the machine. The command works once, until{" "}
              {formatStamp(new Date(minted.expiresAt), timezone)}.
            </p>
          ))}
        {error !== null && (
          <p className="fleet-add-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {openTokens.length > 0 && (
        <ul className="fleet-add-tokens" aria-label="Open join tokens">
          {openTokens.map((token) => (
            <li key={token.id}>
              <span className="faint">
                {/* Two tokens made in the same minute look alike, so each shows
                    the tail of its id. */}
                {minted?.id === token.id ? "This command" : "Earlier token"}{" "}
                <code>{toIdTail(token.id)}</code>, made{" "}
                {formatStamp(new Date(token.createdAt), timezone)}, expires{" "}
                {formatStamp(new Date(token.expiresAt), timezone)}
              </span>
              <button
                type="button"
                className="btn btn--sm btn--quiet"
                aria-label={`Revoke token ${toIdTail(token.id)}`}
                aria-disabled={revoke.isPending && revoke.variables === token.id}
                onClick={() => {
                  if (!revoke.isPending) revoke.mutate(token.id);
                }}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="fleet-add-foot">
        <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
          Done
        </button>
      </div>
    </GlassDialog>
  );
}
