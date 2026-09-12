/**
 * The composer's model selector, whole: the filter it offers only once there
 * is enough to filter, what was reached for last, the account in use with its
 * older models folded away, and every other account as one row. A catalog is
 * scoped instance x runner (spec 06 §3.1), so every model here is read from
 * the one runner the thread is placed on; switching machines re-resolves the
 * whole menu.
 */
import type { ModelDescriptor, ProviderInstance } from "@hydra/contract";
import { accountName, instanceLabel, loginTarget, snapshotOn, type LoginTarget } from "./catalog";
import type { ThreadCatalogs, ThreadConfig, ThreadKind } from "./config";
import type { RecentModel } from "./recent";
import { referenceRunner } from "./runner-menu";

/** Past this many models across every account, the menu is worth filtering. */
const FILTER_THRESHOLD = 8;

/** How many pairs the Recent lane shows, however many the client kept. */
const RECENT_LIMIT = 3;

const ACCOUNT_FIXED = "account fixed";

export interface ModelMenuRow {
  /** The account offering it, so a row picked from any lane knows where it lives. */
  readonly instanceId: string;
  readonly slug: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly current: boolean;
}

export interface ModelMenuRecentRow extends RecentModel {
  readonly name: string;
  readonly providerId: string;
  readonly account: string | null;
  readonly dimmed: string | null;
}

export interface ModelMenuLane {
  readonly instanceId: string | null;
  readonly providerId: string | null;
  /** The lane's one-word label, or nothing to label while no account is picked. */
  readonly label: string | null;
  readonly rows: readonly ModelMenuRow[];
  /** The models the harness still forwards but no longer lists, folded away. */
  readonly older: readonly ModelMenuRow[];
}

export interface ModelMenuInstanceRow {
  readonly instanceId: string;
  readonly providerId: string;
  readonly name: string;
  readonly identity: string | null;
  readonly planLabel: string | null;
  readonly modelCount: number;
  readonly dimmed: string | null;
  readonly login: LoginTarget | null;
  /** Filled while filtering on a draft: the rows of this account the filter
   * matched. An active thread's account is fixed, so there is nothing here to
   * pick and the row stays a row. */
  readonly rows: readonly ModelMenuRow[];
}

export interface ModelMenu {
  readonly filterable: boolean;
  readonly recent: readonly ModelMenuRecentRow[];
  readonly current: ModelMenuLane;
  readonly others: readonly ModelMenuInstanceRow[];
}

export interface ModelMenuView {
  readonly kind: ThreadKind;
  /** What was typed in the filter field; empty is no filter at all. */
  readonly filter: string;
  readonly recent: readonly RecentModel[];
}

const matches = (descriptor: ModelDescriptor, filter: string): boolean =>
  descriptor.name.toLowerCase().includes(filter) || descriptor.slug.toLowerCase().includes(filter);

export const modelMenu = (
  catalogs: ThreadCatalogs,
  current: ThreadConfig,
  view: ModelMenuView,
): ModelMenu => {
  const runner = referenceRunner(catalogs.runners, current.runnerId, catalogs.localRunnerId);
  const filter = view.filter.trim().toLowerCase();
  const modelsOf = (instance: ProviderInstance): readonly ModelDescriptor[] =>
    snapshotOn(instance, runner?.id)?.models ?? [];

  const rowOf = (instance: ProviderInstance, descriptor: ModelDescriptor): ModelMenuRow => ({
    instanceId: instance.id,
    slug: descriptor.slug,
    name: descriptor.name,
    isDefault: descriptor.isDefault === true,
    current: instance.id === current.instanceId && descriptor.slug === current.model,
  });

  const instance = catalogs.instances.find((each) => each.id === current.instanceId);
  const shown =
    instance === undefined
      ? []
      : modelsOf(instance)
          .filter((descriptor) => filter === "" || matches(descriptor, filter))
          .map((descriptor) => ({ descriptor, row: rowOf(instance, descriptor) }));
  // Nothing folds away while filtering - what the user typed is what they are
  // looking for, legacy or not - and the model in force never folds away
  // either, or the lane would carry no check mark.
  const foldable = (descriptor: ModelDescriptor, row: ModelMenuRow): boolean =>
    filter === "" && descriptor.isLegacy === true && !row.current;

  return {
    filterable:
      catalogs.instances.reduce((total, each) => total + modelsOf(each).length, 0) >
      FILTER_THRESHOLD,

    recent: view.recent
      .flatMap((pair) => {
        const held = catalogs.instances.find((each) => each.id === pair.instanceId);
        const descriptor =
          held === undefined
            ? undefined
            : modelsOf(held).find((model) => model.slug === pair.model);
        if (held === undefined || descriptor === undefined) return [];
        return [
          {
            ...pair,
            name: descriptor.name,
            providerId: held.providerId,
            account: accountName(catalogs.instances, held),
            dimmed: view.kind === "active" && held.id !== current.instanceId ? ACCOUNT_FIXED : null,
          },
        ];
      })
      .slice(0, RECENT_LIMIT),

    current: {
      instanceId: current.instanceId,
      providerId: instance?.providerId ?? null,
      label: instance === undefined ? null : instanceLabel(catalogs.instances, instance),
      rows: shown.filter(({ descriptor, row }) => !foldable(descriptor, row)).map(({ row }) => row),
      older: shown.filter(({ descriptor, row }) => foldable(descriptor, row)).map(({ row }) => row),
    },

    others: catalogs.instances
      .filter((each) => each.id !== current.instanceId)
      .flatMap((each) => {
        const snapshot = snapshotOn(each, runner?.id);
        const models = modelsOf(each);
        const matched =
          filter === ""
            ? []
            : models.filter((descriptor) => matches(descriptor, filter)).map((d) => rowOf(each, d));
        if (filter !== "" && matched.length === 0) return [];

        const dimmed =
          view.kind === "active"
            ? ACCOUNT_FIXED
            : snapshot === undefined
              ? `not on ${runner?.name ?? "this machine"}`
              : snapshot.auth.status === "ok"
                ? null
                : "not logged in";

        return [
          {
            instanceId: each.id,
            providerId: each.providerId,
            name: instanceLabel(catalogs.instances, each),
            identity: snapshot?.auth.identity ?? null,
            planLabel: snapshot?.auth.planLabel ?? null,
            modelCount: models.length,
            dimmed,
            // An account the thread cannot move to is not worth logging in
            // to from here: the login would change nothing on this thread.
            login:
              view.kind !== "active" &&
              snapshot !== undefined &&
              snapshot.auth.status !== "ok" &&
              runner !== undefined
                ? loginTarget(each, runner)
                : null,
            rows: view.kind === "active" ? [] : matched,
          },
        ];
      }),
  };
};
