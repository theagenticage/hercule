import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { MachineActivityActor } from "@hercule/client-core/machine-activity";
import { runQuery } from "../../app/queries";
import { SessionMark, SessionName } from "../actor/actor-mark";

/** The size of a session's face in an entry's "by", in CSS pixels. */
const ACTOR_FACE_SIZE = 14;

/**
 * Returns the name of the workflow that run `runId` followed, or `undefined`
 * while the run is read and when it cannot be read. It never suspends and
 * never fails: an entry reads well without the name, so a run that was
 * deleted or is slow to answer leaves the entry as it is.
 */
export const useRunWorkflowName = (runId: string | undefined): string | undefined => {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  // The read is switched off for an entry that has no run. Its key is never used then.
  const run = useQuery({
    ...runQuery(client, runId ?? ""),
    enabled: runId !== undefined,
  });
  const name = run.data?.plan.name;
  return name === undefined || name === "" ? undefined : name;
};

/**
 * Renders who did an entry, such as "by you": the user, a session's face and
 * its name, "by Hercule" for the controller's own acts, or the label of
 * anything else (a run, a plugin).
 */
export function MachineActivityActorName({
  actor,
}: {
  readonly actor: MachineActivityActor;
}): JSX.Element {
  switch (actor.kind) {
    case "user":
      return <span className="machine-activity-by">by you</span>;
    case "system":
      return <span className="machine-activity-by">by Hercule</span>;
    case "other":
      return <span className="machine-activity-by">by {actor.label}</span>;
    case "session":
      return (
        <span className="machine-activity-by">
          by <SessionMark sessionId={actor.sessionId} size={ACTOR_FACE_SIZE} />
          <SessionName sessionId={actor.sessionId} />
        </span>
      );
  }
}
