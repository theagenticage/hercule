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
    face.look === "assistant"
      ? buildAssistantLook(face.seed)
      : buildSessionLook(face.seed, face.look);
  return <Face look={look} pose={face.pose} size={size} />;
}

/**
 * Renders the faces of the work on a machine side by side, a pixel apart, then
 * "+n" for the groups of work they leave out. The stack is one image to a screen reader,
 * labelled with the number of groups, such as "7 groups at work here".
 */
export function MachineFacesStack({
  faces,
  size,
}: {
  readonly faces: MachineFaces;
  readonly size: number;
}): JSX.Element {
  const groupCount = faces.faces.length + faces.moreCount;
  return (
    <span
      className="work-faces"
      role="img"
      aria-label={`${String(groupCount)} ${groupCount === 1 ? "group" : "groups"} at work here`}
    >
      {faces.faces.map((face) => (
        <MachineWorkFace key={`${face.look}:${face.seed}`} face={face} size={size} />
      ))}
      {faces.moreCount > 0 && <small>+{faces.moreCount}</small>}
    </span>
  );
}
