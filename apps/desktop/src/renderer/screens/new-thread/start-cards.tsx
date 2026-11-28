import { lazy, Suspense, useId, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildStartCards } from "@hercule/client-core";
import { startTasksQuery } from "../../app/queries";
import { InboxIcon } from "../../icons/inbox";
import { GitHubMark } from "../../logos";

// The starters show only while a project has no planned task, so they load the
// first time they show, and are not part of the first screen's scripts
// (spec 17 §Performance).
const StarterThreads = lazy(() =>
  import("./starter-threads").then((module) => ({ default: module.StarterThreads })),
);

/**
 * Renders the start cards under a Draft Thread's composer, as the Bureau
 * book's `session-empty` page draws them: "Start from Work" and a note that
 * says what a click does, then up to three planned tasks of the project, most
 * urgent first. Each card shows where the task came from (the GitHub mark, or
 * else the heading's Inbox icon), its priority in words alone ("Urgent" in the
 * failure hue), and its title.
 *
 * While the project has no planned task, three starter threads take the cards'
 * place, see `StarterThreads`.
 *
 * A click hands the card's `message`, one line that points the thread's
 * agent at the task, and the task's id to `onStart`, which adds the message to
 * the Message Draft and joins the thread to the task. The
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
  readonly onStart: (message: string, taskId?: string) => void;
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
      <div className="starts-h starts-head">
        <h2 className="section-h" id={headingId}>
          <InboxIcon size={14} />
          Start from Work
        </h2>
        <span className="starts-note">Puts the Task in your message</span>
      </div>
      <div className="starts">
        {cards.map((card) => (
          <button
            key={card.taskId}
            type="button"
            className="start"
            onClick={() => {
              onStart(card.message, card.taskId);
            }}
          >
            <span className="start-top">
              {card.source === "github" ? <GitHubMark size={14} /> : <InboxIcon size={14} />}
              <span className={card.priority === "urgent" ? "start-priority is-urgent" : undefined}>
                {card.priorityText}
              </span>
            </span>
            <b>{card.title}</b>
          </button>
        ))}
      </div>
    </section>
  );
}
