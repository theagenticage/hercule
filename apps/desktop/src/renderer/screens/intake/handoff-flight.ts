/**
 * The flight of a handoff (spec 17 §Tracking, Motion). When the user hands a
 * signal to an agent, the signal's row lifts out of Intake's list and flies
 * to the top of folded Tracking, where the Task's row lands.
 *
 * The signal leaves the list and the Task's row arrives in Tracking by two
 * separate reads, so the flight has two steps:
 *
 * 1. When the signal's row leaves the list on screen, a copy of it takes its
 *    place, lifted with a shadow. The list closes up beneath the copy.
 * 2. When folded Tracking draws the row of a Task that names the signal, the
 *    copy flies to that row, and the row stays unseen until the copy lands.
 *    Waiting for the row means the copy always flies to where the row really
 *    is, which depends on how many rows Tracking holds.
 *
 * Nothing flies when Tracking is opened, because the sheet covers the list,
 * or when the row is off screen: the list then plays its ordinary motion.
 * Nothing runs while no handoff is under way.
 */
import type { RowExitHandler } from "./use-row-motion";
import { readMotionDuration, readMotionEasing } from "./motion-tokens";

/** How long a lifted copy waits for its Task's row before it gives up and fades, in milliseconds. */
const LANDING_TIMEOUT = 1500;

/**
 * How long a handoff stays expected, in milliseconds, while its signal's row
 * has not left the list on screen. A row that leaves out of view never asks
 * for a flight, so the expectation expires instead of staying for good.
 */
const EXPECTATION_TIMEOUT = 10_000;

/** The flights of the handoffs the user has under way. */
export interface HandoffFlights {
  /**
   * A ref for the layer over the list column that the copies fly in. Tracking
   * draws it, and the closing sheet's copy moves in it too.
   */
  readonly setLayer: (layer: HTMLElement | null) => void;
  /** Returns the layer set by `setLayer`, or `null` while none is drawn. */
  readonly readLayer: () => HTMLElement | null;
  /** A ref for the element of folded Tracking. It is set to `null` when folded Tracking goes. */
  readonly setFold: (fold: HTMLElement | null) => void;
  /** Returns folded Tracking's element, or `null` while Tracking is opened or not drawn. */
  readonly readFold: () => HTMLElement | null;
  /**
   * Records that the user is handing the signal `signalId` off. When its row
   * then leaves the list on screen, it flies. Call it when the answer
   * starts, before it is sent.
   */
  readonly expect: (signalId: string) => void;
  /** Forgets the handoff of `signalId`, because its answer failed. A copy already lifted fades. */
  readonly forget: (signalId: string) => void;
  /** Gives the list the exit of a row whose handoff is expected, as `useRowMotion` takes it. */
  readonly takeLeavingRow: RowExitHandler;
  /**
   * Sends on its way each lifted copy whose signal is named by
   * `handoffSignalIds`, the signals that the Task of the first row of folded
   * Tracking was handed off from. `rows` is the element that holds the rows
   * of folded Tracking, or `null` when it has none. Call it each time folded
   * Tracking has drawn its rows. The flight aims at `rows`' own place, which
   * the first row's arrival and slide never move, and not at the row.
   */
  readonly land: (handoffSignalIds: ReadonlyArray<string>, rows: HTMLElement | null) => void;
}

/** A row's copy, lifted and waiting for the row of its Task. */
interface LiftedCopy {
  readonly copy: HTMLElement;
  /** Where the signal's row stood, in pixels from the window's top left. */
  readonly place: DOMRect;
  /** Gives up waiting: fades the copy out. */
  readonly timeout: ReturnType<typeof setTimeout>;
}

