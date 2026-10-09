/**
 * Tests the 3D face: every pose a colleague in the Office can show builds a
 * face of its own, each face is built once per look and pose and then
 * shared, and only open eyes blink on their own.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { SessionPose } from "@hercule/client-core";
import { readAnatomy } from "./anatomy";
import { hasOpenEyes, readFaceGeometry } from "./face";
import tokens from "../../../styles/tokens.css?raw";

const SESSION_POSES: ReadonlyArray<SessionPose> = ["working", "waiting", "idle", "asleep", "away"];

beforeAll(() => {
  // The face is painted from the design tokens, which jsdom only has once tokens.css is loaded.
  const style = document.createElement("style");
  style.textContent = tokens;
  document.head.append(style);
});

/** Returns the number of vertices of the face of `pose`. */
const countFaceVertices = (pose: SessionPose) =>
  readFaceGeometry(readAnatomy("egg"), pose, []).getAttribute("position").count;

describe("readFaceGeometry", () => {
  it("draws a different face for every pose", () => {
    const counts = SESSION_POSES.map((pose) => countFaceVertices(pose));
    expect(new Set(counts).size).toBe(SESSION_POSES.length);
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
