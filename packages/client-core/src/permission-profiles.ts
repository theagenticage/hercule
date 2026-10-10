/**
 * What Settings > Permission profiles needs to interpret: the words for the
 * grant families, the order of the profile list, a free name for a new
 * profile, which profile is unrestricted, which agents carry each profile,
 * and the grant list after one grant is switched on or off.
 */
import { ALL_GRANTS } from "@hercule/contract";
import type { Agent, Assistant, Grant, GrantFamily, Profile } from "@hercule/contract";
import { formatNameList } from "./name-list";

/**
 * The label and the one-line hint the profile page shows for each grant
 * family. The type makes the compiler refuse a family without text.
 */
export const GRANT_FAMILY_TEXT: Readonly<
  Record<GrantFamily, { readonly label: string; readonly hint: string }>
> = {
  task: { label: "Tasks", hint: "Tasks in Intake and on projects." },
  workflow: { label: "Workflows", hint: "Workflows and their triggers." },
  run: { label: "Runs", hint: "Start begins a run. Write follows and cancels runs." },
  session: {
    label: "Sessions",
    hint: "Spawn starts a session. Steer sends it input or stops it.",
  },
  subscription: {
    label: "Subscriptions",
    hint: "What wakes a session when something happens.",
  },
  notification: { label: "Notifications", hint: "Notifications to you. Only you act on one." },
  settings: { label: "Settings", hint: "Your time zone and mutes." },
  event: { label: "Events", hint: "The event log. Audit adds its security entries." },
  connection: {
    label: "Connections",
    hint: "Manage adds and edits them. Use acts through them.",
  },
  infra: { label: "Machines", hint: "Machines, providers, plugins and the controller." },
  workspace: { label: "Workspaces", hint: "Write creates and disposes of them." },
  agent: { label: "Agents", hint: "Agents, assistants and their Conversations." },
  memory: { label: "Memory", hint: "An assistant's own memory, never another's." },
  permission: {
    label: "Permissions",
    hint: "These profiles, and deciding a permission request.",
  },
  project: { label: "Projects", hint: "Projects and what belongs to them." },
  resource: { label: "Resources", hint: "Repositories, folders and mailboxes." },
  secret: { label: "Secrets", hint: "Read sees their names, never their values." },
  credential: { label: "Credentials", hint: "Your API keys and your password." },
};

/** Returns a grant verb as its button label: "read" becomes "Read". */
export const formatGrantVerb = (verb: string): string =>
  verb.slice(0, 1).toUpperCase() + verb.slice(1);

/**
 * Returns the name a new profile starts with: "New profile", or the first of
 * "New profile 2", "New profile 3", ... that no profile in `profiles` has.
 * `profile.create` fails with `conflict` on a taken name, and names are
 * unique by exact text, so the comparison is exact too.
 */
export const chooseNewProfileName = (profiles: ReadonlyArray<Pick<Profile, "name">>): string => {
  const taken = new Set(profiles.map((profile) => profile.name));
  let name = "New profile";
  for (let number = 2; taken.has(name); number += 1) name = `New profile ${number}`;
  return name;
};

/**
 * An agent that carries a permission profile. An assistant is a kind of
 * agent, so `kind` tells the two apart.
 */
export interface ProfileAgent {
  readonly id: string;
  readonly name: string;
  readonly kind: "agent" | "assistant";
}

