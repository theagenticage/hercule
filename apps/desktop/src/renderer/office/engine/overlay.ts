/**
 * The name tags drawn over the 3D office, as DOM elements placed
 * over each colleague's head, and the room labels of the overview.
 *
 * In the `smart` mode, the tags follow the camera's distance:
 * - far away, one label per room shows its name, how many colleagues belong
 *   in it and how many of those wait on the user (`countColleaguesByRoom`,
 *   the same counts the Rooms directory shows);
 * - in the middle distance, the colleagues in the room the camera looks at
 *   show their names;
 * - close up, every colleague in view does.
 *
 * A room of kind "floor", such as a storey of the Tower, stands for the rooms
 * of its storey that lie inside it. Far away, only its label shows. The
 * rooms inside it show their labels in the middle distance, for the "floor"
 * room the camera looks at. Rooms outside any "floor" room keep their label
 * far away.
 *
 * At every distance the waiting, hovered and selected colleagues show theirs.
 * Mode `all` shows every tag and mode `none` only the hovered and selected
 * ones. Where tags overlap, the more important one shows: selected, hovered,
 * waiting, a room label, then the nearest to the camera. Far away, the room
 * labels come before the waiting tags. A waiting tag that overlaps moves up
 * to make way, but the hovered tag stays where it showed, so no tag moves
 * under the pointer.
 *
 * Far away in the `smart` mode, a large fleet's requests must not bury the
 * room labels, which count them:
 * - only the colleagues who have waited longest show a full tag; every other
 *   waiting colleague shows a marigold pip over its head;
 * - room labels come before the full tags, and a full tag that finds no free
 *   place shows a pip instead;
 * - while the camera moves, the longest-waiting colleagues stay the same ones,
 *   so tags do not switch between pip and full tag during a flight. They are
 *   chosen again when the camera comes to rest.
 *
 * A tag shows the colleague's state as the sim holds it now
 * (`readColleagueStates`), so an answered colleague's request leaves its tag.
 *
 * Tags cost no layout per frame: a tag is measured once when its text
 * changes, and a frame writes only a moved tag's transform and a class when
 * a tag shows or hides. A tag whose colleague stands behind a wall does not
 * show, unless it is hovered or selected. The tags let pointer events
 * through to the canvas; the picker asks the overlay which tag is under the
 * pointer, and the overlay itself handles clicks on room labels.
 */
import { Vector3, type PerspectiveCamera } from "three";
import {
  WALL_HEIGHT,
  findFloorRoom,
  type ColleagueRig,
  type ColleagueState,
  type RoomInfo,
  type Seat,
} from "./contracts";
import { countColleaguesByRoom, isWaiting } from "./room-counts";
import { isCameraMoving, isShown, readCameraView } from "./camera-rig";
import { isColleagueHidden, registerTagHitTest } from "./picking";
import { readColleagueStates, setOffice, type TagMode } from "../office-store";
import "./overlay.css";

export interface Overlay {
  /** Places every tag at its colleague's head, as the camera now sees it. */
  update(): void;
  setMode(mode: TagMode): void;
  setHovered(id: string | null): void;
  setSelected(id: string | null): void;
  dispose(): void;
}

/** How the `smart` mode shows tags at the camera's current distance. */
type Level = "far" | "mid" | "close";

