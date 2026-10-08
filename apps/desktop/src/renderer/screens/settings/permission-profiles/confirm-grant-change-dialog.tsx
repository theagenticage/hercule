import { useRef, type JSX } from "react";
import { describeGrantChange } from "@hercule/client-core";
import type { Grant } from "@hercule/contract";
import { GlassDialog } from "../../glass-dialog";
import "./permission-profiles.css";

/**
 * Renders the dialog that asks before a grant of the profile `profileName`
 * changes: which grant goes or comes back, and that threads run on the
 * profile unless the user picks another. `held` is whether the profile is to
 * hold `grant` afterwards.
 *
 * Change calls `onConfirm`. Cancel, Esc and a click on the scrim call
 * nothing. `onClose` is called whenever the dialog closes, and the caller
 * then unmounts it.
 */
export function ConfirmGrantChangeDialog({
  profileName,
  grant,
  held,
  onConfirm,
  onClose,
}: {
  readonly profileName: string;
  readonly grant: Grant;
  readonly held: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const title = `Change ${profileName}?`;
  return (
    <GlassDialog dialogRef={dialogRef} className="confirm-dialog" label={title} onClose={onClose}>
      <div className="pop-h">
        <b>{title}</b>
      </div>
      <div className="pop-sec confirm-dialog-body">
        <p>{describeGrantChange(profileName, grant, held)}</p>
        <p>
          {`Threads run on ${profileName} unless you pick another profile, so the change reaches them on their next call.`}
        </p>
        <div className="confirm-dialog-acts">
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => dialogRef.current?.close()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--accent"
            onClick={() => {
              onConfirm();
              dialogRef.current?.close();
            }}
          >
            Change
          </button>
        </div>
      </div>
    </GlassDialog>
  );
}
