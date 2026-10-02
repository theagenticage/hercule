/**
 * Starts a provider's login, and decides how far a device login has come.
 * In a device login the user types a one-time code in the browser, and
 * nothing is sent back through Hercule. When the vendor's login ends, the
 * controller probes the instance again and announces the new snapshot, so the
 * login is finished once a fresh snapshot for the login's runner says the
 * harness is logged in. That holds only for a harness that was logged out as
 * the login started: see `DeviceLogin.loggedInAtStart`.
 */
import type { CapabilitySnapshot, ProviderInstance } from "@hercule/contract";
import type { HerculeClient } from "./client";
import { describeCodeExpiry } from "./minutes-left";

/** Where a device login stands. */
export type DeviceLoginStep =
  /**
   * The code is shown and still valid; the user has not finished yet.
   * `minutesLeft` is how long the code still works, rounded up, or null when
   * the runner's build did not say. `endsByItself` is false when the step can
   * never turn `done`, because the harness was logged in already when the
   * login started.
   */
  | {
      readonly kind: "waiting";
      readonly minutesLeft: number | null;
      readonly endsByItself: boolean;
    }
  /** A snapshot taken after the login started says the harness is logged in. */
  | { readonly kind: "done" }
  /** The code expired before the login finished. */
  | { readonly kind: "expired" };

/** A device login on one runner, as the screen that started it knows it. */
export interface DeviceLogin {
  readonly instanceId: string;
  readonly runnerId: string;
  /** The code the user enters in the browser. */
  readonly userCode: string;
  /**
   * When the instance was last probed on the runner as the login started, or
   * null when it never was. A snapshot is fresh when it was probed after this.
   * Both instants come from the controller's clock, so the browser's clock
   * plays no part.
   */
  readonly probedAtStart: string | null;
  /**
   * Whether the harness was logged in on the runner as the login started, as
   * when the user logs in again. The old credential still checks as logged
   * in, and the controller probes for other reasons too, such as a runner
   * connecting, so a fresh logged-in snapshot does not prove that this login
   * ended. Such a login never counts as done.
   */
  readonly loggedInAtStart: boolean;
  /** When the code expires, or undefined when the runner's build did not say. */
  readonly expiresAt: string | undefined;
}

/** A provider's login, as it started on the runner. */
export interface StartedProviderLogin {
  /** The vendor's sign-in page. */
  readonly url: string;
  /** The device login, or null for a paste-back login, where the user pastes a code here. */
  readonly deviceLogin: DeviceLogin | null;
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
 * Starts the login of the provider instance `instanceId` on `runnerId`, and
 * returns its sign-in page and, for a device login, what the screen needs to
 * tell when it ends. Fails with the controller's error when the login does
 * not start or the instances cannot be read.
 *
 * For a device login, the instance's snapshot is read from the controller
 * once the code is out, never from a cache: a cached snapshot may be older
 * than the newest one, which would then look like the login's result.
 * Reading it after the start is early enough, because the vendor completes
 * the login only after the user has typed the code.
 */
export const startProviderLogin = async (
  client: HerculeClient,
  instanceId: string,
  runnerId: string,
): Promise<StartedProviderLogin> => {
  const started = await client.provider.login({
    params: { id: instanceId },
    payload: { runnerId },
  });
  if (started.userCode === undefined) return { url: started.url, deviceLogin: null };
  const snapshot = findSnapshot(await client.provider.query(), instanceId, runnerId);
  return {
    url: started.url,
    deviceLogin: {
      instanceId,
      runnerId,
      userCode: started.userCode,
      probedAtStart: snapshot?.probedAt ?? null,
      loggedInAtStart: snapshot?.auth.status === "ok",
      expiresAt: started.expiresAt,
    },
  };
};

/**
 * Returns where `login` stands, given the instances as last read and the
 * minutes its code has left (`countMinutesLeft`), or null when the runner's
 * build did not say when the code expires. A login that finished counts as
 * done even when its code has expired since, because the snapshot may arrive
 * after the code's lifetime ran out.
 */
export const decideDeviceLoginStep = (
  login: DeviceLogin,
  instances: ReadonlyArray<ProviderInstance>,
  minutesLeft: number | null,
): DeviceLoginStep => {
  const snapshot = findSnapshot(instances, login.instanceId, login.runnerId);
  const fresh =
    snapshot !== undefined &&
    (login.probedAtStart === null ||
      Date.parse(snapshot.probedAt) > Date.parse(login.probedAtStart));
  if (!login.loggedInAtStart && fresh && snapshot.auth.status === "ok") return { kind: "done" };
  if (minutesLeft === 0) return { kind: "expired" };
  return { kind: "waiting", minutesLeft, endsByItself: !login.loggedInAtStart };
};

/**
 * Returns the line shown while a device login waits, such as "Waiting for
 * you to finish signing in. The code expires in 12 minutes."
 *
 * - With `minutesLeft` null, the line does not say when the code expires:
 *   only the runner knows, and an older runner build does not say.
 * - When the login cannot end by itself, the line says why, so the user
 *   knows to close it once they are done.
 */
export const describeDeviceLoginWait = (
  step: Extract<DeviceLoginStep, { kind: "waiting" }>,
): string => {
  const sentences = ["Waiting for you to finish signing in."];
  if (step.minutesLeft !== null) sentences.push(describeCodeExpiry(step.minutesLeft));
  if (!step.endsByItself) {
    sentences.push("You were logged in already, so Hercule cannot tell when you finish.");
  }
  return sentences.join(" ");
};
