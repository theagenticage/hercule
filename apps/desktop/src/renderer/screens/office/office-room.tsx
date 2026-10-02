import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent,
  type JSX,
  type RefObject,
} from "react";
import {
  formatTenths,
  frameRegion,
  projectPoint,
  ROOM_DEPTH,
  ROOM_WIDTH,
  type PlanRegion,
  type Projection,
} from "./projection";
import type { RoomContents } from "@hercule/client-core";
import type { Project } from "@hercule/contract";
import { furnishRoom, type RoomPiece } from "./room-pieces";
import { drawRoomShell } from "./room-shell";
import "./office.css";

/**
 * The part of the room the camera frames:
 *
 * - "room": the whole room.
 * - "your-desk": your desk and the assistant in the lobby, along the front.
 * - "wing": the first runner's wing and its desks.
 * - "triage": the Triage desk and the plaques on the wall, with the whole wing's engraving in view.
 */
export type RoomShot = "room" | "your-desk" | "wing" | "triage";

/** The plan region each shot frames, in tiles. */
const SHOT_REGIONS: { readonly [Shot in RoomShot]: PlanRegion } = {
  room: { x0: 0, x1: ROOM_WIDTH, y0: 0, y1: ROOM_DEPTH },
  "your-desk": { x0: 0, x1: 24, y0: 13.4, y1: 18.6 },
  wing: { x0: 9.4, x1: 23.4, y0: 0.9, y1: 7.2 },
  triage: { x0: 0, x1: 11, y0: 0, y1: 9 },
};

// The first run floats a card 448px wide over the room's right-hand side, 32px
// from the window's edge. A close shot is framed in the part of the stage the
// card leaves clear, with 16px more to spare; the whole room is framed 200px
// narrower than the stage and runs on under the card's glass.
const CARD_ALLOWANCE = 448 + 48;
const ROOM_ALLOWANCE = 200;
/** The pixels a framed region keeps clear of the framed width's and the stage's edges. */
const FRAME_PAD = 56;
/** The largest a floor tile is drawn, in pixels, however close the shot. */
const MAX_TILE = 46;

/** Returns the projection that frames `shot` on a stage `width` by `height` pixels. */
export function frameShot(width: number, height: number, shot: RoomShot): Projection {
  const framedWidth = width - (shot === "room" ? ROOM_ALLOWANCE : CARD_ALLOWANCE);
  return frameRegion(framedWidth, height, SHOT_REGIONS[shot], FRAME_PAD, MAX_TILE);
}

/**
 * How far, in pixels, a label's pin keeps from the stage's left and top
 * edges. A label stands above its pin and reaches left of it, and at the top
 * it must also clear the step ladder.
 */
const LABEL_LEFT_AND_TOP_CLEARANCE = 72;
/** How far, in pixels, a label's pin keeps from the stage's bottom edge. */
const LABEL_BOTTOM_CLEARANCE = 40;

/**
 * Checks whether a label pinned at stage point `(x, y)` shows whole on a
 * stage `width` by `height` pixels: clear of the window's edges and of the
 * first run's card. A label the shot would cut is left out.
 */
export const isLabelInView = (x: number, y: number, width: number, height: number): boolean =>
  x >= LABEL_LEFT_AND_TOP_CLEARANCE &&
  x <= width - CARD_ALLOWANCE &&
  y >= LABEL_LEFT_AND_TOP_CLEARANCE &&
  y <= height - LABEL_BOTTOM_CLEARANCE;

/** What the room last drew, and what is still settling into it. */
interface Scene {
  readonly contents: RoomContents;
  readonly shot: RoomShot;
  /** The keys of the pieces drawn. */
  readonly keys: ReadonlyArray<string>;
  /** The keys of the pieces still settling, each drawn on an arrival layer. */
  readonly arriving: ReadonlyArray<string>;
  /** Whether the arrivals wait for the camera to stop first. */
  readonly waitsForCamera: boolean;
  /** The last camera move, by the shots it runs between; a new object starts a new move. */
  readonly cameraMove: { readonly from: RoomShot; readonly to: RoomShot } | null;
}

