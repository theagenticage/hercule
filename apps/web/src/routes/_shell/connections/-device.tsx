import { useEffect, useEffectEvent, useState, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, buildButtonClassName } from "@hercule/ui";
import {
  decideDeviceFlowStep,
  describeDeviceFlowWait,
  DEVICE_FLOW_ENDINGS,
  isWebLink,
  queryKeys,
  readErrorMessage,
  waitForDeviceFlow,
  type DeviceFlowStep,
  type HerculeClient,
} from "@hercule/client-core";
import type { ConnectionDeviceStart } from "@hercule/contract";
import { DeviceCode } from "../../../screens/device-code";

/**
 * The second half of a device flow: the code the user enters at the provider,
 * and the wait until they approve it there. The component polls the
 * controller, through `waitForDeviceFlow`, for as long as it is on screen and
 * the flow is open, and stops polling when it is removed. A poll request that
 * fails does not end the flow: the next poll follows at the last interval the
 * controller returned.
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

  const [step, setStep] = useState<DeviceFlowStep>(() =>
    decideDeviceFlowStep(deviceStart, undefined, Date.now()),
  );
  // A failed poll request leaves the flow open, so its status line stays up
  // until the next reply.
  const [lastFailure, setLastFailure] = useState<unknown>(null);

  const finish = useEffectEvent(onDone);

  useEffect(() => {
    const stop = new AbortController();
    void waitForDeviceFlow(client, deviceStart, {
      signal: stop.signal,
      onStep: (next) => {
        setStep(next);
        setLastFailure(null);
        if (next.kind === "done") finish();
      },
      onRequestFailure: setLastFailure,
    }).then(async (last) => {
      // The connection exists from a `done` reply on, even when the panel is
      // gone, so the list is fetched again either way.
      if (last.kind === "done") {
        await queryClient.invalidateQueries({ queryKey: queryKeys.connections() });
      }
    });
    return () => {
      stop.abort();
    };
  }, [client, deviceStart, queryClient]);

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
