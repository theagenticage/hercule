/**
 * Builds the composer's model menu from the user's Model Profiles (spec 06
 * §17, spec 14 "The composer is the thread's configuration"). The web app and
 * the desktop app draw the result as it is, so neither interprets a profile
 * itself.
 *
 * - A **draft** shows every profile as one head of an accordion, in the
 *   profiles' order, with exactly one unfolded. The unfolded profile shows
 *   Recent, then one lane per Provider Account in the profile's order, each
 *   with its "New" rows (models the controller announced) and then its
 *   entries in order. With one profile there are no heads.
 * - A **running thread** keeps its account and harness, so it shows one flat
 *   list of the models it can switch to.
 *
 * Whether an entry can run, and the words for why not, are not worked out
 * from the accounts' snapshots. The controller resolves every entry
 * (`ResolvedModelProfileEntry.problem`) and every account carries its
 * readiness on each runner. A problem with the model itself comes from the
 * entry. A problem with the account on a runner comes from the readiness of
 * the runner the draft is bound to, or from the entry when the draft may go to
 * any runner.
 */
import type {
  EntryProblem,
  ModelProfile,
  ProviderAccount,
  ResolvedModelProfileAccount,
  ResolvedModelProfileEntry,
  Runner,
} from "@hercule/contract";
import { matchesModelSearch } from "../model-profiles/catalog-search";
import {
  buildNewModelRows,
  type NewModelDates,
  type NewModelRow,
} from "../model-profiles/new-model-rows";
import { findProjectModelProfile } from "../model-profiles/profile-lookup";
import {
  describeEntryProblem,
  isMachineProblemReason,
  type MachineProblemReason,
} from "../model-profiles/entry-problem";
import {
  buildProfileEntryKey,
  countProfileEntries,
  findHarnessName,
  findOtherHarnessName,
  isSameProfileEntry,
  isSameStoredEntry,
  listProfileEntries,
  type ProfileEntryKey,
} from "../model-profiles/profile-entries";
import {
  buildProviderAccountName,
  findHarnessLoginMethod,
  findProviderAccountNameIfAmbiguous,
  findProviderAccountReadiness,
  resolveThreadHarnessId,
  type HarnessLoginMethod,
} from "../provider-accounts";
import type { ThreadCatalogs, ThreadConfig, ThreadKind } from "./config";
import type { RecentModel } from "./recent";
import { buildSignInTarget, type SignInTarget } from "./sign-in-target";

/** The menu offers a filter when the profiles together hold more entries than this. */
const FILTER_THRESHOLD = 8;

/** How many recent entries the menu shows in a profile, however many the client kept. */
const RECENT_LIMIT = 3;

/** The line under a running thread's list. */
const OTHER_MODELS_NOTE = "Other models start a new thread.";

/** What the menu says in place of its list while the filter matches nothing. */
const NO_MATCH_NOTE = "No model matches.";

/** What an unfolded profile says in place of its list when it holds nothing to pick. */
const EMPTY_PROFILE_NOTE = "No models in this profile yet.";

/** What a running thread's list says in place of its rows when no profile offers a model to switch to. */
const NO_MODELS_NOTE = "No models in your profiles yet.";

/** What the menu says in place of its list when the user has no Model Profile. */
const NO_PROFILE_NOTE = "No Model Profile yet.";

/** What a lane says while its account's first Model Catalog read is still to come. */
const READING_MODELS_NOTE = "Reading models…";

/** Why an entry cannot be picked now, and the sign-in that would fix it when one would. */
export interface ModelMenuProblem {
  /** What the row shows at its right, such as `not signed in on moss`. */
  readonly message: string;
  readonly signIn: SignInTarget | null;
}

export interface ModelMenuRow {
  readonly providerAccountId: string;
  /** The Provider's id, for its logo. */
  readonly providerId: string;
  /** The qualified id of the harness the entry runs in. */
  readonly harnessId: string;
  readonly model: string;
  /** The model's display name. */
  readonly name: string;
  /**
   * The display name of the harness, such as `pi`, when the entry runs in
   * another harness than its lane's; otherwise `null`.
   */
  readonly inHarness: string | null;
  /** Whether this is the profile's default entry. */
  readonly isDefault: boolean;
  readonly isCurrent: boolean;
  /** Why the row is dimmed; `null` when it can be picked. */
  readonly problem: ModelMenuProblem | null;
}

export interface ModelMenuRecentRow extends ModelMenuRow {
  /** The account's name, only when the user has more than one account at its Provider. */
  readonly account: string | null;
}

