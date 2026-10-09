/**
 * The records the Settings > Assistants specimen (settings-assistants.tsx)
 * seeds its query cache with, as the controller would return them: the
 * three assistants the Bureau book's desktop/settings-assistants.html
 * draws, with Ada picked and set up as the book shows it.
 *
 * - Ada is working, Milo is idle and Juno is asleep, as the book's tabs pose
 *   them.
 * - Ada runs Claude Code on Sonnet 5 with full access and may never use the
 *   edit tool. Ada replies at the end of each turn.
 * - Ada's heartbeat runs every hour from 07:00 to 23:00 in Web chat, read in
 *   UTC, the capture's time zone, so the fixed clock's 09:41 puts the "now"
 *   line where the book draws it.
 * - Ada's context rotates at 70% or 200k tokens, and daily at 04:00.
 * - One Connection has failed, so the Settings list's Connections row
 *   carries the red dot the book draws there.
 *
 * The reference module (settings-assistants-reference.ts) reads this module
 * too, to edit the book's page where the app draws the fixture's words.
 */
import {
  GITHUB_CONNECTION_TYPE,
  type Assistant,
  type Connection,
  type Profile,
  type ProviderInstance,
} from "@hercule/contract";
import { CLAUDE_SONNET, SPECIMEN_INSTANCES, SPECIMEN_RECORDS } from "./sidebar-fixture";
import type { AssistantsSettingsRecords, SidebarRecords } from "./shell-page";
import { ADA, buildAssistantSession, JUNO, MILO } from "./assistant-states-fixture";

/** The moment the permission profile was created, as the API spells a time. */
const CREATED_AT = "2026-09-10T09:00:00.000Z";

/** Ada, as the book's page sets Ada up. */
export const SETTINGS_ADA: Assistant = {
  ...ADA,
  systemPrompt:
    "You are Ada, Rogier's personal assistant. Be brief. Never deploy on Fridays, and ask before you spend money.",
  model: { model: CLAUDE_SONNET.slug, options: {} },
  accessMode: "full-access",
  disallowedTools: ["edit"],
  heartbeat: {
    enabled: true,
    schedule: "0 7-23 * * *",
    timezone: "UTC",
    prompt:
      "Look at what changed since the last heartbeat. Write only when something needs Rogier.",
    target: "web",
  },
  rotation: { contextFraction: 0.7, maxContextTokens: 200000, dailyAt: "04:00" },
  reply: "turn-end",
};

/** The account the book's Provider row names, which the Claude Code instance is logged in as. */
export const PROVIDER_ACCOUNT = "rogier@personal";

/**
 * The sidebar specimen's provider instances, with the Claude Code instance
 * logged in as `PROVIDER_ACCOUNT`, so the Provider row's hint is the book's.
 */
const INSTANCES: ReadonlyArray<ProviderInstance> = SPECIMEN_INSTANCES.map((instance) =>
  instance.id === CLAUDE_SONNET.instanceId
    ? {
        ...instance,
        snapshots: instance.snapshots.map((snapshot) => ({
          ...snapshot,
          auth: { ...snapshot.auth, identity: PROVIDER_ACCOUNT },
        })),
      }
    : instance,
);

/** The records the specimen draws: the sidebar specimen's threads, and the three assistants. */
export const SETTINGS_ASSISTANTS_RECORDS: SidebarRecords = {
  ...SPECIMEN_RECORDS,
  instances: INSTANCES,
  assistants: [
    {
      assistant: SETTINGS_ADA,
      currentSession: buildAssistantSession(SETTINGS_ADA, { status: "busy", minutesAgo: 3 }),
    },
    {
      assistant: MILO,
      currentSession: buildAssistantSession(MILO, { status: "idle", minutesAgo: 25 }),
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
  ],
};

/** The permission profile every assistant uses: the shipped "assistant" profile. */
export const ASSISTANT_PROFILE: Profile = {
  id: ADA.permissionProfileId,
  name: "assistant",
  grants: ["task.read", "event.emit", "connection.read"],
  shipped: true,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

/** A GitHub Connection whose last check failed. */
const FAILED_CONNECTION: Connection = {
  id: "c-github",
  type: GITHUB_CONNECTION_TYPE,
  label: "rogier",
  displayName: "rogier",
  status: "error",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [],
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

/** What the section reads besides the sidebar's lists. */
export const SETTINGS_ASSISTANTS_SCREEN: AssistantsSettingsRecords = {
  profiles: [ASSISTANT_PROFILE],
  connections: [FAILED_CONNECTION],
};

/** The address of the section with Ada picked, which the specimen opens. */
export const SETTINGS_ASSISTANTS_PATH = `/settings/assistants?assistant=${SETTINGS_ADA.id}`;
