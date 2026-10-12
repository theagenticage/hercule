/**
 * A Connection's device flow, the setup in which the user enters a code at
 * the provider: when to poll the controller, when the flow ends, and the
 * wording a screen shows while it waits and after it ends.
 *
 * This is the device flow of a Connection's setup, run through
 * `connection.startDeviceFlow` and `connection.pollDeviceFlow`. A provider's
 * device login, which logs a harness in on a runner, is `device-login.ts`.
 */
import type { Connection, ConnectionDevicePoll, ConnectionDeviceStart } from "@hercule/contract";
import type { HerculeClient } from "./client";
import { describeMinutes } from "./minutes-left";

/**
 * Where a device flow stands after its last poll, as a screen acts on it:
 *
 * - `waiting`: the flow is still open. Poll again after `delay` milliseconds.
 *   `status` is the reason the flow is still open.
 * - `ended`: the flow ended without a connection. `message` is the
 *   controller's reason, or `DEVICE_CODE_EXPIRED` when the code's expiry
 *   ended the flow, and polling again would only answer `expired`.
 * - `done`: the connection is written.
 */
export type DeviceFlowStep =
  | {
      readonly kind: "waiting";
      readonly status: Extract<ConnectionDevicePoll, { interval: number }>["status"];
      readonly delay: number;
    }
  | {
      readonly kind: "ended";
      readonly status: Extract<ConnectionDevicePoll, { message: string }>["status"];
      readonly message: string;
    }
  | { readonly kind: "done"; readonly connection: Connection };

/**
 * The reason given when a device flow ends `expired` because its code's
 * expiry passed on this machine's clock while the flow was still open. A
 * flow the controller ended carries the controller's own reason instead,
 * which reads the same.
 */
export const DEVICE_CODE_EXPIRED = "the code expired before it was approved";

/**
 * Decides what a screen does next in a device flow, from the flow's start,
 * the last poll reply (`undefined` before the first poll), and `now`, in
 * milliseconds since the epoch. Before the first poll the flow is `pending`,
 * and the wait is the one the start returned. A `slow-down` reply carries the
 * new, longer wait, so every reply that keeps the flow open is read the same
 * way.
 *
 * An open flow ends `expired` once `now` reaches the code's `expiresAt`,
 * because no poll can succeed after that. Until then, a wait never runs past
 * the expiry, so the screen learns that the code expired the moment it does.
 */
export const decideDeviceFlowStep = (
  deviceStart: ConnectionDeviceStart,
  reply: ConnectionDevicePoll | undefined,
  now: number,
): DeviceFlowStep => {
  const last = reply ?? { status: "pending", interval: deviceStart.interval };
  switch (last.status) {
    case "pending":
    case "slow-down":
    case "unreachable": {
      const timeLeft = Date.parse(deviceStart.expiresAt) - now;
      if (timeLeft <= 0) return { kind: "ended", status: "expired", message: DEVICE_CODE_EXPIRED };
      return {
        kind: "waiting",
        status: last.status,
        delay: Math.min(last.interval * 1000, timeLeft),
      };
    }
    case "done":
      return { kind: "done", connection: last.connection };
    default:
      return { kind: "ended", status: last.status, message: last.message };
  }
};

/** The line a screen shows for each way a device flow can end without a connection. */
export const DEVICE_FLOW_ENDINGS: Readonly<
  Record<Extract<DeviceFlowStep, { kind: "ended" }>["status"], string>
> = {
  expired: "The sign-in expired before it was approved.",
  denied: "The sign-in was declined, so nothing changed.",
  failed: "The sign-in did not finish, so nothing changed.",
};

/** How a sign-in with a code ended without a Connection, as a screen shows it. */
export interface SignInEnding {
  readonly kind: "ended";
  readonly status: Extract<DeviceFlowStep, { kind: "ended" }>["status"];
  /** What happened. */
  readonly line: string;
  /** What the user can do next. */
  readonly next: string;
}

/**
 * Returns the ending of a sign-in that failed with `message`, the
 * controller's own reason, which differs from case to case. A sign-in fails
 * when its code cannot be started, or when the flow ends `failed`.
 */
export const describeSignInFailure = (message: string): SignInEnding => ({
  kind: "ended",
  status: "failed",
  line: DEVICE_FLOW_ENDINGS.failed,
  next: message,
});

/**
 * Returns how a sign-in with a code ended, from the flow's `ending`.
 * `codeMinutes` is how long the code lasted when it was handed out, which an
 * expired sign-in names. `providerName` is the connection type's display
 * name, such as "GitHub", which a declined sign-in names.
 */
