/**
 * Turns the payload of `modelProfile.update` into the body to store, or into
 * the list of things wrong with it. It is pure: the service reads the profile
 * as it is stored and the world it is judged against (the accounts with their
 * snapshots, the Model Catalogs, the providers and the harnesses), and passes
 * them in.
 */
import {
  isModelMissingFromHarness,
  MAX_DISMISSED_NEW_MODELS,
  type DismissedNewModel,
  type Issue,
  type ModelProfileAccountInput,
  type ModelProfileEntry,
  type ModelProfileUpdateInput,
  type ProviderAccount,
} from "@hercule/contract";
import { decideProviderAccountHarness } from "../plugins";
import {
  computeDefaultSelection,
  describeProviderAccount,
  type DefaultSelection,
} from "../provider-accounts";
import { describeHarnessLacksModel } from "./harness-evidence";
import {
  buildSelectionEntries,
  findNamedHarnessId,
  isSameEntry,
  pickSelectionDefault,
  type StoredProfileBody,
  type StoredSection,
} from "./profile-body";
import type { ResolutionWorld } from "./resolve-profile";

/** Builds the key two entries share when they run the same account's model in the same harness. */
const buildEntryKey = (accountId: string, model: string, harnessId: string): string =>
  `${accountId}\u0000${model}\u0000${harnessId}`;

/**
 * Returns the keys (`buildEntryKey`) of the entries the profile holds now, so
 * a write can tell an entry it keeps from one it adds. An entry counts as the
 * same when its account, model and the harness it runs in are the same, so a
 * section whose harness changes makes all of its entries new.
 */
const collectHeldEntryKeys = (
  current: StoredProfileBody,
  world: ResolutionWorld,
): ReadonlySet<string> => {
  const held = new Set<string>();
  for (const section of current.accounts) {
    const account = world.accounts.find((one) => one.id === section.providerAccountId);
    if (account === undefined) continue;
    for (const entry of section.entries ?? []) {
      const harnessId = findNamedHarnessId(entry, section) ?? account.defaultHarnessId;
      held.add(buildEntryKey(account.id, entry.model, harnessId));
    }
  }
  return held;
};

/** The outcome of building a body: the body, or what is wrong with the payload. */
export type BuiltProfileBody =
  | { readonly _tag: "built"; readonly body: StoredProfileBody }
  | { readonly _tag: "refused"; readonly issues: ReadonlyArray<Issue> };

/** A selection that puts nothing in a section: what `none` and an empty catalog give. */
const NO_SELECTION: DefaultSelection = { models: [], defaultModel: null };

type IssuePath = ReadonlyArray<string | number>;

const buildIssue = (path: IssuePath, message: string): Issue => ({
  path: path.map(String),
  message,
});

/** Returns the issue when the account's kind may not run in the harness a section or entry names, else `undefined`. */
const findHarnessIssue = (
  harnessId: string | null,
  account: ProviderAccount,
  path: IssuePath,
  world: ResolutionWorld,
): Issue | undefined => {
  if (harnessId === null) return undefined;
  const choice = decideProviderAccountHarness(world.providers, world.harnesses, account, harnessId);
  return choice._tag === "refused" ? buildIssue([...path, "harnessId"], choice.reason) : undefined;
};

/**
 * The entries a section of the payload comes to, before any of them is
 * checked.
 *
 * - `entries` is `null` while the section waits for its account's first
 *   Model Catalog read.
 * - `selection` is the Default Selection that gave the entries, and `null`
 *   when the caller sent them (or the section is pending). The rule for a
 *   `null` default entry needs to know which of the two it was.
 */
interface SectionEntries {
  readonly entries: ReadonlyArray<ModelProfileEntry> | null;
  readonly selection: DefaultSelection | null;
}

/**
 * Returns the entries the section comes to: the ones sent, else the
 * provider's Default Selection when it applies right away (the selection is
 * `none` or the account's catalog has been read), else pending. Returns
 * `undefined` when entries have to be chosen but this build has no such
 * provider.
 */
const normalizeSectionEntries = (
  section: ModelProfileAccountInput,
  account: ProviderAccount,
  world: ResolutionWorld,
): SectionEntries | undefined => {
  if (section.entries !== undefined) return { entries: section.entries, selection: null };
  const provider = world.providers.find((one) => one.id === account.providerId);
  if (provider === undefined) return undefined;
  const catalog = world.catalogs.find((one) => one.providerAccountId === account.id);
  const selection =
    provider.defaultSelection === "none"
      ? NO_SELECTION
      : catalog !== undefined && catalog.readAt !== null
        ? computeDefaultSelection(provider, catalog.models)
        : null;
  return selection === null
    ? { entries: null, selection: null }
    : { entries: buildSelectionEntries(account.id, selection), selection };
};

