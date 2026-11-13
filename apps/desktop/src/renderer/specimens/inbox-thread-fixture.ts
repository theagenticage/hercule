/**
 * The records of the Inbox specimen's start-thread dialog states (`dialog`,
 * `dialog-unpicked`, `dialog-why` and `dialog-started`): the Northwind
 * webshop Project with its repository `storefront-web`, how the controller
 * matches things to it, and the thread that the fake controller starts, with a
 * short transcript.
 */
import {
  formatPromptContext,
  type ProjectMatch,
  type Resource,
  type SettingsState,
  type Workspace,
} from "@hercule/contract";
import { buildCheckout, buildRepo, buildWorkspace } from "@hercule/client-core/threads/testing";
import { DRAFT_PAGE_RECORDS } from "./draft-fixture";
import type { SidebarRecords, ThreadScreenRecords } from "./shell-page";
import { buildSpecimenSession, CLAUDE_OPUS, SPECIMEN_NOW, STUDIO_MAC } from "./sidebar-fixture";
import { runItem, runTool, type TranscriptStep } from "./thread-fixture";

/** What the fake controller answers and starts for the start-thread dialog. */
export interface ThreadStartRecords {
  /** Answers `externalEntity.matchProject` for the things with these ids. */
  readonly matchProject: (ids: readonly string[]) => ProjectMatch;
  /** The user's thread settings: Opus 5.5 with edits accepted, and a worktree of the repository for each thread. */
  readonly settings: SettingsState["user"];
  /** The thread `session.spawn` starts, with what the thread screen reads of it. */
  readonly started: ThreadScreenRecords;
}

/**
 * The ids the specimens give a Project, a repository, a machine and the two accounts, and the UUIDv7s the
 * contract's schemas accept for them. The shell's lists are seeded and never decoded, so the other
 * specimens keep short ids. The match and the new thread come over the fake controller's wire and are
 * decoded, so everything they point at must be a UUIDv7.
 */
const WIRE_IDS: Readonly<Record<string, string>> = {
  "p-webshop": "01a0ec64-6e80-7000-8000-0000000000b1",
  "r-storefront-web": "01a0ec64-6e80-7000-8000-0000000000b2",
  "r-studio-mac": "01a0ec64-6e80-7000-8000-0000000000b3",
  "a-claude": "01a0ec64-6e80-7000-8000-0000000000b4",
  "a-codex": "01a0ec64-6e80-7000-8000-0000000000b5",
  "w-storefront-main": "01a0ec64-6e80-7000-8000-0000000000b6",
  "p-unrestricted": "01a0ec64-6e80-7000-8000-0000000000b7",
};

/** Returns `records` with every id of `WIRE_IDS` replaced by its UUIDv7, wherever it appears as a whole string. */
const replaceWithWireIds = <T>(records: T): T =>
  JSON.parse(
    Object.entries(WIRE_IDS).reduce(
      (json, [short, wire]) => json.replaceAll(`"${short}"`, `"${wire}"`),
      JSON.stringify(records),
    ),
  ) as T;

/** The webshop Project's repository, which the specimen's pull requests and issues belong to. */
const STOREFRONT_REPO: Resource = buildRepo(
  "r-storefront-web",
  "git@github.com:acme/storefront-web.git",
  "github.com/acme/storefront-web",
  ["p-webshop"],
);

/** The repository's main workspace on studio-mac, on main, the branch a new workspace starts from. */
const STOREFRONT_MAIN_WORKSPACE: Workspace = buildWorkspace({
  id: "w-storefront-main",
  runnerId: STUDIO_MAC.id,
  checkouts: [buildCheckout(STOREFRONT_REPO.id, "main")],
});

/** The shell's lists for the dialog: the draft specimen's accounts and Model Profile, with the Project's repository. */
export const withThreadStartRecords = (records: SidebarRecords): SidebarRecords =>
  replaceWithWireIds({
    ...records,
    accounts: DRAFT_PAGE_RECORDS.accounts,
    modelProfiles: DRAFT_PAGE_RECORDS.modelProfiles ?? [],
    plugins: [...(records.plugins ?? []), ...(DRAFT_PAGE_RECORDS.plugins ?? [])],
    resources: [STOREFRONT_REPO],
    workspaces: [STOREFRONT_MAIN_WORKSPACE],
  });