/** The distances, in metres, where the level changes, with a gap so it does not flicker at the edge. */
const CLOSE_ENTER = 10;
const CLOSE_LEAVE = 12;
const FAR_ENTER = 34;
const FAR_LEAVE = 30;
/** The tag's anchor, in metres above the top of the colleague's head. */
const TAG_LIFT = 0.14;
/** The share of a tag's width left of its anchor. The tag sits off-centre so it clears the face to its right. */
const TAG_ANCHOR_X = 0.38;
/** The least room between two tags, in CSS pixels. */
const TAG_GAP = 2;
/** How much smaller a tag shown last frame counts in a collision, in CSS pixels. */
const TAG_HOLD = 3;
/** The least room between a room label and a tag, in CSS pixels, so a tag never sits on a label. */
const LABEL_CLEARANCE = 6;
/**
 * Where a room label or a waiting tag tries next when a more important one
 * takes its place, instead of hiding. Each step moves it by its own height,
 * from where the last step left it; a positive step moves down.
 * - A room label tries below, then above, then two rows below.
 * - A waiting tag tries one row up, then two, so colleagues waiting side by
 *   side all show their requests. It never moves down over its colleague.
 * - Far away in the `smart` mode, a full waiting tag may climb one row per
 *   other full tag, so the longest-waiting colleagues show all their
 *   requests even when they wait in one queue.
 */
const ROOM_LABEL_SHIFTS: ReadonlyArray<number> = [1, -2, 3];
const WAITING_TAG_SHIFTS: ReadonlyArray<number> = [-1, -1];
/** How many waiting colleagues show a full tag far away in the `smart` mode: the ones who have waited longest. */
const FULL_WAITING_TAGS = 5;
/** The width and height of a pip, in CSS pixels, as `overlay.css` draws it. */
const PIP_SIZE = 8;
/**
 * The order in which tags and room labels claim their place on screen, the
 * lowest first. Far away, the room labels come before the waiting tags, so
 * the user can always find the rooms; in the middle distance they come after.
 */
const RANK = {
  selected: 0,
  hovered: 1,
  farRoomLabel: 2,
  waitingTag: 3,
  roomLabel: 4,
  otherTag: 5,
} as const;
const FAR_WAITING_TAG_SHIFTS: ReadonlyArray<number> = Array.from(
  { length: FULL_WAITING_TAGS - 1 },
  () => -1,
);
/** In the middle distance with no room under the camera's target, tags show within this many metres of it. */
const MID_RADIUS = 8;
/** How far a press may travel, in CSS pixels, and still count as a click on a room label. */
const CLICK_SLOP = 5;

/** A screen rectangle in the overlay's own pixels. */
interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What a colleague's tag and a room label share: an element placed over a point of the office. */
interface Placed {
  readonly element: HTMLElement;
  /** The point the element hangs from, in world space, set each frame. */
  readonly anchor: Vector3;
  /** The element's size in CSS pixels, measured when its text changes. */
  width: number;
  height: number;
  /** True when the text changed since the last measurement. */
  dirty: boolean;
  /** The anchor on screen this frame, in CSS pixels. */
  x: number;
  y: number;
  /** How far the placement moved the element up or down from its anchor this frame, in CSS pixels. */
  shiftY: number;
  /** The anchor's distance from the camera this frame. */
  depth: number;
  /** Whether the element shows: set when the frame's placement ends. */
  shown: boolean;
  /** The last transform written, so a frame writes only a change. */
  writtenX: number;
  writtenY: number;
  /** Where the element sits on screen this frame, for collisions and hit tests. */
  readonly rect: Rect;
  /** The order of importance this frame: lower wins a collision. */
  rank: number;
}

interface Tag extends Placed {
  readonly kind: "tag";
  readonly id: string;
  readonly rig: ColleagueRig;
  /** The colleague's state this frame: the sim's, or the world's while the sim has none for it. */
  state: ColleagueState;
  /** The state the tag's text was last built from. */
  writtenState: ColleagueState;
  /** True when the colleague's body shows this frame. */
  visible: boolean;
  /** The room the colleague stands in this frame. */
  room: RoomInfo | null;
  /**
   * True when the tag shows as a pip this frame: a marigold dot with no text.
   * The tag's width and height stay those of the full tag.
   */
  isPip: boolean;
  /** True when the tag's element carries the pip's look. */
  writtenPip: boolean;
}

