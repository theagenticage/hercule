import { useId, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildStartCards } from "@hercule/client-core";
import { startTasksQuery } from "../../app/queries";
import { IntakeIcon, TasksIcon } from "../../icons";

/** The GitHub mark, copied from the Bureau book's brands.js (Simple Icons, CC0). */
const GITHUB_MARK =
  "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12";

/**
 * Renders the start cards under a Draft Thread's composer, as the Bureau
 * book's `session-empty` page draws them: "Start from Intake", then up to
 * three open tasks of the project, most urgent first. Each card shows where
 * the task came from, whether it is a Proposal or a Task, its priority as
 * bars, and its title.
 *
 * A click hands the card's `message`, one line that points the thread's
 * agent at the task, to `onStart`, which adds it to the Message Draft. The
 * cards render nothing until the tasks are read, and nothing when the
 * project has no open task, so a failed read leaves the draft as it would be
 * without them.
 */
export function StartCards({
  projectId,
  onStart,
}: {
  readonly projectId: string;
  readonly onStart: (message: string) => void;
}): JSX.Element | null {
  const { controller } = useRouteContext({ from: "/_connected" });
  const tasks = useQuery(startTasksQuery(controller.client, projectId)).data ?? [];
  const headingId = useId();
  const cards = buildStartCards(tasks);
  if (cards.length === 0) return null;
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
              {card.source === "github" ? (
                <svg
                  className="br"
                  viewBox="0 0 24 24"
                  width={14}
                  height={14}
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d={GITHUB_MARK} />
                </svg>
              ) : (
                <TasksIcon size={14} />
              )}
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
