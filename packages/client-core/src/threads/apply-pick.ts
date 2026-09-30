/**
 * Applies one selector choice to the picks the composer holds. Three rules:
 *
 * - `config` is the thread's own config, without the picks applied, so a pick
 *   is compared with what the thread would run with if nothing were picked.
 * - A pick that equals that value is not a pick: it is removed from the picks.
 * - The model options belong to the model that offered them. So anything that
 *   changes the catalog (another model, account or runner) drops them, rather
 *   than keeping a value the new catalog never offered.
 */
import type { AccessMode, Workspace } from "@hercule/contract";
import type { ThreadCatalogs, ThreadConfig, ThreadPicks } from "./config";
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

/** Returns the picks without the model options, which belong to the previous model. */
const omitOptions = (picks: ThreadPicks): ThreadPicks => omitPicks(picks, "options");

/**
 * Removes a pick that equals what the thread already runs with, along with
 * `also`, so the next submission does not resend an unchanged value. Returns
 * `picks` unchanged when the key was never picked.
 */
const revertPick = (picks: ThreadPicks, key: Key, ...also: readonly Key[]): ThreadPicks =>
  picks[key] === undefined ? picks : omitPicks(picks, key, ...also);

export const applyPick = (
  catalogs: ThreadCatalogs,
  config: ThreadConfig,
  picks: ThreadPicks,
  pick: ComposerPick,
): ThreadPicks => {
  switch (pick.kind) {
    case "model":
      // A pick that changes the catalog removes the options key rather than
      // setting it to `{}`: the session keeps its current options until the
      // user picks the new model's options.
      return config.model === pick.value
        ? revertPick(picks, "model", "options")
        : { ...omitOptions(picks), model: pick.value };
    case "instanceId": {
      const instance = catalogs.instances.find((each) => each.id === pick.value);
      if (instance === undefined) return picks;
      if (config.instanceId === pick.value)
        return revertPick(picks, "instanceId", "model", "runnerId", "options");
      // A catalog belongs to one instance on one runner, and the runner of the
      // previous instance may not host this one. So resolve the runner first,
      // then read the model from that runner's snapshot.
      const forInstance = computeInstanceDefaults(
        instance,
        catalogs.runners,
        catalogs.localRunnerId,
      );
      return { ...omitOptions(picks), instanceId: pick.value, ...forInstance };
    }
    case "option":
      return { ...picks, options: { ...picks.options, [pick.id]: pick.value } };
    case "accessMode":
      return config.accessMode === pick.value
        ? revertPick(picks, "accessMode")
        : { ...picks, accessMode: pick.value };
    case "runnerId":
      return config.runnerId === pick.value
        ? revertPick(picks, "runnerId", "options")
        : { ...omitOptions(picks), runnerId: pick.value };
    // Unlike the others, a workspace pick is not compared with the config: the
    // config holds `null` until something is picked, and the default shown in
    // its place is resolved from the catalogs, which this function cannot see.
    case "workspace":
      return { ...picks, workspace: pick.value };
  }
};

/**
 * Applies several selector choices to the picks, in order, each as
 * `applyPick` applies it. One choice in a menu can set more than one field,
 * so `buildModelPicks` and `buildWorkspacePicks` return a list. The order
 * matters: picking an account resets the model, so the account comes before
 * the model.
 */
export const applyPicks = (
  catalogs: ThreadCatalogs,
  config: ThreadConfig,
  picks: ThreadPicks,
  steps: readonly ComposerPick[],
): ThreadPicks => steps.reduce((held, step) => applyPick(catalogs, config, held, step), picks);

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
 * Unlike `applyPick`, this keeps the model options: the user picked them
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
