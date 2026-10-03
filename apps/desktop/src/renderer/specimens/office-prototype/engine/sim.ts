/**
 * PROTOTYPE - the office's life. STUB: everyone sits at home in the action
 * their pose implies, until the sim part replaces this. Keep the exported
 * signature.
 */
import type { Action, BuildSim, Sim } from "./contracts";
import type { Pose } from "../world/types";

const HOME_ACTION: Readonly<Record<Pose, Action>> = {
  working: "type",
  waiting: "raise-hand",
  idle: "sip",
  asleep: "sleep",
  paused: "sit",
  failed: "sit",
  done: "sit",
  away: "stand",
};

export const buildSim: BuildSim = ({ world, layout, rigs }) => {
  for (const colleague of world.colleagues) {
    const rig = rigs.get(colleague.id);
    const home = layout.homes.get(colleague.id);
    if (rig === undefined || home === undefined) continue;
    rig.object.position.copy(home.position);
    rig.object.rotation.y = home.facing;
    rig.setAction(HOME_ACTION[colleague.pose]);
    rig.setFace(colleague.pose);
    home.desk?.setLamp(colleague.pose === "working");
  }
  const sim: Sim = {
    update(frame) {
      let moving = false;
      for (const rig of rigs.values()) moving = rig.update(frame) || moving;
      return moving;
    },
    answer() {},
    trigger() {},
    setLiveliness() {},
    dispose() {},
  };
  return sim;
};
