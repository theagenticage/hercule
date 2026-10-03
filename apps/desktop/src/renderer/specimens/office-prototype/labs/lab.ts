/**
 * PROTOTYPE - the harness every lab page shares: a full-window stage with
 * orbit controls, a plain floor, and the theme from `?theme=`. A lab page
 * shows one part of the office on its own, so the part can be built and
 * checked without the rest.
 *
 * `?view=<distance>,<azimuth>,<elevation>,<x>,<y>,<z>` sets the camera.
 */
import "../../../styles/base-layer.css";
import { BoxGeometry, Mesh, Vector3 } from "three";
import { createCameraRig, placeCamera } from "../engine/camera-rig";
import { paint } from "../engine/palette";
import { Stage, type Frame } from "../engine/stage";

/** What a lab adds to the stage: its objects, and what moves each frame. */
export type LabSetup = (stage: Stage) => ((frame: Frame) => boolean) | void;

/**
 * Mounts a lab page: the stage, a floor `floorSize` across, and what `setup`
 * adds. Returns the stage.
 */
export function mountLab(setup: LabSetup, floorSize = 12): Stage {
  const params = new URLSearchParams(location.search);
  document.documentElement.dataset.theme = params.get("theme") ?? "whitehaven";
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;inset:0";
  document.body.style.margin = "0";
  document.body.append(container);
  const stage = new Stage(container);
  stage.setTimeOfDay((params.get("time") as "morning" | null) ?? "auto");
  const floor = new Mesh(new BoxGeometry(floorSize, 0.1, floorSize), paint("room-floor", "matte"));
  floor.position.y = -0.05;
  floor.receiveShadow = true;
  stage.scene.add(floor);
  const [distance = 6, azimuth = 35, elevation = 28, x = 0, y = 0.5, z = 0] = (
    params.get("view") ?? ""
  )
    .split(",")
    .filter((part) => part !== "")
    .map(Number);
  const view = { target: new Vector3(x, y, z), distance, azimuth, elevation };
  const camera = createCameraRig(stage.camera, stage.renderer.domElement, () =>
    stage.requestRender(),
  );
  placeCamera(stage.camera, view);
  camera.flyTo(view);
  const update = setup(stage);
  stage.onFrame((frame) => {
    const moving = update?.(frame) ?? false;
    return camera.update(frame) || moving;
  });
  window.office = { stage };
  return stage;
}
