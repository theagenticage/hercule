/**
 * When the office stands still: while the Mac runs on its battery, so the
 * office costs no power while nothing happens, and while the user asks the
 * system to reduce motion (spec 17's rule that Reduce motion turns every
 * animation off).
 *
 * Standing still is the simulation's liveliness 0: nobody wanders off and
 * nobody breathes or types, so no frames are drawn. A colleague still walks
 * when its state changes, to the queue or back to its desk, and then the
 * frames stop again.
 */

/** The part of the Battery Status API the office reads. TypeScript's DOM types leave it out. */
interface BatteryManager extends EventTarget {
  /** False while the computer runs on its battery; true on mains power, even while the charge is held. */
  readonly charging: boolean;
}

/** The query that matches while the user asks the system to reduce motion. */
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

let reducedMotion: MediaQueryList | null = null;

/** Returns true while the user asks the system to reduce motion. Cheap enough to ask every frame. */
export function prefersReducedMotion(): boolean {
  reducedMotion ??= matchMedia(REDUCED_MOTION);
  return reducedMotion.matches;
}

/**
 * Calls `onChange` with whether the office should stand still now, and again
 * whenever that changes: the Mac goes on or off its battery, or Reduce motion
 * is turned on or off. Returns the function that stops watching.
 *
 * Where the browser has no Battery Status API, only Reduce motion counts.
 * Electron's renderer has it on a secure page, which the app's is.
 */
export function watchStillness(onChange: (still: boolean) => void): () => void {
  const motion = matchMedia(REDUCED_MOTION);
  let battery: BatteryManager | null = null;
  let stopped = false;
  const report = (): void => {
    if (!stopped) onChange(motion.matches || battery?.charging === false);
  };
  motion.addEventListener("change", report);
  report();
  const getBattery = (navigator as { getBattery?: () => Promise<BatteryManager> }).getBattery;
  void getBattery?.call(navigator).then((manager) => {
    if (stopped) return;
    battery = manager;
    manager.addEventListener("chargingchange", report);
    report();
  });
  return () => {
    stopped = true;
    motion.removeEventListener("change", report);
    battery?.removeEventListener("chargingchange", report);
  };
}
