import type { JSX, Ref } from "react";
import type { RailTarget } from "@hercule/client-core/inbox";
import { buildLook, Face, UserAvatar } from "../../faces";
import { CloseIcon } from "../../icons/close";
import "./rail.css";

export type { RailTarget };

/** The size of the face, the monogram and the cross of a target, in pixels. */
const TARGET_SIZE = 40;

/** The size of each of the two faces of the `more` target, in pixels. Two overlap to fill the target's picture. */
const MORE_FACE_SIZE = 24;

/**
 * Renders the rail that rises while a card is carried: one target for each of
 * `targets`, in order, with a hairline before `dismiss`. The rail is as wide as
 * its targets, up to the width of the desk. Past that the targets wrap into a
 * second row, centred, and the hairline stays with `dismiss`. A `hand` target shows
 * the workflow's colleague, `take` shows the user's `monogram` (its first
 * letter), `more` the faces of two more workflows with "Hand to…", and
 * `dismiss` a cross.
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
          key={buildRailTargetKey(target)}
          target={target}
          index={index}
          monogram={monogram}
        />
      ))}
    </div>
  );
}

/** Returns a key that tells `target` apart from the others of one rail. */
const buildRailTargetKey = (target: RailTarget): string =>
  target.kind === "hand" ? `hand:${target.workflowId}` : target.kind;

/** Returns the words under a target. */
const describeTargetLabel = (target: RailTarget): string => {
  switch (target.kind) {
    case "hand":
      return target.name;
    case "more":
      return "Hand to…";
    case "take":
      return "Take it";
    case "dismiss":
      return "Dismiss";
  }
};

function RailTargetView({
  target,
  index,
  monogram,
}: {
  readonly target: RailTarget;
  readonly index: number;
  readonly monogram: string;
}): JSX.Element {
  const targetView = (
    <div className="inbox-rail-target" data-rail-target={index}>
      <span className="inbox-rail-face" data-rail-face>
        {target.kind === "hand" && (
          <Face look={buildLook(target.workflowId)} pose="idle" size={TARGET_SIZE} />
        )}
        {target.kind === "more" &&
          target.workflowIds.map((workflowId) => (
            <Face key={workflowId} look={buildLook(workflowId)} pose="idle" size={MORE_FACE_SIZE} />
          ))}
        {target.kind === "take" && <UserAvatar name={monogram} size={TARGET_SIZE} />}
        {target.kind === "dismiss" && (
          <span className="inbox-rail-cross">
            <CloseIcon size={18} />
          </span>
        )}
      </span>
      <span>{describeTargetLabel(target)}</span>
    </div>
  );
  return target.kind === "dismiss" ? (
    <span className="inbox-rail-tail">
      <i className="inbox-rail-rule" />
      {targetView}
    </span>
  ) : (
    targetView
  );
}
