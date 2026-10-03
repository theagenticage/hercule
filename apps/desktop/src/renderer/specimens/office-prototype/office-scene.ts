/**
 * PROTOTYPE - the director: builds the 3D office into a container and keeps
 * it in step with the office's state. It owns the stage, the camera, and the
 * one office the current variant builds; a change of variant or character
 * style tears the office down and builds the new one in place.
 */
import { Vector3, type Mesh, type Object3D } from "three";
import { createCameraRig, placeCamera } from "./engine/camera-rig";
import type { CameraView, ColleagueRig, OfficeLayout, Sim } from "./engine/contracts";
import { createNavBuilder } from "./engine/nav";
import { createOverlay, type Overlay } from "./engine/overlay";
import { createPicker, type Picker } from "./engine/picking";
import { buildSim } from "./engine/sim";
import { Stage } from "./engine/stage";
import { buildColleagueRig } from "./kit/character";
import {
  onOfficeCommand,
  readOffice,
  setOffice,
  subscribeOffice,
  type OfficeState,
} from "./office-store";
import { LAYOUTS } from "./variants";
import type { World } from "./world/types";

/** One built office: what a change of variant or style replaces. */
interface Built {
  readonly layout: OfficeLayout;
  readonly rigs: ReadonlyMap<string, ColleagueRig>;
  readonly sim: Sim;
  readonly overlay: Overlay;
  readonly picker: Picker;
}

/** What the page and the tools read of a mounted office. */
export interface OfficeScene {
  readonly stage: Stage;
  /** The office as built now. */
  readLayout(): OfficeLayout;
  /** Returns the view that frames one colleague. */
  buildColleagueView(id: string): CameraView | null;
  dispose(): void;
}

/** The distance a click may travel and still count as a click, not a drag. */
const CLICK_SLOP = 5;

/** Frees the geometry of every mesh under `root`. Materials are shared by the palette and stay. */
function disposeGeometry(root: Object3D): void {
  root.traverse((object) => {
    if ((object as Mesh).isMesh) (object as Mesh).geometry.dispose();
  });
}

/** Builds the office for `world` into `container`, and returns its handle. */
export function mountOfficeScene(container: HTMLElement, world: World): OfficeScene {
  const stage = new Stage(container);
  const camera = createCameraRig(stage.camera, stage.renderer.domElement, () =>
    stage.requestRender(),
  );
  let state = readOffice();
  let built: Built;

  const build = (): Built => {
    const layout = LAYOUTS[state.variant]({ world, nav: createNavBuilder() });
    stage.scene.add(layout.root);
    const rigs = new Map<string, ColleagueRig>();
    for (const colleague of world.colleagues) {
      const rig = buildColleagueRig(colleague, state.style);
      rigs.set(colleague.id, rig);
      stage.scene.add(rig.object);
    }
    const sim = buildSim({ world, layout, rigs, stage });
    sim.setLiveliness(state.liveliness);
    const overlay = createOverlay(container, stage.camera, rigs);
    overlay.setMode(state.tags);
    stage.setShadowBounds(layout.bounds);
    camera.setBounds(layout.bounds);
    return {
      layout,
      rigs,
      sim,
      overlay,
      picker: createPicker(stage.renderer.domElement, stage.camera, rigs),
    };
  };

  const teardown = ({ layout, rigs, sim, overlay }: Built): void => {
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
    return { target, distance: 7.5, azimuth: 28, elevation: 30 };
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

  built = build();
  placeCamera(stage.camera, decideView());
  camera.flyTo(decideView());
  applySelection(null);

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
    if (previous.variant !== state.variant || previous.style !== state.style) {
      teardown(built);
      built = build();
      applySelection(null);
      camera.flyTo(decideView());
    }
    if (previous.theme !== state.theme) stage.applyTheme();
    if (previous.timeOfDay !== state.timeOfDay) stage.setTimeOfDay(state.timeOfDay);
    if (previous.quality !== state.quality) stage.setQuality(state.quality);
    if (previous.liveliness !== state.liveliness) built.sim.setLiveliness(state.liveliness);
    if (previous.tags !== state.tags) built.overlay.setMode(state.tags);
    applySelection(previous);
    if (previous.selectedId !== state.selectedId || previous.roomId !== state.roomId) {
      camera.flyTo(decideView());
    }
    stage.requestRender();
  });

  const stopCommands = onOfficeCommand((command) => {
    switch (command.kind) {
      case "answer":
        built.sim.answer(command.colleagueId, command.answer);
        break;
      case "simulate":
        built.sim.trigger(command.event);
        break;
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
    stage,
    readLayout: () => built.layout,
    buildColleagueView,
    dispose() {
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      stopFrames();
      stopState();
      stopCommands();
      teardown(built);
      camera.dispose();
      stage.dispose();
    },
  };
}
