import type { JSX } from "react";
import {
  chooseCardColleaguePose,
  chooseCardSecondLine,
  type TaskAction,
  type TaskActionId,
} from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import { buildLook, Face } from "../../faces";
import { FailedMark } from "../desk";

/** Renders what a failed run needs: the card's words, then the two moves only a failure has. */
export function FailureSection({
  card,
  actions,
  onAction,
}: {
  readonly card: WorkCard;
  readonly actions: readonly TaskAction[];
  readonly onAction: (id: TaskActionId) => void;
}): JSX.Element | null {
  const failure = card.failure;
  const words = chooseCardSecondLine(card, false);
  if (failure === undefined || words?.tone !== "failed") return null;
  const colleague = chooseCardColleaguePose(card);
  return (
    <section className="task-pane-sec" aria-label="What failed">
      <p className="task-pane-who">
        {colleague !== null && (
          <Face look={buildLook(colleague.sessionId)} pose="failed" size={22} />
        )}
        <span>
          <b>{failure.workflowName}</b> stopped.
        </span>
      </p>
      <p className="task-pane-ask task-pane-failed">
        <FailedMark />
        {words.text}
      </p>
      <div className="task-pane-answers">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={action.filled ? "task-pane-answer is-suggested" : "task-pane-answer"}
            onClick={() => {
              onAction(action.id);
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </section>
  );
}
