/**
 * The records of the assistant states specimen (assistant-states.tsx): the
 * scenes that draw the Assistants section and an assistant's page, for a
 * check by eye. `node scripts/capture-assistant.ts` captures each scene in
 * all five themes.
 *
 * The assistants are those of the prototype the design was drawn from, with
 * its ids, so `buildLook` gives each one the hue the Bureau book casts it in:
 * Ada iris, Milo teal, Juno orchid and Hercule sky. Two more show what the
 * prototype never drew: Wren, away because her machine is offline, and an
 * assistant whose name is too long for the sidebar.
 *
 * The sidebar scenes:
 * - `sidebar-poses`: every assistant, so each pose shows once. Ada waits on
 *   the user, so Waiting on you holds her beside a waiting thread, newest
 *   first;
 * - `sidebar-no-threads`: the same assistants and no thread, so the section
 *   stays pinned above the foot under an empty list;
 * - `sidebar-selected`: Juno's page is open, so her row is selected;
 * - `sidebar-selected-waiting`: Ada's page is open, so both her row in
 *   Waiting on you and her row in the section are selected;
 * - `sidebar-many-assistants`: fourteen assistants, more than the section's
 *   40% of the sidebar holds, so its rows scroll under its heading.
 *
 * The page scenes, each with the whole window captured, draw the
 * assistant's Conversation:
 * - `page-idle`: Hercule, who has no session and no message yet, so the
 *   Conversation shows the greeting;
 * - `page-waiting`: Ada, whose session waits on the user to approve a
 *   command: yesterday's and today's messages under their day stamps, the
 *   open reply with the caret alone, and the dock above the composer;
 * - `page-working`: Milo, whose session works: a notice from yesterday, and
 *   the open reply with the text Milo is writing;
 * - `page-replied`: Juno, idle, with no running turn: her stored reply, then
 *   the message the user has just sent, which no turn has picked up yet;
 * - `page-requests`: Ada, whose session waits on two Requests at once, so
 *   the dock pages between them;
 * - `page-long-name`: the assistant whose name is too long for the sidebar;
 * - `page-not-found`: an address whose assistant does not exist.
 */
import type {
  Assistant,
  ConversationMessage,
  OpenRequest,
  Runner,
  Session,
  TranscriptRow,
} from "@hercule/contract";
import { buildProject, buildRunner } from "@hercule/client-core/threads/testing";
import {
  buildSpecimenSession,
  CLAUDE_SONNET,
  GPT,
  SPECIMEN_INSTANCES,
  STUDIO_MAC,
} from "./sidebar-fixture";
import type { EventBody } from "../app/testing";
import type { SidebarRecords, SpecimenAssistant } from "./shell-page";

/** A runner that has gone offline. An assistant whose session runs on it is away. */
const BUILD_BOX: Runner = { ...buildRunner("r-build-box", "build-box"), connectivity: "offline" };

/** The moment every assistant was created, as the API spells a time. */
const CREATED_AT = "2026-09-10T09:00:00.000Z";

/**
 * Returns an assistant named `name` whose id ends in `suffix`. Its main
 * conversation's id ends in the same suffix.
 */
export const buildAssistant = (suffix: string, name: string): Assistant => ({
  id: `01a0ec64-6e80-7000-8000-a000000000${suffix}`,
  name,
  systemPrompt: `You are ${name}.`,
  instanceId: CLAUDE_SONNET.instanceId,
  permissionProfileId: "01a0ec64-6e80-7000-8000-b00000000001",
  accessMode: "auto-accept-edits",
  model: null,
  disallowedTools: [],
  unenforced: [],
  heartbeat: { enabled: false, schedule: "0 7-23 * * *", prompt: "Check in.", target: "web" },
  rotation: { contextFraction: 0.7, maxContextTokens: 200000, dailyAt: "04:00" },
  reply: "turn-end",
  mainConversationId: `01a0ec64-6e80-7000-8000-c000000000${suffix}`,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
});

