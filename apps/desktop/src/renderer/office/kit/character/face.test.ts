/**
 * Tests the 3D face: every pose a colleague in the Office can show draws the
 * features the book gives it, each face is built once per look and pose and
 * then shared, and only open eyes blink on their own.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Box3, Color, Vector3 } from "three";
import type { SessionPose } from "@hercule/client-core";
import { readAnatomy } from "./anatomy";
import { hasOpenEyes, readEyeCentre, readFaceGeometry } from "./face";
import { BONE } from "./parts";
import { readColor } from "../../engine/palette";
import tokens from "../../../styles/tokens.css?raw";

const SESSION_POSES: ReadonlyArray<SessionPose> = ["working", "waiting", "idle", "asleep", "away"];

beforeAll(() => {
  // The face is painted from the design tokens, which jsdom only has once tokens.css is loaded.
  const style = document.createElement("style");
  style.textContent = tokens;
  document.head.append(style);
});

/** What a face draws, as the book describes each pose. */
interface FaceFeatures {
  /** The white glint on an open eye. */
  readonly glint: boolean;
  /** Eyes shut: each eye is a line, much wider than it is tall. */
  readonly closedEyes: boolean;
  /** Ink above the eyes. */
  readonly brows: boolean;
  /** The pale pin of a colleague who can't be reached. */
  readonly awayBadge: boolean;
}

/**
 * Reads the features of the face of `pose`, with no accessories, from its
 * vertices: each vertex's painted colour tells its layer, and its bone tells
 * whether it sits on an eye or on the head.
 */
function readFaceFeatures(pose: SessionPose): FaceFeatures {
  const anatomy = readAnatomy("egg");
  const geometry = readFaceGeometry(anatomy, pose, []);
  const position = geometry.getAttribute("position");
  const color = geometry.getAttribute("color");
  const bone = geometry.getAttribute("skinIndex");
  const ink = readColor("face-ink").getHex();
  const paper = readColor("room-paper").getHex();
  const eyeTop = readEyeCentre(anatomy.egg, "left").y;
  const leftEye = new Box3();
  let glint = false;
  let brows = false;
  let awayBadge = false;
  for (let vertex = 0; vertex < position.count; vertex++) {
    const hex = new Color(color.getX(vertex), color.getY(vertex), color.getZ(vertex)).getHex();
    const onEye = bone.getX(vertex) === BONE.eyeL || bone.getX(vertex) === BONE.eyeR;
    if (bone.getX(vertex) === BONE.eyeL && hex === ink) {
      leftEye.expandByPoint(new Vector3(position.getX(vertex), position.getY(vertex), 0));
    }
    if (onEye && hex === paper) glint = true;
    if (!onEye && hex === paper) awayBadge = true;
    if (!onEye && hex === ink && position.getY(vertex) > eyeTop) brows = true;
  }
  const eye = leftEye.getSize(new Vector3());
  return { glint, closedEyes: eye.x > eye.y * 2, brows, awayBadge };
}

describe("readFaceGeometry", () => {
  it.each<[SessionPose, FaceFeatures]>([
    ["working", { glint: true, closedEyes: false, brows: true, awayBadge: false }],
    ["waiting", { glint: true, closedEyes: false, brows: true, awayBadge: false }],
    ["idle", { glint: true, closedEyes: false, brows: false, awayBadge: false }],
    ["asleep", { glint: false, closedEyes: true, brows: false, awayBadge: false }],
    ["away", { glint: false, closedEyes: false, brows: false, awayBadge: true }],
  ])("draws the %s face as the book does", (pose, features) => {
    expect(readFaceFeatures(pose)).toEqual(features);
  });

  it("builds each look and pose once and then shares it", () => {
    const anatomy = readAnatomy("round");
    for (const pose of SESSION_POSES) {
      expect(readFaceGeometry(anatomy, pose, ["glasses"])).toBe(
        readFaceGeometry(anatomy, pose, ["glasses"]),
      );
    }
  });
});

describe("hasOpenEyes", () => {
  it("is false only while asleep, whose eyes are already shut", () => {
    expect(SESSION_POSES.filter((pose) => !hasOpenEyes(pose))).toEqual(["asleep"]);
  });
});
