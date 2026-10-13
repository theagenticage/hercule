import { useState, type JSX } from "react";
import { buildDiscardHeldQuestion } from "@hercule/client-core";
import { Button } from "@hercule/ui";
import { InPlaceQuestion } from "./in-place-question";

/** The label of the button that asks, and of the answer that does it. */
const DISCARD_LABEL = "Resume and discard held events";

/**
 * Renders the button that resumes a paused start trigger with its
 * `heldCount` held events discarded. It asks first, below the button, because
 * a discarded event never starts a run. Settings > Bounds and the workflow's
 * page both offer it under the trigger's row, the same way.
 *
 * `isPending` is whether a pause or resume of the trigger is in flight. The
 * button and the answers then ignore clicks, so a second request cannot
 * start. `onConfirm` is called once the user accepts.
 */
export function DiscardHeldEvents({
  heldCount,
  isPending,
  onConfirm,
}: {
  readonly heldCount: number;
  readonly isPending: boolean;
  readonly onConfirm: () => void;
}): JSX.Element {
  const [isAsking, setIsAsking] = useState(false);
  return (
    <div className="flex flex-col items-start">
      {/* Hidden, not unmounted, while the question shows, so the focus can
          return to it when the user cancels. An `aria-disabled` button
          ignores clicks. */}
      <Button
        hidden={isAsking}
        className="-ml-2 text-fine"
        aria-disabled={isPending}
        onClick={() => {
          setIsAsking(true);
        }}
      >
        {DISCARD_LABEL}
      </Button>
      {isAsking ? (
        <InPlaceQuestion
          stacked
          question={buildDiscardHeldQuestion(heldCount)}
          declineLabel="Cancel"
          acceptLabel={DISCARD_LABEL}
          disabled={isPending}
          onDecline={() => {
            setIsAsking(false);
          }}
          onAccept={() => {
            setIsAsking(false);
            onConfirm();
          }}
        />
      ) : null}
    </div>
  );
}