interface RoomLabel extends Placed {
  readonly kind: "room";
  readonly room: RoomInfo;
  readonly count: HTMLElement;
  readonly waiting: HTMLElement;
  /**
   * The label of the "floor" room this room lies inside, or null. While the
   * "floor" room's label shows far away, this one waits for the middle distance.
   */
  floorLabel: RoomLabel | null;
  /** The counts the text shows. */
  writtenPresent: number;
  writtenAsking: number;
}

/**
 * Returns when a colleague started waiting on the user, in milliseconds since
 * the epoch. A colleague with no request sorts after every one with a request.
 */
const readWaitingSince = (tag: Tag): number =>
  tag.state.request === null ? Infinity : Date.parse(tag.state.request.waitingSince);

/** Returns true when two states of a colleague give its tag the same text. */
const isSameTagText = (a: ColleagueState, b: ColleagueState): boolean =>
  a.pose === b.pose && a.stateLabel === b.stateLabel && a.request === b.request;

/** Returns true when a placed element is a tag showing as a pip. */
const isPipTag = (placed: Tag | RoomLabel): boolean => placed.kind === "tag" && placed.isPip;

/** Returns true when two rectangles overlap, or come closer than `gap` CSS pixels. */
const overlaps = (a: Rect, b: Rect, gap: number): boolean =>
  a.left < b.right + gap &&
  b.left < a.right + gap &&
  a.top < b.bottom + gap &&
  b.top < a.bottom + gap;

/** Returns how much smaller than its element an element counts in a collision on each side, in CSS pixels. */
const readInset = (placed: Placed): number => (placed.shown ? TAG_HOLD - TAG_GAP : -TAG_GAP);

/** Creates the placement state an element starts with. */
function createPlaced(element: HTMLElement, anchor: Vector3): Placed {
  return {
    element,
    anchor,
    width: 0,
    height: 0,
    dirty: true,
    x: 0,
    y: 0,
    shiftY: 0,
    depth: 0,
    shown: false,
    writtenX: NaN,
    writtenY: NaN,
    rect: { left: 0, top: 0, right: 0, bottom: 0 },
    rank: 0,
  };
}

/** Creates one colleague's tag, without its text. */
function createTag(id: string, rig: ColleagueRig): Tag {
  const element = document.createElement("div");
  element.className = "office-tag";
  element.style.setProperty("--hue", `var(--hue-${rig.colleague.look.hue})`);
  return {
    ...createPlaced(element, new Vector3()),
    kind: "tag",
    id,
    rig,
    state: rig.colleague,
    writtenState: rig.colleague,
    visible: false,
    room: null,
    isPip: false,
    writtenPip: false,
  };
}

/** Writes a tag's text from its colleague's state this frame: the hue dot, the name, and the state or the request. */
function writeTagText(tag: Tag): void {
  const { state } = tag;
  tag.writtenState = state;
  const dot = document.createElement("i");
  dot.className = "office-tag__dot";
  const name = document.createElement("b");
  name.className = "office-tag__name";
  name.textContent = tag.rig.colleague.name;
  const stateText = document.createElement("span");
  stateText.className = "office-tag__state";
  stateText.textContent = state.request?.short ?? state.stateLabel;
  tag.element.replaceChildren(dot, name, stateText);
  tag.element.classList.toggle("office-tag--waiting", isWaiting(state));
  tag.dirty = true;
}

/** Creates one room's label, without its counts. */
function createRoomLabel(room: RoomInfo): RoomLabel {
  const element = document.createElement("div");
  element.className = "office-room-label";
  const name = document.createElement("span");
  name.className = "office-room-label__name";
  name.textContent = room.label;
  const count = document.createElement("span");
  count.className = "count office-room-label__count";
  const waiting = document.createElement("span");
  waiting.className = "count count--you office-room-label__count";
  element.append(name, count, waiting);
  const centre = room.bounds.getCenter(new Vector3());
  return {
    ...createPlaced(element, new Vector3(centre.x, room.bounds.min.y + WALL_HEIGHT, centre.z)),
    kind: "room",
    room,
    count,
    waiting,
    floorLabel: null,
    writtenPresent: -1,
    writtenAsking: -1,
  };
}

