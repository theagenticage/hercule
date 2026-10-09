/**
 * The Office in the main pane: the 3D scene, and the panels drawn over it.
 * The scene mounts once and stays mounted while the user moves between
 * colleagues, so the camera can glide instead of cutting; a new world is
 * handed to the mounted scene.
 *
 * The panels sit on the deck, a layer over the part of the Office the user
 * can see: the whole pane, or the part left of the drawer while it is
 * open. They are the top bar and the dossier card of the selected colleague.
 *
 * While the drawer is open the stage also slides left by half the drawer's
 * width, so the selected colleague, whom the camera centres, stays centred
 * in what is left of the Office.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import type { BuiltOffice } from "../engine/contracts";
import { mountOfficeScene, type OfficeScene } from "../office-scene";
import type { OpenColleague } from "../office-store";
import type { World } from "../world/types";
import { DossierCard } from "./dossier-card";
import { OfficeDrawer } from "./office-drawer";
import { useOfficeKeys } from "./office-keys";
import { TopBar } from "./top-bar";
import "./office.css";

/**
 * Renders the Office of `world`: the scene, and the panels over it, and the
 * drawer open on `open`, or closed for null.
 */
export function OfficeView({
  world,
  open,
}: {
  readonly world: World;
  readonly open: OpenColleague | null;
}): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<OfficeScene | null>(null);
  // The office as built now, which the panels read the rooms from. The scene
  // sets it after each build, so the panels follow a rebuilt office.
  const [builtOffice, setBuiltOffice] = useState<BuiltOffice | null>(null);
  useOfficeKeys(world);
  // The scene is built once, from the first world; later worlds go to `setWorld`.
  const firstWorld = useRef(world);
  useEffect(() => {
    const mounted = mountOfficeScene(
      stageRef.current!,
      deckRef.current!,
      firstWorld.current,
      setBuiltOffice,
    );
    setScene(mounted);
    return () => {
      setScene(null);
      setBuiltOffice(null);
      mounted.dispose();
    };
  }, []);
  useEffect(() => {
    scene?.setWorld(world);
  }, [scene, world]);
  return (
    <div className="office" data-drawer={open !== null}>
      <div className="office-stage" ref={stageRef} />
      <div className="office-deck" ref={deckRef}>
        <TopBar world={world} office={builtOffice} />
        <DossierCard world={world} office={builtOffice} />
      </div>
      <OfficeDrawer open={open} />
    </div>
  );
}