/** One Provider Account's section of the open profile. */
export interface ModelMenuLane {
  readonly providerAccountId: string;
  readonly providerId: string;
  /** The account's name, such as `Anthropic · work`. */
  readonly name: string;
  /**
   * The models announced as new in this account's section, drawn at the top
   * of the lane. Empty on a running thread's menu and in
   * `buildProfileLanes`, which do not announce.
   */
  readonly newModels: readonly NewModelRow[];
  readonly rows: readonly ModelMenuRow[];
  /** What to show in place of rows while the account's models are still being read, else `null`. */
  readonly note: string | null;
}

/**
 * A Model Profile as the menu draws it: a head, and when `unfolded`, its
 * Recent entries and lanes. A folded profile has neither, because nothing
 * draws them.
 */
export interface ModelMenuProfile {
  readonly profileId: string;
  readonly name: string;
  /** How many entries the profile holds, the filter ignored. */
  readonly entryCount: number;
  readonly unfolded: boolean;
  /** Up to three entries of this profile the user picked most recently, newest first. */
  readonly recent: readonly ModelMenuRecentRow[];
  readonly lanes: readonly ModelMenuLane[];
  /** What to draw in place of the list when the profile is unfolded and holds nothing to pick; else `null`. */
  readonly empty: string | null;
}

export type ModelMenu =
  | {
      readonly kind: "draft";
      /** Whether the menu offers a filter field. */
      readonly filterable: boolean;
      /** Whether each profile has a head. False when the user has one profile. */
      readonly hasHeads: boolean;
      /**
       * The profiles in their order, exactly one unfolded. While the filter has
       * text, every profile with a match is unfolded and shows only its
       * matches, and a profile without a match is left out.
       */
      readonly profiles: readonly ModelMenuProfile[];
      /**
       * What to draw in place of the whole list: that the user has no profile,
       * or that no model matches the filter. `null` when there are profiles
       * to draw.
       */
      readonly empty: string | null;
    }
  | {
      readonly kind: "active";
      /** Whether the menu offers a filter field. */
      readonly filterable: boolean;
      /** Every model the thread can switch to, each once. */
      readonly rows: readonly ModelMenuRow[];
      /** The line shown under the list. */
      readonly note: string;
      /** What to draw in place of the list when `rows` is empty; `null` otherwise. */
      readonly empty: string | null;
    };

/** What the thread runs now: the entry that gets the check mark, and for a running thread its runner. */
export type ModelMenuCurrent = Pick<
  ThreadConfig,
  "providerAccountId" | "harnessId" | "model" | "runnerId" | "projectId"
>;

export interface ModelMenuView extends NewModelDates {
  readonly kind: ThreadKind;
  /** The text typed in the filter field; empty means no filter. */
  readonly filter: string;
  /** The entries the user picked, newest first. A profile shows the first three it holds. */
  readonly recent: readonly RecentModel[];
  /**
   * The profile the user opened in this menu by clicking its head, or `null`
   * until they click one. A draft ignores an id that is no profile.
   */
  readonly openedProfileId: string | null;
  /**
   * The profile the user had open last on this device, which the client
   * stores, or `null` when none is stored. A draft ignores an id that is no
   * profile.
   */
  readonly lastOpenProfileId: string | null;
  /**
   * The runner a draft is bound to: the one the user picked, or the one a
   * joined workspace decides. `null` while any runner will do, and then an
   * entry is dimmed only when no connected runner can run it. A running
   * thread ignores it and uses the runner of its session.
   */
  readonly runnerId: string | null;
}

/** Checks that a sign-in started now could reach the runner. */
const canSignInOn = (runner: Runner): boolean =>
  runner.connectivity === "online" && runner.lifecycle !== "retired";

/** Returns the reason of `problem` when it is about running the entry on a machine, else `null`. */
const readRunReason = (problem: EntryProblem | null): MachineProblemReason | null =>
  problem === null || !isMachineProblemReason(problem.reason) ? null : problem.reason;

/** What the menu reads to name things and to decide what can run. */
interface MenuContext {
  readonly catalogs: ThreadCatalogs;
  /** The runner every entry is judged on, or `undefined` when any runner will do. */
  readonly runner: Runner | undefined;
  readonly filter: string;
  readonly currentKey: ProfileEntryKey | null;
}

/**
 * Checks that signing in on a machine would fix the problem: the account's
 * kind has a harness login, and the problem is a missing sign-in, or for an
 * account whose login makes a token, a token that is missing or expired. An
 * API key is typed in at Settings, so no sign-in fixes it.
 */
