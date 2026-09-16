/**
 * One selector choice folded into the picks the composer holds. Three rules:
 * the config given is the thread's own, without the picks over it, so a pick
 * is compared against what the thread would run with had nothing been picked;
 * a pick that lands back on that value is not a pick at all and leaves the
 * picks without it; and the per-model choices belong to the model that
 * offered them, so anything that changes the catalog underneath them -
 * another model, another account, another machine - drops them rather than
 * carrying a value the new catalog never offered.
 */
import type { AccessMode } from "@hydra/contract";
import type { ThreadCatalogs, ThreadConfig, ThreadPicks } from "./config";
import { instanceDefaults } from "./thread-defaults";
import type { WorkspacePick } from "./workspaces";

export type ComposerPick =
  | { readonly kind: "model"; readonly value: string }
  | { readonly kind: "instanceId"; readonly value: string }
  | { readonly kind: "option"; readonly id: string; readonly value: string | boolean }
  | { readonly kind: "accessMode"; readonly value: AccessMode }
  | { readonly kind: "runnerId"; readonly value: string }
  | { readonly kind: "workspace"; readonly value: WorkspacePick };

type Key = keyof ThreadPicks;

const without = (picks: ThreadPicks, ...keys: readonly Key[]): ThreadPicks =>
  Object.fromEntries(Object.entries(picks).filter(([key]) => !keys.includes(key as Key)));

/** The picks without the choices the old model offered, since they go with it. */
const withoutOptions = (picks: ThreadPicks): ThreadPicks => without(picks, "options");

/**
 * A pick that lands back on what the thread already runs with: the key goes,
 * so nothing rides the next submission saying what it already says. A key
 * that was never picked means nothing changed at all.
 */
const revert = (picks: ThreadPicks, key: Key, ...also: readonly Key[]): ThreadPicks =>
  picks[key] === undefined ? picks : without(picks, key, ...also);

export const applyPick = (
  catalogs: ThreadCatalogs,
  config: ThreadConfig,
  picks: ThreadPicks,
  pick: ComposerPick,
): ThreadPicks => {
  switch (pick.kind) {
    case "model":
      // A pick that changes the catalog says nothing about the choices at
      // all, rather than saying `{}`: the session keeps what it runs with
      // until the new model's own choices are picked.
      return config.model === pick.value
        ? revert(picks, "model", "options")
        : { ...withoutOptions(picks), model: pick.value };
    case "instanceId": {
      const instance = catalogs.instances.find((each) => each.id === pick.value);
      if (instance === undefined) return picks;
      if (config.instanceId === pick.value)
        return revert(picks, "instanceId", "model", "runnerId", "options");
      // A catalog is scoped instance x runner, and the machine that hosts the
      // instance just left need not host this one, so the runner is resolved
      // first and the model read from that runner's snapshot.
      const forInstance = instanceDefaults(instance, catalogs.runners, catalogs.localRunnerId);
      return { ...withoutOptions(picks), instanceId: pick.value, ...forInstance };
    }
    case "option":
      return { ...picks, options: { ...picks.options, [pick.id]: pick.value } };
    case "accessMode":
      return config.accessMode === pick.value
        ? revert(picks, "accessMode")
        : { ...picks, accessMode: pick.value };
    case "runnerId":
      return config.runnerId === pick.value
        ? revert(picks, "runnerId", "options")
        : { ...withoutOptions(picks), runnerId: pick.value };
    // Unlike the others, a workspace pick is not compared against the config:
    // what the config holds is `null` until something is picked, and the value
    // that stands in its place is a default resolved from the catalogs, not a
    // value this function can see.
    case "workspace":
      return { ...picks, workspace: pick.value };
  }
};
