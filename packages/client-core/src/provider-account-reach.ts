/**
 * The words and the form of "where it works" on a Provider Account's card,
 * worked out from `ProviderAccountReach` so that the card only draws.
 */
import type { ProviderAccountReach } from "./provider-account-machines";

/** The most machines a card draws as one pip each. An account on more machines shows a count. */
export const MAX_REACH_PIPS = 3;

/** One machine of a per-machine account, as a pip draws it. */
export interface ReachPip {
  readonly runnerId: string;
  /**
   * Whether the controller's readiness for the account's default harness on the machine
   * is `ready`: a filled pip when `true`, a ring when `false`. The readiness does not
   * say whether the machine is connected.
   */
  readonly ready: boolean;
}

/**
 * How a card shows where its account works. Every form has `description`, the
 * text for the card's tooltip and its accessible name.
 *
 * - `shared`: "All", for a key or token every machine uses;
 * - `none`: "No machines", for a per-machine account with no machine to sign in on;
 * - `pips`: one pip per machine, for up to `MAX_REACH_PIPS` machines;
 * - `count`: "2/5", the machines that are ready out of all of them, for more
 *   machines than that. `needsAttention` is `true` when one is not ready.
 */
export type ProviderAccountReachView =
  | { readonly form: "shared"; readonly description: string }
  | { readonly form: "none"; readonly description: string }
  | {
      readonly form: "pips";
      readonly pips: ReadonlyArray<ReachPip>;
      readonly description: string;
    }
  | {
      readonly form: "count";
      readonly count: string;
      readonly needsAttention: boolean;
      readonly description: string;
    };

/**
 * Returns how the card shows `reach`, or `null` when it shows nothing: it
 * does not know where the account works, and a card that guessed would be
 * wrong. A machine is ready when the controller's readiness row for the
 * account's default harness there says `ready` (`signedIn`). Connectivity is
 * not part of that row, so an offline machine is as ready as the row says.
 */
export const describeProviderAccountReach = (
  reach: ProviderAccountReach,
): ProviderAccountReachView | null => {
  switch (reach.kind) {
    case "unknown":
      return null;
    case "shared":
      return { form: "shared", description: "Shared credential: works on every machine" };
    case "per-machine": {
      const { machines } = reach;
      if (machines.length === 0) return { form: "none", description: "No machines" };
      const ready = machines.filter((machine) => machine.signedIn).length;
      const summary = `Ready on ${ready} of ${machines.length} ${machines.length === 1 ? "machine" : "machines"}`;
      const description = `${summary}. ${machines
        .map((machine) => `${machine.runnerName}: ${machine.signedIn ? "ready" : "not ready"}`)
        .join(" · ")}`;
      if (machines.length <= MAX_REACH_PIPS) {
        return {
          form: "pips",
          pips: machines.map((machine) => ({
            runnerId: machine.runnerId,
            ready: machine.signedIn,
          })),
          description,
        };
      }
      return {
        form: "count",
        count: `${ready}/${machines.length}`,
        needsAttention: ready < machines.length,
        description,
      };
    }
  }
};
