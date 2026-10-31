/**
 * What a client says about the harnesses a Provider Account can run in (spec 06
 * section 15.4): which ones it can, and for the others the first reason it
 * cannot. The account sheet's Default harness section reads this, so a
 * harness is struck through for the same reason wherever it is drawn.
 */
import type { Harness, Provider, ProviderAccount, Runner } from "@hercule/contract";
import { findHarnessName } from "./model-profiles/profile-entries";
import { formatNameList } from "./name-list";
import { buildProviderAccountName, findProviderAccountKind } from "./provider-accounts";

/** One harness, as a Provider Account sees it. */
export interface ProviderAccountHarnessChoice {
  /** The qualified id of the harness, such as `claude-code/claude-code`. */
  readonly harnessId: string;
  readonly harnessName: string;
  /**
   * Why the account cannot run in the harness, in a sentence such as "pi is on
   * no machine"; `null` when it can.
   */
  readonly unavailableReason: string | null;
}

/**
 * Returns the kind's title as a noun, such as "Claude subscription" or "API
 * key". This relies on a convention of the plugins' kind titles, which nothing
 * enforces: the title starts with the noun, and a comma may follow it to say
 * where the account signs in ("Claude subscription, every machine"). The part
 * after the comma says nothing about which harness may run the account, so it
 * is left off. A plugin whose title has a comma inside its noun would be cut
 * short.
 */
const readKindNoun = (title: string): string => title.split(",")[0]!.trim();

/** Returns `noun` with its article: "a Claude subscription", "an API key". */
const withArticle = (noun: string): string => `${/^[AEIOU]/i.test(noun) ? "an" : "a"} ${noun}`;

/**
 * Checks whether the harness is installed on the runner, going by the
 * runner's facts. The harness's executable name on the runner's `PATH` is its
 * `binaryName`.
 */
export const isHarnessInstalledOnRunner = (harness: Harness, runner: Runner): boolean =>
  (runner.facts?.harnesses ?? []).some(
    (binary) => binary.name === harness.binaryName && binary.present,
  );

/** Returns the runners that are not retired. */
export const listActiveRunners = (runners: ReadonlyArray<Runner>): ReadonlyArray<Runner> =>
  runners.filter((runner) => runner.lifecycle !== "retired");

/** Checks whether the harness is installed on at least one runner that is not retired. */
const isInstalledOnAnyRunner = (harness: Harness, runners: ReadonlyArray<Runner>): boolean =>
  listActiveRunners(runners).some((runner) => isHarnessInstalledOnRunner(harness, runner));

/**
 * Checks that the harness lists the account's provider and kind among what it
 * runs, which is what `harness.runs` declares.
 */
const doesHarnessRunAccountKind = (
  account: Pick<ProviderAccount, "providerId" | "kind">,
  harness: Harness,
): boolean =>
  harness.runs
    .find((support) => support.providerId === account.providerId)
    ?.kinds.some((each) => each.kind === account.kind) === true;

/**
 * Checks that the account's kind can run in the harness at all: the provider's
 * terms allow the kind in it, and the harness runs the provider and the kind.
 * It does not ask whether the harness is installed on any machine, because
 * that changes with the machines while this stays the same.
 */
export const canAccountKindRunInHarness = (
  account: Pick<ProviderAccount, "providerId" | "kind">,
  providers: ReadonlyArray<Provider>,
  harness: Harness,
): boolean =>
  findProviderAccountKind(providers, account)?.harnesses.includes(harness.id) === true &&
  doesHarnessRunAccountKind(account, harness);

/**
 * Returns one entry for each harness in `harnesses`, in that order, saying
 * whether `account` can run in it. When it cannot, `unavailableReason` is the
 * first of these that holds, in the order of spec 06 section 15.4:
 *
 * - the account's kind does not list the harness, because the provider's terms
 *   do not allow it: "Anthropic allows a Claude subscription only in Claude
 *   Code";
 * - the harness's `runs` does not list the provider and the kind: "Codex can't
 *   run Anthropic's API key";
 * - the harness is installed on no runner that is not retired: "pi is on no
 *   machine".
 *
 * When no registered Provider declares the account's kind any more, no harness
 * is known to run it, and every entry says so.
 */
export const listProviderAccountHarnessChoices = (
  account: Pick<ProviderAccount, "providerId" | "kind" | "label">,
  providers: ReadonlyArray<Provider>,
  harnesses: ReadonlyArray<Harness>,
  runners: ReadonlyArray<Runner>,
): ReadonlyArray<ProviderAccountHarnessChoice> => {
  const kind = findProviderAccountKind(providers, account);
  const providerName = buildProviderAccountName(providers, { ...account, label: null });

  const decideReason = (harness: Harness): string | null => {
    if (kind === undefined) {
      return `${providerName} no longer offers this kind of account`;
    }
    if (!kind.harnesses.includes(harness.id)) {
      return `${providerName} allows ${withArticle(readKindNoun(kind.title))} only in ${formatNameList(
        kind.harnesses.map((harnessId) => findHarnessName(harnesses, harnessId)),
        "and",
      )}`;
    }
    if (!doesHarnessRunAccountKind(account, harness)) {
      return `${harness.displayName} can't run ${providerName}'s ${readKindNoun(kind.title)}`;
    }
    return isInstalledOnAnyRunner(harness, runners)
      ? null
      : `${harness.displayName} is on no machine`;
  };

  return harnesses.map((harness) => ({
    harnessId: harness.id,
    harnessName: harness.displayName,
    unavailableReason: decideReason(harness),
  }));
};
