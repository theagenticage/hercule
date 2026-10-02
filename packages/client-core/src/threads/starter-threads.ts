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
export const STARTER_THREADS: Readonly<
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
    { title: "Make a presentation", message: "Make me a short presentation about …" },
    {
      title: "Research a question",
      message: "Research … and summarise what you find, with sources",
    },
    { title: "Write a plan", message: "Write a one-page plan for …" },
  ],
};

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