export const ADA = buildAssistant("10", "Ada");
export const MILO = buildAssistant("3b", "Milo");
export const JUNO = buildAssistant("1e", "Juno");
const HERCULE = buildAssistant("4c", "Hercule");
const WREN = buildAssistant("27", "Wren");
// Nearly 128 characters, the longest name an assistant may have.
const LONG_NAMED = buildAssistant(
  "61",
  "Bartholomew, keeper of the release calendar, the on-call rota, the quarterly roadmap and every runbook in the ops team's wiki",
);

/** Returns a session of `assistant`'s main conversation, last active `minutesAgo` minutes ago. */
export const buildAssistantSession = (
  assistant: Assistant,
  over: Partial<Session> & { readonly minutesAgo: number },
): Session =>
  buildSpecimenSession({
    id: `s-${assistant.id}`,
    title: assistant.name,
    agentId: assistant.id,
    conversationId: assistant.mainConversationId,
    model: CLAUDE_SONNET,
    ...over,
  });

/** The approval Ada asks for, the Request the prototype draws. */
const ADA_REQUEST: OpenRequest = {
  requestId: "rq-ada-backup-log",
  itemId: "it-ada-backup-log",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "tail -n 200 /var/log/pg-backup.log" },
};

/** A question Ada asks while her approval is open, so that the dock holds two Requests. */
const ADA_QUESTION: OpenRequest = {
  requestId: "rq-ada-backup-window",
  itemId: "it-ada-backup-window",
  kind: "question",
  detail: {
    questions: [
      {
        question: "Move the backup window to start at 01:00?",
        header: "Window",
        options: [
          { label: "Move it", description: "Start the backup job at 01:00 from tonight." },
          { label: "Keep 02:00", description: "Leave the window as it is." },
        ],
        multiSelect: false,
      },
    ],
  },
};

/** A message of a conversation, without the fields `buildConversationMessages` fills in. */
export interface MessageStep {
  readonly senderRole: ConversationMessage["senderRole"];
  /** When the message was stored, as the API spells a time. */
  readonly createdAt: string;
  readonly text: string;
}

/**
 * Returns the messages of `assistant`'s main conversation built from `steps`,
 * oldest first, with positions from 1. A reply and a notice come from the
 * assistant's current session, and a reply holds the one text `itemId` of
 * its turn `turnId`.
 */
export const buildConversationMessages = (
  assistant: Assistant,
  steps: ReadonlyArray<MessageStep>,
): ConversationMessage[] =>
  steps.map(({ senderRole, createdAt, text }, index) => {
    const position = index + 1;
    const owner = senderRole === "owner";
    return {
      id: `01a0ec64-6e80-7000-8000-d${assistant.id.slice(-2)}000000${String(position).padStart(3, "0")}`,
      conversationId: assistant.mainConversationId,
      containerKey: null,
      position,
      senderRole,
      senderLabel: owner ? "rogier" : assistant.name,
      text,
      sessionId: owner ? null : `s-${assistant.id}`,
      turnId: senderRole === "assistant" ? `turn-${String(position)}` : null,
      itemId: senderRole === "assistant" ? `item-${String(position)}` : null,
      actor: owner ? "user" : `session:s-${assistant.id}`,
      createdAt,
    };
  });

/**
 * Returns the rows of the running turn of `assistant`'s current session, all
 * at `at`, with positions from 1.
 */
export const buildRunningTurnRows = (
  assistant: Assistant,
  at: string,
  events: ReadonlyArray<EventBody>,
): TranscriptRow[] =>
  events.map((body, index) => ({
    position: index + 1,
    at,
    event: {
      ...body,
      eventId: `event-${assistant.name}-${String(index + 1)}`,
      sessionId: `s-${assistant.id}`,
      at,
    },
  }));

/**
 * Ada's messages this morning, as the Bureau book's desktop/assistant.html
 * draws them: her heartbeat at 09:00, a reminder at 09:20, and at 09:38 the
 * question her running turn answers. "3‑D" holds the book's non-breaking
 * hyphen. The Conversation specimen draws them too (conversation-fixture.ts).
 */
