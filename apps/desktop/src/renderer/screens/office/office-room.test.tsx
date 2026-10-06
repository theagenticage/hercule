import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { RoomContents } from "@hercule/client-core";
import { buildProject } from "@hercule/client-core/threads/testing";
import { buildLook } from "../../faces";
import { OfficeRoom, type RoomShot } from ".";

/** The assistant the first run seats in the club chair. */
const HERCULE = { id: "a-hercule", name: "Hercule" };

/** The room before anything is set up: the lights off and nothing in it but the shell and its dressing. */
const BARE: RoomContents = {
  lightsOn: false,
  wing: null,
  yourDesk: false,
  assistant: null,
  triage: null,
  gitHubAccount: null,
};

/** The room once the first run is done: every piece in it. */
const FURNISHED: RoomContents = {
  lightsOn: true,
  wing: {
    runnerName: "studio-mac",
    note: "this Mac · 6 desks",
    deskCount: 6,
    firstThread: { projectId: "p-webshop", projectName: "webshop" },
  },
  yourDesk: true,
  assistant: HERCULE,
  triage: { note: "reads GitHub" },
  gitHubAccount: "rogier",
};

/** The projects the room tints desks from: webshop, first, takes the first tint. */
const PROJECTS = [buildProject("p-webshop", "webshop")];

let reduceMotion = false;

