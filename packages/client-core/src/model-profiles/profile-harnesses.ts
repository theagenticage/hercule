/**
 * What the Models page draws about harnesses: the pill in a section's head,
 * and the "Runs in" and "Also offer in" choices on each row (spec 06 section
 * 15.4, spec 17). The page draws these as they come. The rule for which
 * harness a choice is struck through for, and why, is only here and in the
 * account sheet's `listProviderAccountHarnessChoices`, which this reuses for
 * everything the account decides by itself.
 */
import {
  isModelMissingFromHarness,
  type Harness,
  type Provider,
  type ProviderAccount,
  type ResolvedModelProfileAccount,
  type ResolvedModelProfileEntry,
  type Runner,
} from "@hercule/contract";
import { formatNameList } from "../name-list";
import {
  canAccountKindRunInHarness,
  isHarnessInstalledOnRunner,
  listProviderAccountHarnessChoices,
} from "../provider-account-harnesses";
import { findHarnessName } from "./profile-entries";

/** Where an entry or a section can run: what to write, and what it reads. */
export interface HarnessTarget {
  /**
   * The qualified id of the harness to write, such as `pi/pi`; `null` follows
   * the level above: the account's default harness for a section, the
   * section's harness for an entry.
   */
  readonly harnessId: string | null;
  /** The harness this target runs in, whose logo it wears. */
  readonly resolvedHarnessId: string;
  /**
   * What it reads: the harness's name, such as "pi", or its id when no harness
   * has it any more. The section's `null` target reads "Same as the account ·
   * Claude Code".
   */
  readonly name: string;
}

/** One harness a section or an entry can be set to. */
export interface HarnessOption extends HarnessTarget {
  /** Why it cannot be picked, in a short sentence; `null` when it can. It is drawn struck through. */
  readonly unavailableReason: string | null;
  /** A quiet note under a pickable option, such as "Not on moss and beelink"; `null` for none. */
  readonly note: string | null;
  /** Whether this is what the section or the entry is set to now. */
  readonly isCurrent: boolean;
}

/** The harness pill in the head of a section. */
export interface SectionHarness {
  /** The harness the section runs in. */
  readonly resolvedHarnessId: string;
  /** What the pill reads: "Same as the account · Claude Code" while the section follows the account, else the harness's name. */
  readonly label: string;
  /** Whether the section follows the account's default harness (the profile names none for it). */
  readonly followsAccount: boolean;
  /** Whether fewer than two harnesses can be picked, so the pill takes its quiet look. */
  readonly isFixed: boolean;
  /**
   * The popover: "Same as the account" (a `harnessId` of `null`) first, then
   * every harness in the harness list's order. A harness the section is set
   * to that no longer exists comes last, so the checked option is never missing.
   */
  readonly options: readonly HarnessOption[];
}

/** The harness choices of one row. */
export interface RowHarnessChoices {
  /** The harnesses the entry can run in; empty when fewer than two are listed. The section's harness comes first. */
  readonly runsIn: readonly HarnessOption[];
  /** The harnesses the model can be offered in as another entry: the pickable `runsIn` options the entry is not in now. */
  readonly alsoOfferIn: readonly HarnessTarget[];
}

/** What the harness choices of a section are read from. */
export interface HarnessCatalogs {
  readonly providers: readonly Provider[];
  readonly harnesses: readonly Harness[];
  readonly runners: readonly Runner[];
}

/**
 * Returns the names of the runners, not retired, where the harness is not
 * installed, when it is installed on at least one of them; else `[]`. A
 * harness that is on no machine is struck through instead (see
 * `listProviderAccountHarnessChoices`), so this only speaks about a harness
 * that is partly there.
 */
const listRunnersWithoutHarness = (harness: Harness, runners: readonly Runner[]): string[] => {
  const active = runners.filter((runner) => runner.lifecycle !== "retired");
  const without = active.filter((runner) => !isHarnessInstalledOnRunner(harness, runner));
  return without.length === active.length ? [] : without.map(({ name }) => name);
};

/**
 * Returns what the pill and the rows of one section draw: the pill, and for
 * each entry, a function that returns its row's choices. `account` is the
 * section's account, and `section` its profile section.
 *
 * Everything the account decides by itself comes from
 * `listProviderAccountHarnessChoices`: the provider's terms, what the harness
 * runs, and whether it is on any machine. On top of that, an option is struck
 * through for what the entries of the section make of it.
 */