export const describeSignInEnding = (
  ending: Extract<DeviceFlowStep, { kind: "ended" }>,
  codeMinutes: number,
  providerName: string,
): SignInEnding => {
  switch (ending.status) {
    case "expired":
      return {
        kind: "ended",
        status: "expired",
        line: DEVICE_FLOW_ENDINGS.expired,
        next: `A code lasts ${describeMinutes(codeMinutes)}. Start again for a new one.`,
      };
    case "denied":
      return {
        kind: "ended",
        status: "denied",
        line: DEVICE_FLOW_ENDINGS.denied,
        next: `Hercule was declined on ${providerName}’s approval page. Start again if that was a mistake.`,
      };
    case "failed":
      return describeSignInFailure(ending.message);
  }
};

/**
 * Returns the status line a screen shows while a device flow waits for the
 * user. `providerName` is the connection type's display name, such as
 * "GitHub". A `request-failed` wait is a poll request that did not reach the
 * controller or failed there: the flow is still open, so polling goes on.
 */
export const describeDeviceFlowWait = (
  status: Extract<DeviceFlowStep, { kind: "waiting" }>["status"] | "request-failed",
  providerName: string,
): string => {
  switch (status) {
    case "pending":
      return `Waiting for you to approve Hercule on ${providerName}.`;
    case "slow-down":
      return `${providerName} asked for slower checks. Still waiting for you to approve the code.`;
    case "unreachable":
      return `Cannot reach ${providerName} right now. Still trying.`;
    case "request-failed":
      return "The last check did not go through. Still trying.";
  }
};

/** What `waitForDeviceFlow` reports to the screen that shows the flow. */
export interface DeviceFlowWatcher {
  /** Stops the polling. No callback runs after the signal aborts. */
  readonly signal: AbortSignal;
  /**
   * Receives each step the flow reaches: the one a poll reply leads to, or the
   * `expired` ending when the code's expiry passes. A failed poll request does
   * not call it.
   */
  readonly onStep: (step: DeviceFlowStep) => void;
  /** Receives the error of a poll request that failed. The flow is still open, so polling goes on. */
  readonly onRequestFailure: (error: unknown) => void;
}

/**
 * Returns a promise that resolves after `delay` milliseconds, or as soon as
 * `signal` aborts, whichever comes first. The timer is cleared on abort, so
 * an aborted wait leaves nothing scheduled.
 */
const waitUnlessAborted = (delay: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const stop = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, delay);
    signal.addEventListener("abort", stop, { once: true });
  });

/**
 * Polls `connection.pollDeviceFlow` until the device flow ends, and returns
 * the last step: `done` or `ended` when the flow ended, or the open `waiting`
 * step when `watcher.signal` aborted first. It never throws.
 *
 * - The first poll waits the interval `deviceStart` returned, and each later
 *   poll waits the interval of the last reply, so a `slow-down` reply slows
 *   every poll after it.
 * - A poll request that fails does not end the flow. The next poll follows at
 *   the last interval the controller returned.
 * - One poll runs at a time, and the next one is scheduled only after it
 *   answers.
 * - When the code's `expiresAt` passes, the flow ends `expired` at that
 *   moment, with no further poll, and `watcher.onStep` receives the ending.
 *   A code that has expired already ends the flow before any poll.
 *
 * A reply that arrives after the signal aborted calls no callback, so a
 * screen the user already left cannot act on it. The reply still decides the
 * step this function returns: a `done` reply means the controller wrote the
 * Connection, and the caller may want to read its connections again.
 *
 * The waits use `setTimeout` alone, so a test can drive them with fake timers.
 */
export const waitForDeviceFlow = async (
  client: HerculeClient,
  deviceStart: ConnectionDeviceStart,
  watcher: DeviceFlowWatcher,
): Promise<DeviceFlowStep> => {
  const { signal } = watcher;
  let reply: ConnectionDevicePoll | undefined;
  let step = decideDeviceFlowStep(deviceStart, undefined, Date.now());
  // A screen may show the code as waiting before this runs, so a code that
  // had expired before it arrived is reported too.
  if (step.kind === "ended" && !signal.aborted) watcher.onStep(step);
  while (step.kind === "waiting" && !signal.aborted) {
    await waitUnlessAborted(step.delay, signal);
    if (signal.aborted) break;
    // The wait ends no later than the code's expiry. A code that expired
    // during the wait ends the flow here, before another poll goes out.
    step = decideDeviceFlowStep(deviceStart, reply, Date.now());
    if (step.kind === "waiting") {
      try {
        reply = await client.connection.pollDeviceFlow({
          payload: { setupId: deviceStart.setupId },
        });
      } catch (error) {
        if (!signal.aborted) watcher.onRequestFailure(error);
        continue;
      }
      step = decideDeviceFlowStep(deviceStart, reply, Date.now());
    }
    if (!signal.aborted) watcher.onStep(step);
  }
  return step;
};
