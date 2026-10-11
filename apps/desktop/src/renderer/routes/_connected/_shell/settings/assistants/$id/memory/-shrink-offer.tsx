import { useRef, useState, type JSX } from "react";
import { ConfirmDialog } from "../../../../../../../screens/confirm-dialog";

/**
 * Renders the way past a save the controller refused because the new text
 * cuts most of a large document: a button that asks for a confirmation in a
 * dialog, which says how much the text loses. Confirming calls `onConfirm`,
 * which saves the refused text again with the cut confirmed. `loss` is the
 * sentence `describeShrinkLoss` builds from the refusal's sizes.
 */
export function ShrinkOffer({
  loss,
  onConfirm,
}: {
  readonly loss: string;
  readonly onConfirm: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="memory-shrink">
      <button
        type="button"
        className="btn btn--sm btn--danger"
        onClick={() => {
          setConfirming(true);
        }}
      >
        Save the shorter text…
      </button>
      {confirming && (
        <ConfirmDialog
          dialogRef={dialogRef}
          title="Save the shorter text?"
          actionLabel="Save"
          actionClass="danger"
          onConfirm={() => {
            dialogRef.current?.close();
            onConfirm();
          }}
          onClose={() => setConfirming(false)}
        >
          <p>{loss}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