export const buildSectionHarnessChoices = (
  section: ResolvedModelProfileAccount,
  account: ProviderAccount,
  { providers, harnesses, runners }: HarnessCatalogs,
): {
  readonly harness: SectionHarness;
  readonly buildRowChoices: (entry: ResolvedModelProfileEntry) => RowHarnessChoices;
} => {
  const accountChoices = listProviderAccountHarnessChoices(account, providers, harnesses, runners);
  const findHarness = (harnessId: string): Harness | undefined =>
    harnesses.find(({ id }) => id === harnessId);
  const findAccountReason = (harnessId: string): string | null =>
    accountChoices.find((choice) => choice.harnessId === harnessId)?.unavailableReason ?? null;

  /**
   * Returns why choosing `harnessId` for the section is refused because of its
   * entries, or `null`. Choosing it moves every entry that follows the
   * section there, which fails when:
   *
   * - the harness is known not to list the model of such an entry, unless the
   *   section already holds that model in that harness (the controller does not
   *   check what a profile already holds);
   * - two entries become the same model in the harness.
   */
  const findMoveReason = (harnessId: string): string | null => {
    const harness = findHarness(harnessId);
    const harnessName = findHarnessName(harnesses, harnessId);
    const followers = section.entries.filter((entry) => entry.harnessId === null);
    const missing = followers.filter(
      (entry) =>
        !section.entries.some(
          (held) => held.model === entry.model && held.resolvedHarnessId === harnessId,
        ) && isModelMissingFromHarness(account, harness, entry.model),
    );
    if (missing.length > 0) {
      return `${harnessName} doesn't know ${formatNameList(
        missing.map(({ name }) => name),
        "and",
      )}`;
    }
    const clashes = new Map<string, string>();
    for (const entry of section.entries) {
      const entryHarnessId = entry.harnessId === null ? harnessId : entry.resolvedHarnessId;
      const wouldRepeat = section.entries.some(
        (other) =>
          other !== entry &&
          other.model === entry.model &&
          (other.harnessId === null ? harnessId : other.resolvedHarnessId) === entryHarnessId,
      );
      if (wouldRepeat) clashes.set(entry.model, entry.name);
    }
    return clashes.size > 0
      ? `${formatNameList(clashes.values(), "and")} would be in the menu twice in ${harnessName}`
      : null;
  };

  const buildPillOption = (harnessId: string | null, resolvedHarnessId: string): HarnessOption => {
    const harness = findHarness(resolvedHarnessId);
    const harnessName = findHarnessName(harnesses, resolvedHarnessId);
    const isCurrent = section.harnessId === harnessId;
    const unavailableReason =
      findAccountReason(resolvedHarnessId) ??
      (isCurrent ? null : findMoveReason(resolvedHarnessId));
    const missingOn =
      unavailableReason === null && harness !== undefined
        ? listRunnersWithoutHarness(harness, runners)
        : [];
    return {
      harnessId,
      resolvedHarnessId,
      name: harnessId === null ? `Same as the account · ${harnessName}` : harnessName,
      unavailableReason,
      note: missingOn.length > 0 ? `Not on ${formatNameList(missingOn, "and")}` : null,
      isCurrent,
    };
  };

  const followsAccount = section.harnessId === null;
  const followOption = buildPillOption(null, account.defaultHarnessId);
  const options = [
    followOption,
    ...harnesses.map((harness) => buildPillOption(harness.id, harness.id)),
  ];
  if (section.harnessId !== null && findHarness(section.harnessId) === undefined) {
    options.push(buildPillOption(section.harnessId, section.harnessId));
  }
  const pickableHarnessIds = new Set(
    options
      .filter((option) => option.unavailableReason === null)
      .map((option) => option.resolvedHarnessId),
  );

  const buildRowChoices = (entry: ResolvedModelProfileEntry): RowHarnessChoices => {
    const candidateIds = harnesses
      .filter(
        (harness) =>
          harness.id === entry.resolvedHarnessId ||
          canAccountKindRunInHarness(account, providers, harness),
      )
      .map(({ id }) => id);
    if (!candidateIds.includes(entry.resolvedHarnessId)) candidateIds.push(entry.resolvedHarnessId);
    // The section's harness first: it is the choice that follows the section.
    candidateIds.sort(
      (a, b) => Number(b === section.resolvedHarnessId) - Number(a === section.resolvedHarnessId),
    );

    const runsIn = candidateIds.map((harnessId): HarnessOption => {
      const harness = findHarness(harnessId);
      const harnessName = findHarnessName(harnesses, harnessId);
      const unavailableReason =
        findAccountReason(harnessId) ??
        (isModelMissingFromHarness(account, harness, entry.model)
          ? `${harnessName} doesn't know this model`
          : section.entries.some(
                (other) =>
                  other !== entry &&
                  other.model === entry.model &&
                  other.resolvedHarnessId === harnessId,
              )
            ? `Already in the menu in ${harnessName}`
            : null);
      return {
        harnessId: harnessId === section.resolvedHarnessId ? null : harnessId,
        resolvedHarnessId: harnessId,
        name: harnessName,
        unavailableReason,
        note: null,
        isCurrent: harnessId === entry.resolvedHarnessId,
      };
    });
    if (runsIn.length < 2) return { runsIn: [], alsoOfferIn: [] };
    return {
      runsIn,
      alsoOfferIn: runsIn
        .filter((option) => option.unavailableReason === null && !option.isCurrent)
        .map(({ harnessId, resolvedHarnessId, name }) => ({ harnessId, resolvedHarnessId, name })),
    };
  };

  return {
    harness: {
      resolvedHarnessId: section.resolvedHarnessId,
      label: followsAccount
        ? followOption.name
        : findHarnessName(harnesses, section.resolvedHarnessId),
      followsAccount,
      isFixed: pickableHarnessIds.size < 2,
      options,
    },
    buildRowChoices,
  };
};
