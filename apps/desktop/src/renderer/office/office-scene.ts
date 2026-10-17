/**
 * The director: builds the 3D Office into a container and keeps it in step
 * with the Office's state and the user's threads. It owns the stage, the
 * camera, the sim, the colleagues' bodies and the building they move in.
 *
 * The sim and the bodies live as long as the scene. Only the building is
 * rebuilt, in place and with the camera where it was, when the world's desks
 * change. A colleague new to the world gets a body at once and walks in from
 * the front pavement; a colleague who left keeps its body, its desk and its
 * room until the last colleague walking out of its room has gone. Only then
 * is the body removed and the building rebuilt without its desk. Nobody jumps
 * when the building is rebuilt, because the sim moves everyone onto the new
 * building.
 */
import { Vector3, type Mesh, type Object3D } from "three";
import { clearCaches } from "./engine/caches";
import { createCameraRig, placeCamera } from "./engine/camera-rig";
import { addContactShadow } from "./engine/contact-shadow";
import {
  LAMP,
  type CameraView,
  type ColleagueRig,
  type Lamp,
  type BuiltOffice,
} from "./engine/contracts";
import { createNavBuilder } from "./engine/nav";
import { createOverlay, type Overlay } from "./engine/overlay";
import { createPicker, type Picker } from "./engine/picking";
import { buildSim } from "./engine/sim";
import { Stage } from "./engine/stage";
import { watchMinutes } from "./engine/minutes";
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
import { buildBureau } from "./maps/bureau";
import { computeDeskKey, keepColleagues } from "./world/build-world";
import type { Colleague, World } from "./world/types";

/**
 * Everything one build of the building made from one world: the built
 * office, the overlay with the name tags, the picker and the lamps. The
 * colleagues' bodies and the sim are not part of it, so they outlast it. It is
 * torn down together, when a new world with other desks needs another build.
 */
interface Building {
  readonly office: BuiltOffice;
  readonly overlay: Overlay;
  readonly picker: Picker;
  /** The room lights under the built office's root, which the time of day switches. */
  readonly lamps: ReadonlyArray<Lamp>;
  /** Stops the longcase clock's minute timer. Does nothing for an office with no clock. */
  readonly stopClock: () => void;
}

