import type { JSX } from "react";
import type { MachineFaces, WorkFace } from "@hercule/client-core/machine-work";
import { buildAssistantLook, buildSessionLook, Face } from "../../faces";
import "./work-faces.css";

/**
 * Renders one face of the work on a machine: the look of its seed, in the
 * pose of its state. An assistant has its own look, the other kinds have the
 * look of their kind. `size` is the face's width and height in pixels.
 */
export function MachineWorkFace({
  face,
  size,
}: {
  readonly face: WorkFace;
  readonly size: number;
}): JSX.Element {
  const look =
    face.kind === "assistant"
      ? buildAssistantLook(face.seed)
      : buildSessionLook(face.seed, face.kind);
  return <Face look={look} pose={face.pose} size={size} />;
}

/**
 * Renders `faces` side by side, a pixel apart, then "+n" for the ones they
 * leave out. `unit` is what a face stands for: the groups of work on a
 * machine (a Fleet card) or the sessions of one group (a row of Running
 * here). The stack is one image to a screen reader, labelled with the whole
 * count, such as "7 groups at work here" or "14 sessions at work here", so
 * the "+n" needs no label of its own.
 */
export function MachineFacesStack({
  faces: { faces, moreCount },
  size,
  unit,
}: {
  readonly faces: MachineFaces;
  readonly size: number;
  readonly unit: "group" | "session";
}): JSX.Element {
  const count = faces.length + moreCount;
  return (
    <span
      className="work-faces"
      role="img"
      aria-label={`${String(count)} ${unit}${count === 1 ? "" : "s"} at work here`}
    >
      {faces.map((face, index) => (
        <MachineWorkFace
          key={`${face.kind}:${face.seed}:${String(index)}`}
          face={face}
          size={size}
        />
      ))}
      {moreCount > 0 && <small>+{moreCount}</small>}
    </span>
  );
}