export const ADA_MORNING_STEPS: ReadonlyArray<MessageStep> = [
  {
    senderRole: "assistant",
    createdAt: "2026-09-29T09:00:00.000Z",
    text:
      "Morning Rogier. Triage found one urgent thing: EU card payments that need 3‑D Secure " +
      "have failed since yesterday's deploy. You started a fix at 09:02; it's waiting on your " +
      "OK to push. Also: Marta at Brightline wants her invoice in the company name - I can " +
      "draft that.",
  },
  {
    senderRole: "owner",
    createdAt: "2026-09-29T09:20:00.000Z",
    text: "Remind me Friday to renew the SSL cert for ops.",
  },
  {
    senderRole: "assistant",
    createdAt: "2026-09-29T09:20:00.000Z",
    text: "Done. Reminder set for Friday 2 October, 09:00: renew the SSL cert for ops.",
  },
  {
    senderRole: "owner",
    createdAt: "2026-09-29T09:38:00.000Z",
    text: "What's the status of the backup job?",
  },
];

/**
 * Ada's conversation: an evening question yesterday, then this morning's
 * heartbeat, a reminder, and the question her running turn answers.
 */
const ADA_MESSAGES = buildConversationMessages(ADA, [
  {
    senderRole: "owner",
    createdAt: "2026-09-28T16:12:00.000Z",
    text: "Anything urgent before I log off?",
  },
  {
    senderRole: "assistant",
    createdAt: "2026-09-28T16:13:00.000Z",
    text: "Nothing urgent. The staging deploy is green and no Task is waiting on you.",
  },
  ...ADA_MORNING_STEPS,
]);

/** Milo's conversation: a turn that failed yesterday, and today's question. */
const MILO_MESSAGES = buildConversationMessages(MILO, [
  {
    senderRole: "owner",
    createdAt: "2026-09-28T18:40:00.000Z",
    text: "Check why last night's backup ran so long.",
  },
  {
    senderRole: "notice",
    createdAt: "2026-09-28T18:41:00.000Z",
    text: "Milo could not answer: the runner build-box went offline during the turn.",
  },
  {
    senderRole: "owner",
    createdAt: "2026-09-29T09:35:00.000Z",
    text: "build-box is back. Try the backup job again?",
  },
]);

/** The text Milo is writing, not finished yet. */
const MILO_OPEN_TEXT =
  "So far: the backup job's `pg_dump` has been slower each night since the table `events` " +
  "passed 40 GB, and last night it ran past the end of its window, finishing at 05:12.\n\n" +
  "Two ways out, both small:";

/** Every assistant, each in its own pose. */
const ASSISTANTS: ReadonlyArray<SpecimenAssistant> = [
  {
    assistant: ADA,
    currentSession: buildAssistantSession(ADA, {
      status: "busy",
      minutesAgo: 2,
      openRequests: [ADA_REQUEST],
    }),
    messages: ADA_MESSAGES,
    runningTurn: buildRunningTurnRows(ADA, "2026-09-29T09:38:00.000Z", [
      { _tag: "turn.started", turnId: "turn-ada-backup", model: CLAUDE_SONNET.slug },
      { _tag: "request.opened", request: ADA_REQUEST },
    ]),
  },
  {
    assistant: MILO,
    currentSession: buildAssistantSession(MILO, { status: "busy", minutesAgo: 1 }),
    messages: MILO_MESSAGES,
    runningTurn: buildRunningTurnRows(MILO, "2026-09-29T09:36:00.000Z", [
      { _tag: "turn.started", turnId: "turn-milo-backup", model: CLAUDE_SONNET.slug },
      {
        _tag: "item.started",
        turnId: "turn-milo-backup",
        itemId: "it-milo-answer",
        kind: "assistant_message",
      },
      {
        _tag: "content.delta",
        turnId: "turn-milo-backup",
        itemId: "it-milo-answer",
        streamKind: "assistant_text",
        delta: MILO_OPEN_TEXT,
      },
    ]),
  },
  {
    assistant: JUNO,
    currentSession: buildAssistantSession(JUNO, {
      status: "exited",
      resumable: true,
      exitedAt: new Date(Date.UTC(2026, 8, 29, 6, 10)).toISOString(),
      minutesAgo: 211,
    }),
  },
  // Hercule has never been sent a message, so it has no session yet.
  { assistant: HERCULE, currentSession: null },
  {
    assistant: WREN,
    currentSession: buildAssistantSession(WREN, {
      status: "idle",
      runnerId: BUILD_BOX.id,
      minutesAgo: 40,
    }),
  },
  {
    assistant: LONG_NAMED,
    currentSession: buildAssistantSession(LONG_NAMED, { status: "idle", minutesAgo: 90 }),
  },
];

