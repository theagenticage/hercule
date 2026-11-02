import { useCallback, useSyncExternalStore } from "react";
import type { FleetMachine } from "@hercule/client-core/fleet";
import { findNextListTimeChange } from "@hercule/client-core/list-time";
import { ageClock } from "../../app/age-clock";

/**
 * Returns the time the Fleet page draws its times at, such as "Offline since
 * 09:12". It comes from the age clock, so the page runs no timer of its own.
 *
 * A machine that is not online shows when it was last heard from, as "09:12"
 * today and with its weekday after midnight. While such a machine is shown,
 * the hook watches the clock for the next local midnight in `timezone`, so the
 * text changes then. With every machine online no time is shown, and the
 * hook watches nothing.
 */
export const useFleetNow = (machines: readonly FleetMachine[], timezone: string): Date => {
  const showsTime = machines.some(
    ({ runner }) => runner.connectivity !== "online" && runner.lastSeenAt !== null,
  );
  const subscribe = useCallback(
    (onChange: () => void) =>
      showsTime
        ? ageClock.watch((now) => findNextListTimeChange(now, timezone, now, "past"), onChange)
        : () => {},
    [showsTime, timezone],
  );
  return useSyncExternalStore(subscribe, ageClock.readNow);
};