/** Checks whether the user asked macOS to reduce motion. */
const prefersReducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Returns the keys of the pieces `contents` puts in the room. */
const listPieceKeys = (contents: RoomContents): string[] =>
  // The keys do not depend on the projects, which only tint a desk.
  furnishRoom(contents, []).map((piece) => piece.key);

/**
 * Returns the scene after the room is asked to draw `contents` at `shot`,
 * having last drawn `scene`. The pieces `contents` adds arrive, and a new
 * shot moves the camera, unless the user asked to reduce motion: then the
 * room is drawn again in place.
 */
function advanceScene(scene: Scene, contents: RoomContents, shot: RoomShot): Scene {
  const keys = listPieceKeys(contents);
  const reduced = prefersReducedMotion();
  const added = reduced ? [] : keys.filter((key) => !scene.keys.includes(key));
  const moved = !reduced && shot !== scene.shot;
  return {
    contents,
    shot,
    keys,
    // Pieces still settling from an earlier change keep settling, unless this change adds its own.
    arriving: added.length > 0 ? added : scene.arriving.filter((key) => keys.includes(key)),
    waitsForCamera: added.length > 0 ? moved : scene.waitsForCamera,
    cameraMove: moved ? { from: scene.shot, to: shot } : scene.cameraMove,
  };
}

/**
 * Returns the stage's size in whole CSS pixels, as laid out, and draws the
 * caller again whenever it changes. Returns `null` until the stage is laid out
 * with a size.
 */
