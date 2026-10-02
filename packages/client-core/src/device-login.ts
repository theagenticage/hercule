/**
 * Decides how far a provider's device login has come. In a device login the
 * user types a one-time code in the browser, and nothing is sent back through
 * Hercule. When the vendor's login ends, the controller probes the instance
 * again and announces the new snapshot, so the login is finished once a fresh
 * snapshot for the login's runner says the harness is logged in.
 */
import type { CapabilitySnapshot, ProviderInstance } from "@hercule/contract";

/** Where a device login stands. */
export type DeviceLoginStep =
  /**
   * The code is shown and still valid; the user has not finished yet.
   * `minutesLeft` is how long the code still works, rounded up, or null when
   * the runner's build did not say.
   */
  | { readonly kind: "waiting"; readonly minutesLeft: number | null }
  /** A snapshot taken after the login started says the harness is logged in. */
  | { readonly kind: "done" }
  /** The code expired before the login finished. */
  | { readonly kind: "expired" };

/** A device login on one runner, as the screen that started it knows it. */
export interface DeviceLogin {
  readonly instanceId: string;
  readonly runnerId: string;
  /**
   * When the instance was last probed on the runner as the login started, or
   * null when it never was. A snapshot is fresh when it was probed after this.
   * Both instants come from the controller's clock, so the browser's clock
   * plays no part.
   */
  readonly probedAtStart: string | null;
  /** When the code expires, or undefined when the runner's build did not say. */
  readonly expiresAt: string | undefined;
}

/** Returns the snapshot of `instanceId` on `runnerId`, or undefined when there is none. */
const findSnapshot = (
  instances: ReadonlyArray<ProviderInstance>,
  instanceId: string,
  runnerId: string,
): CapabilitySnapshot | undefined =>
  instances
    .find((instance) => instance.id === instanceId)
    ?.snapshots.find((snapshot) => snapshot.runnerId === runnerId);

/**
 * Returns when `instanceId` was last probed on `runnerId`, or null when it
 * has no snapshot there. A screen reads this as it starts a device login, to
 * fill `DeviceLogin.probedAtStart`.
 */
export const readProbedAt = (
  instances: ReadonlyArray<ProviderInstance>,
  instanceId: string,
  runnerId: string,
): string | null => findSnapshot(instances, instanceId, runnerId)?.probedAt ?? null;

/**
 * Returns where `login` stands, given the instances as last read and the
 * current time in milliseconds. A login that finished counts as done even when
 * its code has expired since, because the snapshot may arrive after the code's
 * lifetime ran out.
 */
export const decideDeviceLoginStep = (
  login: DeviceLogin,
  instances: ReadonlyArray<ProviderInstance>,
  now: number,
): DeviceLoginStep => {
  const snapshot = findSnapshot(instances, login.instanceId, login.runnerId);
  const fresh =
    snapshot !== undefined &&
    (login.probedAtStart === null ||
      Date.parse(snapshot.probedAt) > Date.parse(login.probedAtStart));
  if (fresh && snapshot.auth.status === "ok") return { kind: "done" };
  if (login.expiresAt === undefined) return { kind: "waiting", minutesLeft: null };
  const left = Date.parse(login.expiresAt) - now;
  return left <= 0
    ? { kind: "expired" }
    : { kind: "waiting", minutesLeft: Math.ceil(left / 60_000) };
};
