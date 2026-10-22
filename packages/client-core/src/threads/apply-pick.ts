/**
 * Applies one selector choice to the picks the composer holds. Three rules:
 *
 * - `config` is the thread's own config, without the picks applied, so a pick
 *   is compared with what the thread would run with if nothing were picked.
 * - A pick that equals that value is not a pick: it is removed from the picks.
 * - The model options belong to the model that offered them. `applyPicks`
 *   keeps the options the user had after a pick that changes the catalog
 *   (model, account, runner or workspace), but only those the model the thread
 *   ends up with also offers, with a valid value. The others are dropped,
 *   rather than sent as a value that catalog never offered.
 */
import type { AccessMode, ModelOption, Workspace } from "@hercule/contract";
import { findModelDescriptor } from "./composer-fields";
import {
  computeEffectiveConfig,
  type ThreadCatalogs,
  type ThreadConfig,
  type ThreadPicks,
} from "./config";
import { computeInstanceDefaults } from "./thread-defaults";
import { findRunnerForPick, type WorkspacePick } from "./workspaces";

export type ComposerPick =
  | { readonly kind: "model"; readonly value: string }
  | { readonly kind: "instanceId"; readonly value: string }
  | { readonly kind: "option"; readonly id: string; readonly value: string | boolean }
  | { readonly kind: "accessMode"; readonly value: AccessMode }
  | { readonly kind: "runnerId"; readonly value: string }
  | { readonly kind: "workspace"; readonly value: WorkspacePick };

type Key = keyof ThreadPicks;

const omitPicks = (picks: ThreadPicks, ...keys: readonly Key[]): ThreadPicks =>
  Object.fromEntries(Object.entries(picks).filter(([key]) => !keys.includes(key as Key)));

/** Checks that `value` is one of the values `option` accepts. */
const acceptsValue = (option: ModelOption, value: string | boolean): boolean =>
  option.kind === "boolean"
    ? typeof value === "boolean"
    : (option.choices ?? []).some((choice) => choice.value === value);

/**
 * Returns `picks` with the model options `shown` (the options the composer
 * showed before the picks changed) that the model the thread now runs with
 * also offers.
 *
 * An option stays when that model declares an option with the same id and the
 * value is valid for it. When the model is unknown (a custom slug, or no
 * snapshot for the instance on that runner) no options stay, because the
 * composer shows no options selector for it and would send choices the user
 * cannot see. An option the effective config already holds from the thread's
 * own config is not picked again, so the picks stay minimal. The result has no
 * `options` key when nothing stays.
 */
const reconcileOptions = (
  catalogs: ThreadCatalogs,
  config: ThreadConfig,
  shown: ThreadConfig["options"],
  picks: ThreadPicks,
): ThreadPicks => {
  const withoutOptions = omitPicks(picks, "options");
  const next = computeEffectiveConfig(config, withoutOptions);
  const offered = findModelDescriptor(catalogs, next)?.options ?? [];
  const kept = Object.entries(shown).filter(
    ([id, value]) =>
      next.options[id] !== value &&
      offered.some((option) => option.id === id && acceptsValue(option, value)),
  );
  return kept.length === 0
    ? withoutOptions
    : { ...withoutOptions, options: Object.fromEntries(kept) };
};

/**
 * Removes a pick that equals what the thread already runs with, along with
 * `also`, so the next submission does not resend an unchanged value. Returns
 * `picks` unchanged when the key was never picked.
 */
const revertPick = (picks: ThreadPicks, key: Key, ...also: readonly Key[]): ThreadPicks =>
  picks[key] === undefined ? picks : omitPicks(picks, key, ...also);

/**
 * Applies one selector choice to the picks. Purely structural: it sets or
 * reverts the picked field and touches no model options, which `applyPicks`
 * reconciles once all the choices are in.
 */
