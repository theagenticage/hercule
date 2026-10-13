import type { JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  describeTrigger,
  isPausedWithHeldEvents,
  queryKeys,
  readErrorMessage,
  resolveDisplayTimezone,
  type HerculeClient,
} from "@hercule/client-core";
import type { Trigger, Workflow } from "@hercule/contract";
import { Button, FailedMark, PausedMark, cn } from "@hercule/ui";
import { settingsQuery, triggersQuery, workflowQuery } from "../../../app/queries";
import { DiscardHeldEvents } from "../../../screens/discard-held-events";
import { SaveStatus } from "../../../screens/save-status";
import { useResumeTrigger } from "../../../screens/use-resume-trigger";
import { HeldEvents } from "./-held-events";

/**
 * Renders the triggers of a saved workflow below its problems panel, one row
 * each, and nothing when the workflow declares none. The route's loader has
 * already read them, so the panel does not wait for them.
 *
 * The panel shows the triggers as the controller holds them, from the last
 * save, not from the source being typed. A long list scrolls inside the panel,
 * so the editor above keeps most of the page. While the workflow is invalid
 * or disabled, the heading says that no trigger fires, because each row still
 * shows its trigger's own status. A trigger that lists its held events needs
 * more room, so the panel may then grow taller.
 */
export function TriggersPanel({
  client,
  workflowId,
}: {
  readonly client: HerculeClient;
  readonly workflowId: string;
}): JSX.Element | null {
  const triggers = useSuspenseQuery(triggersQuery(client, workflowId)).data.items;
  const workflow = useSuspenseQuery(workflowQuery(client, workflowId)).data;
  if (triggers.length === 0) return null;
  return (
    <section
      aria-labelledby="workflow-triggers"
      className={cn(
        "flex shrink-0 flex-col rounded-card border border-line-soft bg-surface",
        // A trigger listing its held events takes about five lines, which
        // would leave no room for the other triggers in the usual height.
        triggers.some(isPausedWithHeldEvents) ? "max-h-[296px]" : "max-h-[176px]",
      )}
    >
      <div className="flex items-baseline gap-2 px-4 py-2 text-meta">
        <h2 id="workflow-triggers" className="font-emph text-ink">
          Triggers
        </h2>{" "}
        {workflow.invalidSince !== undefined ? (
          <p className="text-muted">The workflow is invalid, so no trigger fires.</p>
        ) : workflow.enabled ? null : (
          <p className="text-muted">The workflow is disabled, so no trigger fires.</p>
        )}
      </div>
      <ul className="flex min-h-0 flex-col overflow-y-auto px-1.5 pb-1.5">
        {triggers.map((trigger) => (
          <TriggerRow
            key={trigger.triggerId}
            client={client}
            trigger={trigger}
            workflow={workflow}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * Renders one trigger: a mark when it is paused or its health is an error, its
 * id, what it fires on (an event kind and Connection, or a schedule), a cron
 * trigger's next fire time, and a start trigger's use of its spawn bound and
 * status, with a button that pauses or resumes it. Below come the events it
 * holds, the error on its health and the scheduled times it missed, when any
 * exist.
 *
 * A trigger the breaker paused shows Resume as the primary action, because
 * it is waiting for the user's answer. A trigger paused manually shows it as
 * quietly as Pause. A paused trigger that holds events also offers to resume
 * it with them discarded.
 *
 * The row owns the pause and resume mutations, because nothing above it
 * needs them, and shows the error of the last one sent. It reads the user's
 * display timezone itself; the entry guard has put the settings in the cache
 * before any route loads. A signal trigger only resumes a run that is already
 * waiting, so it has no status and no button.
 */
function TriggerRow({
  client,
  trigger,
  workflow,
}: {
  readonly client: HerculeClient;
  readonly trigger: Trigger;
  readonly workflow: Workflow;
}): JSX.Element {
  const queryClient = useQueryClient();
  const timezone = resolveDisplayTimezone(
    useSuspenseQuery(settingsQuery(client)).data.user.timezone,
  );
  const reading = describeTrigger(trigger, timezone, workflow);
  const { workflowId, triggerId } = trigger;
  const { toggle } = reading;

  const pause = useMutation({
    mutationFn: () => client.trigger.pause({ params: { workflowId, triggerId } }),
    // Returning the promise keeps the buttons inert until the list is
    // refetched, so they never show the old label after the response.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.triggers(workflowId) }),
  });
  const resume = useResumeTrigger(client, { workflowId, triggerId });
  const isPending = pause.isPending || resume.isPending;
  // Each action clears the other's error first, so only the last one's shows.
  const sendPause = () => {
    resume.reset();
    pause.mutate();
  };
  const sendResume = (discardHeld: boolean) => {
    pause.reset();
    resume.mutate(discardHeld);
  };
  const error = pause.error ?? resume.error;

  // The `{" "}` spaces are for screen readers. Flex layout adds no space
  // between items, so without them the texts run together.
  return (
    <li className="flex flex-col gap-0.5 rounded-control px-2.5 py-1 text-meta">
      <div className="flex h-6 items-center gap-3">
        <span className="flex w-3 shrink-0 justify-center">
          {reading.mark === "paused" ? (
            <PausedMark />
          ) : reading.mark === "failed" ? (
            <FailedMark />
          ) : null}
        </span>
        <span className="shrink-0 font-mono text-fine font-emph text-ink">{triggerId}</span>{" "}
        <span
          className={cn(
            "flex-1 font-mono text-fine",
            // A schedule is short and is a cron trigger's main fact, so it is
            // never cut short. An event kind with its Connection can be long.
            reading.firesOn === "schedule" ? "shrink-0 text-muted" : "min-w-0 truncate text-faint",
          )}
        >
          {reading.firesOnText}
        </span>{" "}
        {reading.nextFireText === undefined ? null : (
          <span className="shrink-0 font-mono text-fine text-faint tabular-nums">
            {reading.nextFireText}
          </span>
        )}{" "}
        {reading.bound === undefined ? null : (
          <span
            title={reading.bound.title}
            className="shrink-0 font-mono text-fine text-faint tabular-nums"
          >
            {reading.bound.text}
          </span>
        )}{" "}
        {reading.status === undefined ? null : (
          <span
            className={cn("shrink-0", reading.status.tone === "attn" ? "text-attn" : "text-muted")}
          >
            {reading.status.text}
          </span>
        )}{" "}
        {toggle === undefined ? null : (
          <Button
            variant={reading.isPausedByBreaker ? "primary" : "quiet"}
            className="-mr-1 w-[72px] justify-center text-meta"
            // An `aria-disabled` button ignores clicks, so a double click
            // cannot send the request twice.
            aria-disabled={isPending}
            onClick={() => {
              if (toggle === "pause") sendPause();
              else sendResume(false);
            }}
          >
            {toggle === "pause" ? "Pause" : "Resume"}
          </Button>
        )}
      </div>{" "}
      {reading.held === undefined ? null : (
        <HeldEvents
          client={client}
          workflowId={workflowId}
          triggerId={triggerId}
          heldCount={trigger.heldCount ?? 0}
          held={reading.held}
          isListed={reading.canDiscardHeldEvents}
        />
      )}{" "}
      {reading.canDiscardHeldEvents ? (
        <div className="pl-6">
          <DiscardHeldEvents
            heldCount={trigger.heldCount ?? 0}
            isPending={isPending}
            onConfirm={() => {
              sendResume(true);
            }}
          />
        </div>
      ) : null}{" "}
      {reading.healthError === undefined ? null : (
        <p className="pl-6 text-fine text-fail">
          {reading.healthError.message}
          <span className="text-faint">{` · ${reading.healthError.atText}`}</span>
        </p>
      )}{" "}
      {reading.skippedTicksText === undefined ? null : (
        <p className="pl-6 text-fine text-muted">{reading.skippedTicksText}</p>
      )}{" "}
      {error === null ? null : (
        <div className="pl-6">
          <SaveStatus saved={false} failure={readErrorMessage(error)} />
        </div>
      )}
    </li>
  );
}
