/**
 * The records the Settings > Permission profiles specimen
 * (settings-profiles.tsx) seeds its query cache with, as the controller
 * would return them: the five profiles the Bureau book's
 * desktop/settings-profiles.html draws, and the agents and assistants that
 * use them.
 *
 * - The three shipped profiles hold the grants the controller seeds
 *   (`SHIPPED_PROFILES` in apps/controller/src/seed.ts, which the desktop app
 *   may not import): `assistant` 28, `worker` 9 and `unrestricted` all 44.
 * - Releaser, made by the user, holds 11 grants. The book gives only the
 *   count and never opens its page, so the grants are the ones a release
 *   needs.
 * - Reviewer, made by the user, holds the 16 grants the book presses on its
 *   page.
 * - Ada and Juno use `assistant`, triage-step and fix-step use `worker`, and
 *   Milo and pr-review use Reviewer. Nothing uses `unrestricted` or Releaser.
 *
 * The reference module (settings-profiles-reference.ts) reads this module
 * too, to edit the book's page where the app orders or poses something
 * differently from the book.
 */
import { ALL_GRANTS, type Agent, type Grant, type Profile } from "@hercule/contract";
import { CLAUDE_SONNET } from "./sidebar-fixture";
import type { PermissionProfilesSettingsRecords, SidebarRecords } from "./shell-page";
import {
  ASSISTANT_PROFILE,
  SETTINGS_ASSISTANTS_RECORDS,
  SETTINGS_ASSISTANTS_SCREEN,
} from "./settings-assistants-fixture";
import { MILO } from "./assistant-states-fixture";

/** The moment every profile and agent was created, as the API spells a time. */
const CREATED_AT = "2026-09-10T09:00:00.000Z";

/** The grants of the shipped `assistant` profile, as the controller seeds them: 28. */
const ASSISTANT_GRANTS: ReadonlyArray<Grant> = [
  "task.read",
  "task.create",
  "task.update",
  "task.delete",
  "workflow.read",
  "run.read",
  "run.start",
  "run.write",
  "session.read",
  "session.spawn",
  "session.steer",
  "subscription.read",
  "subscription.write",
  "notification.read",
  "notification.write",
  "settings.read",
  "event.read",
  "event.emit",
  "connection.read",
  "connection.use",
  "infra.read",
  "workspace.read",
  "agent.read",
  "memory.read",
  "memory.write",
  "permission.read",
  "project.read",
  "resource.read",
];

/** The grants of the shipped `worker` profile, as the controller seeds them: 9. */
const WORKER_GRANTS: ReadonlyArray<Grant> = [
  "task.read",
  "task.create",
  "task.update",
  "run.read",
  "subscription.read",
  "subscription.write",
  "notification.read",
  "notification.write",
  "event.read",
];

/** The grants of Releaser: 11. */
const RELEASER_GRANTS: ReadonlyArray<Grant> = [
  "task.read",
  "workflow.read",
  "run.read",
  "run.start",
  "run.write",
  "session.read",
  "event.read",
  "connection.read",
  "connection.use",
  "project.read",
  "resource.read",
];

/** The grants of Reviewer: the 16 the book presses on its page. */
const REVIEWER_GRANTS: ReadonlyArray<Grant> = [
  "task.read",
  "task.create",
  "task.update",
  "workflow.read",
  "run.read",
  "session.read",
  "subscription.read",
  "subscription.write",
  "notification.read",
  "notification.write",
  "event.read",
  "connection.read",
  "connection.use",
  "workspace.read",
  "project.read",
  "resource.read",
];

/** Returns a profile named `name` that holds `grants`, with an id ending in `suffix`. */
const buildProfile = (
  suffix: string,
  name: string,
  grants: ReadonlyArray<Grant>,
  shipped: boolean,
): Profile => ({
  id: `01a0ec64-6e80-7000-8000-b000000000${suffix}`,
  name,
  grants,
  shipped,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
});

/** The shipped `assistant` profile, which Ada and Juno use. It keeps the id every assistant fixture carries. */
const SHIPPED_ASSISTANT_PROFILE: Profile = { ...ASSISTANT_PROFILE, grants: ASSISTANT_GRANTS };
/** The shipped `unrestricted` profile, which nothing uses. */
export const UNRESTRICTED_PROFILE = buildProfile("02", "unrestricted", ALL_GRANTS, true);
const WORKER_PROFILE = buildProfile("03", "worker", WORKER_GRANTS, true);
const RELEASER_PROFILE = buildProfile("04", "Releaser", RELEASER_GRANTS, false);
/** The profile of Milo and pr-review. */
export const REVIEWER_PROFILE = buildProfile("05", "Reviewer", REVIEWER_GRANTS, false);

/** Returns an agent named `name` on `profile`, with the id `id`. */
const buildAgent = (id: string, name: string, profile: Profile): Agent => ({
  id,
  name,
  systemPrompt: `You are ${name}.`,
  instanceId: CLAUDE_SONNET.instanceId,
  permissionProfileId: profile.id,
  accessMode: "full-access",
  model: null,
  disallowedTools: [],
  unenforced: [],
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
});

/** The plain agents, in the order the controller lists them. */
const AGENTS: ReadonlyArray<Agent> = [
  buildAgent("01a0ec64-6e80-7000-8000-000000000a01", "triage-step", WORKER_PROFILE),
  buildAgent("01a0ec64-6e80-7000-8000-000000000a02", "fix-step", WORKER_PROFILE),
  buildAgent("01a0ec64-6e80-7000-8000-000000000a03", "pr-review", REVIEWER_PROFILE),
];

/**
 * The records the specimen draws around the screen: the Assistants
 * specimen's, with Milo on Reviewer, as the book has him. The book's sidebar
 * is not compared, so, as in the Appearance specimen, it holds just the first
 * four threads.
 */
export const PERMISSION_PROFILES_SIDEBAR_RECORDS: SidebarRecords = {
  ...SETTINGS_ASSISTANTS_RECORDS,
  threads: SETTINGS_ASSISTANTS_RECORDS.threads.slice(0, 4),
  assistants: SETTINGS_ASSISTANTS_RECORDS.assistants.map((entry) =>
    entry.assistant.id === MILO.id
      ? { ...entry, assistant: { ...entry.assistant, permissionProfileId: REVIEWER_PROFILE.id } }
      : entry,
  ),
};

/**
 * What the section reads besides the sidebar's lists. The profiles come in
 * the order the controller lists them, by name, so the list's own order
 * (shipped first) is the app's, not the fixture's.
 */
export const PERMISSION_PROFILES_SETTINGS_RECORDS: PermissionProfilesSettingsRecords = {
  profiles: [
    RELEASER_PROFILE,
    REVIEWER_PROFILE,
    SHIPPED_ASSISTANT_PROFILE,
    UNRESTRICTED_PROFILE,
    WORKER_PROFILE,
  ],
  agents: AGENTS,
  connections: SETTINGS_ASSISTANTS_SCREEN.connections,
};
