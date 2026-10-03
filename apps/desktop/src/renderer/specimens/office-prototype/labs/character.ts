/**
 * PROTOTYPE - the character lab: the colleagues as the character kit builds
 * them, in a lineup of every shape, hue and accessory. Open labs/character.html.
 *
 * Query parameters:
 * - `style=bean|suited`: one style only. Both are shown by default, beans in front.
 * - `action=<action>`: what everyone does; `stand` by default.
 * - `pose=<pose>|all`: the face everyone wears, or `all` for one pose each.
 * - `only=<index>`: one colleague of the lineup, alone at the origin.
 * - `walk=1`: everyone walks a circle, at `speed=<m/s>` (1.1 by default).
 * - `sit=1`: everyone sits: at desks typing, reading and sitting, and in
 *   armchairs sipping, sleeping and sitting. `action=` overrides the action.
 * - `ambient=0`: ambient motion off, so the lab stops drawing once settled.
 * - `hover=<index>|all`, `select=<index>|all`: hover or select colleagues.
 * - `look=x,y,z`: everyone looks at a point.
 *
 * `window.characterLab` gives the screenshot tool's scripts the rigs.
 */
import { Euler, type Object3D, Quaternion, Vector3 } from "three";
import type { Action, CharacterStyle, ColleagueRig } from "../engine/contracts";
import { buildColleagueRig, setAmbientMotion } from "../kit/character";
import { buildArmchair, buildDesk } from "../kit/props";
import type { Accessory, Hue, Shape } from "../../../faces/look";
import type { Colleague, Headwear, Pose, Role } from "../world/types";
import { mountLab } from "./lab";

declare global {
  interface Window {
    /** The character lab's rigs, for the screenshot tool's scripts. */
    characterLab?: {
      readonly rigs: ReadonlyArray<ColleagueRig>;
      setAction(action: Action): void;
      setFace(pose: Pose): void;
    };
  }
}

const POSES: ReadonlyArray<Pose> = [
  "working",
  "waiting",
  "idle",
  "asleep",
  "paused",
  "failed",
  "done",
  "away",
];

/** One colleague of the lineup. */
interface Sitter {
  readonly name: string;
  readonly hue: Hue;
  readonly shape: Shape;
  readonly accessories: ReadonlyArray<Accessory>;
  readonly headwear: Headwear | null;
  readonly role: Role;
}

/** The lineup: every shape twice, every hue, every accessory and headwear, and Triage. */
const LINEUP: ReadonlyArray<Sitter> = [
  {
    name: "Ada",
    hue: "iris",
    shape: "egg",
    accessories: [],
    headwear: "cloche",
    role: "assistant",
  },
  {
    name: "Milo",
    hue: "teal",
    shape: "round",
    accessories: [],
    headwear: "headset",
    role: "assistant",
  },
  {
    name: "Juno",
    hue: "orchid",
    shape: "tall",
    accessories: [],
    headwear: "beret",
    role: "assistant",
  },
  {
    name: "Triage",
    hue: "lime",
    shape: "egg",
    accessories: ["tache", "bowtie"],
    headwear: null,
    role: "triage",
  },
  {
    name: "Payouts",
    hue: "sky",
    shape: "wide",
    accessories: ["homburg"],
    headwear: null,
    role: "session",
  },
  {
    name: "Checkout",
    hue: "peach",
    shape: "egg",
    accessories: ["monocle"],
    headwear: null,
    role: "session",
  },
  {
    name: "Cart",
    hue: "mint",
    shape: "round",
    accessories: ["glasses"],
    headwear: null,
    role: "session",
  },
  {
    name: "Infra",
    hue: "grape",
    shape: "tall",
    accessories: ["watch"],
    headwear: null,
    role: "session",
  },
];

/** The actions the `sit=1` scene gives its seats, desks first, then armchairs. */
const SEATED: ReadonlyArray<{ readonly seat: "desk" | "armchair"; readonly action: Action }> = [
  { seat: "desk", action: "type" },
  { seat: "desk", action: "read" },
  { seat: "desk", action: "sit" },
  { seat: "armchair", action: "sip" },
  { seat: "armchair", action: "sleep" },
  { seat: "armchair", action: "sit" },
];

/** Builds the colleague a lineup entry stands for, wearing `pose`. */
function buildColleague(sitter: Sitter, style: CharacterStyle, pose: Pose): Colleague {
  return {
    id: `${style}-${sitter.name.toLowerCase()}`,
    name: sitter.name,
    title: sitter.name,
    role: sitter.role,
    look: {
      hue: sitter.hue,
      shape: sitter.shape,
      accessories: sitter.accessories,
      headwear: sitter.headwear,
    },
    pose,
    stateLabel: "",
    project: null,
    area: sitter.role === "triage" ? "triage" : "assistants",
    runnerId: null,
    model: null,
    activity: [],
    request: null,
    threadId: null,
  };
}

