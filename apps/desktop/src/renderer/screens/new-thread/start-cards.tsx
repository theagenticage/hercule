import { lazy, Suspense, useId, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildStartCards } from "@hercule/client-core";
import { startTasksQuery } from "../../app/queries";
import { IntakeIcon } from "../../icons/intake";
import { TasksIcon } from "../../icons/tasks";
import { GitHubMark } from "../../logos";

// The starters show only while a project has no open task, so they load the
// first time they show, and are not part of the first screen's scripts
// (spec 17 §Performance).
const StarterThreads = lazy(() =>
  import("./starter-threads").then((module) => ({ default: module.StarterThreads })),
);

/**
 * Renders the start cards under a Draft Thread's composer, as the Bureau
 * book's `session-empty` page draws them: "Start from Intake", then up to
 * three open tasks of the project, most urgent first. Each card shows where
 * the task came from, whether it is a Proposal or a Task, its priority as
 * bars, and its title.
 *
 * While the project has no open task, three starter threads take the cards'
 * place, see `StarterThreads`.
 *
 * A click hands the card's `message`, one line that points the thread's
 * agent at the task, to `onStart`, which adds it to the Message Draft. The
 * cards render nothing until the tasks are read, so a failed read leaves the
 * draft as it would be without them.
 */
export function StartCards({
  projectId,
  projectName,
  hasRepository,
  onStart,
}: {
  readonly projectId: string;
  readonly projectName: string;
  readonly hasRepository: boolean;
  readonly onStart: (message: string) => void;
}): JSX.Element | null {
  const { controller } = useRouteContext({ from: "/_connected" });
  const tasks = useQuery(startTasksQuery(controller.client, projectId)).data;
  const headingId = useId();
  if (tasks === undefined) return null;
  const cards = buildStartCards(tasks);
  if (cards.length === 0) {
    return (
      // Without its own boundary, the starters' load would suspend the draft
      // above them.
      <Suspense fallback={null}>
        <StarterThreads projectName={projectName} hasRepository={hasRepository} onStart={onStart} />
      </Suspense>
    );
  }
  return (
    <section aria-labelledby={headingId}>
      <h2 className="starts-h section-h" id={headingId}>
        <IntakeIcon size={14} />
        Start from Intake
      </h2>
      <div className="starts">
        {cards.map((card) => (
          <button
            key={card.taskId}
            type="button"
            className="start"
            onClick={() => {
              onStart(card.message);
            }}
          >
            <span className="start-top">
              {card.source === "github" ? <GitHubMark size={14} /> : <TasksIcon size={14} />}
              <span>{card.kind}</span>
              <span className="spacer" />
              <span
                className="bars"
                data-p={card.bars}
                role="img"
                aria-label={`${card.priority} priority`}
              >
                <i />
                <i />
                <i />
                <i />
              </span>
            </span>
            <b>{card.title}</b>
          </button>
        ))}
      </div>
    </section>
  );
}