beforeEach(() => {
  reduceMotion = false;
  // jsdom lays nothing out, so the stage is given the size of a 1440 by 900 window.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1440);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(900);
  window.matchMedia = (query: string) =>
    ({
      matches: query === "(prefers-reduced-motion: reduce)" && reduceMotion,
    }) as MediaQueryList;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Renders the room with `contents` at `shot` and returns its root element, with a function to change both. */
function renderRoom(contents: RoomContents, shot: RoomShot = "room") {
  const { container, rerender } = render(
    <OfficeRoom contents={contents} projects={PROJECTS} shot={shot} />,
  );
  return {
    room: container.querySelector<HTMLElement>(".office-room")!,
    change: (next: RoomContents, nextShot: RoomShot = shot) => {
      rerender(<OfficeRoom contents={next} projects={PROJECTS} shot={nextShot} />);
    },
  };
}

/** Returns the visible text of every label over `room`, in order. */
const readLabels = (room: HTMLElement): string[] =>
  [...room.querySelectorAll(".tag")].map((tag) => tag.textContent);

describe("OfficeRoom", () => {
  it("draws nothing but the veil until the stage has a size", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(0);
    const { room } = renderRoom(FURNISHED);
    expect(room.querySelector("svg")).toBeNull();
    expect(room.querySelector(".room-veil")).not.toBeNull();
  });

  it("draws the bare room as one picture, with the lights off and nobody in it", () => {
    const { room } = renderRoom(BARE);
    expect(room.dataset.lights).toBe("off");
    const pictures = room.querySelectorAll("svg.floor");
    expect(pictures).toHaveLength(1);
    expect(pictures[0]!.getAttribute("aria-label")).toBe("Your office, furnished as you set it up");
    expect(room.querySelector(".wall-word")?.textContent).toBe("Hercule");
    expect(room.querySelector(".desk-top")).toBeNull();
    expect(room.querySelector(".cr")).toBeNull();
    expect(room.querySelector(".hat")).toBeNull();
    expect(room.querySelector(".engrave")).toBeNull();
    expect(room.querySelector(".plaque-mark")).toBeNull();
    expect(readLabels(room)).toEqual([]);
  });

  it("lifts the veil when the lights are on", () => {
    const { room } = renderRoom({ ...BARE, lightsOn: true });
    expect(room.dataset.lights).toBe("on");
  });

  it("sets out your desk and the hat stand", () => {
    const { room } = renderRoom({ ...BARE, yourDesk: true });
    expect(room.querySelector(".hat")).not.toBeNull();
    expect(readLabels(room)).toEqual(["Your desk"]);
  });

  it("seats the assistant asleep in the club chair", () => {
    const { room } = renderRoom({ ...BARE, assistant: HERCULE });
    expect(room.querySelectorAll(".cr")).toHaveLength(1);
    expect(room.querySelector(".cr--asleep")).not.toBeNull();
    expect(room.querySelector(".table-top")).not.toBeNull();
    expect(readLabels(room)).toEqual(["Herculeyour assistant"]);
  });

  it("draws the assistant's face from its id, not its name", () => {
    const fromId = buildLook(HERCULE.id).hue;
    expect(fromId).not.toBe(buildLook(HERCULE.name).hue);

    const { room } = renderRoom({ ...BARE, assistant: HERCULE });

    expect(room.querySelector<SVGSVGElement>(".cr")?.style.getPropertyValue("--hue")).toBe(
      `var(--hue-${fromId})`,
    );
  });

  it("lays the wing's field with its desks, two rows of four at most", () => {
    // client-core caps a wing at eight desks, so eight is the most the room draws.
    const wing = { runnerName: "studio-mac", note: "", deskCount: 8, firstThread: null };
    const { room } = renderRoom({ ...BARE, wing }, "wing");
    expect(room.querySelector(".engrave-name")?.textContent).toBe("studio-mac");
    expect(room.querySelectorAll(".desk-top")).toHaveLength(8);
    expect(room.querySelector(".cr")).toBeNull();
  });

  it("seats the first thread at a desk in its project's tint", () => {
    const { room } = renderRoom({ ...BARE, wing: FURNISHED.wing }, "wing");
    expect(room.querySelectorAll(".desk-top")).toHaveLength(6);
    expect(room.querySelectorAll(".cr--idle")).toHaveLength(1);
    const tinted = [...room.querySelectorAll<SVGElement>(".blotter")].filter(
      (blotter) => blotter.style.fill !== "",
    );
    expect(tinted.map((blotter) => blotter.style.fill)).toEqual(["var(--proj-webshop)"]);
    expect(readLabels(room)).toEqual(["New threadwebshop"]);
  });

  it("seats Triage at its desk with no tube while GitHub is not connected", () => {
    const { room } = renderRoom({ ...BARE, triage: { note: "no Connections yet" } }, "triage");
    expect(room.querySelectorAll(".desk-top")).toHaveLength(1);
    expect(room.querySelectorAll(".cr--idle")).toHaveLength(1);
    expect(room.querySelector(".tube--main")).toBeNull();
    expect(room.querySelector(".plaque-mark")).toBeNull();
    expect(readLabels(room)).toEqual(["Triageno Connections yet"]);
  });

  it("hangs the GitHub plaque and runs a still tube from it to Triage's desk", () => {
    const { room } = renderRoom(
      { ...BARE, triage: { note: "reads GitHub" }, gitHubAccount: "rogier" },
      "triage",
    );
    expect(room.querySelector(".plaque-mark")).not.toBeNull();
    expect(room.querySelector(".tube--main")).not.toBeNull();
    expect(room.querySelector(".capsule, animateMotion")).toBeNull();
    expect(readLabels(room)).toEqual(["GitHubrogier", "Triagereads GitHub"]);
  });

  it("leaves out a label the card or the window's edge would cut", () => {
    // The close shot of the wing leaves your desk, at the front left, off the stage.
    const { room } = renderRoom(FURNISHED, "wing");
    expect(readLabels(room)).toContain("New threadwebshop");
    expect(readLabels(room)).not.toContain("Your desk");
  });

  it("draws nothing that moves once the room is still", () => {
    const { room } = renderRoom(FURNISHED);
    expect(room.querySelector("animate, animateMotion, animateTransform")).toBeNull();
    expect(room.querySelector(".room-arrival")).toBeNull();
    expect(room.querySelector(".is-new")).toBeNull();
  });
});

describe("OfficeRoom arrivals", () => {
  it("settles a new piece on its own layer, then draws it into the still picture", () => {
    const { room, change } = renderRoom(BARE);
    change({ ...BARE, yourDesk: true });

    const arrival = room.querySelector(".room-arrival")!;
    expect(arrival.classList.contains("room-arrival--character")).toBe(false);
    expect(arrival.querySelector(".hat")).not.toBeNull();
    expect(room.querySelector(".tag.is-new")?.textContent).toBe("Your desk");

    fireEvent.animationEnd(arrival, { animationName: "room-settle" });
    expect(room.querySelector(".room-arrival")).toBeNull();
    expect(room.querySelector(".is-new")).toBeNull();
    expect(room.querySelectorAll("svg.floor")).toHaveLength(1);
    expect(room.querySelector("svg.floor .hat")).not.toBeNull();
  });

  it("settles a colleague on the character layer", () => {
    const { room, change } = renderRoom(BARE);
    change({ ...BARE, assistant: HERCULE });
    expect(room.querySelector(".room-arrival--character .cr--asleep")).not.toBeNull();
  });

  it("moves the camera to a new shot and lands the new pieces once it stops", () => {
    const { room, change } = renderRoom({ ...BARE, yourDesk: true }, "your-desk");
    change({ ...BARE, yourDesk: true, wing: FURNISHED.wing }, "wing");

    const camera = room.querySelector<HTMLElement>(".room-camera")!;
    expect(camera.classList.contains("is-moving")).toBe(true);
    expect(camera.style.transform).toBe("none");
    expect(room.querySelector(".room-arrival.is-late")).not.toBeNull();
  });

  it("draws the room again in place under Reduce motion", () => {
    reduceMotion = true;
    const { room, change } = renderRoom(BARE, "room");
    change({ ...BARE, yourDesk: true }, "your-desk");

    expect(room.querySelector(".room-arrival")).toBeNull();
    expect(room.querySelector(".is-new")).toBeNull();
    expect(room.querySelector(".room-camera")!.classList.contains("is-moving")).toBe(false);
    expect(room.querySelector("svg.floor .hat")).not.toBeNull();
  });
});
