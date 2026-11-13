/**
 * What the start-thread dialog decides and says: the starters and the message
 * each one writes, the reason behind the project the dialog picked, the text
 * sent as the thread's first prompt, and the key under which unsent words are
 * kept. Pure: nothing here reads or writes anything.
 */
import {
  MAX_PROMPT_LENGTH,
  type EntityMention,
  type InboxThing,
  type ProjectMatch,
} from "@hercule/contract";

/** The ways the dialog can begin its message. */
export type ThreadStarter = "investigate" | "fix" | "reply" | "summarise" | "own";

/** The starters in the order the dialog lists them, with the label of each chip. */
export const THREAD_STARTERS: readonly {
  readonly starter: ThreadStarter;
  readonly label: string;
}[] = [
  { starter: "investigate", label: "Investigate" },
  { starter: "fix", label: "Fix" },
  { starter: "reply", label: "Draft a reply" },
  { starter: "summarise", label: "Summarise" },
  { starter: "own", label: "Your own words" },
];

/**
 * The starter the dialog opens with: always Investigate. The drawing makes it
 * Draft a reply when everything is a conversation, but the Inbox's things carry
 * no such kind, so the rule is narrowed to the one case the client can know.
 */
export const DEFAULT_THREAD_STARTER: ThreadStarter = "investigate";

/** Returns who asked first, newest ask first, over `things` in order. `undefined` when no ask names a person. */
const findFirstAsker = (things: readonly InboxThing[]): string | undefined => {
  for (const thing of things) {
    for (const ask of thing.asks) if (ask.asker !== undefined) return ask.asker;
  }
  return undefined;
};

/**
 * Returns the message `starter` writes for `things`. "Your own words" writes
 * nothing. "Draft a reply" names the person of the first ask that has one.
 * Call it with at least one thing.
 */
export const writeStarterMessage = (
  starter: ThreadStarter,
  things: readonly InboxThing[],
): string => {
  const isOne = things.length === 1;
  const these = isOne ? "this" : `these ${things.length}`;
  switch (starter) {
    case "investigate":
      return `Look into ${these} and tell me what is going on before you change anything. Say what you think the cause is, how sure you are, and what you would do next.`;
    case "fix":
      return `Fix ${these} and open a pull request. Keep the change small, add a test for the case, and ask me before anything needs a migration.`;
    case "reply": {
      const asker = findFirstAsker(things);
      return `Draft a reply${asker === undefined ? "" : ` to ${asker}`}. Do not send it: show me the draft, and say what you checked to write it.`;
    }
    case "summarise":
      return `Summarise where ${these} stand${isOne ? "s" : ""}: who waits on whom, what changed this week, and what is still open.`;
    case "own":
      return "";
  }
};

/** One piece of a sentence; `strong` pieces are set in bold. */
export interface ReasonPhrase {
  readonly text: string;
  readonly strong?: boolean;
}

/** Returns the sentence as one plain string, for a screen reader or a test. */
export const joinReasonText = (parts: readonly ReasonPhrase[]): string =>
  parts.map((part) => part.text).join("");

/**
 * Where the dialog's project stands:
 * - `inferred`: the controller's reply decides, and may say there is no project.
 * - `chosen`: the user picked this Project.
 * - `none-chosen`: the user picked "No project", a choice of its own.
 * - `unpicked`: nothing is picked and no reply says why.
 */
export type ProjectChoice =
  | { readonly kind: "inferred"; readonly match: ProjectMatch }
  | { readonly kind: "chosen"; readonly projectId: string }
  | { readonly kind: "none-chosen" }
  | { readonly kind: "unpicked" };

/** The names a reason needs, which the choice only holds as ids. */
export interface ProjectChoiceNames {
  /** The picked Project's name. Needed whenever a Project is picked. */
  readonly projectName?: string;
  /** The name of the Resource (repository) a match was made on. */
  readonly repositoryName?: string;
}

/** Returns whether a Project is picked, and so whether the thread may start. */
export const hasProjectPick = (choice: ProjectChoice): boolean =>
  choice.kind === "chosen" || (choice.kind === "inferred" && choice.match.kind === "matched");

const NO_REPOSITORY_WORDS: readonly ReasonPhrase[] = [
  {
    text: "Nothing here points at a repository, so no project is picked. Choose one, or start it without code.",
  },
];
const AMBIGUOUS_WORDS: readonly ReasonPhrase[] = [
  {
    text: "These point at more than one project, so none is picked. Choose one, or start it without code.",
  },
];

/** Returns how a mention reads in a sentence: its identifier, else its quoted title, else `fallback`. */
const nameMention = (mention: EntityMention, fallback: string): string =>
  mention.identifier ?? (mention.title === undefined ? fallback : `“${mention.title}”`);