/** Juno's conversation: her stored reply, then the message the user has just sent. */
const JUNO_MESSAGES = buildConversationMessages(JUNO, [
  {
    senderRole: "owner",
    createdAt: "2026-09-29T09:30:00.000Z",
    text: "Did Marta's invoice go out?",
  },
  {
    senderRole: "assistant",
    createdAt: "2026-09-29T09:31:00.000Z",
    text: "Yes. It went out at 09:28 in Brightline's company name, and Marta confirmed it.",
  },
  {
    senderRole: "owner",
    createdAt: "2026-09-29T09:41:00.000Z",
    text: "Thanks. Put the next one in the same name.",
  },
]);

/** Every assistant, with Juno idle after her reply and the user's newest message. */
const REPLIED_ASSISTANTS: ReadonlyArray<SpecimenAssistant> = ASSISTANTS.map((entry) =>
  entry.assistant === JUNO
    ? {
        assistant: JUNO,
        currentSession: buildAssistantSession(JUNO, { status: "idle", minutesAgo: 0 }),
        messages: JUNO_MESSAGES,
      }
    : entry,
);

/** Every assistant, with Ada waiting on two Requests. */
const TWO_REQUESTS_ASSISTANTS: ReadonlyArray<SpecimenAssistant> = ASSISTANTS.map((entry) =>
  entry.assistant === ADA
    ? {
        assistant: ADA,
        currentSession: buildAssistantSession(ADA, {
          status: "busy",
          minutesAgo: 2,
          openRequests: [ADA_REQUEST, ADA_QUESTION],
        }),
        messages: ADA_MESSAGES,
        runningTurn: buildRunningTurnRows(ADA, "2026-09-29T09:38:00.000Z", [
          { _tag: "turn.started", turnId: "turn-ada-backup", model: CLAUDE_SONNET.slug },
          { _tag: "request.opened", request: ADA_REQUEST },
          { _tag: "request.opened", request: ADA_QUESTION },
        ]),
      }
    : entry,
);

/** Eight more assistants, idle but for one at work, for the scene with fourteen. */
const MORE_ASSISTANTS: ReadonlyArray<SpecimenAssistant> = [
  "Iris",
  "Otto",
  "Pippa",
  "Quinn",
  "Rosa",
  "Silas",
  "Tess",
  "Vera",
].map((name, index) => {
  const assistant = buildAssistant(String(70 + index), name);
  return {
    assistant,
    currentSession: buildAssistantSession(assistant, {
      status: index === 0 ? "busy" : "idle",
      minutesAgo: 30 + index * 15,
    }),
  };
});

/**
 * The threads: a waiting one, which Waiting on you lists after Ada because
 * it waits longer, and three more in ops.
 */
