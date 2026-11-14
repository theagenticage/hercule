/**
 * What the start-thread dialog decides and says: the starters and the message
 * each one writes, the reason behind the project the dialog picked, the text
 * sent as the thread's first prompt, and the key under which unsent words are
 * kept. Pure: nothing here reads or writes anything.
 */
import type {
  EvidenceEntity,
  InboxThing,
  ProjectMatch,
  Resource,
  ThreadWorkspace,
} from "@hercule/contract";
import { ApiError, readErrorMessage } from "../errors";
import { formatAccessMode } from "../threads/access-modes";
import type { ShelfItem } from "../attachments/shelf";
import { holdsMessageContent, type ThreadPicks } from "../threads/config";
import { buildDraftView, type DraftReads, type DraftView } from "../threads/draft-view";
import {
  decideDefaultWorkspacePick,
  formatRepoName,
  joinPhraseText,
  listProjectRepos,
  type WorkspacePick,
} from "../threads/workspaces";
import { describeInboxThreadStartFailure } from "./inbox-moves";

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

/**
 * Where the dialog's project stands:
 * - `inferred`: the controller's reply decides, and may say there is no project.
 * - `chosen`: the user picked this Project.
 * - `none-chosen`: the user picked "No project", a choice of its own.
 * - `matching`: nothing is picked yet because the controller's reply is on its way.
 * - `failed`: nothing is picked because the controller could not match; `reason` says why.
 */
type ProjectChoice =
  | { readonly kind: "inferred"; readonly match: ProjectMatch }
  | { readonly kind: "chosen"; readonly projectId: string }
  | { readonly kind: "none-chosen" }
  | { readonly kind: "matching" }
  | { readonly kind: "failed"; readonly reason: string };

/** The names a reason needs, which the choice only holds as ids. */
interface ProjectChoiceNames {
  /** The picked Project's name. Needed whenever a Project is picked. */
  readonly projectName?: string;
  /** The name of the Resource (repository) a match was made on. */
  readonly repositoryName?: string;
  /** Whether the picked Project holds a Model Profile that the thread then uses. */
  readonly hasModelProfile?: boolean;
  /**
   * Whether the thread starts by asking before it edits. `false` once the user
   * picked another access mode under "No project"; left out counts as `true`.
   */
  readonly asksBeforeEdits?: boolean;
}

/** Returns whether a Project is picked, and so whether the thread may start. */
const hasProjectPick = (choice: ProjectChoice): boolean =>
  choice.kind === "chosen" || (choice.kind === "inferred" && choice.match.kind === "matched");

const NO_REPOSITORY_WORDS: readonly ReasonPhrase[] = [
  {
    text: "Nothing here points at a repository, so no project is picked. Choose one, or start it without code.",
  },
];
const MATCHING_WORDS: readonly ReasonPhrase[] = [
  { text: "Looking for the project these belong to." },
];
const AMBIGUOUS_WORDS: readonly ReasonPhrase[] = [
  {
    text: "These point at more than one project, so none is picked. Choose one, or start it without code.",
  },
];

/** Returns how a mention reads in a sentence: its identifier, else its quoted title, else `fallback`. */
const nameMention = (mention: EvidenceEntity, fallback: string): string =>
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

/** Returns the closing words of a picked Project's reason: that its profile comes along, when it has one. */
const PROFILE_WORDS = (names: ProjectChoiceNames): string =>
  names.hasModelProfile === true ? " Its profile comes with it." : "";

/**
 * Returns the one line under the composer that says why the dialog's project
 * is what it is, as pieces in which the Project's name is `strong`.
 * `names` must hold the Project's name when a Project is picked, and the
 * repository's name when it was picked by a match.
 */
const describeProjectChoice = (
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
            text: ` because ${describeMatchEvidence(choice.match, names)}.${PROFILE_WORDS(names)}`,
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
        { text: `, which you chose.${PROFILE_WORDS(names)}` },
      ];
    case "none-chosen":
      return [
        { text: "No project", strong: true },
        {
          text: `: the agent works without code or a checkout, with your own profile${names.asksBeforeEdits === false ? "" : ", and asks before it edits anything"}.`,
        },
      ];
    case "matching":
      return MATCHING_WORDS;
    case "failed":
      return [
        {
          text: `Could not look up the project: ${choice.reason}. Choose one, or try again.`,
        },
      ];
  }
};

/** Returns the pieces of a reason line as one string. */
const joinReasonText = (parts: readonly ReasonPhrase[]): string =>
  parts.map((part) => part.text).join("");

/** The pick of the dialog's lip that a popover explains. */
type ThreadPick = "project" | "access" | "profile";

/** What the popover of a pick needs besides the choice. */
interface ThreadPickLabels extends ProjectChoiceNames {
  /** The access mode the thread will start with, as the pick shows it. */
  readonly accessLabel: string;
  /** The Model Profile the thread will start with, as the pick shows it. */
  readonly profileLabel: string;
}

/**
 * Returns the reason shown for one pick: a line at the top of that pick's
 * menu, or under the project pick. The workspace pick is not here: the dialog
 * shows the workspace lead for it.
 *
 * `labels` hold the values actually sent, so no line claims more than they
 * say: access and profile name the resolved label, and say where it comes
 * from only in ways that hold even when the user picked it by hand.
 */
