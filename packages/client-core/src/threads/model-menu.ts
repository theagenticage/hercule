/**
 * Builds the composer's model selector. It has:
 *
 * - a filter field, offered only when there are enough models to filter;
 * - the recently picked models;
 * - the models of the current account, with its older models collapsed;
 * - one row for every other account.
 *
 * A catalog belongs to one account in one harness on one runner, because each
 * runner has its own copy of the harness, with its own version and login
 * (spec 06 §3.1). So every model here is read from the runner the thread is
 * placed on, in the harness the thread runs in: the current account's, for
 * the current account, and the default harness of every other account, which
 * is what picking that account would run in. Switching runners rebuilds the
 * whole menu.
 */
import type { ModelDescriptor, ProviderAccount } from "@hercule/contract";
import { describeModelCount } from "../model-count";
import { buildProviderAccountName, findAccountNameIfAmbiguous } from "../provider-accounts";
import { buildSignInTarget, findSnapshotOn, type SignInTarget } from "./catalog";
import type { ThreadCatalogs, ThreadConfig, ThreadKind } from "./config";
import type { RecentModel } from "./recent";
import { findReferenceRunner } from "./runner-menu";

/** The menu offers a filter when all accounts together have more models than this. */
const FILTER_THRESHOLD = 8;

/** How many recent models the menu shows, however many the client kept. */
const RECENT_LIMIT = 3;

const ACCOUNT_FIXED = "account fixed";

export interface ModelMenuRow {
  /** The account that offers the model, so a row picked from any section knows its account. */
  readonly providerAccountId: string;
  readonly slug: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly current: boolean;
}

export interface ModelMenuRecentRow extends RecentModel {
  readonly name: string;
  readonly harnessId: string;
  readonly account: string | null;
  readonly dimmed: string | null;
}

export interface ModelMenuLane {
  readonly providerAccountId: string | null;
  readonly harnessId: string | null;
  /** The section's one-word label, or `null` while no account is picked. */
  readonly label: string | null;
  readonly rows: readonly ModelMenuRow[];
  /** Legacy models the harness still accepts but no longer lists, shown collapsed. */
  readonly older: readonly ModelMenuRow[];
}

export interface ModelMenuAccountRow {
  readonly providerAccountId: string;
  readonly harnessId: string;
  readonly name: string;
  readonly identity: string | null;
  readonly planLabel: string | null;
  /** How many models the account has, in words: "3 models". */
  readonly models: string;
  readonly dimmed: string | null;
  readonly signIn: SignInTarget | null;
  /**
   * The account's models that match the filter, filled only while filtering
   * on a draft. An active thread's account is fixed, so it cannot pick these
   * models and this stays empty.
   */
  readonly rows: readonly ModelMenuRow[];
}

export interface ModelMenu {
  readonly filterable: boolean;
  readonly recent: readonly ModelMenuRecentRow[];
  readonly current: ModelMenuLane;
  readonly others: readonly ModelMenuAccountRow[];
}

export interface ModelMenuView {
  readonly kind: ThreadKind;
  /** The text typed in the filter field; empty means no filter. */
  readonly filter: string;
  readonly recent: readonly RecentModel[];
}

const matchesFilter = (descriptor: ModelDescriptor, filter: string): boolean =>
  descriptor.name.toLowerCase().includes(filter) || descriptor.slug.toLowerCase().includes(filter);