/**
 * Returns the issues in the entries of one section, sent or selected alike:
 *
 * - an entry belongs to the account of its section;
 * - an entry's own harness is one its account may use;
 * - an account's model appears once per harness;
 * - an entry the write adds is not one its harness is known not to list
 *   (`isModelMissingFromHarness`). An entry the profile already holds in the
 *   same harness is exempt, so a profile that holds such an entry can still
 *   be edited.
 *
 * A model the harness lacks is an issue on its own entry when the caller sent
 * it. When a Default Selection gave the entries, the caller chose none of
 * them, and dropping the missing ones would be silent, so one issue on
 * `entries` lists them all.
 */
const findEntryIssues = (
  section: ModelProfileAccountInput,
  account: ProviderAccount,
  { entries, selection }: SectionEntries,
  path: IssuePath,
  heldEntryKeys: ReadonlySet<string>,
  world: ResolutionWorld,
): ReadonlyArray<Issue> => {
  const issues: Array<Issue> = [];
  const seenKeys = new Set<string>();
  const lacking: Array<{ index: number; model: string; harnessName: string }> = [];
  (entries ?? []).forEach((entry, index) => {
    const entryPath = [...path, "entries", index];
    if (entry.providerAccountId !== account.id) {
      issues.push(
        buildIssue(
          [...entryPath, "providerAccountId"],
          "an entry belongs to the account of the section it is in",
        ),
      );
      return;
    }
    const harnessIssue = findHarnessIssue(entry.harnessId, account, entryPath, world);
    if (harnessIssue !== undefined) issues.push(harnessIssue);
    const harnessId = findNamedHarnessId(entry, section) ?? account.defaultHarnessId;
    const key = buildEntryKey(account.id, entry.model, harnessId);
    const harness = world.harnesses.find((one) => one.id === harnessId);
    if (seenKeys.has(key)) {
      issues.push(
        buildIssue(
          entryPath,
          `${entry.model} is already in this section in ${harness?.displayName ?? harnessId}; an account's model appears once per harness`,
        ),
      );
    } else {
      seenKeys.add(key);
    }
    if (
      harnessIssue === undefined &&
      !heldEntryKeys.has(key) &&
      isModelMissingFromHarness(account, harness, entry.model)
    ) {
      lacking.push({ index, model: entry.model, harnessName: harness?.displayName ?? harnessId });
    }
  });

  const accountName = describeProviderAccount(account, world.providers);
  if (selection !== null) {
    if (lacking.length > 0) {
      issues.push(
        buildIssue(
          [...path, "entries"],
          `${lacking[0]!.harnessName} does not list ${lacking.map((one) => one.model).join(", ")} for ${accountName}, and a section sent without entries would get them. Send the entries you want, or choose another harness.`,
        ),
      );
    }
  } else {
    for (const { index, model, harnessName } of lacking) {
      issues.push(
        buildIssue(
          [...path, "entries", index, "model"],
          describeHarnessLacksModel(harnessName, model, accountName),
        ),
      );
    }
  }
  return issues;
};

/**
 * Returns the dismissals worth storing: those of a model that could still be
 * announced as new. A dismissal is dropped when it can never matter:
 *
 * - the account's provider has the Default Selection `none`, which never
 *   announces a model; or
 * - the catalog lists the model, and it was first seen at or before the
 *   account's first read, so it is not new and never will be.
 *
 * Kept: a model the catalog does not list (it may arrive later, or it left
 * and the catalog no longer says when it was first seen), a model first seen
 * after the first read, and any dismissal of an account that was never read.
 *
 * Without this the list would grow by one for every model taken out of a
 * profile, and at `MAX_DISMISSED_NEW_MODELS` a user who curates a catalog of
 * hundreds of models (OpenRouter's) could not save the profile any more. A
 * dismissal of an unknown account is kept here, because the write is refused
 * for it anyway.
 */
const dropUnannounceableDismissals = (
  dismissed: ReadonlyArray<DismissedNewModel>,
  world: ResolutionWorld,
): ReadonlyArray<DismissedNewModel> =>
  dismissed.filter((one) => {
    const account = world.accounts.find((candidate) => candidate.id === one.providerAccountId);
    const provider = world.providers.find((candidate) => candidate.id === account?.providerId);
    if (provider?.defaultSelection === "none") return false;
    const catalog = world.catalogs.find((candidate) => candidate.providerAccountId === account?.id);
    const listed = catalog?.models.find((model) => model.slug === one.model);
    return (
      catalog?.firstReadAt == null ||
      listed === undefined ||
      Date.parse(listed.firstSeenAt) > Date.parse(catalog.firstReadAt)
    );
  });