const canFixBySigningIn = (
  reason: MachineProblemReason,
  loginMethod: HarnessLoginMethod | null,
): boolean =>
  loginMethod !== null &&
  (reason === "not-signed-in" ||
    (loginMethod === "create-token" &&
      (reason === "credential-missing" || reason === "token-expired")));

/**
 * Returns why `entry` cannot be picked, or `null` when it can:
 *
 * - a problem with the model itself, from the entry;
 * - with a runner, the account's readiness for the entry's harness on it;
 * - with no runner, the entry's own problem, which covers every connected
 *   runner.
 *
 * The sign-in goes to the runner the reason is about, or with no runner, to
 * the first online runner that has the same reason.
 */
const findProblem = (
  context: MenuContext,
  account: ProviderAccount,
  entry: ResolvedModelProfileEntry,
): ModelMenuProblem | null => {
  const { catalogs, runner } = context;
  const subject = {
    harnessName: findHarnessName(catalogs.harnesses, entry.resolvedHarnessId),
    loginMethod: findHarnessLoginMethod(catalogs.providers, account),
  };
  const { problem } = entry;
  if (problem !== null && !isMachineProblemReason(problem.reason)) {
    return { message: problem.message, signIn: null };
  }
  const readiness = (each: Runner) =>
    findProviderAccountReadiness(account, entry.resolvedHarnessId, each.id);
  const runnerState = runner === undefined ? null : readiness(runner);
  const reason: MachineProblemReason | null =
    runnerState === null ? readRunReason(problem) : runnerState === "ready" ? null : runnerState;
  if (reason === null) return null;
  const target = canFixBySigningIn(reason, subject.loginMethod)
    ? (runner === undefined ? catalogs.runners : [runner]).find(
        (each) => canSignInOn(each) && readiness(each) === reason,
      )
    : undefined;
  return {
    message: describeEntryProblem(reason, {
      ...subject,
      machineName: (runner ?? target)?.name ?? null,
    }),
    signIn: target === undefined ? null : buildSignInTarget(catalogs.providers, account, target),
  };
};

const matchesFilter = (row: Pick<ModelMenuRow, "name" | "model">, filter: string): boolean =>
  matchesModelSearch({ name: row.name, slug: row.model }, filter);

/** One entry of a profile with the section and account it belongs to. */
interface PlacedEntry {
  readonly section: ResolvedModelProfileAccount;
  readonly account: ProviderAccount;
  readonly entry: ResolvedModelProfileEntry;
}

const listPlacedEntries = (
  profile: ModelProfile,
  accounts: readonly ProviderAccount[],
): readonly PlacedEntry[] =>
  profile.accounts.flatMap((section) => {
    const account = accounts.find((each) => each.id === section.providerAccountId);
    return account === undefined
      ? []
      : section.entries.map((entry) => ({ section, account, entry }));
  });

const buildRow = (
  context: MenuContext,
  profile: ModelProfile,
  { section, account, entry }: PlacedEntry,
): ModelMenuRow => {
  const { catalogs, currentKey } = context;
  const { defaultEntry } = profile;
  return {
    providerAccountId: entry.providerAccountId,
    providerId: account.providerId,
    harnessId: entry.resolvedHarnessId,
    model: entry.model,
    name: entry.name,
    inHarness: findOtherHarnessName(catalogs.harnesses, section, entry),
    isDefault: defaultEntry !== null && isSameStoredEntry(defaultEntry, entry),
    isCurrent: currentKey !== null && isSameProfileEntry(buildProfileEntryKey(entry), currentKey),
    problem: findProblem(context, account, entry),
  };
};

/**
 * Builds the lanes of `profile` from its `placed` entries, the filter applied.
 * `listNewModels` gives the "New" rows of a section. A lane with new rows
 * stays even when it has no entries.
 */
const buildLanes = (
  context: MenuContext,
  profile: ModelProfile,
  placed: readonly PlacedEntry[],
  listNewModels: (section: ResolvedModelProfileAccount) => readonly NewModelRow[],
): readonly ModelMenuLane[] => {
  const { catalogs, filter } = context;
  return profile.accounts.flatMap((section): readonly ModelMenuLane[] => {
    const account = catalogs.accounts.find((each) => each.id === section.providerAccountId);
    if (account === undefined) return [];
    const rows = placed
      .filter((each) => each.section === section)
      .map((each) => buildRow(context, profile, each))
      .filter((row) => matchesFilter(row, filter));
    const newModels = listNewModels(section).filter((row) =>
      matchesFilter({ name: row.name, model: row.model }, filter),
    );
    // A section with nothing to pick has no lane, and neither does a lane
    // that waits for its models while the user is filtering.
    const waiting = section.selectionPending && filter === "";
    if (rows.length === 0 && newModels.length === 0 && !waiting) return [];
    return [
      {
        providerAccountId: account.id,
        providerId: account.providerId,
        name: buildProviderAccountName(catalogs.providers, account),
        newModels,
        rows,
        note: waiting ? READING_MODELS_NOTE : null,
      },
    ];
  });
};

