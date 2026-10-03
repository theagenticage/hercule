/**
 * PROTOTYPE - the office in the main pane: the 3D scene, and the panels
 * drawn over it. The scene mounts once and stays mounted while the user
 * moves between colleagues, so the camera can glide instead of cutting.
 *
 * The panels sit on the deck, a layer over the part of the office the user
 * can see: the whole pane, or the part left of the thread drawer while it is
 * open. They are the top bar, the dossier card of the selected colleague,
 * the controls panel and the performance readout.
 *
 * While the drawer is open the stage also slides left by half the drawer's
 * width, so the selected colleague, whom the camera centres, stays centred
 * in what is left of the office.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from "react";
import { mountOfficeScene, type OfficeScene } from "../office-scene";
import { readOffice, subscribeOffice } from "../office-store";
import type { World } from "../world/types";
import { ControlsPanel } from "./controls-panel";
import { DossierCard } from "./dossier-card";
import { useOfficeKeys } from "./office-keys";
import { PerfHud } from "./perf-hud";
import { findDrawerThreadId, ThreadDrawer } from "./thread-drawer";
import { TopBar } from "./top-bar";
import "./office.css";

/** Renders the office of `world`: the scene, and the panels and the thread drawer over it. */
export function OfficeView({ world }: { readonly world: World }): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<OfficeScene | null>(null);
  const state = useSyncExternalStore(subscribeOffice, readOffice);
  useOfficeKeys(world);
  useEffect(() => {
    const scene = mountOfficeScene(stageRef.current!, world);
    window.office = scene;
    setScene(scene);
    return () => {
      setScene(null);
      delete window.office;
      scene.dispose();
    };
  }, [world]);
  return (
    <div className="office" data-drawer={findDrawerThreadId(world, state) !== null}>
      <div className="office-stage" ref={stageRef} />
      <div className="office-deck">
        <TopBar world={world} scene={scene} />
        <DossierCard world={world} scene={scene} />
        <ControlsPanel />
        {state.perf && scene !== null ? <PerfHud scene={scene} /> : null}
      </div>
      <ThreadDrawer world={world} />
    </div>
  );
}
