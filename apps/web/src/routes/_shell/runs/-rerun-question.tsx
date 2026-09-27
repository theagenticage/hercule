import { useState, type JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { listRerunChoices, queryKeys, type HerculeClient } from "@hercule/client-core";
import type { RerunMode, Run } from "@hercule/contract";
import { SegmentedControl, SegmentedControlItem } from "@hercule/ui";
import { InPlaceQuestion } from "../../../screens/in-place-question";

/**
 * Returns the mutation that re-runs the run with `runId`, and `startRerun`,
 * which starts a re-run in the mode it is given and then goes to the new
 * run's page.
 *
 * The mutation lives on the run's page rather than in the question, because
 * the question closes as soon as it is answered, while the page keeps showing
 * whether the re-run is still starting and why it failed.
 */
export const useRerun = (client: HerculeClient, runId: string) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const rerun = useMutation({
    mutationFn: (mode: RerunMode) => client.run.rerun({ params: { id: runId }, payload: { mode } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs() }),
  });
  return {
    rerun,
    startRerun: (mode: RerunMode): void => {
      rerun.mutate(mode, {
        // A per-call `onSuccess` runs only while the page is mounted, so a
        // user who already left the page is not pulled to the new run.
        onSuccess: (started) => {
          void navigate({ to: "/runs/$runId", params: { runId: started.runId } });
        },
      });
    },
  };
};

/**
 * Renders the question shown before an ended run is re-run. It asks which
 * workflow the new run follows, with the default picked, and explains the
 * picked choice below it. A run that offers only one choice gets no picker,
 * only the explanation. The question opens with the default picked each time,
 * because the page mounts it afresh each time it asks.
 *
 * `onAccept` receives the picked mode.
 */
export function RerunQuestion({
  run,
  onDecline,
  onAccept,
}: {
  readonly run: Pick<Run, "workflowId">;
  readonly onDecline: () => void;
  readonly onAccept: (mode: RerunMode) => void;
}): JSX.Element {
  const choices = listRerunChoices(run);
  const [rerunMode, setRerunMode] = useState(choices[0].mode);
  const picked = choices.find((choice) => choice.mode === rerunMode) ?? choices[0];
  return (
    <InPlaceQuestion
      stacked
      question="Re-run with the same inputs?"
      declineLabel="Cancel"
      acceptLabel="Re-run"
      onDecline={onDecline}
      onAccept={() => {
        onAccept(picked.mode);
      }}
    >
      {choices.length === 1 ? null : (
        <SegmentedControl
          aria-label="Re-run"
          className="w-auto self-start"
          value={picked.mode}
          onValueChange={(next) => {
            setRerunMode(next === "replay" ? "replay" : "re-stamp");
          }}
        >
          {choices.map((choice) => (
            <SegmentedControlItem key={choice.mode} value={choice.mode} className="px-3">
              {choice.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      )}
      <p className="text-meta text-pretty">{picked.explanation}</p>
    </InPlaceQuestion>
  );
}