/** Orders two ids as text, which for UUIDv7 is the order they were made in. */
const compareById = (a: { readonly id: string }, b: { readonly id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Orders two records by name, and by id when the names are equal, so a list
 * sorted with it has the same order on every read.
 */
const compareByNameThenId = (
  a: { readonly id: string; readonly name: string },
  b: { readonly id: string; readonly name: string },
): number => a.name.localeCompare(b.name) || compareById(a, b);

/**
 * Returns the agents of each profile, by profile id. A profile no agent
 * carries has no entry.
 *
 * `agent.query` never returns an assistant (an assistant is an agent row of
 * its own kind, listed by `assistant.query`), so an agent appears once.
 * Within a profile the assistants come first and the plain agents after
 * them, each group by name and then by id, so the order is the same on every
 * read.
 */
export const groupAgentsByProfile = (
  agents: ReadonlyArray<Pick<Agent, "id" | "name" | "permissionProfileId">>,
  assistants: ReadonlyArray<Pick<Assistant, "id" | "name" | "permissionProfileId">>,
): ReadonlyMap<string, ReadonlyArray<ProfileAgent>> => {
  const listAgents = (
    records: ReadonlyArray<Pick<Agent, "id" | "name" | "permissionProfileId">>,
    kind: ProfileAgent["kind"],
  ): ReadonlyArray<readonly [string, ProfileAgent]> =>
    records
      .map((each) => [each.permissionProfileId, { id: each.id, name: each.name, kind }] as const)
      .sort(([, a], [, b]) => compareByNameThenId(a, b));
  const grouped = new Map<string, ProfileAgent[]>();
  for (const [profileId, agent] of [
    ...listAgents(assistants, "assistant"),
    ...listAgents(agents, "agent"),
  ]) {
    const inProfile = grouped.get(profileId);
    if (inProfile === undefined) grouped.set(profileId, [agent]);
    else inProfile.push(agent);
  }
  return grouped;
};

/** The most agents a profile row names; the rest are counted. */
const NAMED_AGENT_LIMIT = 2;

/** Returns the names of the first `NAMED_AGENT_LIMIT` agents, and how many agents come after them. */
const splitNamedAgents = (
  agents: ReadonlyArray<ProfileAgent>,
): { readonly names: ReadonlyArray<string>; readonly rest: number } => {
  const names = agents.slice(0, NAMED_AGENT_LIMIT).map((agent) => agent.name);
  return { names, rest: agents.length - names.length };
};

/**
 * Returns the agents' names as the profile list shows them: "Nothing" for no
 * agents, the names joined with ", " for one or two, and the first two names
 * followed by " and N more" for more ("Milo, pr-review and 3 more").
 */
export const describeProfileAgents = (agents: ReadonlyArray<ProfileAgent>): string => {
  if (agents.length === 0) return "Nothing";
  const { names, rest } = splitNamedAgents(agents);
  return rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", ");
};

/**
 * Returns the sentence that explains why a profile cannot be deleted while
 * `agents` carry it, or `null` when no agent does. Up to two agents are
 * named ("Milo and pr-review use it. Move them to another profile first."),
 * and any others are counted ("Milo, pr-review and 3 more use it.").
 */
export const describeProfileInUse = (agents: ReadonlyArray<ProfileAgent>): string | null => {
  if (agents.length === 0) return null;
  const { names, rest } = splitNamedAgents(agents);
  const who = formatNameList(rest > 0 ? [...names, `${rest} more`] : names, "and");
  return agents.length === 1
    ? `${who} uses it. Move it to another profile first.`
    : `${who} use it. Move them to another profile first.`;
};

/** One grant put into a profile or taken out of it. */
export interface GrantChange {
  readonly grant: Grant;
  /** Whether the profile holds `grant` after the change. */
  readonly held: boolean;
}

/** Returns the family a grant belongs to: "task" for "task.delete". */
export const readGrantFamily = (grant: Grant): GrantFamily => grant.split(".")[0] as GrantFamily;

/**
 * Returns `grants` with `change.grant` added when `change.held` is true, or
 * removed when it is false. The result is in `ALL_GRANTS` order and holds no
 * repeats, so the list sent to `profile.update`, which replaces the whole
 * list, is the same for the same set of grants.
 */
export const applyGrantChange = (
  grants: ReadonlyArray<Grant>,
  change: GrantChange,
): ReadonlyArray<Grant> => {
  const current = new Set(grants);
  return ALL_GRANTS.filter((each) => (each === change.grant ? change.held : current.has(each)));
};

/**
 * Returns `profiles` in the order the profile list shows them: the shipped
 * profiles first, then the profiles the user made, each group by name and
 * then by id so the order is the same on every read.
 */
export const sortProfiles = <P extends Pick<Profile, "id" | "name" | "shipped">>(
  profiles: ReadonlyArray<P>,
): ReadonlyArray<P> =>
  profiles.toSorted((a, b) => Number(b.shipped) - Number(a.shipped) || compareByNameThenId(a, b));

/** The name of the shipped profile that is meant to hold every grant. */
const UNRESTRICTED_PROFILE_NAME = "unrestricted";

/**
 * Checks whether `profile` is the shipped `unrestricted` profile, which
 * threads run on unless the user picks another one.
 *
 * The profile is found by its shipped name, so a rename makes this return
 * `false`. Issue #496 tracks giving it a fixed id, so a rename no longer hides it.
 */
export const isUnrestrictedProfile = (profile: Pick<Profile, "name" | "shipped">): boolean =>
  profile.shipped && profile.name === UNRESTRICTED_PROFILE_NAME;

/**
 * Returns the first line of the dialog that asks before a grant of the
 * unrestricted profile `profileName` changes: "This takes Delete on Tasks
 * away from unrestricted." when `change.held` is false, and "This gives
 * Delete on Tasks back to unrestricted." when it is true.
 *
 * The "gives ... back" wording assumes the profile is meant to hold every
 * grant, so it fits the unrestricted profile only.
 */
export const describeUnrestrictedGrantChange = (
  profileName: string,
  change: GrantChange,
): string => {
  const family = readGrantFamily(change.grant);
  const verb = change.grant.slice(family.length + 1);
  const what = `${formatGrantVerb(verb)} on ${GRANT_FAMILY_TEXT[family].label}`;
  return change.held
    ? `This gives ${what} back to ${profileName}.`
    : `This takes ${what} away from ${profileName}.`;
};
