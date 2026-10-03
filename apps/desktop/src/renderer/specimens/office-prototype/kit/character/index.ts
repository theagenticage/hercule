/**
 * PROTOTYPE - a colleague's 3D body. STUB: a capsule in the colleague's hue,
 * until the character kit replaces it. Keep the exported signature.
 */
import { CapsuleGeometry, Group, Mesh } from "three";
import type { Action, BuildColleagueRig, ColleagueRig } from "../../engine/contracts";
import { COLLEAGUE_HEIGHT, SEAT_HEIGHT } from "../../engine/contracts";
import { paintHue } from "../../engine/palette";

const geometry = new CapsuleGeometry(0.3, COLLEAGUE_HEIGHT - 0.6, 6, 16);

export const buildColleagueRig: BuildColleagueRig = (colleague) => {
  const object = new Group();
  const body = new Mesh(geometry, paintHue(colleague.look.hue));
  body.position.y = COLLEAGUE_HEIGHT / 2;
  body.castShadow = true;
  object.add(body);
  let action: Action = "stand";
  const rig: ColleagueRig = {
    colleague,
    object,
    headHeight: COLLEAGUE_HEIGHT,
    setAction(next) {
      action = next;
      const sitting =
        next === "sit" || next === "type" || next === "read" || next === "sip" || next === "sleep";
      body.position.y = COLLEAGUE_HEIGHT / 2 + (sitting ? SEAT_HEIGHT - 0.2 : 0);
    },
    setFace() {},
    setWalkSpeed() {},
    lookAt() {},
    setHovered() {},
    setSelected() {},
    update() {
      return action === "walk";
    },
    dispose() {},
  };
  return rig;
};
