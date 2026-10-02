/**
 * The starter threads a Draft Thread offers while Intake has nothing to start
 * from: three ideas for a first thread, each a click away from a Message Draft.
 */

/** One starter: its title on the card, and what a click adds to the Message Draft. */
export interface StarterThread {
  readonly title: string;
  readonly message: string;
}

/**
 * The starters' copy, in one place. `code` is for a project with a
 * repository; `knowledgeWork` is for a project without one, because Hercule
 * is for work that is not code too. `{project}` stands for the project's name.
 * A `…` marks where the user writes their own subject.
 */
const STARTER_THREADS: Readonly<
  Record<"code" | "knowledgeWork", readonly [StarterThread, StarterThread, StarterThread]>
> = {
  code: [
    { title: "Get to know it", message: "Walk me through how {project} is put together" },
    { title: "A first fix", message: "Find a failing or flaky test and fix it" },
    {
      title: "A small chore",
      message: "Bring the README up to date with how {project} runs today",
    },
  ],
  knowledgeWork: [
    { title: "Something to present", message: "Make me a short presentation about …" },
    {
      title: "Something to find out",
      message: "Research … and summarise what you find, with sources",
    },
    { title: "Something to plan", message: "Write a one-page plan for …" },
  ],
};

/**
 * Returns the line under the starters that says what fills Intake: Triage
 * brings work from GitHub, so without a GitHub Connection the line says to
 * connect GitHub. It names no time of day, because Triage does not run on a
 * schedule yet, and a time would be a promise nothing keeps.
 */
export const describeEmptyIntake = (hasGitHubConnection: boolean): string =>
  hasGitHubConnection
    ? "Intake is empty for now. Triage reads GitHub and brings what needs work here."
    : "Intake is empty for now. Connect GitHub, and Triage brings what needs work here.";

/**
 * Returns the three starters for a project: the code starters when the
 * project has a repository, the knowledge-work starters otherwise, with
 * `{project}` replaced by `projectName`.
 */
export const chooseStarterThreads = (
  projectName: string,
  hasRepository: boolean,
): readonly StarterThread[] =>
  STARTER_THREADS[hasRepository ? "code" : "knowledgeWork"].map((starter) => ({
    title: starter.title,
    message: starter.message.replaceAll("{project}", projectName),
  }));
