/**
 * The director: builds the 3D Office into a container and keeps it in step
 * with the Office's state and the user's threads. It owns the stage, the
 * camera, and the one office built from the current world.
 *
 * A new world with the same desks is played on the built office: each
 * colleague whose thread changed pose walks where the new pose takes it. A
 * new world with other desks tears the office down and builds the new one in
 * place, with the camera where it was. Rebuilding on every pose change would
 * stop every walk and churn GPU memory on every Request.
 */
import { Vector3, type Mesh, type Object3D } from "three";
import { createCameraRig, placeCamera } from "./engine/camera-rig";
import { addContactShadow } from "./engine/contact-shadow";
import {
  LAMP,
  type CameraView,
  type ColleagueRig,
  type Lamp,
  type OfficeLayout,
  type Sim,
} from "./engine/contracts";
import { createNavBuilder } from "./engine/nav";
import { createOverlay, type Overlay } from "./engine/overlay";
import { createPicker, type Picker } from "./engine/picking";
import { buildSim } from "./engine/sim";
import { Stage } from "./engine/stage";
import { prefersReducedMotion, watchStillness } from "./engine/stillness";
import { buildColleagueRig, setAmbientMotion } from "./kit/character";
import {
  OFFICE_SETTINGS,
  onOfficeCommand,
  publishColleagueStates,
  readOffice,
  setOffice,
  subscribeOffice,
  type OfficeState,
} from "./office-store";
import { buildBureau } from "./variants/bureau";
import { computeDeskKey } from "./world/build-world";
import type { Colleague, World } from "./world/types";

/**
 * The office built from one world: the rooms, a rig per colleague, the sim
 * that moves them, their name tags and the picker. A new world with other
 * desks tears it down and builds another.
 */
interface BuiltOffice {
  readonly layout: OfficeLayout;
  readonly rigs: ReadonlyMap<string, ColleagueRig>;
  readonly sim: Sim;
  readonly overlay: Overlay;
  readonly picker: Picker;
  /** The room lights under the layout's root, which the time of day switches. */
  readonly lamps: ReadonlyArray<Lamp>;
}

/** What the page and the tools read of a mounted office. */
export interface OfficeScene {
  /**
   * Moves the office to a new world: the colleagues walk to their new
   * states, or the office is rebuilt when the desks changed.
   */
  setWorld(world: World): void;
  dispose(): void;
}

/** The distance a click may travel and still count as a click, not a drag. */
const CLICK_SLOP = 5;

/** How far the camera stands from the selected colleague, in metres. */
const COLLEAGUE_VIEW_DISTANCE = 7.5;

/** How far the camera stands from the selected colleague while the thread drawer is open, in metres. */
const DRAWER_VIEW_DISTANCE = 12;

/** Frees the geometry of every mesh under `root`. Materials are shared by the palette and stay. */
function disposeGeometry(root: Object3D): void {
  root.traverse((object) => {
    if ((object as Mesh).isMesh) (object as Mesh).geometry.dispose();
  });
}

/** Returns every room light under `root`. */
function findLamps(root: Object3D): ReadonlyArray<Lamp> {
  const lamps: Lamp[] = [];
  root.traverse((object) => {
    const lamp = object.userData[LAMP] as Lamp | undefined;
    if (lamp !== undefined) lamps.push(lamp);
  });
  return lamps;
}

/** Checks whether a colleague's tag would read the same in both states: same pose, label and request. */
function isSameState(a: Colleague, b: Colleague): boolean {
  return (
    a.pose === b.pose &&
    a.stateLabel === b.stateLabel &&
    a.request?.short === b.request?.short &&
    a.request?.prompt === b.request?.prompt &&
    a.request?.answers.join("\n") === b.request?.answers.join("\n")
  );
}

/** Counts the colleagues in `world` who wait on the user. */
function countWaiting(world: World): number {
  return world.colleagues.filter((colleague) => colleague.pose === "waiting").length;
}

/**
 * Builds the office for `initialWorld` into `container`, and returns its
 * handle. `viewport` is the element whose box is the part of the office the
 * user sees; the name tags and room labels stay inside it. `onBuild` is
 * called with the office's layout after every build: once here, and again
 * whenever a new world rebuilds the office.
 */