/** Creates the flights of one Intake screen. */
export const createHandoffFlights = (): HandoffFlights => {
  let layer: HTMLElement | null = null;
  let fold: HTMLElement | null = null;
  /** The handoffs expected, each with the timer that forgets it. */
  const expected = new Map<string, ReturnType<typeof setTimeout>>();
  const lifted = new Map<string, LiftedCopy>();
  // What folded Tracking drew last, for a copy that is lifted after its row arrived.
  let drawn: { readonly signalIds: ReadonlyArray<string>; readonly rows: HTMLElement } | null =
    null;

  /** Stops expecting the handoff of `signalId`. Returns whether it was expected. */
  const stopExpecting = (signalId: string): boolean => {
    const timer = expected.get(signalId);
    if (timer === undefined) return false;
    clearTimeout(timer);
    return expected.delete(signalId);
  };

  /** Fades `copy` out where it stands, and removes it. */
  const fadeOut = (signalId: string): void => {
    const waiting = lifted.get(signalId);
    if (waiting === undefined) return;
    lifted.delete(signalId);
    clearTimeout(waiting.timeout);
    const { copy } = waiting;
    const remove = (): void => {
      copy.remove();
    };
    copy
      .animate({ opacity: [1, 0] }, { duration: readMotionDuration("--dur-1"), fill: "forwards" })
      .finished.then(remove, remove);
  };

  /**
   * Flies the lifted copy of `signalId` to `slot`, where the first of the
   * rows `rows` stands, and hides that row until the copy lands. `slot` is
   * read by the caller, so that the reads of one change come before its writes.
   */
  const fly = (signalId: string, rows: HTMLElement, slot: DOMRect): void => {
    const waiting = lifted.get(signalId);
    const firstRow = rows.firstElementChild;
    if (waiting === undefined || !(firstRow instanceof HTMLElement)) return;
    lifted.delete(signalId);
    clearTimeout(waiting.timeout);
    const { copy, place } = waiting;
    const duration = readMotionDuration("--dur-3");
    const remove = (): void => {
      copy.remove();
    };
    copy
      .animate(
        {
          transform: [
            "none",
            `translate(${String(slot.left - place.left)}px, ${String(slot.top - place.top)}px)`,
          ],
        },
        { duration, easing: readMotionEasing(), fill: "forwards" },
      )
      .finished.then(remove, remove);
    // The copy stands in for the row until it lands. This animation comes
    // after the row's own arrival, so its opacity wins.
    firstRow.animate({ opacity: [0, 0] }, { duration });
  };

  const land: HandoffFlights["land"] = (handoffSignalIds, rows) => {
    drawn = rows === null ? null : { signalIds: handoffSignalIds, rows };
    if (rows === null || !handoffSignalIds.some((signalId) => lifted.has(signalId))) return;
    const slot = rows.getBoundingClientRect();
    for (const signalId of handoffSignalIds) fly(signalId, rows, slot);
  };

  return {
    setLayer: (element) => {
      layer = element;
    },
    readLayer: () => layer,
    setFold: (element) => {
      fold = element;
    },
    readFold: () => fold,
    expect: (signalId) => {
      stopExpecting(signalId);
      expected.set(
        signalId,
        setTimeout(() => {
          expected.delete(signalId);
        }, EXPECTATION_TIMEOUT),
      );
    },
    forget: (signalId) => {
      stopExpecting(signalId);
      fadeOut(signalId);
    },
    takeLeavingRow: (key, copy, place) => {
      if (!stopExpecting(key) || layer === null || fold === null) return false;
      // Everything is read before anything is written, so the page lays out once.
      const layerPlace = layer.getBoundingClientRect();
      // The Task's row may have arrived before its signal left the list.
      const arrivedRows =
        drawn?.rows.isConnected === true && drawn.signalIds.includes(key) ? drawn.rows : null;
      const slot = arrivedRows?.getBoundingClientRect() ?? null;
      copy.classList.add("tr-lifted");
      Object.assign(copy.style, {
        position: "absolute",
        top: `${String(place.top - layerPlace.top)}px`,
        left: `${String(place.left - layerPlace.left)}px`,
        width: `${String(place.width)}px`,
        height: `${String(place.height)}px`,
        margin: "0",
      });
      layer.append(copy);
      lifted.set(key, {
        copy,
        place,
        timeout: setTimeout(() => {
          fadeOut(key);
        }, LANDING_TIMEOUT),
      });
      if (arrivedRows !== null && slot !== null) fly(key, arrivedRows, slot);
      return true;
    },
    land,
  };
};