/**
 * Returns the lanes of `profile` with every entry it holds, as a draft with no
 * filter and no bound runner shows them. Settings > Threads lists its model
 * field from these, so it offers the same rows, with the same problems, as the
 * composer's menu. The lanes announce no new models, because that field
 * lists only what the profile holds.
 */
export const buildProfileLanes = (
  catalogs: ThreadCatalogs,
  profile: ModelProfile,
): readonly ModelMenuLane[] =>
  buildLanes(
    { catalogs, runner: undefined, filter: "", currentKey: null },
    profile,
    listPlacedEntries(profile, catalogs.accounts),
    () => [],
  );

/** What an unfolded profile shows. */
interface ProfileBody {
  readonly recent: readonly ModelMenuRecentRow[];
  readonly lanes: readonly ModelMenuLane[];
}

/** Builds the Recent entries and the lanes of `profile`, the filter applied. */
const buildProfileBody = (
  context: MenuContext,
  profile: ModelProfile,
  recent: readonly RecentModel[],
  dates: NewModelDates,
): ProfileBody => {
  const { catalogs, filter } = context;
  const placed = listPlacedEntries(profile, catalogs.accounts);

  const recentRows = recent
    .flatMap((pair) => {
      const found = placed.find(({ entry }) =>
        isSameProfileEntry(buildProfileEntryKey(entry), {
          providerAccountId: pair.providerAccountId,
          harnessId: pair.harnessId,
          model: pair.model,
        }),
      );
      return found === undefined ? [] : [found];
    })
    .map((found) => ({
      ...buildRow(context, profile, found),
      account: findProviderAccountNameIfAmbiguous(
        catalogs.accounts,
        catalogs.providers,
        found.account,
      ),
    }))
    .filter((row) => matchesFilter(row, filter))
    .slice(0, RECENT_LIMIT);

  return {
    recent: recentRows,
    lanes: buildLanes(context, profile, placed, (section) => buildNewModelRows(section, dates)),
  };
};

/** Returns what a running thread's list says in place of an empty list. */
const describeEmptyList = (filter: string): string =>
  filter === "" ? NO_MODELS_NOTE : NO_MATCH_NOTE;

/**
 * Builds the flat list of a running thread: every entry of every profile with
 * the session's account and harness, each model once, the first profile
 * listing it winning. A model the thread runs that no profile lists is added
 * as the first, current row with its id as name, so the list always shows the
 * model in use. No row is the default, because the profiles may disagree
 * about which entry is.
 */
const buildActiveMenu = (context: MenuContext, current: ModelMenuCurrent): ModelMenu => {
  const { catalogs, filter } = context;
  const account = catalogs.accounts.find((each) => each.id === current.providerAccountId);
  const harnessId =
    account === undefined ? null : resolveThreadHarnessId(account, current.harnessId);
  const rows: ModelMenuRow[] = [];
  let entryCount = 0;
  if (account !== undefined && harnessId !== null) {
    for (const profile of catalogs.modelProfiles) {
      for (const placed of listPlacedEntries(profile, catalogs.accounts)) {
        const { entry } = placed;
        if (entry.providerAccountId !== account.id || entry.resolvedHarnessId !== harnessId) {
          continue;
        }
        if (rows.some((row) => row.model === entry.model)) continue;
        rows.push({ ...buildRow(context, profile, placed), inHarness: null, isDefault: false });
      }
    }
    entryCount = rows.length;
    if (current.model !== null && !rows.some((row) => row.model === current.model)) {
      rows.unshift({
        providerAccountId: account.id,
        providerId: account.providerId,
        harnessId,
        model: current.model,
        name: current.model,
        inHarness: null,
        isDefault: false,
        isCurrent: true,
        problem: null,
      });
    }
  }
  const shown = rows.filter((row) => matchesFilter(row, filter));
  return {
    kind: "active",
    filterable: entryCount > FILTER_THRESHOLD,
    rows: shown,
    note: OTHER_MODELS_NOTE,
    empty: shown.length === 0 ? describeEmptyList(filter) : null,
  };
};