const applyPick = (
  catalogs: ThreadCatalogs,
  config: ThreadConfig,
  picks: ThreadPicks,
  pick: ComposerPick,
): ThreadPicks => {
  switch (pick.kind) {
    case "model":
      return config.model === pick.value
        ? revertPick(picks, "model")
        : { ...picks, model: pick.value };
    case "instanceId": {
      const instance = catalogs.instances.find((each) => each.id === pick.value);
      if (instance === undefined) return picks;
      if (config.instanceId === pick.value)
        return revertPick(picks, "instanceId", "model", "runnerId");
      // A catalog belongs to one instance on one runner, and the runner of the
      // previous instance may not host this one. So resolve the runner first,
      // then read the model from that runner's snapshot.
      const forInstance = computeInstanceDefaults(
        instance,
        catalogs.runners,
        catalogs.thisMacRunnerId,
      );
      return { ...picks, instanceId: pick.value, ...forInstance };
    }
    case "option":
      return { ...picks, options: { ...picks.options, [pick.id]: pick.value } };
    case "accessMode":
      return config.accessMode === pick.value
        ? revertPick(picks, "accessMode")
        : { ...picks, accessMode: pick.value };
    case "runnerId":
      return config.runnerId === pick.value
        ? revertPick(picks, "runnerId")
        : { ...picks, runnerId: pick.value };
    // Unlike the others, a workspace pick is not compared with the config: the
    // config holds `null` until something is picked, and the default shown in
    // its place is resolved from the catalogs, which this function cannot see.
    case "workspace":
      return { ...picks, workspace: pick.value };
  }
};

/**
 * Applies several selector choices to the picks, in order, and returns the
 * new picks. One choice in a menu can set more than one field, so
 * `buildModelPicks` and `buildWorkspacePicks` return a list. The order
 * matters: picking an account resets the model, so the account comes before
 * the model.
 *
 * Owns the rule that model options survive when offered. When any choice can
 * change the catalog the thread runs with (a model, account, runner or
 * workspace), it takes the options the composer showed before the first
 * choice, plus those the choices picked, and keeps the ones the final model
 * offers (see `reconcileOptions`). It checks only the final result, so an
 * account's default model, which a later model choice replaces, never costs
 * an option. It does this even when a choice leaves the picks as they were,
 * because the catalog can change without a pick changing: a workspace pick
 * can move the effective runner to the one the config already holds.
 */
export const applyPicks = (
  catalogs: ThreadCatalogs,
  config: ThreadConfig,
  picks: ThreadPicks,
  steps: readonly ComposerPick[],
): ThreadPicks => {
  const applied = steps.reduce((held, step) => applyPick(catalogs, config, held, step), picks);
  if (!steps.some((step) => step.kind !== "option" && step.kind !== "accessMode")) return applied;
  const shown = computeEffectiveConfig(
    config,
    steps
      .filter((step) => step.kind === "option")
      .reduce((held, step) => applyPick(catalogs, config, held, step), picks),
  ).options;
  return reconcileOptions(catalogs, config, shown, applied);
};

/**
 * Returns the picks that choose `model` of the account `instanceId`, for a
 * thread that runs on the account `current.instanceId`, picks applied:
 *
 * - the model alone, when the thread already runs on that account;
 * - the account, then the model, when it does not.
 *
 * The account is not picked again when it already applies, because picking
 * an account resets the machine and the model to that account's defaults,
 * and a machine the user picked would be lost.
 */
export const buildModelPicks = (
  current: Pick<ThreadConfig, "instanceId">,
  instanceId: string,
  model: string,
): readonly ComposerPick[] =>
  current.instanceId === instanceId
    ? [{ kind: "model", value: model }]
    : [
        { kind: "instanceId", value: instanceId },
        { kind: "model", value: model },
      ];

/**
 * Returns the picks that choose `workspace`: the workspace, then, for a
 * workspace that exists, the machine it is on. A workspace is on one runner
 * and never moves, so joining it means running there.
 */
export const buildWorkspacePicks = (
  workspace: WorkspacePick,
  workspaces: readonly Workspace[],
): readonly ComposerPick[] => {
  const runnerId = findRunnerForPick(workspace, workspaces);
  return runnerId === null
    ? [{ kind: "workspace", value: workspace }]
    : [
        { kind: "workspace", value: workspace },
        { kind: "runnerId", value: runnerId },
      ];
};

/**
 * Returns `picks` with `workspace` picked and, for a workspace that exists,
 * the machine it is on.
 *
 * A Draft Thread starts in the workspace its composer shows, even when that
 * is a default the user never picked, so the start adds it to the picks.
 * Unlike `applyPicks`, this keeps the model options: the user picked them
 * while the composer showed this workspace and its machine.
 */
export const addWorkspacePicks = (
  picks: ThreadPicks,
  workspace: WorkspacePick,
  workspaces: readonly Workspace[],
): ThreadPicks => {
  const runnerId = findRunnerForPick(workspace, workspaces);
  return { ...picks, workspace, ...(runnerId === null ? {} : { runnerId }) };
};