/**
 * Builds the body that `input` asks for.
 *
 * - A section sent with `entries` keeps them as sent.
 * - A section sent without `entries` gets its provider's Default Selection:
 *   right away when the provider's selection is `none` or the account's
 *   catalog has been read, otherwise it is stored pending (`entries: null`).
 *   A selection applied right away goes through the same harness check as
 *   explicit entries, and the write is refused naming the models when the
 *   harness is known not to list some of them. A pending one is filled later
 *   with every selected model, and the harness's gaps show as
 *   `harness-lacks-model` on read.
 * - The dismissed models are stored without those that can never be
 *   announced (`dropUnannounceableDismissals`). What is left is refused when
 *   it is over `MAX_DISMISSED_NEW_MODELS`.
 * - A `defaultEntry` of `null` is allowed only when every entry of the
 *   profile comes from a Default Selection filled in this write. The default
 *   then becomes the first filled section's default model, else the first
 *   entry. Anywhere else a `null` default on a profile with entries is an
 *   issue, because the write would otherwise leave a default no one chose.
 *
 * Entries are never checked against the catalog: an entry whose model left it
 * is kept and shows that it cannot run. An entry the write adds, or moves to
 * another harness, is checked against what the account's probes found: it is
 * refused when its harness lists its own models, a successful probe of the
 * account in that harness exists, and the probe lacks the model. An entry the
 * profile `current`ly holds in the same harness is not checked again, so a
 * profile that already holds such an entry can still be edited.
 */
export const buildProfileBody = (
  input: ModelProfileUpdateInput,
  current: StoredProfileBody,
  world: ResolutionWorld,
): BuiltProfileBody => {
  const issues: Array<Issue> = [];
  const sections: Array<StoredSection> = [];
  const normalizedSections: Array<SectionEntries> = [];
  const seenAccounts = new Set<string>();
  const heldEntryKeys = collectHeldEntryKeys(current, world);

  input.accounts.forEach((section, sectionIndex) => {
    const path = ["accounts", sectionIndex];
    const account = world.accounts.find((one) => one.id === section.providerAccountId);
    if (account === undefined) {
      issues.push(buildIssue([...path, "providerAccountId"], "no such provider account"));
      return;
    }
    if (seenAccounts.has(account.id)) {
      issues.push(
        buildIssue(
          [...path, "providerAccountId"],
          "this account is in the profile twice; put each account in one section",
        ),
      );
    }
    seenAccounts.add(account.id);
    const sectionHarnessIssue = findHarnessIssue(section.harnessId, account, path, world);
    if (sectionHarnessIssue !== undefined) issues.push(sectionHarnessIssue);

    const normalized = normalizeSectionEntries(section, account, world);
    if (normalized === undefined) {
      issues.push(
        buildIssue(
          [...path, "entries"],
          `this build has no ${account.providerId} provider, so it cannot choose this account's models; send the entries`,
        ),
      );
      return;
    }
    issues.push(...findEntryIssues(section, account, normalized, path, heldEntryKeys, world));
    normalizedSections.push(normalized);
    sections.push({
      providerAccountId: account.id,
      harnessId: section.harnessId,
      entries: normalized.entries,
    });
  });

  const knownAccountIds = new Set(world.accounts.map((one) => one.id));
  input.dismissedNewModels.forEach((dismissed, index) => {
    if (!knownAccountIds.has(dismissed.providerAccountId)) {
      issues.push(
        buildIssue(["dismissedNewModels", index, "providerAccountId"], "no such provider account"),
      );
    }
  });

  const dismissedNewModels = dropUnannounceableDismissals(input.dismissedNewModels, world);
  if (dismissedNewModels.length > MAX_DISMISSED_NEW_MODELS) {
    issues.push(
      buildIssue(
        ["dismissedNewModels"],
        `This profile has dismissed ${String(dismissedNewModels.length)} new models, the most it keeps (${String(MAX_DISMISSED_NEW_MODELS)}). Take some out of its dismissed list with \`hercule model-profile update\`.`,
      ),
    );
  }

  const entries = sections.flatMap((section) => section.entries ?? []);
  const chosenDefault = input.defaultEntry;
  let defaultEntry: ModelProfileEntry | null = chosenDefault;
  if (chosenDefault === null) {
    const hasSentEntries = normalizedSections.some(
      (one) => one.selection === null && (one.entries ?? []).length > 0,
    );
    if (hasSentEntries) {
      issues.push(
        buildIssue(
          ["defaultEntry"],
          "the profile has entries but no default entry; choose which entry a new thread starts on",
        ),
      );
    } else {
      // Every entry comes from a Default Selection: the first selection that
      // holds its default model gives the default entry.
      const fill = normalizedSections.find((one) =>
        one.entries?.some((entry) => entry.model === one.selection?.defaultModel),
      );
      defaultEntry =
        fill?.entries && fill.selection
          ? pickSelectionDefault(fill.entries, fill.selection)
          : (entries[0] ?? null);
    }
  } else if (!entries.some((entry) => isSameEntry(entry, chosenDefault))) {
    issues.push(
      buildIssue(
        ["defaultEntry"],
        "the default entry must be one of the profile's entries, with the same account, model and harness",
      ),
    );
  }

  return issues.length > 0
    ? { _tag: "refused", issues }
    : {
        _tag: "built",
        body: {
          accounts: sections,
          defaultEntry,
          dismissedNewModels,
        },
      };
};