const describePickReason = (
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
        return `${labels.accessLabel} is the access this thread starts with. With no project there is no checkout to edit.`;
      case "profile":
        return `${labels.profileLabel} is the model this thread starts with. No project is picked, so no project profile applies.`;
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
      return `${labels.accessLabel} is the access this thread starts with. A project does not set it.`;
    case "profile":
      return `${labels.profileLabel} is the model this thread starts with. It begins as ${projectName}’s profile, unless you pick another.`;
  }
};

/** Returns the key under which unsent words are kept for a set of things: the same for any order. */
export const buildThingsDraftKey = (ids: readonly string[]): string => [...ids].sort().join(",");

/**
 * Returns the picks to store once the user chooses `chosen` in the project
 * pick: a Project's id, or `null` for "No project".
 *
 * - The workspace pick always goes, because it names a checkout of the
 *   Project it was made in.
 * - "No project" also drops the access pick, so the thread starts with
 *   `NO_PROJECT_ACCESS_MODE` until the user picks an
 *   access mode on purpose.
 */
export const buildPicksForProjectChoice = (
  picks: ThreadPicks,
  chosen: string | null,
): ThreadPicks => {
  const kept = { ...picks };
  delete kept.workspace;
  if (chosen === null) delete kept.accessMode;
  return kept;
};

/** The access mode a thread starts with when no project is picked: it has no checkout to protect, so it asks before it edits. */
const NO_PROJECT_ACCESS_MODE = "approval-required";

/**
 * Returns the picks the composer shows and sends. With "No project" chosen,
 * the access mode is `NO_PROJECT_ACCESS_MODE` unless `picks` holds one the
 * user picked after choosing it. Otherwise `picks` as they are.
 */
const buildPicksUnderChoice = (picks: ThreadPicks, isNoProject: boolean): ThreadPicks =>
  isNoProject ? { accessMode: NO_PROJECT_ACCESS_MODE, ...picks } : picks;

/**
 * Returns the workspace a thread starts in when a match found its evidence in
 * the repository `resourceId` of the Project whose repositories are `repos`.
 *
 * - With the user's workspace setting at `primary`, the repository's main
 *   workspace, rather than the first repository's.
 * - Otherwise the default for the Project (a new workspace with a worktree of
 *   each repository), which already includes the repository.
 * - A `resourceId` that is not one of `repos` leaves the Project's default.
 */
const decideEvidenceWorkspacePick = (
  repos: readonly Resource[],
  resourceId: string | undefined,
  preferred: ThreadWorkspace | null,
): WorkspacePick => {
  const holdsRepository = repos.some((repo) => repo.id === resourceId);
  const pick = decideDefaultWorkspacePick(repos, preferred);
  return holdsRepository && pick.kind === "primary" && resourceId !== undefined
    ? { kind: "primary", resourceId }
    : pick;
};

/**
 * The state of the controller's lookup of the Project the things belong to
 * (`externalEntity.matchProject`):
 * - `loading`: no answer yet. The answer for the previous things is never kept.
 * - `refetching`: the last lookup failed and a new one is on its way.
 * - `failed`: the lookup failed; `reason` says why.
 * - `answered`: the controller replied, possibly that there is no Project.
 *
 * A failed refresh that left an old answer behind is `refetching` or `failed`,
 * never `answered`: the old answer must not stay sendable.
 */
export type ProjectLookup =
  | { readonly kind: "loading" }
  | { readonly kind: "refetching" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "answered"; readonly match: ProjectMatch };

/** What the user has written and chosen in a start-thread draft that decides the Project and the send. */
export interface ThreadStartDraftState {
  /** The Project the user chose: its id, `null` for "No project", `undefined` when nothing was chosen. */
  readonly chosenProject: string | null | undefined;
  /** The picks the user made in the composer. */
  readonly picks: ThreadPicks;
  /** The message in the composer's field. */
  readonly text: string;
  /** The images attached to the message. */
  readonly attachments: readonly ShelfItem[];
}

/** The Project pick of the dialog's lip. */
export type ThreadProjectPick =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "none" }
  | { readonly kind: "unpicked" };

/**
 * Why a new send cannot go, or `null` when the draft itself allows it:
 * - `matching`: the lookup of the Project is on its way or failed.
 * - `no-project`: the lookup found no single Project and the user chose none.
 * - `no-message`: no words and no image.
 * - `blocked`: the thread cannot start as configured, see `DraftView.fields.blocked`.
 */
export type ThreadSendBlock = "matching" | "no-project" | "no-message" | "blocked";

