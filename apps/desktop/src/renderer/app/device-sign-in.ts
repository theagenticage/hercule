/**
 * A sign-in with a device code, as the first run's GitHub step and the setup
 * of a Connection in Settings > Connections run it: ask the controller for a
 * code, show it, and poll for the flow's end while the code is on screen.
 */
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  countMinutesLeft,
  describeCodeExpiry,
  describeDeviceFlowWait,
  describeSignInEnding,
  describeSignInFailure,
  queryKeys,
  readErrorMessage,
  waitForDeviceFlow,
  type HerculeClient,
  type SignInEnding,
} from "@hercule/client-core";
import type { ConnectionDeviceStart } from "@hercule/contract";
import { useMinutesLeft } from "./age-clock";

/**
 * Where a sign-in with a device code stands, as a screen shows it:
 *
 * - `idle`: nothing started, or the last sign-in was cancelled.
 * - `starting`: the controller has not answered with a code yet.
 * - `code`: the user enters `code` at `verificationUri`. `wait` is the line
 *   under it, with how long the code still works.
 * - `ended`: the sign-in ended without a Connection.
 */
export type DeviceSignInProgress =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | {
      readonly kind: "code";
      readonly code: string;
      readonly verificationUri: string;
      readonly wait: string;
    }
  | SignInEnding;

/**
 * Where the sign-in stands inside the hook. `starting` carries the number of
 * the start it waits for, and `code` the controller's answer, how long the
 * code lasted when it was handed out (`codeMinutes`), and the wait line
 * without the code's expiry.
 */
type SignInState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting"; readonly request: number }
  | {
      readonly kind: "code";
      readonly deviceStart: ConnectionDeviceStart;
      readonly codeMinutes: number;
      readonly wait: string;
    }
  | SignInEnding;

/**
 * Runs a sign-in with a device code for a Connection of `type`, or for the
 * Connection `connectionId` when one is given (a reconnect). `providerName`
 * is the type's display name, such as "GitHub", which the wait and ending
 * lines name.
 *
 * Returns where the sign-in stands, `start`, which asks for a code, and
 * `cancel`, which goes back to `idle`. `start` does nothing while a start is
 * already waiting, because a second code would replace the first.
 *
 * While a code is on screen, the hook polls the controller for the flow's
 * end. It stops on `cancel`, on a new start, and when the component
 * unmounts. A code that arrives after `cancel` is dropped. Once the flow is
 * done, the hook reads the Connections again, and then calls `onDone`
 * unless the sign-in was cancelled since.
 */
export function useDeviceSignIn({
  client,
  type,
  connectionId,
  providerName,
  onDone,
}: {
  readonly client: HerculeClient;
  readonly type: string;
  readonly connectionId?: string;
  readonly providerName: string;
  readonly onDone?: () => void;
}): {
  readonly progress: DeviceSignInProgress;
  readonly start: () => void;
  readonly cancel: () => void;
} {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SignInState>({ kind: "idle" });
  // Numbers each start, so an answer that arrives after the user cancelled
  // or started again is dropped rather than shown.
  const lastRequest = useRef(0);
  const startDeviceFlow = useMutation({
    mutationFn: () =>
      client.connection.startDeviceFlow({
        payload: connectionId === undefined ? { type } : { type, connectionId },
      }),
  });

  /** Applies `next` only while the sign-in still waits for the answer to start `request`. */
  const settleStart = (request: number, next: SignInState): void => {
    setState((current) =>
      current.kind === "starting" && current.request === request ? next : current,
    );
  };
  const start = (): void => {
    if (state.kind === "starting") return;
    lastRequest.current += 1;
    const request = lastRequest.current;
    setState({ kind: "starting", request });
    startDeviceFlow.mutate(undefined, {
      onSuccess: (deviceStart) => {
        settleStart(request, {
          kind: "code",
          deviceStart,
          codeMinutes: countMinutesLeft(deviceStart.expiresAt, Date.now()),
          wait: describeDeviceFlowWait("pending", providerName),
        });
      },
      onError: (error) => {
        settleStart(request, describeSignInFailure(readErrorMessage(error)));
      },
    });
  };

  // The callback may change on every render, and the polling must not
  // restart when it does.
  const finish = useEffectEvent(() => onDone?.());
  const deviceStart = state.kind === "code" ? state.deviceStart : null;
  useEffect(() => {
    if (deviceStart === null) return;
    const stop = new AbortController();
    const showWait = (wait: string): void => {
      setState((current) => (current.kind === "code" ? { ...current, wait } : current));
    };
    void waitForDeviceFlow(client, deviceStart, {
      signal: stop.signal,
      onStep: (step) => {
        if (step.kind === "waiting") showWait(describeDeviceFlowWait(step.status, providerName));
        if (step.kind === "ended") {
          setState((current) =>
            current.kind === "code"
              ? describeSignInEnding(step, current.codeMinutes, providerName)
              : current,
          );
        }
      },
      onRequestFailure: () => {
        showWait(describeDeviceFlowWait("request-failed", providerName));
      },
    }).then(async (last) => {
      // The Connection exists from a `done` answer on, even when the user
      // cancelled since, so the list is read again either way.
      if (last.kind !== "done") return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.connections() });
      if (!stop.signal.aborted) finish();
    });
    return () => {
      stop.abort();
    };
  }, [client, deviceStart, queryClient, providerName]);

  // The age clock draws the screen again each time the code loses a minute.
  const minutesLeft = useMinutesLeft(deviceStart?.expiresAt);

  return {
    progress: decideProgress(state, minutesLeft),
    start,
    cancel: () => setState({ kind: "idle" }),
  };
}

/**
 * Returns what a screen shows for `state`. `minutesLeft` is how long the
 * code on screen still works, or null when no code is on screen.
 */
const decideProgress = (state: SignInState, minutesLeft: number | null): DeviceSignInProgress => {
  switch (state.kind) {
    case "idle":
    case "ended":
      return state;
    case "starting":
      return { kind: "starting" };
    case "code":
      return {
        kind: "code",
        code: state.deviceStart.userCode,
        verificationUri: state.deviceStart.verificationUri,
        wait:
          minutesLeft === null ? state.wait : `${state.wait} ${describeCodeExpiry(minutesLeft)}`,
      };
  }
};