/**
 * Writes a room label's counts, `present` colleagues of whom `asking` wait on
 * the user, when they changed. A count of nought hides.
 */
function writeCounts(label: RoomLabel, present: number, asking: number): void {
  if (present === label.writtenPresent && asking === label.writtenAsking) return;
  label.writtenPresent = present;
  label.writtenAsking = asking;
  label.count.textContent = String(present);
  label.count.title = `${present} ${present === 1 ? "colleague" : "colleagues"} here`;
  label.count.style.display = present === 0 ? "none" : "";
  label.waiting.textContent = String(asking);
  label.waiting.title = `${asking} waiting on you`;
  label.waiting.style.display = asking === 0 ? "none" : "";
  label.element.classList.toggle("office-room-label--counted", present > 0);
  label.dirty = true;
}

/**
 * Creates the overlay in `container`, which also holds the canvas, with a
 * tag for every rig in `rigs` and a label for every room in `rooms`. `homes`
 * holds each colleague's seat, which the room labels count by. The `rigs`
 * map is the same one the picker gets, which is how the picker finds the tags.
 *
 * `viewport` is the element whose box is the part of the canvas the user
 * sees: the canvas can reach past it, under the thread drawer or past the
 * pane's edge. A tag or label shows only when all of it lies inside, so none
 * is ever cut off.
 */