/** Everything the start-thread dialog shows and decides from a draft, see `buildThreadStartView`. */
export interface ThreadStartView {
  /** The draft the composer shows and sends: the Project, the user's picks, and the workspace the match found its evidence in. */
  readonly view: DraftView;
  /** The Project's name, or `undefined` when no Project is picked. */
  readonly projectName: string | undefined;
  readonly projectPick: ThreadProjectPick;
  /** Whether the composer's picks may change: a Project, or "No project", is picked. */
  readonly isProjectPicked: boolean;
  /** The line under the composer that says why the Project is what it is. */
  readonly reason: readonly ReasonPhrase[];
  /** The line under the Project pick. */
  readonly pickReason: string;
  /** The line at the top of each of the composer's menus. */
  readonly pickReasons: {
    readonly accessMode: string;
    readonly model: string;
    readonly workspace: string;
  };
  /** Whether the lookup failed, so the dialog offers to try it again. */
  readonly lookupFailed: boolean;
  /** Why a new send cannot go, or `null`. An attempt that is sent again as it was ignores it. */
  readonly sendBlock: ThreadSendBlock | null;
}

/**
 * Builds what the start-thread dialog shows and decides from the `draft`:
 * the Project (the user's choice, else the controller's match as `lookup`
 * says), the composer's view with the picks that follow from it, the reason
 * lines, and whether a new send may go.
 *
 * - A chosen Project, or "No project", wins over any lookup, also a late one.
 * - A matched Project puts the workspace in the repository the match found its
 *   evidence in, unless the user picked a workspace.
 * - "No project" starts with approval-required access unless the user picked another.
 * - The lookup that is on its way or failed is not the same as "nothing points
 *   at a repository": it says so, and nothing is sendable.
 */
export const buildThreadStartView = ({
  reads,
  draft,
  lookup,
}: {
  readonly reads: DraftReads;
  readonly draft: ThreadStartDraftState;
  readonly lookup: ProjectLookup;
}): ThreadStartView => {
  const choice: ProjectChoice =
    draft.chosenProject === null
      ? { kind: "none-chosen" }
      : draft.chosenProject !== undefined
        ? { kind: "chosen", projectId: draft.chosenProject }
        : lookup.kind === "answered"
          ? { kind: "inferred", match: lookup.match }
          : lookup.kind === "failed"
            ? { kind: "failed", reason: lookup.reason }
            : { kind: "matching" };
  const matched =
    choice.kind === "inferred" && choice.match.kind === "matched" ? choice.match : undefined;
  const projectId = choice.kind === "chosen" ? choice.projectId : (matched?.projectId ?? null);
  const isNoProject = choice.kind === "none-chosen";
  const isProjectPicked = hasProjectPick(choice) || isNoProject;
  const underChoice = buildPicksUnderChoice(draft.picks, isNoProject);
  // The workspace follows the repository the match found its evidence in, unless the user picked one.
  const picks: ThreadPicks =
    matched === undefined || underChoice.workspace !== undefined
      ? underChoice
      : {
          ...underChoice,
          workspace: decideEvidenceWorkspacePick(
            listProjectRepos(reads.resources, projectId),
            matched.resourceId,
            reads.settings.user["thread.workspace"] ?? null,
          ),
        };
  const view = buildDraftView(reads, { projectId, workspaceId: null }, picks);
  const project = view.catalogs.projects.find((each) => each.id === projectId);
  const resource = view.catalogs.resources.find((each) => each.id === matched?.resourceId);
  const names: ThreadPickLabels = {
    ...(project === undefined ? {} : { projectName: project.name }),
    ...(resource === undefined ? {} : { repositoryName: formatRepoName(resource) }),
    hasModelProfile: project?.modelProfileId != null,
    asksBeforeEdits: view.fields.accessMode.value === "approval-required",
    accessLabel: formatAccessMode(view.fields.accessMode.value),
    profileLabel: view.fields.model.pill.name ?? "",
  };
  const reason = describeProjectChoice(choice, names);
  return {
    view,
    projectName: project?.name,
    projectPick: isNoProject
      ? { kind: "none" }
      : projectId !== null
        ? { kind: "project", projectId }
        : { kind: "unpicked" },
    isProjectPicked,
    reason,
    // A lookup that is on its way or failed is not "nothing points at a repository", which the pick's own reason says.
    pickReason:
      choice.kind === "matching" || choice.kind === "failed"
        ? joinReasonText(reason)
        : describePickReason("project", choice, names),
    pickReasons: {
      accessMode: describePickReason("access", choice, names),
      model: describePickReason("profile", choice, names),
      workspace: joinPhraseText(view.fields.lead ?? []),
    },
    lookupFailed: choice.kind === "failed",
    sendBlock:
      choice.kind === "matching"
        ? "matching"
        : !isProjectPicked
          ? "no-project"
          : !holdsMessageContent({ text: draft.text, attachments: draft.attachments })
            ? "no-message"
            : view.fields.blocked !== null
              ? "blocked"
              : null,
  };
};

/**
 * Returns the sentence for a thread that failed to start on the Task `title`.
 * The controller's refusals (an `ApiError` below 500) end with their own
 * advice. Any other failure, such as an unreachable controller or a server
 * error, has none, so this adds "Try again.".
 */
export const describeThreadStartError = (title: string, error: unknown): string => {
  const reason = readErrorMessage(error).replace(/\.+$/, "");
  const text = describeInboxThreadStartFailure(title, reason);
  return error instanceof ApiError && error.status < 500 ? text : `${text} Try again.`;
};
