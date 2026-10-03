/**
 * Tests where the overlay places the colleagues' name tags. The tests check
 * that:
 *
 * - of two waiting colleagues whose tags overlap, the farther one's tag moves
 *   up to make way;
 * - hovering the tag that moved up moves no tag, so the tag under the pointer
 *   stays the one the user points at.
 *
 * jsdom lays nothing out, so every tag measures as 160 by 24 CSS pixels and
 * the overlay's box is 1000 by 800.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Object3D, PerspectiveCamera } from "three";
import type { OpenRequest, Session } from "@hercule/contract";
import { MOSS, buildSession } from "@hercule/client-core/threads/testing";
import { buildWorld } from "../world/build-world";
import type { ColleagueRig } from "./contracts";
import { createOverlay } from "./overlay";

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
  sessions: [buildAsking("near"), buildAsking("far")],
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
