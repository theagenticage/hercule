import { useEffect, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, buildButtonClassName } from "@hercule/ui";
import {
  computeNextPollDelay,
  isWebLink,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import type { ConnectionDeviceStart } from "@hercule/contract";
import { DeviceCode } from "../../../screens/device-code";

/**
 * The second half of a device flow: the code the user enters at the provider,
 * and the wait until they approve it there. The component polls the
 * controller for as long as it is on screen and the flow is open, and stops
 * polling when it is removed.
 *
 * When the flow ends without a connection (the code expired, or the user or
 * the provider refused), the component shows why and offers to start again,
 * which asks the provider for a new code.
 */
export function DeviceSignIn({
  client,
  providerName,
  start,
  restarting,
  onRestart,
  onCancel,
  onDone,
}: {
  readonly client: HerculeClient;
  /** The connection type's display name, such as "GitHub". */
  readonly providerName: string;
  readonly start: ConnectionDeviceStart;
  /** True while a new code is being requested after this flow ended. */
  readonly restarting: boolean;
  readonly onRestart: () => void;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();

  const poll = useMutation({
    mutationFn: () => client.connection.pollDevice({ payload: { setupId: start.setupId } }),
    onSuccess: async (outcome) => {
      if (outcome.status !== "done") return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.connections() });
      onDone();
    },
  });

  const outcome = poll.data;

  // No poll is scheduled while one is in flight, after a poll that failed, or
  // once the flow has ended. The effect also depends on `outcome`, because a
  // fast answer can arrive in the same render as the request, and the next
  // poll must still be scheduled when its delay equals the last one.
  const delay = poll.isPending || poll.isError ? null : computeNextPollDelay(start, outcome);
  const pollAgain = poll.mutate;
  useEffect(() => {
    if (delay === null) return;
    const timer = setTimeout(() => {
      pollAgain();
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [delay, outcome, pollAgain]);

  const failure =
    poll.error !== null
      ? readErrorMessage(poll.error)
      : outcome !== undefined && "message" in outcome
        ? outcome.message
        : null;

  if (failure !== null) {
    return (
      <>
        <p className="max-w-[52ch] text-row text-fail" role="alert">
          {failure}
        </p>
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="form" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="form" disabled={restarting} onClick={onRestart}>
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
      <DeviceCode code={start.userCode} />
      <div className="flex items-center gap-1.5">
        <Button type="button" variant="form" onClick={onCancel}>
          Cancel
        </Button>
        {/* The address comes from the provider, so it is a link only when it
            is a web address. Any other text is shown for the user to copy. */}
        {isWebLink(start.verificationUri) ? (
          <a
            href={start.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className={buildButtonClassName("form", undefined)}
          >
            Open {providerName}
          </a>
        ) : (
          <p className="font-mono text-fine break-all text-ink">{start.verificationUri}</p>
        )}
      </div>
      <p className="text-fine text-muted" role="status">
        {outcome?.status === "unreachable"
          ? `Cannot reach ${providerName} right now. Still trying.`
          : `Waiting for you to approve the code at ${providerName}.`}
      </p>
    </>
  );
}