const SESSION_ID = "01a0ec64-6e80-7000-8000-0000000000a1";
const TURN_ID = "turn-1";
/** The moment the started thread's turn began, which is the specimen's clock. */
const TURN_START = SPECIMEN_NOW;

/** What the user wrote in the dialog, before the context block the controller appends. */
const USER_WORDS =
  "Look into these 4 and tell me what is going on before you change anything. Say what you think the cause is, how sure you are, and what you would do next.";

/** A thing the started thread's message carries as context, with what the block writes of it. */
export interface ContextThingSource {
  readonly id: string;
  readonly ref: string;
  readonly title: string;
  readonly status?: string;
  /** The place the thing lives in, such as its repository. Written as the block's `Project` field. */
  readonly place?: string;
}

/** Returns the steps of the started thread, whose first message is `USER_WORDS` and the context block of `things`. */
const buildSteps = (things: ReadonlyArray<ContextThingSource>): ReadonlyArray<TranscriptStep> => [
  [0, { _tag: "turn.started", turnId: TURN_ID, model: CLAUDE_OPUS.slug }],
  ...runItem([0, 0], "it-ask", "user_message", {
    text: `${USER_WORDS}\n\n${formatPromptContext({
      origin: { kind: "selection" },
      things: things.map((thing) => ({
        entityId: thing.id,
        ref: thing.ref,
        title: thing.title,
        ...(thing.status === undefined ? {} : { status: thing.status }),
        fields:
          thing.place === undefined
            ? []
            : [{ key: "project", type: "text", label: "project", value: thing.place }],
      })),
    })}`,
  }),
  ...runTool([2, 3], "it-read-1", "command_execution", "Bash", {
    command: "hercule entity read ent_shop142",
  }),
  ...runTool([3, 4], "it-read-2", "command_execution", "Bash", {
    command: "hercule entity read ent_pr6244",
  }),
  ...runTool([4, 5], "it-read-3", "command_execution", "Bash", {
    command: "hercule entity read ent_sn1z9",
  }),
  ...runItem(
    [6, 9],
    "it-first",
    "assistant_message",
    undefined,
    "I read all 4: three pull requests and an error. I’ll start with STOREFRONT-1Z9, which has reached 312 people, and read it against the change in #6244 next.",
  ),
];

const buildStarted = (things: ReadonlyArray<ContextThingSource>): ThreadScreenRecords => {
  const steps = buildSteps(things);
  return replaceWithWireIds({
    session: buildSpecimenSession({
      id: SESSION_ID,
      title: "Show the delivery cost before the payment step",
      projectId: "p-webshop",
      status: "busy",
      minutesAgo: 0,
      model: CLAUDE_OPUS,
      modelSelection: { model: CLAUDE_OPUS.slug, options: { effort: "medium" } },
      requestedAccessMode: "auto-accept-edits",
      accessMode: "auto-accept-edits",
    }),
    transcript: steps.map(([seconds, body], index) => {
      const at = new Date(TURN_START + seconds * 1000).toISOString();
      return {
        position: index + 1,
        at,
        event: { ...body, eventId: `event-${String(index + 1)}`, sessionId: SESSION_ID, at },
      };
    }),
    queuedInputs: [],
  });
};

/**
 * Returns the thread-start records for the specimen. The fake controller
 * matches every set of things that holds a pull request to webshop, by that
 * pull request, and every other set to nothing. The started thread's first
 * message carries `contextThings` as its context block.
 */
export const buildThreadStartRecords = (
  pullRequests: ReadonlyArray<{ readonly id: string; readonly identifier: string }>,
  contextThings: ReadonlyArray<ContextThingSource>,
): ThreadStartRecords => ({
  matchProject: (ids) => {
    const thing = pullRequests.find((each) => ids.includes(each.id));
    return thing === undefined
      ? { kind: "none" }
      : {
          kind: "matched",
          projectId: WIRE_IDS["p-webshop"]!,
          resourceId: WIRE_IDS["r-storefront-web"]!,
          thing,
        };
  },
  settings: {
    "thread.providerAccountId": WIRE_IDS["a-claude"]!,
    "thread.harnessId": null,
    "thread.model": CLAUDE_OPUS.slug,
    "thread.accessMode": "auto-accept-edits",
    "thread.workspace": "ephemeral",
  },
  started: buildStarted(contextThings),
});
