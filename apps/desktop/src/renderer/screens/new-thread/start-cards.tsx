import { useId, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildStartCards,
  chooseStarterThreads,
  describeEmptyIntake,
  filterGitHubConnections,
} from "@hercule/client-core";
import { connectionsQuery, startTasksQuery } from "../../app/queries";
import {
  CheckIcon,
  EyeIcon,
  FileIcon,
  IntakeIcon,
  ListIcon,
  SearchIcon,
  SparkleIcon,
  TasksIcon,
  type IconProps,
} from "../../icons";
import { GitHubMark } from "../../logos";

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
      <StarterThreads projectName={projectName} hasRepository={hasRepository} onStart={onStart} />
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

/**
 * The mark of each starter, in the order `chooseStarterThreads` returns
 * them: the code starters for a project with a repository, the
 * knowledge-work starters for one without.
 */
const STARTER_ICONS: Readonly<
  Record<"code" | "knowledgeWork", readonly ((props: IconProps) => JSX.Element)[]>
> = {
  code: [EyeIcon, CheckIcon, FileIcon],
  knowledgeWork: [FileIcon, SearchIcon, ListIcon],
};

/**
 * Renders three starter threads under "Or start from one of these", for a
 * project whose Intake is empty, then a line that says what fills Intake.
 * A click hands the starter's message to `onStart`, which adds it to the
 * Message Draft without sending it, so the user can finish the sentence.
 *
 * The line depends on whether a GitHub Connection exists, and is left out
 * until the Connections are read, so a failed read costs only the line.
 */
function StarterThreads({
  projectName,
  hasRepository,
  onStart,
}: {
  readonly projectName: string;
  readonly hasRepository: boolean;
  readonly onStart: (message: string) => void;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const connections = useQuery(connectionsQuery(controller.client)).data;
  const headingId = useId();
  const icons = STARTER_ICONS[hasRepository ? "code" : "knowledgeWork"];
  return (
    <section aria-labelledby={headingId}>
      <h2 className="starts-h section-h" id={headingId}>
        <SparkleIcon size={14} />
        Or start from one of these
      </h2>
      <div className="starts">
        {chooseStarterThreads(projectName, hasRepository).map((starter, index) => {
          const Icon = icons[index] ?? FileIcon;
          return (
            <button
              key={starter.title}
              type="button"
              className="start"
              onClick={() => {
                onStart(starter.message);
              }}
            >
              <span className="start-top">
                <Icon size={14} />
                <span>{starter.title}</span>
              </span>
              <b>{starter.message}</b>
            </button>
          );
        })}
      </div>
      {connections === undefined ? null : (
        <p className="intake-note">
          <IntakeIcon size={14} />
          {describeEmptyIntake(filterGitHubConnections(connections).length > 0)}
        </p>
      )}
    </section>
  );
}
