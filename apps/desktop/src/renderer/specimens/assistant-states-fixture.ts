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
 * The page scenes, each with the whole window captured:
 * - `page-idle`: Hercule, who has no session yet;
 * - `page-waiting`: Ada, whose session waits on the user;
 * - `page-working`: Milo, whose session works;
 * - `page-long-name`: the assistant whose name is too long for the sidebar;
 * - `page-not-found`: an address whose assistant does not exist.
 */
import type { Assistant, OpenRequest, Runner, Session } from "@hercule/contract";
import { buildProject, buildRunner } from "@hercule/client-core/threads/testing";
import {
  buildSpecimenSession,
  CLAUDE_SONNET,
  GPT,
  SPECIMEN_INSTANCES,
  STUDIO_MAC,
} from "./sidebar-fixture";
import type { SidebarRecords, SpecimenAssistant } from "./shell-page";

/** A runner that has gone offline. An assistant whose session runs on it is away. */
const BUILD_BOX: Runner = { ...buildRunner("r-build-box", "build-box"), connectivity: "offline" };

/** The moment every assistant was created, as the API spells a time. */
const CREATED_AT = "2026-09-10T09:00:00.000Z";

/**
 * Returns an assistant named `name` whose id ends in `suffix`. Its main
 * conversation's id ends in the same suffix.
 */
const buildAssistant = (suffix: string, name: string): Assistant => ({
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

const ADA = buildAssistant("10", "Ada");
const MILO = buildAssistant("3b", "Milo");
const JUNO = buildAssistant("1e", "Juno");
const HERCULE = buildAssistant("4c", "Hercule");
const WREN = buildAssistant("27", "Wren");
// Nearly 128 characters, the longest name an assistant may have.
const LONG_NAMED = buildAssistant(
  "61",
  "Bartholomew, keeper of the release calendar, the on-call rota, the quarterly roadmap and every runbook in the ops team's wiki",
);

/** Returns a session of `assistant`'s main conversation, last active `minutesAgo` minutes ago. */
const buildAssistantSession = (
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

/** Every assistant, each in its own pose. */
const ASSISTANTS: ReadonlyArray<SpecimenAssistant> = [
  {
    assistant: ADA,
    currentSession: buildAssistantSession(ADA, {
      status: "busy",
      minutesAgo: 2,
      openRequests: [ADA_REQUEST],
    }),
  },
  {
    assistant: MILO,
    currentSession: buildAssistantSession(MILO, { status: "busy", minutesAgo: 1 }),
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
