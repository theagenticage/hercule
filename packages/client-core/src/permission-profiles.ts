/**
 * What Settings > Permission profiles needs to interpret: the words for the
 * grant families, the order of the profile list, a free name for a new
 * profile, which profile is unrestricted, who uses each profile, and the
 * grant list after one grant is switched on or off.
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
  settings: { label: "Settings", hint: "Your time zone, topic order and mutes." },
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

/** An agent or an assistant that carries a permission profile. */
export interface ProfileUser {
  readonly id: string;
  readonly name: string;
  readonly kind: "agent" | "assistant";
}

/**
 * Returns the users of each profile, by profile id. A profile nobody uses has
 * no entry.
 *
 * `agent.query` never returns an assistant (an assistant is an agent row of
 * its own kind, listed by `assistant.query`), so a user appears once. Within
 * a profile the assistants come first and the agents after them, each group
 * by name and then by id, so the order is the same on every read.
 */
export const groupProfileUsers = (
  agents: ReadonlyArray<Pick<Agent, "id" | "name" | "permissionProfileId">>,
  assistants: ReadonlyArray<Pick<Assistant, "id" | "name" | "permissionProfileId">>,
): ReadonlyMap<string, ReadonlyArray<ProfileUser>> => {
  const compare = (a: ProfileUser, b: ProfileUser): number =>
    a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const listUsers = (
    holders: ReadonlyArray<Pick<Agent, "id" | "name" | "permissionProfileId">>,
    kind: ProfileUser["kind"],
  ): ReadonlyArray<readonly [string, ProfileUser]> =>
    holders
      .map((each) => [each.permissionProfileId, { id: each.id, name: each.name, kind }] as const)
      .sort(([, a], [, b]) => compare(a, b));
  const grouped = new Map<string, ProfileUser[]>();
  for (const [profileId, user] of [
    ...listUsers(assistants, "assistant"),
    ...listUsers(agents, "agent"),
  ]) {
    const users = grouped.get(profileId);
    if (users === undefined) grouped.set(profileId, [user]);
    else users.push(user);
  }
  return grouped;
};

/** The most users a profile row names; the rest are counted. */
const NAMED_USER_LIMIT = 2;

/**
 * Returns the users' names as the profile list shows them: "Nothing" for no
 * users, the names joined with ", " for one or two, and the first two names
 * followed by " and N more" for more ("Milo, pr-review and 3 more").
 */
export const describeProfileUsers = (users: ReadonlyArray<ProfileUser>): string => {
  if (users.length === 0) return "Nothing";
  const names = users.slice(0, NAMED_USER_LIMIT).map((user) => user.name);
  const rest = users.length - names.length;
  return rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", ");
};

/**
 * Returns the sentence that explains why a profile cannot be deleted while
 * `users` carry it, or `null` when nobody does. Up to two users are named,
 * as in the list ("Milo and pr-review use it. Move them to another profile
 * first."), and any others are counted ("Milo, pr-review and 3 more use it.").
 */
export const describeProfileDeleteBlock = (users: ReadonlyArray<ProfileUser>): string | null => {
  if (users.length === 0) return null;
  const names = users.slice(0, NAMED_USER_LIMIT).map((user) => user.name);
  const rest = users.length - names.length;
  const who = formatNameList(rest > 0 ? [...names, `${rest} more`] : names, "and");
  return users.length === 1
    ? `${who} uses it. Move it to another profile first.`
    : `${who} use it. Move them to another profile first.`;
};

/**
 * Returns `grants` with `grant` added when `held` is true, or removed when it
 * is false. The result is in `ALL_GRANTS` order and holds no repeats, so the
 * list sent to `profile.update`, which replaces the whole list, is the same
 * for the same set of grants.
 */
export const setGrantHeld = (
  grants: ReadonlyArray<Grant>,
  grant: Grant,
  held: boolean,
): ReadonlyArray<Grant> => {
  const current = new Set(grants);
  return ALL_GRANTS.filter((each) => (each === grant ? held : current.has(each)));
};

/**
 * Returns `profiles` in the order the profile list shows them: the shipped
 * profiles first, then the profiles the user made, each group by name and
 * then by id so the order is the same on every read.
 */
export const sortProfiles = <P extends Pick<Profile, "id" | "name" | "shipped">>(
  profiles: ReadonlyArray<P>,
): ReadonlyArray<P> =>
  profiles.toSorted(
    (a, b) =>
      Number(b.shipped) - Number(a.shipped) ||
      a.name.localeCompare(b.name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

/** The name of the shipped profile that is meant to hold every grant. */
const UNRESTRICTED_PROFILE_NAME = "unrestricted";

/**
 * Checks whether `profile` is the shipped `unrestricted` profile, which
 * threads run on unless the user picks another one.
 *
 * The profile is found by its shipped name, so a rename makes this return
 * `false`. A profile id that stays the same for it is tracked in issue #496.
 */
export const isUnrestrictedProfile = (profile: Pick<Profile, "name" | "shipped">): boolean =>
  profile.shipped && profile.name === UNRESTRICTED_PROFILE_NAME;

/**
 * Returns the first line of the question that asks before a grant of the
 * profile `profileName` changes: "This takes Delete on Tasks away from
 * unrestricted." when `held` is false, and "This gives Delete on Tasks back
 * to unrestricted." when it is true.
 */
export const describeGrantChange = (profileName: string, grant: Grant, held: boolean): string => {
  const [family, verb = ""] = grant.split(".") as [GrantFamily, string?];
  const what = `${formatGrantVerb(verb)} on ${GRANT_FAMILY_TEXT[family].label}`;
  return held
    ? `This gives ${what} back to ${profileName}.`
    : `This takes ${what} away from ${profileName}.`;
};
