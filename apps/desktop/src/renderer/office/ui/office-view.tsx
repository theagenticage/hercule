/**
 * The Office in the main pane: the 3D scene, and the panels drawn over it.
 * The scene mounts once and stays mounted while the user moves between
 * colleagues, so the camera can glide instead of cutting; a new world is
 * handed to the mounted scene.
 *
 * The panels sit on the deck, a layer over the part of the Office the user
 * can see: the whole pane, or the part left of the thread drawer while it is
 * open. They are the top bar and the dossier card of the selected colleague.
 *
 * While the drawer is open the stage also slides left by half the drawer's
 * width, so the selected colleague, whom the camera centres, stays centred
 * in what is left of the Office.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from "react";
import { mountOfficeScene, type OfficeScene } from "../office-scene";
import { readOffice, subscribeOffice } from "../office-store";
import type { World } from "../world/types";
import { DossierCard } from "./dossier-card";
import { useOfficeKeys } from "./office-keys";
import { findDrawerThreadId, ThreadDrawer } from "./thread-drawer";
import { TopBar } from "./top-bar";
import "./office.css";

/** Renders the Office of `world`: the scene, and the panels and the thread drawer over it. */
export function OfficeView({ world }: { readonly world: World }): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<OfficeScene | null>(null);
  const state = useSyncExternalStore(subscribeOffice, readOffice);
  useOfficeKeys(world);
  // The scene is built once, from the first world; later worlds go to `setWorld`.
  const firstWorld = useRef(world);
  useEffect(() => {
    const mounted = mountOfficeScene(stageRef.current!, firstWorld.current);
    setScene(mounted);
    return () => {
      setScene(null);
      mounted.dispose();
    };
  }, []);
  useEffect(() => {
    scene?.setWorld(world);
  }, [scene, world]);
  return (
    <div className="office" data-drawer={findDrawerThreadId(state) !== null}>
      <div className="office-stage" ref={stageRef} />
      <div className="office-deck">
        <TopBar world={world} scene={scene} />
        <DossierCard world={world} scene={scene} />
      </div>
      <ThreadDrawer />
    </div>
  );
}
