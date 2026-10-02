import { useEffect, useEffectEvent, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, buildButtonClassName } from "@hercule/ui";
import {
  decideDeviceFlowStep,
  isWebLink,
  queryKeys,
  readErrorMessage,
  type DeviceFlowStep,
  type HerculeClient,
} from "@hercule/client-core";
import type { ConnectionDevicePoll, ConnectionDeviceStart } from "@hercule/contract";
import { DeviceCode } from "../../../screens/device-code";

/** The message shown for each way a device flow can end without a connection. */
const DEVICE_FLOW_ENDINGS: Readonly<
  Record<Extract<DeviceFlowStep, { kind: "ended" }>["status"], string>
> = {
  expired: "The sign-in expired before it was approved.",
  denied: "The sign-in was declined, so nothing was connected.",
  failed: "The sign-in failed, so nothing was connected.",
};

/**
 * Returns the status line shown while the flow waits for the user. A
 * `request-failed` wait is a poll request that did not reach the controller or
 * failed there; the flow is still open, so the panel keeps polling.
 */
const describeDeviceFlowWait = (
  status: Extract<DeviceFlowStep, { kind: "waiting" }>["status"] | "request-failed",
  providerName: string,
): string => {
  switch (status) {
    case "pending":
      return `Waiting for you to approve the code at ${providerName}.`;
    case "slow-down":
      return `${providerName} asked for slower checks. Still waiting for you to approve the code.`;
    case "unreachable":
      return `Cannot reach ${providerName} right now. Still trying.`;
    case "request-failed":
      return "The last check did not go through. Still trying.";
  }
};

/**
 * The second half of a device flow: the code the user enters at the provider,
 * and the wait until they approve it there. The component polls the
 * controller for as long as it is on screen and the flow is open, and stops
 * polling when it is removed. A poll request that fails does not end the flow:
 * the next poll follows at the last interval the controller returned.
 *
 * When the flow ends without a connection (the code expired, or the user or
 * the provider refused), the component shows why and offers to start again,
 * which asks the provider for a new code.
 */
export function DeviceSignIn({
  client,
  providerName,
  deviceStart,
  onRestart,
  onCancel,
  onDone,
}: {
  readonly client: HerculeClient;
  /** The connection type's display name, such as "GitHub". */
  readonly providerName: string;
  readonly deviceStart: ConnectionDeviceStart;
  readonly onRestart: () => void;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();

  const poll = useMutation({
    mutationFn: () =>
      client.connection.pollDeviceFlow({ payload: { setupId: deviceStart.setupId } }),
    // The connection exists from this reply on, even when the panel is gone,
    // so the list is fetched again either way.
    onSuccess: async (reply) => {
      if (reply.status === "done") {
        await queryClient.invalidateQueries({ queryKey: queryKeys.connections() });
      }
    },
  });

  // The last reply and the last failed request are kept here rather than read
  // from `poll.data` and `poll.error`, because React Query clears those when
  // the next poll starts. A failed poll must keep the last interval, and its
  // status line stays up until the next reply.
  const [lastReply, setLastReply] = useState<ConnectionDevicePoll | undefined>(undefined);
  const [lastFailure, setLastFailure] = useState<unknown>(null);
  const [settledPolls, setSettledPolls] = useState(0);
  const step = decideDeviceFlowStep(deviceStart, lastReply);

  // The callbacks are passed to `mutate`, not to `useMutation`, because React
  // Query calls them only while this panel is on screen. A reply that arrives
  // after the user pressed Cancel therefore cannot close another panel.
  const pollOnce = useEffectEvent(() => {
    poll.mutate(undefined, {
      onSuccess: (reply) => {
        setLastReply(reply);
        setLastFailure(null);
        if (reply.status === "done") onDone();
      },
      onError: setLastFailure,
      onSettled: () => {
        setSettledPolls((count) => count + 1);
      },
    });
  });

  // No poll is scheduled while one is in flight, or once the flow has ended.
  // `settledPolls` changes once per finished poll, so the next poll is
  // scheduled even when its delay equals the last one. Neither `isPending` nor
  // the mutation's `submittedAt` can be relied on for that: React Query may
  // report the start and the end of a fast poll in one update, so `isPending`
  // never shows as true, and `submittedAt` is the wall-clock time in
  // milliseconds, which two polls share when the timers are faked and the
  // wall clock does not move between them.
  const delay = step.kind === "waiting" && !poll.isPending ? step.delay : null;
  useEffect(() => {
    if (delay === null) return;
    const timer = setTimeout(pollOnce, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [delay, settledPolls]);

  if (step.kind === "ended") {
    return (
      <>
        <div className="flex max-w-[52ch] flex-col gap-0.5" role="alert">
          <p className="text-row text-fail">{DEVICE_FLOW_ENDINGS[step.status]}</p>
          <p className="text-fine text-muted">{step.message}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" className="-ml-2" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="form" onClick={onRestart}>
            Start again
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="max-w-[52ch] text-row text-muted">
        Open {providerName} and enter this code there.
      </p>
      <DeviceCode code={deviceStart.userCode} />
      <div className="flex items-center gap-2">
        <Button type="button" className="-ml-2" onClick={onCancel}>
          Cancel
        </Button>
        {/* The address comes from the provider, so it is a link only when it
            is a web address. Any other text is shown for the user to copy. */}
        {isWebLink(deviceStart.verificationUri) ? (
          <a
            href={deviceStart.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className={buildButtonClassName("form", undefined)}
          >
            Open {providerName}
          </a>
        ) : (
          <p className="font-mono text-fine break-all text-ink">{deviceStart.verificationUri}</p>
        )}
      </div>
      <div className="flex max-w-[52ch] flex-col gap-0.5" role="status">
        {lastFailure === null ? (
          <p className="text-fine text-muted">
            {/* A done flow closes the panel at once, so it shows the plain wait until then. */}
            {describeDeviceFlowWait(
              step.kind === "waiting" ? step.status : "pending",
              providerName,
            )}
          </p>
        ) : (
          <>
            <p className="text-fine text-muted">
              {describeDeviceFlowWait("request-failed", providerName)}
            </p>
            <p className="text-fine text-faint">{readErrorMessage(lastFailure)}</p>
          </>
        )}
      </div>
    </>
  );
}