const THREADS: ReadonlyArray<Session> = [
  buildSpecimenSession({
    id: "s-grafana-migration",
    title: "Migrate ops dashboards to Grafana 11",
    projectId: "p-ops",
    status: "busy",
    minutesAgo: 6,
    model: CLAUDE_SONNET,
    openRequests: [
      {
        requestId: "rq-grafana-folder",
        itemId: "it-grafana-folder",
        kind: "question",
        detail: {
          questions: [
            {
              question: "Keep the old Grafana folder?",
              header: "Folder",
              options: [
                { label: "Keep it", description: "Leave the old dashboards where they are." },
                { label: "Delete it", description: "Remove the old dashboards." },
              ],
              multiSelect: false,
            },
          ],
        },
      },
    ],
  }),
  buildSpecimenSession({
    id: "s-rotate-secrets",
    title: "Rotate staging secrets",
    projectId: "p-ops",
    status: "busy",
    minutesAgo: 9,
    model: GPT,
  }),
  buildSpecimenSession({
    id: "s-metrics-rebuild",
    title: "Rebuild the metrics dashboard",
    projectId: "p-ops",
    status: "idle",
    minutesAgo: 25,
    model: CLAUDE_SONNET,
  }),
];

/** Returns every list the sidebar reads, holding `threads` and `assistants`. */
const buildSceneRecords = (
  threads: ReadonlyArray<Session>,
  assistants: ReadonlyArray<SpecimenAssistant> = ASSISTANTS,
): SidebarRecords => ({
  threads,
  assistants,
  projects: [buildProject("p-ops", "ops")],
  workspaces: [],
  resources: [],
  runners: [STUDIO_MAC, BUILD_BOX],
  instances: SPECIMEN_INSTANCES,
  user: { username: "Rogier" },
});

/** The part of the window a scene's capture holds. */
export type AssistantSceneRegion = "sidebar" | "window";

/** One scene of the assistant states specimen. */
export interface AssistantScene {
  /** The scene's name, which its capture's file name ends in. */
  readonly name: string;
  readonly records: SidebarRecords;
  /** The app's address: `/` opens a Draft Thread, `/assistants/<id>` an assistant's page. */
  readonly path: string;
  readonly region: AssistantSceneRegion;
}

const WITH_THREADS = buildSceneRecords(THREADS);
const NO_THREADS = buildSceneRecords([]);
const MANY_ASSISTANTS = buildSceneRecords(THREADS, [...ASSISTANTS, ...MORE_ASSISTANTS]);
const REPLIED = buildSceneRecords(THREADS, REPLIED_ASSISTANTS);
const TWO_REQUESTS = buildSceneRecords(THREADS, TWO_REQUESTS_ASSISTANTS);

/** The scenes, in order: `?scene=1` is the first. */
export const ASSISTANT_SCENES: ReadonlyArray<AssistantScene> = [
  { name: "sidebar-poses", records: WITH_THREADS, path: "/", region: "sidebar" },
  { name: "sidebar-no-threads", records: NO_THREADS, path: "/", region: "sidebar" },
  {
    name: "sidebar-selected",
    records: WITH_THREADS,
    path: `/assistants/${JUNO.id}`,
    region: "sidebar",
  },
  {
    name: "sidebar-selected-waiting",
    records: WITH_THREADS,
    path: `/assistants/${ADA.id}`,
    region: "sidebar",
  },
  { name: "sidebar-many-assistants", records: MANY_ASSISTANTS, path: "/", region: "sidebar" },
  {
    name: "page-idle",
    records: WITH_THREADS,
    path: `/assistants/${HERCULE.id}`,
    region: "window",
  },
  { name: "page-waiting", records: WITH_THREADS, path: `/assistants/${ADA.id}`, region: "window" },
  { name: "page-working", records: WITH_THREADS, path: `/assistants/${MILO.id}`, region: "window" },
  { name: "page-replied", records: REPLIED, path: `/assistants/${JUNO.id}`, region: "window" },
  {
    name: "page-requests",
    records: TWO_REQUESTS,
    path: `/assistants/${ADA.id}`,
    region: "window",
  },
  {
    name: "page-long-name",
    records: WITH_THREADS,
    path: `/assistants/${LONG_NAMED.id}`,
    region: "window",
  },
  {
    name: "page-not-found",
    records: WITH_THREADS,
    path: "/assistants/01a0ec64-6e80-7000-8000-a000000000ff",
    region: "window",
  },
];