/** Returns the sentence part that says why a match chose its Project, without the Project's name. */
const describeMatchEvidence = (
  match: Extract<ProjectMatch, { kind: "matched" }>,
  { projectName, repositoryName }: ProjectChoiceNames,
): string => {
  const place = `in ${repositoryName ?? "a repository"}, one of ${projectName ?? "its"}’s repositories`;
  return match.via === undefined
    ? `${nameMention(match.thing, "It")} is ${place}`
    : `${nameMention(match.thing, "It")} is linked to ${nameMention(match.via, "a linked thing")}, ${place}`;
};

/**
 * Returns the one line under the composer that says why the dialog's project
 * is what it is, as pieces in which the Project's name is `strong`.
 * `names` must hold the Project's name when a Project is picked, and the
 * repository's name when it was picked by a match.
 */
export const describeProjectChoice = (
  choice: ProjectChoice,
  names: ProjectChoiceNames,
): readonly ReasonPhrase[] => {
  const projectName = names.projectName ?? "The project";
  if (choice.kind === "inferred") {
    switch (choice.match.kind) {
      case "matched":
        return [
          { text: projectName, strong: true },
          {
            text: ` because ${describeMatchEvidence(choice.match, names)}. Its profile comes with it.`,
          },
        ];
      case "ambiguous":
        return AMBIGUOUS_WORDS;
      case "none":
        return NO_REPOSITORY_WORDS;
    }
  }
  switch (choice.kind) {
    case "chosen":
      return [
        { text: projectName, strong: true },
        { text: ", which you chose. Its profile comes with it." },
      ];
    case "none-chosen":
      return [
        { text: "No project", strong: true },
        {
          text: ": the agent works without code or a checkout, with your own profile, and asks before it edits anything.",
        },
      ];
    case "unpicked":
      return NO_REPOSITORY_WORDS;
  }
};

/** The pick of the dialog's lip that a popover explains. */
export type ThreadPick = "project" | "access" | "profile";

/** What the popover of a pick needs besides the choice. */
export interface ThreadPickLabels extends ProjectChoiceNames {
  /** The access mode the thread will start with, as the pick shows it. */
  readonly accessLabel: string;
  /** The Model Profile the thread will start with, as the pick shows it. */
  readonly profileLabel: string;
}

/**
 * Returns the reason a popover gives for one pick. The workspace pick is not here: the dialog shows the workspace lead for it. Project and profile follow
 * the project; access is the user's own
 * default, because a Project holds a Model Profile and no access mode.
 */
export const describePickReason = (
  pick: ThreadPick,
  choice: ProjectChoice,
  labels: ThreadPickLabels,
): string => {
  const projectName = labels.projectName ?? "the project";
  if (choice.kind === "none-chosen") {
    switch (pick) {
      case "project":
        return "You chose to start it without code.";
      case "access":
        return `${labels.accessLabel}, because with no project the agent asks before it edits anything.`;
      case "profile":
        return "Your own profile, because no project is picked.";
    }
  }
  if (!hasProjectPick(choice)) {
    if (pick !== "project") return "Comes from the project you choose.";
    return choice.kind === "inferred" && choice.match.kind === "ambiguous"
      ? "These point at more than one project."
      : "Nothing here points at a repository.";
  }
  switch (pick) {
    case "project":
      return choice.kind === "inferred" && choice.match.kind === "matched"
        ? `Picked because ${describeMatchEvidence(choice.match, labels)}.`
        : "You chose it.";
    case "access":
      return `${labels.accessLabel} is your default access for a new thread. A project does not set it.`;
    case "profile":
      return `${labels.profileLabel} is ${projectName}’s profile.`;
  }
};

/** What `buildThingsPromptText` makes: the text, or why no text was made. */
export type ThingsPromptText =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "too-long"; readonly reason: string };

/** Returns the line that lists one thing in the prompt: identifier, title and id. */
const describeThingForPrompt = (thing: InboxThing): string =>
  `- ${thing.identifier} ${thing.title} (${thing.id})`;

/**
 * Builds the prompt that starts the thread: `message`, a blank line, one line
 * per thing (identifier, title, id), and how to read them in full. Returns a
 * refusal, never a cut prompt, when the text would pass the prompt's length
 * limit. This stands in until the controller builds the context itself.
 */
export const buildThingsPromptText = (
  message: string,
  things: readonly InboxThing[],
): ThingsPromptText => {
  const text = [
    message,
    "",
    ...things.map(describeThingForPrompt),
    "",
    "Read any of them in full with `hercule entity read <id>`.",
  ].join("\n");
  return text.length <= MAX_PROMPT_LENGTH
    ? { kind: "text", text }
    : {
        kind: "too-long",
        reason: `The message and the things are ${text.length.toLocaleString("en-US")} letters, and a thread starts with at most ${MAX_PROMPT_LENGTH.toLocaleString("en-US")}. Shorten the message or leave some things out.`,
      };
};

/** Returns the key under which unsent words are kept for a set of things: the same for any order. */
export const buildThingsDraftKey = (ids: readonly string[]): string => [...ids].sort().join(",");
