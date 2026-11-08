import type { JSX, Ref } from "react";
import { buildLook, Face, UserAvatar } from "../../faces";
import { CloseIcon } from "../../icons/close";
import "./rail.css";

/**
 * Who can take a carried card, as the rail offers it:
 *
 * - `hand` hands it to the workflow `workflowId`, shown as a colleague named `name`;
 * - `take` makes it the user's own;
 * - `dismiss` sets it aside.
 */
export type RailTarget =
  | { readonly kind: "hand"; readonly workflowId: string; readonly name: string }
  | { readonly kind: "take" }
  | { readonly kind: "dismiss" };

/** The size of the face, the monogram and the cross of a target, in pixels. */
const TARGET_SIZE = 40;

/**
 * Renders the rail that rises while a card is carried: one target for each of
 * `targets`, in order, with a hairline before `dismiss`. A `hand` target shows
 * the workflow's colleague, `take` shows the user's `monogram` (its first
 * letter), and `dismiss` a cross.
 *
 * The rail takes no pointer and is hidden from assistive technology: the
 * carry reads the geometry of each target (`data-rail-target` is its index in
 * `targets`, and `data-rail-face` marks the picture that swells when the card
 * is near), and the same moves are in every card's own buttons and keys.
 * `ref` is the rail's element, which the carry moves.
 */
export function Rail({
  targets,
  monogram,
  ref,
}: {
  readonly targets: readonly RailTarget[];
  readonly monogram: string;
  readonly ref?: Ref<HTMLDivElement>;
}): JSX.Element {
  return (
    <div ref={ref} className="inbox-rail" aria-hidden="true">
      {targets.map((target, index) => (
        <RailTargetView
          key={describeKey(target)}
          target={target}
          index={index}
          monogram={monogram}
        />
      ))}
    </div>
  );
}

/** Returns a key that tells `target` apart from the others of one rail. */
const describeKey = (target: RailTarget): string =>
  target.kind === "hand" ? `hand:${target.workflowId}` : target.kind;

function RailTargetView({
  target,
  index,
  monogram,
}: {
  readonly target: RailTarget;
  readonly index: number;
  readonly monogram: string;
}): JSX.Element {
  return (
    <>
      {target.kind === "dismiss" && <i className="inbox-rail-rule" />}
      <div className="inbox-rail-target" data-rail-target={index}>
        <span className="inbox-rail-face" data-rail-face>
          {target.kind === "hand" && (
            <Face look={buildLook(target.workflowId)} pose="idle" size={TARGET_SIZE} />
          )}
          {target.kind === "take" && <UserAvatar name={monogram} size={TARGET_SIZE} />}
          {target.kind === "dismiss" && (
            <span className="inbox-rail-cross">
              <CloseIcon size={18} />
            </span>
          )}
        </span>
        <span>
          {target.kind === "hand" ? target.name : target.kind === "take" ? "Take it" : "Dismiss"}
        </span>
      </div>
    </>
  );
}