/**
 * Returns the profile a draft's menu unfolds while the filter is empty, or
 * `undefined` when there is no profile. The first of these that exists:
 *
 * 1. the profile the user opened in this menu;
 * 2. a profile that holds the current entry. When several do, the project's
 *    profile, then the profile open last, then the first in the profiles'
 *    order;
 * 3. the project's profile;
 * 4. the profile open last on this device;
 * 5. the first profile.
 *
 * An id that no profile has, such as a deleted profile's, counts as absent.
 */
const chooseUnfoldedProfile = (
  profiles: readonly ModelProfile[],
  currentKey: ProfileEntryKey | null,
  projectProfile: ModelProfile | undefined,
  view: ModelMenuView,
): ModelProfile | undefined => {
  const findProfile = (id: string | null) => profiles.find((profile) => profile.id === id);
  const holders =
    currentKey === null
      ? []
      : profiles.filter((profile) =>
          listProfileEntries(profile).some((entry) =>
            isSameProfileEntry(buildProfileEntryKey(entry), currentKey),
          ),
        );
  return (
    findProfile(view.openedProfileId) ??
    holders.find((profile) => profile.id === projectProfile?.id) ??
    holders.find((profile) => profile.id === view.lastOpenProfileId) ??
    holders[0] ??
    projectProfile ??
    findProfile(view.lastOpenProfileId) ??
    profiles[0]
  );
};

/**
 * Builds a draft's menu: every profile as a head, one unfolded. With filter
 * text, every profile with a match is unfolded and shows its matches only,
 * and a profile without a match is left out.
 */
const buildDraftMenu = (
  context: MenuContext,
  current: ModelMenuCurrent,
  view: ModelMenuView,
): ModelMenu => {
  const { catalogs, filter } = context;
  const { modelProfiles } = catalogs;
  const base = { kind: "draft", hasHeads: modelProfiles.length > 1 } as const;
  if (modelProfiles.length === 0) {
    return { ...base, filterable: false, profiles: [], empty: NO_PROFILE_NOTE };
  }
  const unfolded = chooseUnfoldedProfile(
    modelProfiles,
    context.currentKey,
    findProjectModelProfile(catalogs.projects ?? [], modelProfiles, current.projectId),
    view,
  );
  const entryCounts = modelProfiles.map(countProfileEntries);
  const profiles = modelProfiles.flatMap((profile, index): readonly ModelMenuProfile[] => {
    const head = {
      profileId: profile.id,
      name: profile.name,
      entryCount: entryCounts[index] ?? 0,
    };
    if (filter === "" && profile !== unfolded) {
      return [{ ...head, unfolded: false, recent: [], lanes: [], empty: null }];
    }
    const { recent, lanes } = buildProfileBody(context, profile, view.recent, view);
    const hasRows = recent.length > 0 || lanes.length > 0;
    if (filter !== "" && !hasRows) return [];
    return [{ ...head, unfolded: true, recent, lanes, empty: hasRows ? null : EMPTY_PROFILE_NOTE }];
  });
  return {
    ...base,
    filterable: entryCounts.reduce((total, count) => total + count, 0) > FILTER_THRESHOLD,
    profiles,
    empty: profiles.length === 0 ? NO_MATCH_NOTE : null,
  };
};

/**
 * Returns the model menu for the thread's current config.
 *
 * A draft gets every profile as a head of an accordion, one unfolded (see
 * `chooseUnfoldedProfile`). A running thread gets the flat list of its account
 * and harness. Picking a row is one `model` choice that names its account,
 * harness and model together (`applyThreadChoice`), so the draft runs the
 * entry the row showed. Opening a head changes nothing in the draft's config.
 */
export const buildModelMenu = (
  catalogs: ThreadCatalogs,
  current: ModelMenuCurrent,
  view: ModelMenuView,
): ModelMenu => {
  const account = catalogs.accounts.find((each) => each.id === current.providerAccountId);
  const harnessId =
    account === undefined ? null : resolveThreadHarnessId(account, current.harnessId);
  const boundRunnerId = view.kind === "active" ? current.runnerId : view.runnerId;
  const context: MenuContext = {
    catalogs,
    runner: catalogs.runners.find((runner) => runner.id === boundRunnerId),
    filter: view.filter.trim(),
    currentKey:
      account === undefined || harnessId === null || current.model === null
        ? null
        : { providerAccountId: account.id, harnessId, model: current.model },
  };
  return view.kind === "active"
    ? buildActiveMenu(context, current)
    : buildDraftMenu(context, current, view);
};
