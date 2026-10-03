/**
 * PROTOTYPE - the office's furniture. STUB: plain boxes, until the props kit
 * replaces them. Keep the exported signatures.
 */
import { BoxGeometry, Group, Mesh, Object3D } from "three";
import type { DeskHandle } from "../../engine/contracts";
import { DESK_HEIGHT, SEAT_HEIGHT } from "../../engine/contracts";
import { paint } from "../../engine/palette";

const box = (w: number, h: number, d: number) => new BoxGeometry(w, h, d);

/** Builds a clerk's desk with its chair; the chair is on the desk's +z side, facing -z. */
export function buildDesk(): DeskHandle {
  const object = new Group();
  const top = new Mesh(box(1.3, 0.06, 0.72), paint("room-desk", "lacquer"));
  top.position.y = DESK_HEIGHT;
  const body = new Mesh(box(1.2, DESK_HEIGHT - 0.06, 0.62), paint("room-wood", "satin"));
  body.position.y = (DESK_HEIGHT - 0.06) / 2;
  const chair = new Mesh(box(0.5, SEAT_HEIGHT, 0.5), paint("room-fabric", "fabric"));
  chair.position.set(0, SEAT_HEIGHT / 2, 0.75);
  const lamp = new Mesh(box(0.2, 0.1, 0.12), paint("room-lamp", "glass"));
  lamp.position.set(-0.4, DESK_HEIGHT + 0.25, -0.15);
  for (const mesh of [top, body, chair, lamp]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  object.add(top, body, chair, lamp);
  const seatMarker = new Object3D();
  seatMarker.position.set(0, 0, 0.75);
  seatMarker.rotation.y = Math.PI;
  object.add(seatMarker);
  return {
    object,
    seatMarker,
    setLamp(on) {
      lamp.material = paint("room-lamp", on ? "glow" : "glass");
    },
    setNote() {},
    setCup() {},
  };
}