export function mountOfficeScene(
  container: HTMLElement,
  viewport: HTMLElement,
  initialWorld: World,
  onBuild: (layout: OfficeLayout) => void,
): OfficeScene {
  const stage = new Stage(container);
  const camera = createCameraRig(stage.camera, stage.renderer.domElement, () =>
    stage.requestRender(),
  );
  let state = readOffice();
  let world = initialWorld;
  let deskKey = computeDeskKey(world);
  let built: BuiltOffice;
  // True while the Mac runs on its battery or the user asks to reduce motion:
  // the office then stands still, whatever its liveliness. The battery's
  // answer comes later, through `watchStillness` below.
  let still = prefersReducedMotion();
  /** Returns the liveliness the office runs at now. */
  const decideLiveliness = (): 0 | 1 | 2 => (still ? 0 : OFFICE_SETTINGS.liveliness);

  const build = (): BuiltOffice => {
    const layout = buildBureau({ world, nav: createNavBuilder() });
    stage.scene.add(layout.root);
    const rigs = new Map<string, ColleagueRig>();
    for (const colleague of world.colleagues) {
      const rig = buildColleagueRig(colleague, OFFICE_SETTINGS.style);
      addContactShadow(rig.object);
      rigs.set(colleague.id, rig);
      stage.scene.add(rig.object);
    }
    const sim = buildSim({ world, layout, rigs, stage });
    sim.setLiveliness(decideLiveliness());
    // The panels and the sidebar read the colleagues' states from the store,
    // so they follow whichever office is built now.
    publishColleagueStates(sim.readStates());
    sim.subscribeStates(() => publishColleagueStates(sim.readStates()));
    const overlay = createOverlay(
      container,
      viewport,
      stage.camera,
      rigs,
      layout.rooms,
      layout.homes,
    );
    overlay.setMode(OFFICE_SETTINGS.tags);
    stage.setShadowBounds(layout.bounds);
    stage.setBuilding(layout.root);
    camera.setBounds(layout.bounds);
    camera.trackWalls(layout.root);
    const lamps = findLamps(layout.root);
    onBuild(layout);
    return {
      layout,
      rigs,
      sim,
      overlay,
      picker: createPicker(stage.renderer.domElement, stage.camera, rigs),
      lamps,
    };
  };

  /** Lights the room lamps in the evening and at night, and puts them out by day. The theme decides which. */
  const switchLamps = (): void => {
    const time = stage.resolveTimeOfDay();
    const on = time === "evening" || time === "night";
    for (const lamp of built.lamps) lamp.setOn(on);
  };

  const teardown = ({ layout, rigs, sim, overlay }: BuiltOffice): void => {
    sim.dispose();
    overlay.dispose();
    for (const rig of rigs.values()) {
      stage.scene.remove(rig.object);
      rig.dispose();
    }
    stage.scene.remove(layout.root);
    disposeGeometry(layout.root);
    layout.dispose();
  };

  const buildColleagueView = (id: string): CameraView | null => {
    const rig = built.rigs.get(id);
    if (rig === undefined) return null;
    const target = rig.object.getWorldPosition(new Vector3()).setY(rig.object.position.y + 0.55);
    // The open drawer covers almost half of the office, so the camera steps
    // back to keep the colleague's desk and neighbours in what is left.
    const distance = state.drawer ? DRAWER_VIEW_DISTANCE : COLLEAGUE_VIEW_DISTANCE;
    return { target, distance, azimuth: 28, elevation: 30 };
  };

  /** Returns the view the state asks for: the selected colleague, the chosen room, or the whole office. */
  const decideView = (): CameraView => {
    if (state.selectedId !== null) {
      const view = buildColleagueView(state.selectedId);
      if (view !== null) return view;
    }
    const room = built.layout.rooms.find((candidate) => candidate.id === state.roomId);
    return room?.view ?? built.layout.overview;
  };

  const applySelection = (previous: OfficeState | null): void => {
    if (previous?.selectedId !== state.selectedId) {
      if (previous?.selectedId != null) built.rigs.get(previous.selectedId)?.setSelected(false);
      const rig = state.selectedId === null ? undefined : built.rigs.get(state.selectedId);
      rig?.setSelected(true);
      built.overlay.setSelected(state.selectedId);
      camera.follow(rig === undefined ? null : () => rig.object.getWorldPosition(new Vector3()));
    }
    if (previous?.hoveredId !== state.hoveredId) {
      if (previous?.hoveredId != null) built.rigs.get(previous.hoveredId)?.setHovered(false);
      if (state.hoveredId !== null) built.rigs.get(state.hoveredId)?.setHovered(true);
      built.overlay.setHovered(state.hoveredId);
    }
  };

  setAmbientMotion(decideLiveliness() > 0);
  built = build();
  switchLamps();
  // The office opens with a short glide down onto the first view, so it reads
  // as a place the camera arrives in rather than a picture.
  const opening = decideView();
  placeCamera(stage.camera, {
    ...opening,
    distance: opening.distance * 1.35,
    azimuth: opening.azimuth - 24,
    elevation: Math.min(opening.elevation + 12, 70),
  });
  camera.flyTo(opening);
  applySelection(null);
  // Signs drawn on canvases redraw once their typeface loads, after the first frames.
  void document.fonts.ready.then(() => stage.requestRender());

  const stopFrames = stage.onFrame((frame) => {
    let moving = built.sim.update(frame);
    moving = (built.layout.update?.(frame) ?? false) || moving;
    moving = camera.update(frame) || moving;
    built.overlay.update();
    return moving;
  });

  const stopState = subscribeOffice(() => {
    const previous = state;
    state = readOffice();
    applySelection(previous);
    if (
      previous.selectedId !== state.selectedId ||
      previous.roomId !== state.roomId ||
      previous.drawer !== state.drawer
    ) {
      camera.flyTo(decideView());
    }
    stage.requestRender();
  });

  // The Office's light follows the app's theme: the lamps go on with the dark theme.
  const themeObserver = new MutationObserver(() => {
    stage.applyTheme();
    switchLamps();
    stage.requestRender();
  });
  themeObserver.observe(document.documentElement, { attributeFilter: ["data-theme"] });

  /** Sets the liveliness the office runs at now on the sim and on every colleague. */
  function applyLiveliness(): void {
    const level = decideLiveliness();
    setAmbientMotion(level > 0);
    built.sim.setLiveliness(level);
    stage.requestRender();
  }

  const stopStillness = watchStillness((next) => {
    if (next === still) return;
    still = next;
    applyLiveliness();
  });

  const stopCommands = onOfficeCommand((command) => {
    switch (command.kind) {
      case "overview":
        setOffice({ selectedId: null, roomId: null, drawer: false });
        camera.flyTo(built.layout.overview);
        break;
      case "focus-room":
        setOffice({ selectedId: null, roomId: command.roomId, drawer: false });
        break;
      case "focus-colleague":
        setOffice({ selectedId: command.colleagueId });
        break;
    }
    stage.requestRender();
  });

  // A click selects the colleague under the pointer; a drag moves the camera
  // and selects nothing.
  const canvas = stage.renderer.domElement;
  let pressedAt: { x: number; y: number } | null = null;
  const onPointerMove = (event: PointerEvent): void => {
    if (event.buttons !== 0) return;
    const id = built.picker.pick(event.clientX, event.clientY);
    canvas.style.cursor = id === null ? "" : "pointer";
    setOffice({ hoveredId: id });
  };
  const onPointerDown = (event: PointerEvent): void => {
    pressedAt = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (pressedAt === null) return;
    const travelled = Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y);
    pressedAt = null;
    if (travelled > CLICK_SLOP) return;
    const id = built.picker.pick(event.clientX, event.clientY);
    if (id !== null) setOffice({ selectedId: id, roomId: null });
  };
  const onPointerLeave = (): void => setOffice({ hoveredId: null });
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);

  return {
    setWorld(next) {
      const previous = world;
      const nextKey = computeDeskKey(next);
      world = next;
      if (nextKey === deskKey) {
        const before = new Map(previous.colleagues.map((colleague) => [colleague.id, colleague]));
        const lounge = new Set(next.lounge);
        // Most new worlds change nothing the office shows, such as a thread's
        // last activity, and draw no frame.
        let changed = false;
        for (const colleague of next.colleagues) {
          const old = before.get(colleague.id);
          if (old !== undefined && isSameState(old, colleague)) continue;
          built.sim.setColleagueState(
            colleague.id,
            { pose: colleague.pose, request: colleague.request, stateLabel: colleague.stateLabel },
            lounge.has(colleague.id),
          );
          changed = true;
        }
        // The sign redraws its canvas on every call, so only a new count is sent.
        const waiting = countWaiting(next);
        if (waiting !== countWaiting(previous)) {
          built.layout.setWaitingCount?.(waiting);
          changed = true;
        }
        if (changed) stage.requestRender();
        return;
      }
      deskKey = nextKey;
      teardown(built);
      built = build();
      switchLamps();
      applySelection(null);
      stage.requestRender();
    },
    dispose() {
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      stopFrames();
      stopState();
      stopStillness();
      stopCommands();
      themeObserver.disconnect();
      teardown(built);
      camera.dispose();
      stage.dispose();
      // The store outlives the scene, so the states of these colleagues
      // would otherwise still be read on the next visit.
      publishColleagueStates(new Map());
    },
  };
}