/** What the page and the tools read of a mounted office. */
export interface OfficeScene {
  /**
   * Moves the office to a new world: colleagues walk in, out, or to their new
   * states, and the building is rebuilt when the desks changed.
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

/**
 * Frees the geometry of every mesh under `root`. Most materials are shared
 * between builds and stay until the Office closes; a mesh with a material or
 * texture of its own, such as a sign's lettered face, frees them when its
 * geometry is disposed.
 */
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

/** Counts the colleagues in `world` who wait on the user. */
function countWaiting(world: World): number {
  return world.colleagues.filter((colleague) => colleague.pose === "waiting").length;
}

/**
 * Builds the office for `initialWorld` into `container`, and returns its
 * handle. `viewport` is the element whose box is the part of the office the
 * user sees; the name tags and room labels stay inside it. `onBuild` is
 * called with the built office after every build: once here, and again
 * whenever a new world rebuilds the office, which includes when the last
 * colleague walking out of a room has gone.
 */
export function mountOfficeScene(
  container: HTMLElement,
  viewport: HTMLElement,
  initialWorld: World,
  onBuild: (office: BuiltOffice) => void,
): OfficeScene {
  const stage = new Stage(container);
  const camera = createCameraRig(stage.camera, stage.renderer.domElement, () =>
    stage.requestRender(),
  );
  let state = readOffice();
  /** The last world given to the scene. */
  let latest = initialWorld;
  /** The world the building was built from. It still holds the desks of colleagues walking out. */
  let builtWorld = initialWorld;
  let deskKey = computeDeskKey(builtWorld);
  /** The number of waiting colleagues the "now serving" sign shows. */
  let shownWaiting = countWaiting(builtWorld);
  let disposed = false;
  let building: Building;
  /** A body for every colleague in the scene: in the latest world, or still walking out. */
  const rigs = new Map<string, ColleagueRig>();
  // True while the Mac runs on its battery or the user asks to reduce motion:
  // the office then stands still, whatever its liveliness. The battery's
  // answer comes later, through `watchStillness` below.
  let still = prefersReducedMotion();
  /** Returns the liveliness the office runs at now. */
  const decideLiveliness = (): 0 | 1 | 2 => (still ? 0 : OFFICE_SETTINGS.liveliness);

  /** Gives `colleague` a body in the scene. The sim decides where it stands and whether it shows. */
  const addRig = (colleague: Colleague): void => {
    const rig = buildColleagueRig(colleague);
    addContactShadow(rig.object);
    stage.scene.add(rig.object);
    rigs.set(colleague.id, rig);
  };

  /** Takes the body of the colleague with id `id` out of the scene and frees it. */
  const removeRig = (id: string): void => {
    const rig = rigs.get(id);
    if (rig === undefined) return;
    if (state.selectedId === id) camera.follow(null);
    stage.scene.remove(rig.object);
    rig.dispose();
    rigs.delete(id);
  };

  const build = (world: World): Building => {
    const office = buildBureau({ world, nav: createNavBuilder() });
    stage.scene.add(office.root);
    const { clock } = office;
    let stopClock = (): void => {};
    if (clock !== undefined) {
      stage.scene.add(clock.hands);
      // The hands move once a minute, even while the office stands still,
      // because a clock that stops is wrong. Only an office with a clock
      // runs the timer.
      stopClock = watchMinutes((now) => {
        clock.setTime(now);
        stage.requestRender();
      });
    }
    const overlay = createOverlay({
      container,
      viewport,
      camera: stage.camera,
      office,
      colleagues: world.colleagues,
      rigs,
    });
    overlay.setMode(OFFICE_SETTINGS.tags);
    stage.setShadowBounds(office.bounds);
    stage.setBuilding(office.root);
    camera.setBounds(office.bounds);
    camera.trackWalls(office.root);
    const lamps = findLamps(office.root);
    onBuild(office);
    return {
      office,
      overlay,
      picker: createPicker(stage.renderer.domElement, stage.camera, rigs),
      lamps,
      stopClock,
    };
  };

  /** Lights the room lamps in the evening, and puts them out in the morning. The theme decides which. */
  const switchLamps = (): void => {
    const on = stage.resolveTimeOfDay() === "evening";
    for (const lamp of building.lamps) lamp.setOn(on);
  };

  const tearDownBuilding = ({ office, overlay, stopClock }: Building): void => {
    stopClock();
    overlay.dispose();
    stage.scene.remove(office.root);
    disposeGeometry(office.root);
    if (office.clock !== undefined) {
      stage.scene.remove(office.clock.hands);
      disposeGeometry(office.clock.hands);
    }
    office.dispose();
  };

  const buildColleagueView = (id: string): CameraView | null => {
    const rig = rigs.get(id);
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
    const room = building.office.rooms.find((candidate) => candidate.id === state.roomId);
    return room?.view ?? building.office.overview;
  };

  const applySelection = (previous: OfficeState | null): void => {
    if (previous?.selectedId !== state.selectedId) {
      if (previous?.selectedId != null) rigs.get(previous.selectedId)?.setSelected(false);
      const rig = state.selectedId === null ? undefined : rigs.get(state.selectedId);
      rig?.setSelected(true);
      building.overlay.setSelected(state.selectedId);
      camera.follow(rig === undefined ? null : () => rig.object.getWorldPosition(new Vector3()));
    }
    if (previous?.hoveredId !== state.hoveredId) {
      if (previous?.hoveredId != null) rigs.get(previous.hoveredId)?.setHovered(false);
      if (state.hoveredId !== null) rigs.get(state.hoveredId)?.setHovered(true);
      building.overlay.setHovered(state.hoveredId);
    }
  };

  /**
   * Brings the scene up to the latest world: adds bodies for new colleagues,
   * rebuilds the building when its desks changed, and hands the world to the
   * sim. A frame is drawn only when something the Office shows changed: most
   * new worlds change nothing it shows, such as a thread's last activity.
   */
  const applyLatestWorld = (): void => {
    const present = new Set(latest.colleagues.map(({ id }) => id));
    // A body is removed once its colleague has walked out, so every body the
    // latest world does not hold belongs to a colleague still walking out.
    const leaving = new Set([...rigs.keys()].filter((id) => !present.has(id)));
    const next = keepColleagues(latest, builtWorld, leaving);
    for (const colleague of latest.colleagues) {
      if (!rigs.has(colleague.id)) addRig(colleague);
    }
    let changed = false;
    const nextKey = computeDeskKey(next);
    if (nextKey !== deskKey) {
      tearDownBuilding(building);
      building = build(next);
      shownWaiting = countWaiting(next);
      deskKey = nextKey;
      switchLamps();
      // Bodies outlast a building, so only the new overlay needs the selection and hover.
      building.overlay.setSelected(state.selectedId);
      building.overlay.setHovered(state.hoveredId);
      changed = true;
    }
    builtWorld = next;
    changed = sim.setWorld(latest, building.office) || changed;
    // The sign redraws its canvas on every call, so only a new count is sent.
    const waiting = countWaiting(latest);
    if (waiting !== shownWaiting) {
      building.office.setWaitingCount?.(waiting);
      shownWaiting = waiting;
      changed = true;
    }
    if (changed) stage.requestRender();
  };

  setAmbientMotion(decideLiveliness() > 0);
  for (const colleague of builtWorld.colleagues) addRig(colleague);
  building = build(builtWorld);
  const sim = buildSim({
    world: builtWorld,
    office: building.office,
    rigs,
    stage,
    onDeparted: (ids) => {
      for (const id of ids) removeRig(id);
      // Called while the sim is running a script, so the world is applied after it returns.
      queueMicrotask(() => {
        if (!disposed) applyLatestWorld();
      });
    },
  });
  sim.setLiveliness(decideLiveliness());
  // The panels and the sidebar read the colleagues' states from the store.
  publishColleagueStates(sim.readStates());
  const stopStates = sim.subscribeStates(() => publishColleagueStates(sim.readStates()));
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
    let moving = sim.update(frame);
    moving = camera.update(frame) || moving;
    building.overlay.update();
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
    sim.setLiveliness(level);
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
        camera.flyTo(building.office.overview);
        break;
      case "turn-camera":
        camera.turn(command.degrees);
        break;
      case "zoom-camera":
        camera.zoomStep(command.direction);
        break;
      case "resume-follow":
        camera.resumeFollow();
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
    const id = building.picker.pick(event.clientX, event.clientY);
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
    const id = building.picker.pick(event.clientX, event.clientY);
    if (id !== null) setOffice({ selectedId: id, roomId: null });
  };
  const onPointerLeave = (): void => setOffice({ hoveredId: null });
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);

  return {
    setWorld(next) {
      latest = next;
      applyLatestWorld();
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
      disposed = true;
      stopStates();
      tearDownBuilding(building);
      sim.dispose();
      for (const id of [...rigs.keys()]) removeRig(id);
      camera.dispose();
      clearCaches();
      stage.dispose();
      // The store outlives the scene, so the states of these colleagues
      // would otherwise still be read on the next visit.
      publishColleagueStates(new Map());
    },
  };
}
