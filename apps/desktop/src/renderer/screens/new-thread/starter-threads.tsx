import { useId, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  chooseStarterThreads,
  describeEmptyIntake,
  filterGitHubConnections,
} from "@hercule/client-core";
import { connectionsQuery } from "../../app/queries";
import { CheckIcon } from "../../icons/check";
import { EyeIcon } from "../../icons/eye";
import { FileIcon } from "../../icons/file";
import type { IconProps } from "../../icons/icon-frame";
import { IntakeIcon } from "../../icons/intake";
import { ListIcon } from "../../icons/list";
import { SearchIcon } from "../../icons/search";
import { SparkleIcon } from "../../icons/sparkle";

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
 * The line depends on whether a GitHub Connection exists. The shell's loader
 * read the Connections, so the line never waits for them.
 */
export function StarterThreads({
  projectName,
  hasRepository,
  onStart,
}: {
  readonly projectName: string;
  readonly hasRepository: boolean;
  readonly onStart: (message: string) => void;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const connections = useSuspenseQuery(connectionsQuery(controller.client)).data;
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
      <p className="intake-note">
        <IntakeIcon size={14} />
        {describeEmptyIntake(filterGitHubConnections(connections).length > 0)}
      </p>
    </section>
  );
}
