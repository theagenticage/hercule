/**
 * PROTOTYPE - the office in the main pane: the 3D scene, and the panels
 * drawn over it. The scene mounts once and stays mounted while the user
 * moves between colleagues, so the camera can glide instead of cutting.
 */
import { useEffect, useRef, type JSX } from "react";
import { mountOfficeScene, type OfficeScene } from "../office-scene";
import type { World } from "../world/types";
import "./office.css";

declare global {
  interface Window {
    /** The mounted office, for the screenshot tool and the console. */
    office?: OfficeScene;
  }
}

export function OfficeView({ world }: { readonly world: World }): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scene = mountOfficeScene(stageRef.current!, world);
    window.office = scene;
    return () => {
      delete window.office;
      scene.dispose();
    };
  }, [world]);
  return (
    <div className="office">
      <div className="office-stage" ref={stageRef} />
    </div>
  );
}