/** Checks whether `value` (`all`, or an index) picks the colleague at `index`. */
function isPicked(value: string | null, index: number): boolean {
  return value === "all" || (value !== null && Number(value) === index);
}

const seatPosition = new Vector3();
const seatTurn = new Quaternion();
const seatAngles = new Euler(0, 0, 0, "YXZ");

/** Stands `rig` on `marker`'s spot, facing the way the marker faces. */
function standOnMarker(rig: ColleagueRig, marker: Object3D): void {
  marker.updateWorldMatrix(true, false);
  marker.getWorldPosition(seatPosition);
  marker.getWorldQuaternion(seatTurn);
  rig.object.position.copy(seatPosition);
  rig.object.rotation.y = seatAngles.setFromQuaternion(seatTurn).y;
}

mountLab((stage) => {
  const params = new URLSearchParams(location.search);
  const onlyStyle = params.get("style") as CharacterStyle | null;
  const styles: ReadonlyArray<CharacterStyle> =
    onlyStyle === null ? ["bean", "suited"] : [onlyStyle];
  const poseParam = params.get("pose");
  const actionParam = params.get("action") as Action | null;
  const only = params.get("only");
  const walking = params.get("walk") === "1";
  const sitting = params.get("sit") === "1";
  const speed = Number(params.get("speed") ?? "1.1");
  const look = params.get("look");
  setAmbientMotion(params.get("ambient") !== "0");

  const lineup = only === null ? LINEUP : LINEUP.filter((_, index) => index === Number(only));
  const rigs: ColleagueRig[] = [];
  /** The circle each walker walks: its radius and where on it the walker starts. */
  const circles: Array<{ readonly radius: number; readonly start: number }> = [];

  styles.forEach((style, row) => {
    const rowZ = styles.length === 1 ? 0 : row === 0 ? 0.7 : -0.7;
    const count = sitting ? Math.min(lineup.length, SEATED.length) : lineup.length;
    for (let index = 0; index < count; index++) {
      const sitter = lineup[index]!;
      const lineupIndex = LINEUP.indexOf(sitter);
      const pose =
        poseParam === "all" ? POSES[lineupIndex % POSES.length]! : (poseParam as Pose | null);
      const rig = buildColleagueRig(buildColleague(sitter, style, pose ?? "working"), style);
      rig.setFace(pose ?? "working");
      stage.scene.add(rig.object);
      rigs.push(rig);
      if (isPicked(params.get("hover"), lineupIndex)) rig.setHovered(true);
      if (isPicked(params.get("select"), lineupIndex)) rig.setSelected(true);
      if (look !== null) {
        const [x = 0, y = 1, z = 3] = look.split(",").map(Number);
        rig.lookAt(new Vector3(x, y, z));
      }
      if (walking) {
        rig.setAction("walk");
        rig.setWalkSpeed(speed);
        circles.push({ radius: 1.6 + row * 1.1, start: (index / count) * Math.PI * 2 });
      } else if (sitting) {
        const seated = SEATED[index]!;
        const x = (index - (count - 1) / 2) * 1.7;
        if (seated.seat === "desk") {
          const desk = buildDesk();
          desk.object.position.set(x, 0, rowZ * 2.4 - 0.4);
          desk.object.rotation.y = Math.PI;
          stage.scene.add(desk.object);
          standOnMarker(rig, desk.seatMarker);
        } else {
          const chair = buildArmchair();
          chair.object.position.set(x, 0, rowZ * 2.4);
          stage.scene.add(chair.object);
          standOnMarker(rig, chair.seatMarker);
        }
        rig.setAction(actionParam ?? seated.action);
      } else {
        rig.object.position.set((index - (count - 1) / 2) * 0.95, 0, rowZ);
        rig.setAction(actionParam ?? "stand");
      }
    }
  });

  window.characterLab = {
    rigs,
    setAction(action) {
      for (const rig of rigs) rig.setAction(action);
      stage.requestRender();
    },
    setFace(pose) {
      for (const rig of rigs) rig.setFace(pose);
      stage.requestRender();
    },
  };

  let time = 0;
  return (frame) => {
    time += frame.dt;
    if (walking) {
      rigs.forEach((rig, index) => {
        const { radius, start } = circles[index]!;
        const angle = start + (time * speed) / radius;
        rig.object.position.set(radius * Math.cos(angle), 0, radius * Math.sin(angle));
        rig.object.rotation.y = Math.atan2(-Math.sin(angle), Math.cos(angle));
      });
    }
    let moving = walking;
    for (const rig of rigs) moving = rig.update(frame) || moving;
    return moving;
  };
}, 16);