/** Returns the model menu for the thread's current config. */
export const buildModelMenu = (
  catalogs: ThreadCatalogs,
  current: ThreadConfig,
  view: ModelMenuView,
): ModelMenu => {
  const runner = findReferenceRunner(catalogs.runners, current.runnerId, catalogs.thisMacRunnerId);
  const filter = view.filter.trim().toLowerCase();
  // The current account runs in the thread's harness. Another account would
  // run in its own default harness once picked.
  const findHarnessId = (account: ProviderAccount): string =>
    account.id === current.providerAccountId
      ? (current.harnessId ?? account.defaultHarnessId)
      : account.defaultHarnessId;
  const findSnapshot = (account: ProviderAccount) =>
    findSnapshotOn(account, findHarnessId(account), runner?.id);
  const listModels = (account: ProviderAccount): readonly ModelDescriptor[] =>
    findSnapshot(account)?.models ?? [];

  const buildRow = (account: ProviderAccount, descriptor: ModelDescriptor): ModelMenuRow => ({
    providerAccountId: account.id,
    slug: descriptor.slug,
    name: descriptor.name,
    isDefault: descriptor.isDefault === true,
    current: account.id === current.providerAccountId && descriptor.slug === current.model,
  });

  const account = catalogs.accounts.find((each) => each.id === current.providerAccountId);
  const shown =
    account === undefined
      ? []
      : listModels(account)
          .filter((descriptor) => filter === "" || matchesFilter(descriptor, filter))
          .map((descriptor) => ({ descriptor, row: buildRow(account, descriptor) }));
  // Nothing is collapsed while filtering, because the user is looking for
  // what they typed, legacy or not. The current model is never collapsed
  // either, or the section would show no check mark.
  const isFoldable = (descriptor: ModelDescriptor, row: ModelMenuRow): boolean =>
    filter === "" && descriptor.isLegacy === true && !row.current;

  return {
    filterable:
      catalogs.accounts.reduce((total, each) => total + listModels(each).length, 0) >
      FILTER_THRESHOLD,

    recent: view.recent
      .flatMap((pair) => {
        const held = catalogs.accounts.find((each) => each.id === pair.providerAccountId);
        const descriptor =
          held === undefined
            ? undefined
            : listModels(held).find((model) => model.slug === pair.model);
        if (held === undefined || descriptor === undefined) return [];
        return [
          {
            ...pair,
            name: descriptor.name,
            harnessId: findHarnessId(held),
            account: findAccountNameIfAmbiguous(catalogs.accounts, catalogs.providers, held),
            dimmed:
              view.kind === "active" && held.id !== current.providerAccountId
                ? ACCOUNT_FIXED
                : null,
          },
        ];
      })
      .slice(0, RECENT_LIMIT),

    current: {
      providerAccountId: current.providerAccountId,
      harnessId: account === undefined ? null : findHarnessId(account),
      label: account === undefined ? null : buildProviderAccountName(catalogs.providers, account),
      rows: shown
        .filter(({ descriptor, row }) => !isFoldable(descriptor, row))
        .map(({ row }) => row),
      older: shown
        .filter(({ descriptor, row }) => isFoldable(descriptor, row))
        .map(({ row }) => row),
    },

    others: catalogs.accounts
      .filter((each) => each.id !== current.providerAccountId)
      .flatMap((each) => {
        const snapshot = findSnapshot(each);
        const models = listModels(each);
        const matched =
          filter === ""
            ? []
            : models
                .filter((descriptor) => matchesFilter(descriptor, filter))
                .map((d) => buildRow(each, d));
        if (filter !== "" && matched.length === 0) return [];

        const dimmed =
          view.kind === "active"
            ? ACCOUNT_FIXED
            : snapshot === undefined
              ? `not on ${runner?.name ?? "this machine"}`
              : snapshot.auth.status === "ok"
                ? null
                : "not signed in";

        return [
          {
            providerAccountId: each.id,
            harnessId: findHarnessId(each),
            name: buildProviderAccountName(catalogs.providers, each),
            identity: snapshot?.auth.identity ?? null,
            planLabel: snapshot?.auth.planLabel ?? null,
            models: describeModelCount(models.length),
            dimmed,
            // Do not offer a sign-in for an account the thread cannot switch to:
            // the sign-in would change nothing for this thread.
            signIn:
              view.kind !== "active" &&
              snapshot !== undefined &&
              snapshot.auth.status !== "ok" &&
              runner !== undefined
                ? buildSignInTarget(catalogs.providers, each, runner)
                : null,
            rows: view.kind === "active" ? [] : matched,
          },
        ];
      }),
  };
};
