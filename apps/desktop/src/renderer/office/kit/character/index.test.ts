/**
 * Tests a colleague's rig through the calls the Office makes on it:
 *
 * - a settled doze draws no frames while ambient motion is off;
 * - a dozer's closed eyes never blink, while open eyes do;
 * - a stretch plays once and ends standing, even with ambient motion off;
 * - an assistant's hat counts toward the height of its head.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SessionPose } from "@hercule/client-core";
import { buildAssistantLook, buildLook, type Look } from "../../../faces";
import { STRETCH_SECONDS, type Action, type ColleagueRig } from "../../engine/contracts";
import type { Colleague } from "../../world/types";
import { buildColleagueRig, setAmbientMotion } from "./index";
import tokens from "../../../styles/tokens.css?raw";

beforeAll(() => {
  // The rig paints itself from the design tokens, which jsdom only has once tokens.css is loaded.
  const style = document.createElement("style");
  style.textContent = tokens;
  document.head.append(style);
});

afterEach(() => setAmbientMotion(true));

/** Returns an assistant colleague in `pose`, wearing `look`. */
const createColleague = (pose: SessionPose, look: Look): Colleague =>
  ({ kind: "assistant", id: "assistant-1", look, pose }) as Colleague;

/** Builds a rig in `pose` doing `action`. */
const buildRig = (pose: SessionPose, action: Action): ColleagueRig => {
  const rig = buildColleagueRig(createColleague(pose, buildLook("assistant-1")));
  rig.setAction(action);
  rig.setFace(pose);
  return rig;
};

const FRAME = { dt: 1 / 60, time: 0 } as const;

/** Runs `seconds` of frames on `rig`. Returns the result of the last frame. */
const runFrames = (rig: ColleagueRig, seconds: number): boolean => {
  let moving = true;
  for (let t = 0; t < seconds; t += FRAME.dt) moving = rig.update(FRAME);
  return moving;
};

/**
 * Returns the vertical scale of both eye bones, which a blink squeezes. The
 * eye bones are the only bones that sit in front of their parent with nothing
 * attached to them.
 */
const readEyeScales = (rig: ColleagueRig): number[] => {
  const scales: number[] = [];
  rig.object.traverse((node) => {
    if ("isBone" in node && node.position.z > 0 && node.children.length === 0) {
      scales.push(node.scale.y);
    }
  });
  return scales;
};

describe("doze", () => {
  it("settles and draws no frames while ambient motion is off", () => {
    setAmbientMotion(false);
    const rig = buildRig("asleep", "doze");
    runFrames(rig, 3);
    expect(rig.update(FRAME)).toBe(false);
    expect(runFrames(rig, 2)).toBe(false);
  });

  it("keeps moving, breathing, while ambient motion is on", () => {
    const rig = buildRig("asleep", "doze");
    runFrames(rig, 3);
    expect(rig.update(FRAME)).toBe(true);
  });

  it("never blinks closed eyes, while open eyes blink within ten seconds", () => {
    const asleep = buildRig("asleep", "doze");
    const awake = buildRig("idle", "sit");
    runFrames(asleep, 0.5);
    runFrames(awake, 0.5);
    let asleepBlinked = false;
    let awakeBlinked = false;
    for (let t = 0; t < 10; t += FRAME.dt) {
      asleep.update(FRAME);
      awake.update(FRAME);
      asleepBlinked ||= readEyeScales(asleep).some((scale) => scale < 0.9);
      awakeBlinked ||= readEyeScales(awake).some((scale) => scale < 0.9);
    }
    expect(asleepBlinked).toBe(false);
    expect(awakeBlinked).toBe(true);
  });
});

describe("stretch", () => {
  it("plays once and then stands, even with ambient motion off", () => {
    setAmbientMotion(false);
    const rig = buildRig("idle", "stretch");
    expect(runFrames(rig, STRETCH_SECONDS - 0.1)).toBe(true);
    runFrames(rig, 3);
    expect(rig.update(FRAME)).toBe(false);
  });
});

describe("headHeight", () => {
  it("includes an assistant's hat", () => {
    const look = buildAssistantLook("assistant-1");
    const bare = buildColleagueRig(createColleague("idle", { ...look, headwear: null }));
    const hatted = buildColleagueRig(createColleague("idle", look));
    for (const rig of [bare, hatted]) runFrames(rig, 0.5);
    expect(look.accessories).not.toContain("homburg");
    expect(hatted.headHeight).toBeGreaterThan(bare.headHeight);
  });
});