function useStageSize(
  ref: RefObject<HTMLElement | null>,
): { readonly width: number; readonly height: number } | null {
  const [size, setSize] = useState<{ readonly width: number; readonly height: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const stage = ref.current!;
    const measure = () => {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      setSize((last) =>
        width === 0 || height === 0
          ? null
          : last?.width === width && last.height === height
            ? last
            : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return size;
}

/**
 * Draws the Office as the first run furnishes it: the room `contents`
 * describes, framed at `shot`. The first thread's desk takes its project's
 * tint from `projects`, the project list in its own order. The room fills its
 * positioned parent, and draws nothing until the parent has a size.
 *
 * When `contents` gains a piece, the piece settles into place from just
 * above, then the room is drawn again as one still picture. When `shot`
 * changes, the camera moves to the new framing first, and the new pieces
 * land once it stops. The veil lifts when the lights come on. Nothing moves
 * once the room is still, and with Reduce motion on the room is drawn again
 * in place.
 *
 * The room is a picture with one label for assistive technology. The labels
 * over it are visible text, but the screen around the room says in words
 * everything they show.
 */
export function OfficeRoom({
  contents,
  projects,
  shot,
}: {
  readonly contents: RoomContents;
  readonly projects: readonly Project[];
  readonly shot: RoomShot;
}): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const size = useStageSize(stageRef);
  // A pattern id may not hold the colons React's ids have.
  const parquetId = `parquet-${useId().replace(/[^\w-]/g, "")}`;

  const [scene, setScene] = useState<Scene>(() => ({
    contents,
    shot,
    keys: listPieceKeys(contents),
    arriving: [],
    waitsForCamera: false,
    cameraMove: null,
  }));
  if (scene.contents !== contents || scene.shot !== shot) {
    setScene(advanceScene(scene, contents, shot));
  }

  const { cameraMove } = scene;
  useLayoutEffect(() => {
    const camera = cameraRef.current!;
    const { clientWidth: width, clientHeight: height } = stageRef.current!;
    if (cameraMove === null || width === 0 || height === 0) return;
    const from = frameShot(width, height, cameraMove.from);
    const to = frameShot(width, height, cameraMove.to);
    camera.classList.remove("is-moving");
    if (from.tile === to.tile && from.originX === to.originX && from.originY === to.originY) {
      camera.style.transform = "none";
      return;
    }
    // Show the old framing with a transform of the new drawing, then let the transform go.
    const k = from.tile / to.tile;
    camera.style.transform = `translate(${(from.originX - k * to.originX).toFixed(1)}px,${(from.originY - k * to.originY).toFixed(1)}px) scale(${k.toFixed(4)})`;
    // Reading the layout applies the starting transform before the transition is switched on.
    void camera.offsetWidth;
    camera.classList.add("is-moving");
    camera.style.transform = "none";
  }, [cameraMove]);

  const endArrivals = (event: AnimationEvent) => {
    if (event.animationName !== "room-settle" && event.animationName !== "room-label-settle")
      return;
    setScene((last) =>
      last.arriving.length === 0 ? last : { ...last, arriving: [], waitsForCamera: false },
    );
  };

  return (
    <div ref={stageRef} className="office-room" data-lights={contents.lightsOn ? "on" : "off"}>
      <div ref={cameraRef} className="room-camera" onAnimationEnd={endArrivals}>
        {size !== null && (
          <RoomDrawing
            contents={contents}
            projects={projects}
            projection={frameShot(size.width, size.height, shot)}
            width={size.width}
            height={size.height}
            parquetId={parquetId}
            arriving={scene.arriving}
            waitsForCamera={scene.waitsForCamera}
          />
        )}
      </div>
      <div className="room-veil" />
    </div>
  );
}

/**
 * Draws the room under `projection` on a stage `width` by `height` pixels: one
 * still SVG with the shell and every settled piece, one layer each for the
 * furniture and the colleagues in `arriving`, and the labels over them all.
 */
function RoomDrawing({
  contents,
  projects,
  projection,
  width,
  height,
  parquetId,
  arriving,
  waitsForCamera,
}: {
  readonly contents: RoomContents;
  readonly projects: readonly Project[];
  readonly projection: Projection;
  readonly width: number;
  readonly height: number;
  readonly parquetId: string;
  readonly arriving: ReadonlyArray<string>;
  readonly waitsForCamera: boolean;
}): JSX.Element {
  const pieces = furnishRoom(contents, projects).sort((a, b) => a.depth - b.depth);
  const stillPieces = pieces.filter((piece) => !arriving.includes(piece.key));
  const arrivingFurniture = pieces.filter(
    (piece) => arriving.includes(piece.key) && !piece.isColleague,
  );
  const arrivingColleagues = pieces.filter(
    (piece) => arriving.includes(piece.key) && piece.isColleague,
  );
  const lateClass = waitsForCamera ? " is-late" : "";

  const drawPieces = (list: ReadonlyArray<RoomPiece>) =>
    list.map((piece) => <PieceDrawing key={piece.key} piece={piece} projection={projection} />);
  const svgSize = { width, height, viewBox: `0 0 ${width} ${height}` };

  return (
    <>
      <svg
        className="floor"
        {...svgSize}
        role="img"
        aria-label="Your office, furnished as you set it up"
      >
        {drawRoomShell(projection, parquetId, contents.gitHubAccount !== null)}
        {drawPieces(stillPieces)}
      </svg>
      {arrivingFurniture.length > 0 && (
        <div className={`room-arrival${lateClass}`}>
          <svg className="floor" {...svgSize} aria-hidden="true">
            {drawPieces(arrivingFurniture)}
          </svg>
        </div>
      )}
      {arrivingColleagues.length > 0 && (
        <div className={`room-arrival room-arrival--character${lateClass}`}>
          <svg className="floor" {...svgSize} aria-hidden="true">
            {drawPieces(arrivingColleagues)}
          </svg>
        </div>
      )}
      <div className={`tags${lateClass}`}>
        {pieces.map((piece) => {
          const label = piece.placeLabel(projection);
          if (label === null) return null;
          const [x, y] = projectPoint(projection, label.x, label.y, label.z);
          if (!isLabelInView(x, y, width, height)) return null;
          const className = ["tag", label.variant, arriving.includes(piece.key) ? "is-new" : null]
            .filter((part) => part !== null)
            .join(" ");
          return (
            <div
              key={piece.key}
              className={className}
              style={{ left: `${formatTenths(x)}px`, top: `${formatTenths(y)}px` }}
            >
              {label.content}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Draws one piece under `projection`. A component of its own, so React keys each piece. */
function PieceDrawing({
  piece,
  projection,
}: {
  readonly piece: RoomPiece;
  readonly projection: Projection;
}): JSX.Element | null {
  return piece.draw(projection);
}