export function createOverlay(
  container: HTMLElement,
  viewport: HTMLElement,
  camera: PerspectiveCamera,
  rigs: ReadonlyMap<string, ColleagueRig>,
  rooms: ReadonlyArray<RoomInfo>,
  homes: ReadonlyMap<string, Seat>,
): Overlay {
  const layer = document.createElement("div");
  layer.className = "office-tags";
  container.append(layer);

  const tags = [...rigs].map(([id, rig]) => createTag(id, rig));
  for (const tag of tags) {
    writeTagText(tag);
    layer.append(tag.element);
  }
  // The smallest room first, so a colleague in a room inside a hall counts in the room.
  const sizedRooms = [...rooms].sort((a, b) => {
    const sa = a.bounds.getSize(new Vector3());
    const sb = b.bounds.getSize(new Vector3());
    return sa.x * sa.z - sb.x * sb.z;
  });
  const labels = sizedRooms.map(createRoomLabel);
  for (const label of labels) layer.append(label.element);
  const labelsByRoom = new Map(labels.map((label) => [label.room, label]));
  for (const label of labels) {
    const floorRoom = findFloorRoom(label.room, rooms);
    label.floorLabel = floorRoom === null ? null : (labelsByRoom.get(floorRoom) ?? null);
  }
  const tagsById = new Map(tags.map((tag) => [tag.id, tag]));

  let mode: TagMode = "smart";
  let hoveredId: string | null = null;
  let selectedId: string | null = null;
  let level: Level = "far";
  let width = container.clientWidth;
  let height = container.clientHeight;
  let disposed = false;
  /** The states the room labels were last counted from. The sim replaces its map on every change. */
  let countedStates: ReadonlyMap<string, ColleagueState> | null = null;
  /** The tags and labels showing, most important first, for hit tests. */
  let shownInOrder: Array<Tag | RoomLabel> = [];

  /** The part of the overlay the user sees, in the overlay's CSS pixels, measured each frame. */
  const view: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  const projected = new Vector3();
  const lookedAt = new Vector3();
  const candidates: Array<Tag | RoomLabel> = [];
  const waitingTags: Tag[] = [];
  /** The waiting colleagues who show a full tag far away, kept while the camera moves. */
  const longestWaitingIds = new Set<string>();
  let isLongestWaitingKept = false;

  /** Returns the smallest room whose box holds a point, or null. */
  const findRoom = (point: Vector3): RoomInfo | null => {
    for (const room of sizedRooms) {
      const { min, max } = room.bounds;
      if (
        point.x >= min.x &&
        point.x <= max.x &&
        point.z >= min.z &&
        point.z <= max.z &&
        point.y >= min.y - 0.3 &&
        point.y <= max.y
      ) {
        return room;
      }
    }
    return null;
  };

  /**
   * Projects an element's anchor onto the overlay and sets its screen
   * rectangle. `shareLeft` and `shareAbove` are the shares of the element's
   * size left of and above the anchor. A pip has its own small size. Returns
   * false when the anchor is behind the camera or off screen.
   */
  const placeOnScreen = (
    placed: Tag | RoomLabel,
    shareLeft: number,
    shareAbove: number,
  ): boolean => {
    placed.depth = placed.anchor.distanceTo(camera.position);
    projected.copy(placed.anchor).project(camera);
    if (projected.z >= 1 || projected.z <= -1) return false;
    placed.x = ((projected.x + 1) / 2) * width;
    placed.y = ((1 - projected.y) / 2) * height;
    placed.shiftY = 0;
    // A tag shown last frame counts a little smaller, so two tags at the edge of touching do not swap every frame.
    const inset = readInset(placed);
    const isPip = isPipTag(placed);
    const placedWidth = isPip ? PIP_SIZE : placed.width;
    const placedHeight = isPip ? PIP_SIZE : placed.height;
    const { rect } = placed;
    rect.left = placed.x - placedWidth * shareLeft + inset;
    rect.right = rect.left + placedWidth - 2 * inset;
    rect.top = placed.y - placedHeight * shareAbove + inset;
    rect.bottom = rect.top + placedHeight - 2 * inset;
    return isInsideView(placed);
  };

  /** Returns true when all of an element, not only its collision rectangle, lies inside the part of the overlay the user sees. */
  const isInsideView = (placed: Placed): boolean => {
    const inset = readInset(placed);
    const { rect } = placed;
    return (
      rect.left - inset >= view.left &&
      rect.right + inset <= view.right &&
      rect.top - inset >= view.top &&
      rect.bottom + inset <= view.bottom
    );
  };

  /**
   * Measures the part of the overlay the user sees, from the boxes of
   * `viewport` and `container`. Both are read at the start of a frame, before
   * the frame writes anything, so the read costs no extra layout. They are read
   * every frame because the stage slides under the drawer with a CSS
   * transition, which no observer reports.
   */
  const measureView = (): void => {
    const box = container.getBoundingClientRect();
    const seen = viewport.getBoundingClientRect();
    view.left = Math.max(0, seen.left - box.left);
    view.top = Math.max(0, seen.top - box.top);
    view.right = Math.min(width, seen.right - box.left);
    view.bottom = Math.min(height, seen.bottom - box.top);
  };

  /** Moves an element's anchor and rectangle on screen by `dy` CSS pixels. */
  const shiftOnScreen = (placed: Placed, dy: number): void => {
    placed.y += dy;
    placed.shiftY += dy;
    placed.rect.top += dy;
    placed.rect.bottom += dy;
  };

  /**
   * Measures every element whose text changed. Reads all sizes in one pass,
   * so the page lays out once. A tag drawn as a pip waits until it shows in
   * full again, because only the full tag's size is worth measuring.
   */
  const measureChanged = (): void => {
    for (const placed of [...tags, ...labels]) {
      if (!placed.dirty || (placed.kind === "tag" && placed.writtenPip)) continue;
      placed.width = placed.element.offsetWidth;
      placed.height = placed.element.offsetHeight;
      placed.dirty = false;
    }
  };

  /** Decides the `smart` mode's level from the camera's distance to what it looks at. */
  const decideLevel = (distance: number): Level => {
    if (level === "close" && distance <= CLOSE_LEAVE) return "close";
    if (level === "far" && distance >= FAR_LEAVE) return "far";
    return distance < CLOSE_ENTER ? "close" : distance > FAR_ENTER ? "far" : "mid";
  };

  /** Writes an element's transform and shown state, each only when it changed. */
  const write = (placed: Placed, shown: boolean): void => {
    if (shown) {
      const ratio = window.devicePixelRatio || 1;
      const x = Math.round(placed.x * ratio) / ratio;
      const y = Math.round(placed.y * ratio) / ratio;
      if (x !== placed.writtenX || y !== placed.writtenY) {
        placed.writtenX = x;
        placed.writtenY = y;
        placed.element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }
    }
    if (shown !== placed.shown) {
      placed.shown = shown;
      placed.element.classList.toggle("is-shown", shown);
    }
  };

  /** Returns true when the `smart` mode, or the mode the user chose, shows a visible colleague's tag. */
  const wantsTag = (tag: Tag, focusRoom: RoomInfo | null): boolean => {
    if (tag.id === selectedId || tag.id === hoveredId) return true;
    if (mode === "all") return true;
    if (mode === "none") return false;
    if (isWaiting(tag.state) || level === "close") return true;
    if (level === "far") return false;
    return focusRoom !== null
      ? tag.room === focusRoom
      : tag.anchor.distanceTo(lookedAt) < MID_RADIUS;
  };

  /**
   * Decides which tags show as pips. Far away in the `smart` mode, every
   * waiting colleague shows a pip except the hovered, the selected, and the
   * ones who have waited longest. The placement may still turn a full tag into
   * a pip when it finds no free place for the full tag.
   *
   * Only colleagues the user can see count as the longest waiting: on screen,
   * and not behind a wall. Otherwise a room seen
   * from far away could show only pips while the full tags go to colleagues
   * out of view. While the camera moves, the choice is kept from the last
   * frame, so tags do not switch between pip and full tag during a flight.
   */
  const decidePips = (): void => {
    const isFar = mode === "smart" && level === "far";
    if (!isFar) {
      longestWaitingIds.clear();
      isLongestWaitingKept = false;
    } else if (!isLongestWaitingKept || !isCameraMoving(camera)) {
      waitingTags.length = 0;
      for (const tag of tags) {
        if (!tag.visible || !isWaiting(tag.state)) continue;
        projected.copy(tag.anchor).project(camera);
        const isOnScreen =
          Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && Math.abs(projected.z) < 1;
        if (!isOnScreen || isColleagueHidden(camera, tag.rig)) continue;
        waitingTags.push(tag);
      }
      waitingTags.sort((a, b) => readWaitingSince(a) - readWaitingSince(b));
      longestWaitingIds.clear();
      for (const tag of waitingTags.slice(0, FULL_WAITING_TAGS)) longestWaitingIds.add(tag.id);
      isLongestWaitingKept = true;
    }
    for (const tag of tags) {
      tag.isPip =
        isFar &&
        isWaiting(tag.state) &&
        !longestWaitingIds.has(tag.id) &&
        tag.id !== selectedId &&
        tag.id !== hoveredId;
    }
  };

  function update(): void {
    if (disposed) return;
    measureView();
    camera.updateMatrixWorld();
    const view = readCameraView(camera);
    if (view !== null) lookedAt.copy(view.target);
    else camera.getWorldDirection(lookedAt).multiplyScalar(20).add(camera.position);
    level = decideLevel(view?.distance ?? camera.position.distanceTo(lookedAt));
    const focusRoom = findRoom(lookedAt);
    const focusLabel = focusRoom === null ? undefined : labelsByRoom.get(focusRoom);
    const focusFloorLabel =
      focusLabel?.room.kind === "floor" ? focusLabel : (focusLabel?.floorLabel ?? null);

    // First the text and the counts, then one measuring pass, then placement.
    const states = readColleagueStates();
    if (states !== countedStates) {
      countedStates = states;
      const counts = countColleaguesByRoom(rooms, homes, states);
      for (const label of labels) {
        const count = counts.get(label.room.id);
        writeCounts(label, count?.colleagues ?? 0, count?.waiting ?? 0);
      }
    }
    for (const tag of tags) {
      const { rig } = tag;
      tag.state = states.get(tag.id) ?? rig.colleague;
      if (!isSameTagText(tag.state, tag.writtenState)) writeTagText(tag);
      tag.visible = isShown(rig.object);
      if (!tag.visible) continue;
      rig.object.getWorldPosition(tag.anchor);
      tag.room = findRoom(tag.anchor);
      tag.anchor.y += rig.headHeight + TAG_LIFT;
    }
    decidePips();
    measureChanged();

    const isFar = mode === "smart" && level === "far";
    candidates.length = 0;
    for (const tag of tags) {
      if (!tag.visible || !wantsTag(tag, focusRoom)) continue;
      const heldShiftY = tag.id === hoveredId && tag.shown ? tag.shiftY : 0;
      // A pip sits centred over the head, and gives way to every tag and label.
      if (!placeOnScreen(tag, tag.isPip ? 0.5 : TAG_ANCHOR_X, 1)) continue;
      // The hovered tag stays where it showed, even when it had moved up to
      // make way for another tag. Back at its anchor, it would push that tag
      // in under the pointer, and a click would select the wrong colleague.
      shiftOnScreen(tag, heldShiftY);
      tag.rank =
        tag.id === selectedId
          ? RANK.selected
          : tag.id === hoveredId
            ? RANK.hovered
            : isWaiting(tag.state) && !tag.isPip
              ? RANK.waitingTag
              : RANK.otherTag;
      // A tag over a colleague the user cannot see would float over a wall.
      // The hovered and selected ones show anyway.
      if (tag.rank > RANK.hovered && isColleagueHidden(camera, tag.rig)) continue;
      candidates.push(tag);
    }
    if (mode === "smart" && level !== "close") {
      for (const label of labels) {
        const wanted =
          level === "far"
            ? label.floorLabel === null
            : label.floorLabel !== null && label.floorLabel === focusFloorLabel;
        if (!wanted) continue;
        if (!placeOnScreen(label, 0.5, 0.5)) continue;
        label.rank = level === "far" ? RANK.farRoomLabel : RANK.roomLabel;
        candidates.push(label);
      }
    }
    candidates.sort((a, b) => a.rank - b.rank || a.depth - b.depth);

    const shown = new Set<Placed>();
    shownInOrder = [];
    const isFree = (candidate: Tag | RoomLabel): boolean =>
      !shownInOrder.some((placed) => {
        // Pips may overlap one another: two colleagues waiting side by side both keep theirs.
        if (isPipTag(placed) && isPipTag(candidate)) return false;
        const gap = (placed.kind === "room") !== (candidate.kind === "room") ? LABEL_CLEARANCE : 0;
        return overlaps(placed.rect, candidate.rect, gap);
      });
    for (const candidate of candidates) {
      const shifts =
        candidate.kind === "room"
          ? ROOM_LABEL_SHIFTS
          : candidate.rank === RANK.waitingTag
            ? isFar
              ? FAR_WAITING_TAG_SHIFTS
              : WAITING_TAG_SHIFTS
            : [];
      let fits =
        isFree(candidate) ||
        shifts.some((step) => {
          // The step keeps a label's clearance too, so a tag that makes way for a label clears it.
          shiftOnScreen(candidate, step * (candidate.height + 2 * TAG_GAP + LABEL_CLEARANCE));
          return isInsideView(candidate) && isFree(candidate);
        });
      // Far away, a full waiting tag with no free place shows its pip instead.
      if (!fits && isFar && candidate.kind === "tag" && candidate.rank === RANK.waitingTag) {
        candidate.isPip = true;
        fits = placeOnScreen(candidate, 0.5, 1) && isFree(candidate);
      }
      if (!fits) continue;
      shown.add(candidate);
      shownInOrder.push(candidate);
    }
    for (const tag of tags) {
      if (tag.isPip !== tag.writtenPip) {
        tag.writtenPip = tag.isPip;
        tag.element.classList.toggle("office-tag--pip", tag.isPip);
      }
      write(tag, shown.has(tag));
    }
    for (const label of labels) write(label, shown.has(label));
  }

  /** Returns the tag or room label showing under a point of the page, or null. */
  const findShownAt = (clientX: number, clientY: number): Tag | RoomLabel | null => {
    if (shownInOrder.length === 0) return null;
    const box = layer.getBoundingClientRect();
    const x = clientX - box.left;
    const y = clientY - box.top;
    return (
      shownInOrder.find(
        ({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
      ) ?? null
    );
  };

  const findTagAt = (clientX: number, clientY: number): string | null => {
    const found = findShownAt(clientX, clientY);
    return found?.kind === "tag" ? found.id : null;
  };

  const findRoomLabelAt = (clientX: number, clientY: number): RoomLabel | null => {
    const found = findShownAt(clientX, clientY);
    return found?.kind === "room" ? found : null;
  };

  /** Marks the tag of a colleague hovered or selected, and unmarks the one before. */
  const markTag = (previous: string | null, next: string | null, className: string): void => {
    if (previous !== null) tagsById.get(previous)?.element.classList.remove(className);
    if (next !== null) tagsById.get(next)?.element.classList.add(className);
  };

  registerTagHitTest(rigs, findTagAt);

  // Room labels take clicks themselves; a colleague's tag goes through the picker.
  let pressedAt: { x: number; y: number } | null = null;
  let hotLabel: RoomLabel | null = null;
  const onPointerDown = (event: PointerEvent): void => {
    pressedAt = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (pressedAt === null) return;
    const travelled = Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y);
    pressedAt = null;
    if (travelled > CLICK_SLOP) return;
    const label = findRoomLabelAt(event.clientX, event.clientY);
    if (label !== null) setOffice({ selectedId: null, roomId: label.room.id, drawer: false });
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (event.buttons !== 0) return;
    const label = findRoomLabelAt(event.clientX, event.clientY);
    if (label === hotLabel) return;
    hotLabel?.element.classList.remove("is-hot");
    label?.element.classList.add("is-hot");
    hotLabel = label;
    container.style.cursor = label === null ? "" : "pointer";
  };
  // The camera glides to a double-clicked floor point; a double-click on a room label is not one.
  const onDoubleClick = (event: MouseEvent): void => {
    if (findRoomLabelAt(event.clientX, event.clientY) !== null) event.stopPropagation();
  };
  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointerup", onPointerUp);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("dblclick", onDoubleClick, { capture: true });

  const resizeObserver = new ResizeObserver(() => {
    width = container.clientWidth;
    height = container.clientHeight;
    update();
  });
  resizeObserver.observe(container);
  // The room labels use the display font; measure again once it has loaded.
  void document.fonts.ready.then(() => {
    for (const tag of tags) tag.dirty = true;
    for (const label of labels) label.dirty = true;
    update();
  });

  return {
    update,
    setMode(next) {
      mode = next;
      update();
    },
    setHovered(id) {
      markTag(hoveredId, id, "is-hovered");
      hoveredId = id;
      update();
    },
    setSelected(id) {
      markTag(selectedId, id, "is-selected");
      selectedId = id;
      update();
    },
    dispose() {
      disposed = true;
      registerTagHitTest(rigs, null);
      resizeObserver.disconnect();
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("dblclick", onDoubleClick, { capture: true });
      container.style.cursor = "";
      layer.remove();
    },
  };
}
