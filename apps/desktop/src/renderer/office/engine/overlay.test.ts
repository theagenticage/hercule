/**
 * Tests where the overlay places the colleagues' name tags and the room
 * labels, and what the picker finds under them. The tests check that:
 *
 * - of two waiting colleagues whose tags overlap, the farther one's tag moves
 *   up to make way;
 * - hovering the tag that moved up moves no tag, so the tag under the pointer
 *   stays the one the user points at;
 * - a room label drawn over a colleague takes the pointer, so a click on the
 *   label picks the room and not the colleague behind it.
 *
 * jsdom lays nothing out, so every tag measures as 160 by 24 CSS pixels and
 * the overlay's box is 1000 by 800.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Box3, Object3D, PerspectiveCamera, Vector3 } from "three";
import type { OpenRequest, Session } from "@hercule/contract";
import { MOSS, buildSession } from "@hercule/client-core/threads/testing";
import { buildWorld } from "../world/build-world";
import { placeCamera } from "./camera-rig";
import type { ColleagueRig, RoomInfo } from "./contracts";
import { createOverlay } from "./overlay";
import { createPicker } from "./picking";

const WIDTH = 1000;
const HEIGHT = 800;

const REQUEST: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
};

/** Returns a thread on moss with id and title `id` that waits on `REQUEST`. */
const buildAsking = (id: string): Session =>
  buildSession({ id, title: id, runnerId: MOSS.id, status: "busy", openRequest: REQUEST });

const WORLD = buildWorld({
  sessions: [
    buildAsking("near"),
    buildAsking("far"),
    buildSession({ id: "idle", title: "idle", runnerId: MOSS.id }),
  ],
  projects: [],
  workspaces: [],
  runners: [MOSS],
  localRunnerId: MOSS.id,
});

/**
 * Returns a rig for the world's colleague with id `id`, standing at `x`, `z`.
 * The overlay reads only the colleague, the object and the head's height.
 */
const buildRig = (id: string, x: number, z: number): ColleagueRig => {
  const object = new Object3D();
  object.position.set(x, 0, z);
  const colleague = WORLD.colleagues.find((each) => each.id === id)!;
  return { colleague, object, headHeight: 1 } as ColleagueRig;
};

/** Returns a div of `WIDTH` by `HEIGHT` at the page's top left, as the overlay measures it. */
const createContainer = (): HTMLElement => {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientWidth", { value: WIDTH });
  Object.defineProperty(container, "clientHeight", { value: HEIGHT });
  container.getBoundingClientRect = () => new DOMRect(0, 0, WIDTH, HEIGHT);
  document.body.append(container);
  return container;
};

/** Returns where each tag in `container` shows, by colleague name, or null for a hidden tag. */
const readTagPlaces = (container: HTMLElement) =>
  Object.fromEntries(
    [...container.querySelectorAll<HTMLElement>(".office-tag")].map((tag) => [
      tag.querySelector(".office-tag__name")!.textContent,
      tag.classList.contains("is-shown") ? tag.style.transform : null,
    ]),
  );

/** Returns the vertical position in a `translate3d(x, y, 0)` transform. */
const readY = (transform: string | null): number =>
  Number(/translate3d\([^,]+, ([-\d.]+)px/.exec(transform ?? "")?.[1]);

/** Returns the horizontal position in a `translate3d(x, y, 0)` transform. */
const readX = (transform: string | null): number =>
  Number(/translate3d\(([-\d.]+)px/.exec(transform ?? "")?.[1]);

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(160);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(24);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("the name tags", () => {
  it("keep their places while the pointer hovers the tag that made way", () => {
    const container = createContainer();
    const camera = new PerspectiveCamera(45, WIDTH / HEIGHT, 0.1, 100);
    camera.position.set(0, 5, 20);
    camera.lookAt(0, 0, 0);
    // The far colleague stands just behind the near one, so their tags overlap.
    const near = buildRig("near", 0, 0);
    const far = buildRig("far", 0.2, -0.5);
    const rigs = new Map([
      ["near", near],
      ["far", far],
    ]);
    const overlay = createOverlay(container, container, camera, rigs, [], new Map());

    overlay.update();
    const before = readTagPlaces(container);
    const nearY = readY(before["near"]!);
    const farY = readY(before["far"]!);
    expect(farY).toBeLessThan(nearY - 24);

    overlay.setHovered("far");

    expect(readTagPlaces(container)).toEqual(before);
    overlay.dispose();
  });
});

describe("the room labels", () => {
  it("take the pointer from a colleague they cover", () => {
    const container = createContainer();
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () => new DOMRect(0, 0, WIDTH, HEIGHT);
    const camera = new PerspectiveCamera(45, WIDTH / HEIGHT, 0.1, 100);
    // Far enough away for the overview, where the room labels show.
    placeCamera(camera, { target: new Vector3(), distance: 40, azimuth: 0, elevation: 80 });
    // An idle colleague has no tag in the overview, so only its body can be picked.
    const rigs = new Map([["idle", buildRig("idle", 0, 0)]]);
    // The room's label hangs over the room's centre, where the colleague stands.
    const room: RoomInfo = {
      id: "webshop",
      label: "Webshop",
      kind: "project",
      floor: 0,
      bounds: new Box3(new Vector3(-3, 0, -3), new Vector3(3, 3, 3)),
      view: { target: new Vector3(), distance: 12, azimuth: 0, elevation: 45 },
      tint: null,
    };
    const picker = createPicker(canvas, camera, rigs);
    const overlay = createOverlay(container, container, camera, rigs, [room], new Map());
    overlay.update();
    const label = container.querySelector<HTMLElement>(".office-room-label")!;
    expect(label.classList.contains("is-shown")).toBe(true);
    const x = readX(label.style.transform);
    const y = readY(label.style.transform);

    expect(picker.pick(x, y)).toBeNull();
    overlay.dispose();

    // With no label in the way, the same point picks the colleague.
    const bare = createOverlay(container, container, camera, rigs, [], new Map());
    bare.update();
    expect(picker.pick(x, y)).toBe("idle");
    bare.dispose();
  });
});
